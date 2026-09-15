import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type {
  SessionDetail,
  SessionContentPart,
  SessionTurn,
  ModelUsage,
  NamedCount,
  SessionPresence,
  SessionSummary,
  Title,
} from "@pace/core";
import { isChatWorkspaceCwd } from "./chat-workspace";
import { tintinwebSubagentShim } from "../subagent/tintinweb";

const maxTextTitleChars = 96;
const maxCommandArgsChars = 80;
const sentenceTerminators = new Set([".", "!", "?", "。", "！", "？"]);

type JsonRecord = Record<string, unknown>;

type IndexedSession = {
  summary: SessionSummary;
  sortTimestamp: number;
};

type CachedSession = {
  modifiedAtMs: number;
  session: IndexedSession;
};

export type SessionIndexCache = {
  entries: Map<string, CachedSession>;
  hits: number;
  misses: number;
};

type TokenUsage = NonNullable<SessionTurn["usage"]>;
type CostBreakdown = NonNullable<SessionTurn["cost"]>;

type Metrics = {
  totalCostUsd: number;
  totalTokens: number;
  currentModel?: string;
  turnCount: number;
  firstTimestamp?: number;
  lastTimestamp?: number;
  modelTotals: Map<string, { costUsd: number; tokens: number }>;
  toolCounts: Map<string, number>;
  skillCounts: Map<string, number>;
};

export type SessionStateUpdate =
  | { kind: "ignored" }
  | { kind: "sessionStarted"; detail: SessionDetail }
  | { kind: "turnAppended"; turn: SessionTurn };

export function createSessionIndexCache(): SessionIndexCache {
  return {
    entries: new Map(),
    hits: 0,
    misses: 0,
  };
}

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env) {
  if (env.PI_CODING_AGENT_DIR) {
    return env.PI_CODING_AGENT_DIR;
  }

  return join(homedir(), ".pi", "agent");
}

export async function buildSessionIndex(dir: string, dataDir: string) {
  return buildSessionIndexWithCache(dir, createSessionIndexCache(), dataDir);
}

export async function buildSessionIndexWithCache(
  dir: string,
  cache: SessionIndexCache,
  dataDir: string,
): Promise<SessionSummary[]> {
  const sessionsDir = join(dir, "sessions");

  if (!(await pathExists(sessionsDir))) {
    cache.entries.clear();
    return [];
  }

  const sessions: IndexedSession[] = [];
  const seenPaths = new Set<string>();

  for (const path of await findJsonlFiles(sessionsDir)) {
    seenPaths.add(path);

    const session = await readSessionSummaryCached(path, cache, dataDir);
    if (session) {
      sessions.push(session);
    }
  }

  for (const path of cache.entries.keys()) {
    if (!seenPaths.has(path)) {
      cache.entries.delete(path);
    }
  }

  return sessions
    .sort((left, right) => right.sortTimestamp - left.sortTimestamp)
    .map((session) => session.summary);
}

// The projection fields presence depends on — a structural subset of
// PersistedSessionProjection so the session parser stays free of persistence.
export type SessionPresenceProjection = {
  piSessionId: string;
  status: string;
  archivedAt?: string;
};

export function annotateSessionPresence(
  summaries: SessionSummary[],
  projections: SessionPresenceProjection[],
): SessionSummary[] {
  const presenceByPiSessionId = new Map<string, SessionPresence>();

  for (const projection of projections) {
    const archived = projection.status === "archived" || Boolean(projection.archivedAt);
    const presence = archived ? "archived" : "active";

    // Duplicate projections of one Pi session should not exist, but if they do,
    // a live one wins: the Session is still visible somewhere in Pace.
    if (presence === "active" || !presenceByPiSessionId.has(projection.piSessionId)) {
      presenceByPiSessionId.set(projection.piSessionId, presence);
    }
  }

  return summaries.map((summary) => ({
    ...summary,
    presence: presenceByPiSessionId.get(summary.id) ?? "external",
  }));
}

