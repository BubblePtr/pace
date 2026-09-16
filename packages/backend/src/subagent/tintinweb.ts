import type {
  SessionContentPart,
  SessionDetail,
  SessionSummary,
  SubagentCapabilities,
  SubagentRecord,
  SubagentState,
  SubagentUsage,
} from "@pace/core";
import { isSettledSubagentState, lookupSubagentByControlId, subagentPhaseForTransition } from "@pace/core";
import type { PiEventBus, SubagentSendInput, SubagentShim, SubagentShimContext, SubagentStopInput } from "./shim";

const TINTINWEB_LIFECYCLE_EVENTS = [
  "subagents:created",
  "subagents:started",
  "subagents:completed",
  "subagents:failed",
] as const;

const TINTINWEB_MANAGER = Symbol.for("pi-subagents:manager");
const RPC_TIMEOUT_MS = 2_000;
const REGISTRY_MISSING_ERROR = "tintinweb does not expose steer/resume on its registry";

export type TintinwebSubagentShimDeps = {
  events?: PiEventBus;
  subscribeSession?: (listener: (event: unknown) => void) => () => void;
  now?: () => string;
  resolveChildSessionId?: (sessionFile: string) => string | undefined;
};

type PendingTool = {
  toolCallId: string;
  args: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sessionIdFromFileName(sessionFile: string): string | undefined {
  const normalized = sessionFile.replace(/\\/g, "/");
  const base = normalized.split("/").pop();
  if (!base) {
    return undefined;
  }
  return base.replace(/\.jsonl$/i, "") || undefined;
}

export function childSessionIdFromSessionFile(
  sessionFile: string | undefined,
  index: readonly Pick<SessionSummary, "id">[],
  resolveChildSessionId?: (sessionFile: string) => string | undefined,
): string {
  if (!sessionFile) {
    return "";
  }
  const resolved = resolveChildSessionId?.(sessionFile);
  if (resolved) {
    return resolved;
  }
  const fromName = sessionIdFromFileName(sessionFile);
  if (fromName && index.some((session) => session.id === fromName)) {
    return fromName;
  }
  return fromName ?? "";
}

export function usageFromTintinwebPayload(value: unknown): SubagentUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const usage = isRecord(value.usage) ? value.usage : value;
  const cost = isRecord(usage.cost) ? usage.cost : undefined;
  const mapped: SubagentUsage = {
    ...(asNumber(usage.input ?? usage.inputTokens) !== undefined
      ? { inputTokens: asNumber(usage.input ?? usage.inputTokens) }
      : {}),
    ...(asNumber(usage.output ?? usage.outputTokens) !== undefined
      ? { outputTokens: asNumber(usage.output ?? usage.outputTokens) }
      : {}),
    ...(asNumber(usage.cacheRead ?? usage.cacheReadTokens) !== undefined
      ? { cacheReadTokens: asNumber(usage.cacheRead ?? usage.cacheReadTokens) }
      : {}),
    ...(asNumber(usage.cacheWrite ?? usage.cacheWriteTokens) !== undefined
      ? { cacheWriteTokens: asNumber(usage.cacheWrite ?? usage.cacheWriteTokens) }
      : {}),
    ...(asNumber(usage.totalTokens ?? usage.total) !== undefined
      ? { totalTokens: asNumber(usage.totalTokens ?? usage.total) }
      : {}),
    ...(asNumber(cost?.total ?? usage.costUsd) !== undefined
      ? { costUsd: asNumber(cost?.total ?? usage.costUsd) }
      : {}),
  };
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

export function stateFromFailedPayload(value: unknown): SubagentState {
  const status = isRecord(value) ? asString(value.status)?.toLowerCase() : undefined;
  return status === "aborted" || status === "stopped" ? "stopped" : "failed";
}

function textFromToolResult(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value) && typeof value.text === "string") {
    return value.text;
  }
  if (isRecord(value) && Array.isArray(value.content)) {
    return value.content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("\n");
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === "string" ? part : isRecord(part) ? asString(part.text) ?? "" : ""))
      .join("\n");
  }
  return "";
}

export function parseTintinwebAgentResult(result: unknown): {
  sourceAgentId?: string;
  sessionFile?: string;
  usage?: SubagentUsage;
  status?: string;
} {
  const details = isRecord(result) && isRecord(result.details) ? result.details : isRecord(result) ? result : {};
  const text = textFromToolResult(result);
  const fromTextId = text.match(/Agent ID:\s*(\S+)/i)?.[1];
  const fromTextFile = text.match(/Session file:\s*(\S+\.jsonl)/i)?.[1];
  return {
    ...(asString(details.agentId ?? details.id ?? fromTextId)
      ? { sourceAgentId: asString(details.agentId ?? details.id ?? fromTextId) }
      : {}),
    ...(asString(details.sessionFile ?? details.session_file ?? fromTextFile)
      ? { sessionFile: asString(details.sessionFile ?? details.session_file ?? fromTextFile) }
      : {}),
    ...(usageFromTintinwebPayload(details) ?? usageFromTintinwebPayload(result)
      ? { usage: usageFromTintinwebPayload(details) ?? usageFromTintinwebPayload(result) }
      : {}),
    ...(asString(details.status) ? { status: asString(details.status) } : {}),
  };
}

function payloadRecord(part: SessionContentPart): Record<string, unknown> | undefined {
  return isRecord(part.payload) ? part.payload : undefined;
}

function toolCallIdFromPart(part: SessionContentPart): string | undefined {
  const payload = payloadRecord(part);
  return asString(payload?.id) ?? asString(payload?.toolCallId) ?? asString(payload?.tool_call_id);
}

function argsFromPart(part: SessionContentPart): Record<string, unknown> {
  const payload = payloadRecord(part);
  const args = payload?.arguments ?? payload?.input ?? payload?.args;
  return isRecord(args) ? args : {};
}

function resultFromPart(part: SessionContentPart): unknown {
  const payload = payloadRecord(part);
  if (payload && ("details" in payload || "content" in payload || "text" in payload)) {
    return payload;
  }
  if (part.text) {
    return { text: part.text, details: payload };
  }
  return payload ?? part.text;
}

export function piEventBusFromUnknown(value: unknown): PiEventBus | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.on === "function") {
    return value as PiEventBus;
  }
  return piEventBusFromUnknown(value.eventBus) ?? piEventBusFromUnknown(value._resourceLoader);
}

type TintinwebManager = {
  getRecord?: (id: string) => { sessionFile?: string } | undefined;
  steer?: (id: string, message: string) => boolean;
  resume?: (
    id: string,
    prompt: string,
    signal?: unknown,
    options?: { isBackground?: boolean },
  ) => Promise<unknown>;
};

function requestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function tintinwebManager(): TintinwebManager | undefined {
  const value = (globalThis as Record<symbol, unknown>)[TINTINWEB_MANAGER];
  return isRecord(value) ? (value as TintinwebManager) : undefined;
}

function controlBusAvailable(events: PiEventBus | undefined): events is PiEventBus & {
  emit: (channel: string, data: unknown) => void;
} {
  return typeof events?.emit === "function";
}

function rpcCall(
  events: PiEventBus & { emit: (channel: string, data: unknown) => void },
  channel: string,
  payload: Record<string, unknown>,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<unknown> {
  const id = asString(payload.requestId) ?? requestId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      const error = new Error(`No reply for ${channel}`);
      (error as Error & { code: string }).code = "rpc_timeout";
      reject(error);
    }, timeoutMs);
    const unsubscribe = events.on(`${channel}:reply:${id}`, (reply) => {
      clearTimeout(timer);
      unsubscribe();
      if (isRecord(reply) && reply.success === false) {
        const error = new Error(asString(reply.error) ?? "Request failed");
        (error as Error & { code: string }).code = "rpc_error";
        reject(error);
        return;
      }
      resolve(isRecord(reply) ? reply.data : reply);
    });
    events.emit(channel, { ...payload, requestId: id });
  });
}