export async function loadSessionDetail(
  dir: string,
  id: string,
  dataDir: string,
  cache: SessionIndexCache = createSessionIndexCache(),
): Promise<SessionDetail> {
  const path = await findSessionFile(dir, id, dataDir);

  if (!path) {
    throw new Error(`session ${id} was not found`);
  }

  const detail = parseSession(await readFile(path, "utf8"), dataDir);
  const index = await buildSessionIndexWithCache(dir, cache, dataDir);
  return {
    ...detail,
    subagents: tintinwebSubagentShim.fromSession?.(detail, index) ?? [],
  };
}

export function parseSession(jsonl: string, dataDir: string): SessionDetail {
  const parser = new SessionParser(dataDir);

  jsonl.split(/\r?\n/).forEach((line, index) => {
    try {
      parser.feedLine(line);
    } catch (error) {
      throw new Error(`failed to parse JSONL at line ${index + 1}: ${messageFromError(error)}`);
    }
  });

  const detail = parser.finish();
  if (!detail) {
    throw new Error("session JSONL did not contain a session record");
  }

  return detail;
}

export class SessionParser {
  private detail?: SessionDetail;
  private metrics = createMetrics();

  constructor(private readonly dataDir: string) {}

  feedLine(line: string): SessionStateUpdate {
    if (!line.trim()) {
      return { kind: "ignored" };
    }

    const record = JSON.parse(line) as JsonRecord;
    const eventType = stringValue(record.type);

    if (eventType === "session") {
      this.metrics = createMetrics();
      touchMetrics(this.metrics, timestampMs(record.timestamp));

      const model = stringFieldFromRecord(record, ["model", "currentModel"]);
      if (model) {
        this.metrics.currentModel = model;
      }

      this.detail = {
        id: stringValue(record.id) ?? "",
        timestamp: isoTimestamp(record.timestamp) ?? "",
        project: deriveProjectName(stringValue(record.cwd) ?? "", this.dataDir),
        totalCostUsd: 0,
        totalTokens: 0,
        primaryModel: undefined,
        turnCount: 0,
        durationSeconds: 0,
        turns: [],
      };

      return { kind: "sessionStarted", detail: cloneDetail(this.detail) };
    }

    if (eventType === "message") {
      touchMetrics(this.metrics, timestampMs(record.timestamp));

      const model = messageModel(record, this.metrics);
      const usage = tokenUsageFromRecord(record);
      const cost = costBreakdownFromRecord(record);
      const role = effectiveRole(record);

      if (role === "assistant") {
        aggregateAssistantMessage(this.metrics, model, usage, cost);
      }

      if (role === "toolResult" && this.tryMergeToolResult(record)) {
        return {
          kind: "turnAppended",
          turn: cloneTurn(this.detail!.turns[this.detail!.turns.length - 1]),
        };
      }

      this.metrics.turnCount += 1;

      return this.appendTurn({
        kind: "message",
        role,
        timestamp: isoTimestamp(record.timestamp),
        modelDurationMs: role === "assistant" ? modelDurationMs(record) : undefined,
        model,
        usage,
        cost,
        parts: contentParts(effectiveContent(record)),
      });
    }

    if (eventType === "model_change" || eventType === "thinking_level_change") {
      touchMetrics(this.metrics, timestampMs(record.timestamp));

      if (eventType === "model_change") {
        this.metrics.currentModel =
          stringFromUnknown(effectiveField(record, "to")) ??
          stringFromUnknown(effectiveField(record, "model")) ??
          this.metrics.currentModel;
      }

      const payload: JsonRecord = {};
      if (this.metrics.currentModel) {
        payload.model = this.metrics.currentModel;
      }
      Object.assign(payload, recordFields(record));

      return this.appendTurn({
        kind: "annotation",
        timestamp: isoTimestamp(record.timestamp),
        title: annotationTitle(eventType),
        model: this.metrics.currentModel,
        parts: [
          {
            partType: eventType,
            payload,
          },
        ],
      });
    }

    return { kind: "ignored" };
  }

  finish() {
    return this.detail ? cloneDetail(this.detail) : undefined;
  }

  private appendTurn(turn: SessionTurn): SessionStateUpdate {
    if (!this.detail) {
      return { kind: "ignored" };
    }

    this.detail.turns.push(turn);
    this.syncDetailMetrics();

    return { kind: "turnAppended", turn: cloneTurn(turn) };
  }

  private tryMergeToolResult(record: JsonRecord) {
    if (!this.detail) {
      return false;
    }

    const assistantTurn = [...this.detail.turns]
      .reverse()
      .find((turn) => turn.kind === "message" && turn.role === "assistant");

    if (!assistantTurn) {
      return false;
    }

    const content = effectiveContent(record);
    const texts = textValuesFromContent(content);
    const isError = effectiveField(record, "isError");
    // Pi ships no tool duration field; the gap between the assistant event
    // (which carries the toolCall) and this toolResult event is the tool's
    // execution time. Model latency comes from a different pair of stamps —
    // see modelDurationMs.
    const callMs = timestampMs(assistantTurn.timestamp);
    const resultMs = timestampMs(record.timestamp);

    assistantTurn.parts.push({
      partType: "toolResult",
      text: texts.length ? texts.join("\n") : undefined,
      name: stringFromUnknown(effectiveField(record, "toolName")),
      isError: typeof isError === "boolean" ? isError : undefined,
      durationMs:
        callMs !== undefined && resultMs !== undefined && resultMs >= callMs
          ? resultMs - callMs
          : undefined,
      payload: effectiveMessage(record) ?? record,
    });

    return true;
  }

  private syncDetailMetrics() {
    if (!this.detail) {
      return;
    }

    this.detail.totalCostUsd = this.metrics.totalCostUsd;
    this.detail.totalTokens = this.metrics.totalTokens;
    this.detail.primaryModel = primaryModel(this.metrics);
    this.detail.turnCount = this.metrics.turnCount;
    this.detail.durationSeconds = durationSeconds(this.metrics);
  }
}

export function classifyTitle(firstUserMessage: string): Title {
  const text = compactWhitespace(firstUserMessage);

  if (isTrivialTitle(text)) {
    return { kind: "raw", text };
  }

  const skillName = parseSkillName(text);
  if (skillName) {
    return { kind: "skill", name: skillName };
  }

  const command = parseCommand(text);
  if (command) {
    return { kind: "command", name: command.name, args: command.args };
  }

  if (!text) {
    return { kind: "raw", text };
  }

  return {
    kind: "text",
    sentence: firstSentenceTitle(text),
  };
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function findJsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) {
        return findJsonlFiles(path);
      }

      return entry.isFile() && extname(entry.name) === ".jsonl" ? [path] : [];
    }),
  );

  return paths.flat();
}

async function findSessionFile(dir: string, id: string, dataDir: string) {
  const sessionsDir = join(dir, "sessions");
  if (!(await pathExists(sessionsDir))) {
    return undefined;
  }

  for (const path of await findJsonlFiles(sessionsDir)) {
    const summary = await readSessionSummary(path, dataDir);
    if (summary?.summary.id === id) {
      return path;
    }
  }

  return undefined;
}

async function readSessionSummaryCached(
  path: string,
  cache: SessionIndexCache,
  dataDir: string,
) {
  const metadata = await stat(path);
  const modifiedAtMs = metadata.mtimeMs;
  const cached = cache.entries.get(path);

  if (cached?.modifiedAtMs === modifiedAtMs) {
    cache.hits += 1;
    return cloneIndexedSession(cached.session);
  }

  cache.misses += 1;
  const session = await readSessionSummary(path, dataDir);
  if (session) {
    cache.entries.set(path, {
      modifiedAtMs,
      session: cloneIndexedSession(session),
    });
  } else {
    cache.entries.delete(path);
  }

  return session;
}