function capabilitiesFor(
  state: SubagentState,
  events: PiEventBus | undefined,
): SubagentCapabilities | undefined {
  const manager = tintinwebManager();
  const canSend = isSettledSubagentState(state)
    ? typeof manager?.resume === "function"
    : typeof manager?.steer === "function";
  const canStop = controlBusAvailable(events);
  if (!canSend && !canStop) {
    return undefined;
  }
  return {
    ...(canSend ? { send: true } : {}),
    ...(canStop ? { stop: true } : {}),
  };
}

export function createTintinwebSubagentShim(deps: TintinwebSubagentShimDeps = {}): SubagentShim {
  const now = deps.now ?? (() => new Date().toISOString());
  const records = new Map<string, SubagentRecord>();
  const byToolCallId = new Map<string, SubagentRecord>();

  const resolveChild = (sessionFile: string | undefined, index: readonly Pick<SessionSummary, "id">[]) =>
    childSessionIdFromSessionFile(sessionFile, index, deps.resolveChildSessionId);

  function fromSession(detail: SessionDetail, index: SessionSummary[]): SubagentRecord[] {
    // Upstream 0.19.0 also omits sessionFile from persisted subagents:record entries.
    // History links therefore depend on Pace capturing and persisting the live record.
    const byAgentId = new Map<string, SubagentRecord>();
    const byToolCallId = new Map<string, SubagentRecord>();
    let clock = 0;
    const stamp = (fallback?: string) => fallback ?? `${detail.timestamp.slice(0, 19)}.${String(++clock).padStart(3, "0")}Z`;

    const emitStored = (record: SubagentRecord) => {
      if (record.sourceAgentId) {
        for (const [key, existing] of byToolCallId) {
          if (existing.sourceAgentId === record.sourceAgentId) {
            byToolCallId.set(key, record);
          }
        }
        byAgentId.set(record.sourceAgentId, record);
      }
      if (record.ownerToolCallId) {
        byToolCallId.set(record.ownerToolCallId, record);
      }
    };

    for (const turn of detail.turns) {
      const open = new Map<string, { toolCallId: string; args: Record<string, unknown> }>();
      for (const part of turn.parts) {
        if (part.partType === "toolCall" && (part.name === "Agent" || payloadRecord(part)?.name === "Agent")) {
          const toolCallId = toolCallIdFromPart(part);
          if (!toolCallId) {
            continue;
          }
          const args = argsFromPart(part);
          open.set(toolCallId, { toolCallId, args });
          const resumeId = asString(args.resume);
          const existing = resumeId ? byAgentId.get(resumeId) : undefined;
          const createdAt = existing?.createdAt ?? stamp(turn.timestamp);
          const record: SubagentRecord = {
            childSessionId: existing?.childSessionId ?? "",
            parentSessionId: detail.id,
            ownerToolCallId: toolCallId,
            state: resumeId && existing && isSettledSubagentState(existing.state) ? "started" : "started",
            source: "tintinweb",
            createdAt,
            updatedAt: stamp(turn.timestamp),
            ...(existing?.usage ? { usage: existing.usage } : {}),
            startedAt: stamp(turn.timestamp),
            ...(existing?.sessionFile ? { sessionFile: existing.sessionFile } : {}),
            ...(resumeId || existing?.sourceAgentId
              ? { sourceAgentId: resumeId ?? existing?.sourceAgentId }
              : {}),
          };
          emitStored(record);
          continue;
        }

        if (part.partType === "toolResult") {
          const payload = payloadRecord(part);
          const toolCallId =
            asString(payload?.toolCallId) ??
            asString(payload?.tool_call_id) ??
            [...open.keys()].find((id) => open.get(id));
          const pending = toolCallId ? open.get(toolCallId) : undefined;
          const name = part.name ?? asString(payload?.toolName) ?? asString(payload?.name);
          if (name && name !== "Agent" && !pending) {
            continue;
          }
          if (!pending && name !== "Agent") {
            continue;
          }
          const parsed = parseTintinwebAgentResult(resultFromPart(part));
          const ownerToolCallId = pending?.toolCallId ?? toolCallId ?? "";
          if (!ownerToolCallId && !parsed.sourceAgentId) {
            continue;
          }
          const existing =
            (parsed.sourceAgentId ? byAgentId.get(parsed.sourceAgentId) : undefined) ??
            (ownerToolCallId ? byToolCallId.get(ownerToolCallId) : undefined);
          const sessionFile = parsed.sessionFile ?? existing?.sessionFile;
          const childSessionId = resolveChild(sessionFile, index) || existing?.childSessionId || "";
          const resumeId = pending ? asString(pending.args.resume) : undefined;
          const status = parsed.status;
          let state: SubagentState = existing?.state ?? "started";
          if (status === "background" || status === "queued") {
            state = status === "queued" ? "created" : "started";
          } else if (status === "aborted" || status === "stopped") {
            state = "stopped";
          } else if (status === "error" || part.isError) {
            state = "failed";
          } else if (status === "completed" || status === "done" || (pending && !asString(pending.args.run_in_background))) {
            state = "completed";
          }
          if (resumeId && existing && isSettledSubagentState(existing.state)) {
            state = "started";
          }
          const record: SubagentRecord = {
            childSessionId,
            parentSessionId: detail.id,
            ownerToolCallId: ownerToolCallId || existing?.ownerToolCallId || "",
            state,
            source: "tintinweb",
            createdAt: existing?.createdAt ?? stamp(turn.timestamp),
            updatedAt: stamp(turn.timestamp),
            ...(parsed.usage ?? existing?.usage ? { usage: parsed.usage ?? existing?.usage } : {}),
            startedAt: existing?.startedAt ?? stamp(turn.timestamp),
            ...(isSettledSubagentState(state) ? { endedAt: stamp(turn.timestamp) } : {}),
            ...(parsed.sourceAgentId ?? existing?.sourceAgentId
              ? { sourceAgentId: parsed.sourceAgentId ?? existing?.sourceAgentId }
              : {}),
            ...(sessionFile ? { sessionFile } : {}),
          };
          emitStored(record);
          if (pending) {
            open.delete(pending.toolCallId);
          }
        }
      }
    }

    const records: SubagentRecord[] = [];
    for (const [ownerToolCallId, record] of byToolCallId) {
      if (!ownerToolCallId) {
        continue;
      }
      records.push({ ...record, ownerToolCallId });
    }
    return records;
  }

  function observe(ctx: SubagentShimContext): () => void {
    records.clear();
    byToolCallId.clear();
    const pendingTools = new Map<string, PendingTool>();
    const unmatchedAgentIds: string[] = [];
    const unsubscribers: Array<() => void> = [];

    const publish = (next: SubagentRecord) => {
      const previous = next.sourceAgentId
        ? records.get(next.sourceAgentId)
        : byToolCallId.get(next.ownerToolCallId);
      const phase = subagentPhaseForTransition(previous?.state, next.state);
      if (next.sourceAgentId) {
        records.set(next.sourceAgentId, next);
      }
      if (next.ownerToolCallId) {
        byToolCallId.set(next.ownerToolCallId, next);
      }
      if (!next.ownerToolCallId) {
        return;
      }
      ctx.onRecord(next, phase);
    };

    const merge = (
      input: {
        sourceAgentId?: string;
        ownerToolCallId?: string;
        state: SubagentState;
        sessionFile?: string;
        usage?: SubagentUsage;
        at?: string;
      },
    ) => {
      const existing =
        (input.sourceAgentId ? records.get(input.sourceAgentId) : undefined) ??
        (input.ownerToolCallId ? byToolCallId.get(input.ownerToolCallId) : undefined);
      const ownerToolCallId = input.ownerToolCallId || existing?.ownerToolCallId || "";
      const sourceAgentId = input.sourceAgentId || existing?.sourceAgentId;
      // Upstream 0.19.0 omits sessionFile from events and Agent results. Retry the
      // registry on each observation because the child may still be initializing.
      const sessionFile = input.sessionFile || existing?.sessionFile ||
        (sourceAgentId ? asString(tintinwebManager()?.getRecord?.(sourceAgentId)?.sessionFile) : undefined);
      const at = input.at ?? now();
      const childSessionId =
        resolveChild(sessionFile, []) || existing?.childSessionId || "";
      const startedAt =
        input.state === "started" || input.state === "created"
          ? existing?.startedAt ?? (input.state === "started" ? at : existing?.startedAt)
          : existing?.startedAt;
      const capabilities = capabilitiesFor(input.state, deps.events);
      const record: SubagentRecord = {
        childSessionId,
        parentSessionId: ctx.parentSessionId,
        ownerToolCallId,
        state: input.state,
        source: "tintinweb",
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
        ...(input.usage ?? existing?.usage ? { usage: input.usage ?? existing?.usage } : {}),
        ...(startedAt ? { startedAt } : {}),
        ...(isSettledSubagentState(input.state) ? { endedAt: at } : {}),
        ...(capabilities ? { capabilities } : {}),
        ...(sourceAgentId ? { sourceAgentId } : {}),
        ...(sessionFile ? { sessionFile } : {}),
      };
      publish(record);
    };

    const attachAgentToTool = (sourceAgentId: string, toolCallId: string) => {
      const pending = pendingTools.get(toolCallId);
      pendingTools.delete(toolCallId);
      const existing = records.get(sourceAgentId);
      const resumeId = pending ? asString(pending.args.resume) : undefined;
      const state: SubagentState =
        resumeId && existing && isSettledSubagentState(existing.state)
          ? "started"
          : existing?.state ?? "started";
      merge({
        sourceAgentId: resumeId ?? sourceAgentId,
        ownerToolCallId: toolCallId,
        state,
        sessionFile: existing?.sessionFile,
        usage: existing?.usage,
      });
    };

    const handleLifecycle = (type: (typeof TINTINWEB_LIFECYCLE_EVENTS)[number], data: unknown) => {
      if (!isRecord(data)) {
        return;
      }
      const sourceAgentId = asString(data.id);
      if (!sourceAgentId) {
        return;
      }
      const at = now();
      if (type === "subagents:created") {
        const pendingToolsList = [...pendingTools.values()];
        const pending = pendingToolsList[pendingToolsList.length - 1];
        merge({
          sourceAgentId,
          ownerToolCallId: pending?.toolCallId ?? asString(data.toolCallId),
          state: "created",
          at,
        });
        if (!pending && !asString(data.toolCallId)) {
          unmatchedAgentIds.push(sourceAgentId);
        }
        return;
      }
      if (type === "subagents:started") {
        const existing = records.get(sourceAgentId);
        const pendingToolsList = [...pendingTools.values()];
        const pending = pendingToolsList[pendingToolsList.length - 1];
        const ownerToolCallId = existing?.ownerToolCallId || pending?.toolCallId || asString(data.toolCallId);
        merge({
          sourceAgentId,
          ownerToolCallId,
          state: "started",
          sessionFile: asString(data.sessionFile) ?? existing?.sessionFile,
          at,
        });
        return;
      }
      if (type === "subagents:completed") {
        merge({
          sourceAgentId,
          state: "completed",
          usage: usageFromTintinwebPayload(data),
          sessionFile: asString(data.sessionFile),
          at,
        });
        return;
      }
      merge({
        sourceAgentId,
        state: stateFromFailedPayload(data),
        usage: usageFromTintinwebPayload(data),
        sessionFile: asString(data.sessionFile),
        at,
      });
    };

    const handleSessionEvent = (event: unknown) => {
      if (!isRecord(event) || typeof event.toolCallId !== "string") {
        return;
      }
      const toolName = asString(event.toolName) ?? asString(event.name);
      if (event.type === "tool_execution_start") {
        if (toolName !== "Agent") {
          return;
        }
        const args = isRecord(event.args) ? event.args : {};
        pendingTools.set(event.toolCallId, { toolCallId: event.toolCallId, args });
        const resumeId = asString(args.resume);
        if (resumeId) {
          attachAgentToTool(resumeId, event.toolCallId);
          return;
        }
        const queued = unmatchedAgentIds.shift();
        if (queued) {
          attachAgentToTool(queued, event.toolCallId);
        }
        return;
      }
      if (event.type === "tool_execution_end" && (toolName === "Agent" || pendingTools.has(event.toolCallId))) {
        const parsed = parseTintinwebAgentResult(event.result);
        const pending = pendingTools.get(event.toolCallId);
        pendingTools.delete(event.toolCallId);
        const sourceAgentId = parsed.sourceAgentId ?? asString(pending?.args.resume);
        if (!sourceAgentId && !parsed.sessionFile) {
          merge({
            ownerToolCallId: event.toolCallId,
            state: event.isError ? "failed" : "started",
            sessionFile: parsed.sessionFile,
            usage: parsed.usage,
          });
          return;
        }
        const existing = sourceAgentId ? records.get(sourceAgentId) : undefined;
        const background = parsed.status === "background" || asString(pending?.args.run_in_background) === "true" || pending?.args.run_in_background === true;
        let state: SubagentState = existing?.state ?? (background ? "started" : "completed");
        if (event.isError) {
          state = "failed";
        } else if (parsed.status === "aborted" || parsed.status === "stopped") {
          state = "stopped";
        } else if (parsed.status === "error") {
          state = "failed";
        } else if (!background && parsed.status !== "background") {
          state = isSettledSubagentState(state) ? state : "completed";
        }
        merge({
          sourceAgentId,
          ownerToolCallId: event.toolCallId,
          state,
          sessionFile: parsed.sessionFile,
          usage: parsed.usage,
        });
      }
    };

    if (deps.events) {
      for (const type of TINTINWEB_LIFECYCLE_EVENTS) {
        unsubscribers.push(deps.events.on(type, (data) => handleLifecycle(type, data)));
      }
    }
    if (deps.subscribeSession) {
      unsubscribers.push(deps.subscribeSession(handleSessionEvent));
    }

    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }

  function liveRecords(): SubagentRecord[] {
    const seen = new Set<SubagentRecord>();
    const list: SubagentRecord[] = [];
    for (const record of [...records.values(), ...byToolCallId.values()]) {
      if (seen.has(record)) {
        continue;
      }
      seen.add(record);
      list.push(record);
    }
    return list;
  }

  function resolveLiveRecord(target: SubagentSendInput | SubagentStopInput): SubagentRecord {
    const record = lookupSubagentByControlId(liveRecords(), target);
    if (!record) {
      const id = target.sourceAgentId ?? target.childSessionId ?? "";
      throw new Error(`Subagent "${id || "unknown"}" was not found for this session.`);
    }
    return record;
  }

  function requireAgentId(record: SubagentRecord): string {
    if (!record.sourceAgentId) {
      throw new Error("This subagent has no plugin id to send or stop.");
    }
    return record.sourceAgentId;
  }

  async function send(input: SubagentSendInput): Promise<void> {
    const text = input.text.trim();
    if (!text) {
      throw new Error("text is required");
    }
    const record = resolveLiveRecord(input);
    if (record.capabilities?.send !== true) {
      throw new Error("This subagent does not advertise send.");
    }
    const agentId = requireAgentId(record);
    const manager = tintinwebManager();
    if (isSettledSubagentState(record.state)) {
      if (typeof manager?.resume !== "function") {
        throw new Error(REGISTRY_MISSING_ERROR);
      }
      await manager.resume(agentId, text, undefined, { isBackground: true });
      return;
    }
    if (typeof manager?.steer !== "function") {
      throw new Error(REGISTRY_MISSING_ERROR);
    }
    if (!manager.steer(agentId, text)) {
      throw new Error(`Agent "${agentId}" is not running.`);
    }
  }

  async function stop(input: SubagentStopInput): Promise<void> {
    const record = resolveLiveRecord(input);
    if (record.capabilities?.stop !== true) {
      throw new Error("This subagent does not advertise stop.");
    }
    if (!controlBusAvailable(deps.events)) {
      throw new Error("Tintinweb subagent stop is not available on this session.");
    }
    const agentId = requireAgentId(record);
    await rpcCall(deps.events, "subagents:rpc:stop", { agentId });
  }

  return {
    source: "tintinweb",
    observe,
    fromSession,
    send,
    stop,
  };
}

export const tintinwebSubagentShim = createTintinwebSubagentShim();