async function readSessionSummary(
  path: string,
  dataDir: string,
): Promise<IndexedSession | undefined> {
  const jsonl = await readFile(path, "utf8");
  let sessionRecord:
    | {
        id: string;
        timestamp: string;
        sortTimestamp: number;
        cwd: string;
      }
    | undefined;
  let firstUserMessage: string | undefined;
  const metrics = createMetrics();

  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let record: JsonRecord;
    try {
      record = JSON.parse(line) as JsonRecord;
    } catch {
      continue;
    }

    const eventType = stringValue(record.type);

    if (eventType === "session") {
      const timestamp = isoTimestamp(record.timestamp);
      const sortTimestamp = timestampMs(record.timestamp);
      const id = stringValue(record.id);
      const cwd = stringValue(record.cwd);

      touchMetrics(metrics, sortTimestamp);
      metrics.currentModel = stringFieldFromRecord(record, ["model", "currentModel"]);

      if (id && timestamp && sortTimestamp !== undefined && cwd) {
        sessionRecord = { id, timestamp, sortTimestamp, cwd };
      }
      continue;
    }

    if (eventType === "model_change") {
      touchMetrics(metrics, timestampMs(record.timestamp));
      metrics.currentModel =
        stringFieldFromRecord(record, ["to", "model"]) ?? metrics.currentModel;
      continue;
    }

    if (eventType === "message") {
      touchMetrics(metrics, timestampMs(record.timestamp));
      aggregateToolCalls(metrics, effectiveContent(record));
      aggregateSkillInvocations(metrics, effectiveContent(record));

      if (effectiveRole(record) === "user" && firstUserMessage === undefined) {
        firstUserMessage = firstTextFromContent(effectiveContent(record));
      }

      const model = messageModel(record, metrics);
      const usage = tokenUsageFromRecord(record);
      const cost = costBreakdownFromRecord(record);

      if (effectiveRole(record) === "assistant") {
        aggregateAssistantMessage(metrics, model, usage, cost);
      }
    }
  }

  if (!sessionRecord) {
    return undefined;
  }

  return {
    summary: {
      id: sessionRecord.id,
      timestamp: sessionRecord.timestamp,
      project: deriveProjectName(sessionRecord.cwd, dataDir),
      title: classifyTitle(firstUserMessage ?? ""),
      totalCostUsd: metrics.totalCostUsd,
      totalTokens: metrics.totalTokens,
      primaryModel: primaryModel(metrics),
      modelBreakdown: modelBreakdown(metrics),
      toolCounts: sortedNamedCounts(metrics.toolCounts),
      skillCounts: sortedNamedCounts(metrics.skillCounts),
      // Pi's JSONL cannot say whether Pace knows this session; annotateSessionPresence
      // resolves it per request, so the cached summary never holds a stale presence.
      presence: "external",
    },
    sortTimestamp: sessionRecord.sortTimestamp,
  };
}

function createMetrics(): Metrics {
  return {
    totalCostUsd: 0,
    totalTokens: 0,
    turnCount: 0,
    modelTotals: new Map(),
    toolCounts: new Map(),
    skillCounts: new Map(),
  };
}

function touchMetrics(metrics: Metrics, timestamp?: number) {
  if (timestamp === undefined) {
    return;
  }

  metrics.firstTimestamp =
    metrics.firstTimestamp === undefined ? timestamp : Math.min(metrics.firstTimestamp, timestamp);
  metrics.lastTimestamp =
    metrics.lastTimestamp === undefined ? timestamp : Math.max(metrics.lastTimestamp, timestamp);
}

function aggregateAssistantMessage(
  metrics: Metrics,
  model: string | undefined,
  usage: TokenUsage | undefined,
  cost: CostBreakdown | undefined,
) {
  const costUsd = cost?.totalUsd ?? 0;
  const tokens = usage?.totalTokens ?? 0;

  metrics.totalCostUsd += costUsd;
  metrics.totalTokens += tokens;

  if (!cost && !usage) {
    return;
  }

  const modelName = model ?? "Unknown model";
  const totals = metrics.modelTotals.get(modelName) ?? { costUsd: 0, tokens: 0 };

  totals.costUsd += costUsd;
  totals.tokens += tokens;
  metrics.modelTotals.set(modelName, totals);
}

function aggregateToolCalls(metrics: Metrics, content: unknown) {
  for (const part of contentItems(content)) {
    const name = toolCallName(part);
    if (name) {
      metrics.toolCounts.set(name, (metrics.toolCounts.get(name) ?? 0) + 1);
    }
  }
}

function aggregateSkillInvocations(metrics: Metrics, content: unknown) {
  for (const text of textValuesFromContent(content)) {
    for (const name of skillNamesInText(text)) {
      metrics.skillCounts.set(name, (metrics.skillCounts.get(name) ?? 0) + 1);
    }
  }
}

function primaryModel(metrics: Metrics) {
  const [first] = modelBreakdown(metrics);

  return first?.model ?? metrics.currentModel;
}

function modelBreakdown(metrics: Metrics): ModelUsage[] {
  return Array.from(metrics.modelTotals.entries())
    .map(([model, totals]) => ({
      model,
      costUsd: totals.costUsd,
      tokens: totals.tokens,
    }))
    .sort((left, right) => (
      right.costUsd - left.costUsd ||
      right.tokens - left.tokens ||
      left.model.localeCompare(right.model)
    ));
}

function durationSeconds(metrics: Metrics) {
  if (metrics.firstTimestamp === undefined || metrics.lastTimestamp === undefined) {
    return undefined;
  }

  return Math.max(0, Math.trunc((metrics.lastTimestamp - metrics.firstTimestamp) / 1000));
}

function effectiveMessage(record: JsonRecord) {
  return isRecord(record.message) ? record.message : undefined;
}

function effectiveRole(record: JsonRecord): SessionTurn["role"] {
  const role = stringFromUnknown(effectiveMessage(record)?.role ?? record.role);

  if (role === "user" || role === "assistant" || role === "toolResult") {
    return role;
  }

  return role ? "unknown" : undefined;
}

function effectiveContent(record: JsonRecord) {
  const message = effectiveMessage(record);

  return message && "content" in message ? message.content : record.content;
}

// No model call runs for hours; a longer span means the inner stamp is not
// what we think it is (epoch 0 being the classic degenerate value).
const maxModelDurationMs = 2 * 60 * 60 * 1000;

/**
 * Pi writes `message.timestamp` (epoch ms) when the provider stream opens and
 * the outer record timestamp when the message ends, so their difference is how
 * long the model call took. This is the one place that validates the pair:
 * anything that is not a plausible positive span — an older session without the
 * inner stamp, a garbage value, a clock skewed backwards, epoch 0 — yields
 * nothing, so consumers estimate rather than trust a bogus number.
 */
function modelDurationMs(record: JsonRecord) {
  const startMs = timestampMs(effectiveMessage(record)?.timestamp);
  const endMs = timestampMs(record.timestamp);

  if (startMs === undefined || endMs === undefined) {
    return undefined;
  }

  const durationMs = endMs - startMs;

  return durationMs > 0 && durationMs <= maxModelDurationMs ? durationMs : undefined;
}

function effectiveField(record: JsonRecord, key: string) {
  const message = effectiveMessage(record);

  return record[key] ?? message?.[key];
}

function recordFields(record: JsonRecord) {
  const omitted = new Set(["type", "id", "timestamp", "cwd", "role", "content", "message"]);
  const fields: JsonRecord = {};

  for (const [key, value] of Object.entries(record)) {
    if (!omitted.has(key)) {
      fields[key] = value;
    }
  }

  const message = effectiveMessage(record);
  if (message) {
    for (const [key, value] of Object.entries(message)) {
      if (!omitted.has(key)) {
        fields[key] = value;
      }
    }
  }

  return fields;
}

function stringFieldFromRecord(record: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = stringFromUnknown(effectiveField(record, key));
    if (value) {
      return value;
    }
  }

  return undefined;
}

function messageModel(record: JsonRecord, metrics: Metrics) {
  const model = stringFieldFromRecord(record, ["model", "currentModel"]);

  if (model) {
    metrics.currentModel = model;
    return model;
  }

  return metrics.currentModel;
}

function tokenUsageFromRecord(record: JsonRecord): TokenUsage | undefined {
  const usage = effectiveField(record, "usage");

  if (!isRecord(usage)) {
    return undefined;
  }

  const inputTokens = numberField(usage, [
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens",
    "input",
  ]);
  const outputTokens = numberField(usage, [
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
    "output",
  ]);
  const cacheReadTokens = numberField(usage, [
    "cacheReadTokens",
    "cache_read_tokens",
    "cachedInputTokens",
    "cached_input_tokens",
    "cachedTokens",
    "cached_tokens",
  ]);
  const cacheWriteTokens = numberField(usage, [
    "cacheWriteTokens",
    "cache_write_tokens",
    "cacheCreationInputTokens",
    "cache_creation_input_tokens",
  ]);
  const totalTokens =
    numberField(usage, ["totalTokens", "total_tokens", "total"]) ??
    (inputTokens ?? 0) + (outputTokens ?? 0);

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    totalTokens,
  };
}

function costBreakdownFromRecord(record: JsonRecord): CostBreakdown | undefined {
  const usage = effectiveField(record, "usage");
  const cost = effectiveField(record, "cost") ?? (isRecord(usage) ? usage.cost : undefined);

  if (typeof cost === "number") {
    return {
      inputUsd: 0,
      outputUsd: 0,
      cacheReadUsd: 0,
      cacheWriteUsd: 0,
      totalUsd: cost,
    };
  }

  if (!isRecord(cost)) {
    return undefined;
  }

  const inputUsd = floatField(cost, ["inputUsd", "input_usd", "inputCost", "input_cost", "input"]) ?? 0;
  const outputUsd = floatField(cost, [
    "outputUsd",
    "output_usd",
    "outputCost",
    "output_cost",
    "output",
  ]) ?? 0;
  const cacheReadUsd = floatField(cost, [
    "cacheReadUsd",
    "cache_read_usd",
    "cacheReadCost",
    "cache_read_cost",
    "cacheRead",
    "cache_read",
  ]) ?? 0;
  const cacheWriteUsd = floatField(cost, [
    "cacheWriteUsd",
    "cache_write_usd",
    "cacheWriteCost",
    "cache_write_cost",
    "cacheWrite",
    "cache_write",
  ]) ?? 0;
  const totalUsd = floatField(cost, [
    "totalUsd",
    "total_usd",
    "totalCostUsd",
    "total_cost_usd",
    "totalCost",
    "total_cost",
    "total",
  ]) ?? inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd;

  return {
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    totalUsd,
  };
}

function contentParts(content: unknown): SessionContentPart[] {
  if (Array.isArray(content)) {
    return content.map(contentPartFromValue);
  }

  if (typeof content === "string") {
    return [
      {
        partType: "text",
        text: content,
        payload: null,
      },
    ];
  }

  if (content !== undefined) {
    return [contentPartFromValue(content)];
  }

  return [];
}

function contentPartFromValue(value: unknown): SessionContentPart {
  if (!isRecord(value)) {
    return {
      partType: "unknown",
      payload: value,
    };
  }

  return {
    partType: stringValue(value.type) ?? "unknown",
    text: stringFromUnknown(value.text ?? value.thinking ?? value.content),
    name: stringFromUnknown(value.name ?? value.toolName),
    payload: value,
  };
}

function firstTextFromContent(content: unknown) {
  return textValuesFromContent(content)[0];
}

function textValuesFromContent(content: unknown): string[] {
  return contentItems(content)
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (!isRecord(part)) {
        return undefined;
      }

      return stringFromUnknown(part.text ?? part.content);
    })
    .filter((value): value is string => value !== undefined);
}

function contentItems(content: unknown) {
  if (content === undefined || content === null) {
    return [];
  }

  return Array.isArray(content) ? content : [content];
}

function toolCallName(value: unknown) {
  if (!isRecord(value) || stringValue(value.type) !== "toolCall") {
    return undefined;
  }

  return stringFromUnknown(value.name ?? value.toolName);
}

function skillNamesInText(text: string) {
  const names: string[] = [];
  let cursor = text;

  while (true) {
    const start = cursor.indexOf("<skill");
    if (start === -1) {
      break;
    }

    cursor = cursor.slice(start);
    const end = cursor.indexOf(">");
    if (end === -1) {
      break;
    }

    const tag = cursor.slice(0, end + 1);
    const name = parseSkillName(tag) ?? parseSkillShorthandName(tag);
    if (name) {
      names.push(name);
    }
    cursor = cursor.slice(end + 1);
  }

  return names;
}

function sortedNamedCounts(counts: Map<string, number>): NamedCount[] {
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

export function deriveProjectName(cwd: string, dataDir: string) {
  if (isChatWorkspaceCwd(dataDir, cwd)) {
    return "Chat";
  }

  const checkoutName = basename(cwd);
  const projectRoot = dirname(cwd);

  if (
    checkoutName.startsWith("session-") &&
    basename(dirname(projectRoot)) === ".pig-worktrees"
  ) {
    return basename(projectRoot);
  }

  return basename(cwd) || cwd;
}

function compactWhitespace(value: string) {
  return value.split(/\s+/).filter(Boolean).join(" ");
}

function isTrivialTitle(text: string) {
  return ["", "hi", "hello", "hey", "echo test", "/exit"].includes(text.toLowerCase());
}

function parseCommand(text: string) {
  if (!text.startsWith("/")) {
    return undefined;
  }

  const command = text.slice(1);
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(command);
  const name = match?.[1] ?? "";
  const args = match?.[2]?.trim() ?? "";

  if (!name) {
    return undefined;
  }

  return {
    name,
    args: truncateAtWordBoundary(args, maxCommandArgsChars),
  };
}

function parseSkillName(text: string) {
  if (!text.startsWith("<skill")) {
    return undefined;
  }

  const match = /\bname=(["'])(.*?)\1/.exec(text);
  const name = match?.[2]?.trim();

  return name || undefined;
}

function parseSkillShorthandName(tag: string) {
  const rest = tag.startsWith("<skill-") ? tag.slice("<skill-".length) : "";
  const name = rest.split(/[>\s/]/, 1)[0]?.trim();

  return name || undefined;
}

function firstSentenceTitle(text: string) {
  const chars = Array.from(text);
  const index = chars.findIndex((char) => sentenceTerminators.has(char));
  const firstSentence = index === -1 ? text : chars.slice(0, index + 1).join("").trim();

  return truncateAtWordBoundary(firstSentence, maxTextTitleChars);
}

function truncateAtWordBoundary(text: string, maxChars: number) {
  const chars = Array.from(text);
  if (chars.length <= maxChars) {
    return text;
  }

  const candidate = chars.slice(0, maxChars).join("");
  const whitespaceMatches = [...candidate.matchAll(/\s+/g)];
  const boundary = whitespaceMatches[whitespaceMatches.length - 1]?.index;
  const truncated = (boundary && boundary > 0 ? candidate.slice(0, boundary) : candidate)
    .replace(/[.!?。！？]+$/u, "")
    .trimEnd();

  return `${truncated}...`;
}

function annotationTitle(eventType: string) {
  switch (eventType) {
    case "model_change":
      return "Model changed";
    case "thinking_level_change":
      return "Thinking level changed";
    default:
      return "Session annotation";
  }
}

function timestampMs(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isoTimestamp(value: unknown) {
  const timestamp = timestampMs(value);
  return timestamp === undefined ? undefined : new Date(timestamp).toISOString();
}

function numberField(object: JsonRecord, keys: string[]) {
  const value = keys.map((key) => object[key]).find((candidate) => candidate !== undefined);

  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function floatField(object: JsonRecord, keys: string[]) {
  const value = keys.map((key) => object[key]).find((candidate) => candidate !== undefined);

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function stringFromUnknown(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function cloneDetail(detail: SessionDetail): SessionDetail {
  return {
    ...detail,
    turns: detail.turns.map(cloneTurn),
  };
}

function cloneTurn(turn: SessionTurn): SessionTurn {
  return {
    ...turn,
    usage: turn.usage ? { ...turn.usage } : undefined,
    cost: turn.cost ? { ...turn.cost } : undefined,
    parts: turn.parts.map((part) => ({ ...part })),
  };
}

function cloneIndexedSession(session: IndexedSession): IndexedSession {
  return {
    sortTimestamp: session.sortTimestamp,
    summary: {
      ...session.summary,
      title: { ...session.summary.title } as Title,
      modelBreakdown: session.summary.modelBreakdown.map((usage) => ({ ...usage })),
      toolCounts: session.summary.toolCounts.map((count) => ({ ...count })),
      skillCounts: session.summary.skillCounts.map((count) => ({ ...count })),
    },
  };
}
