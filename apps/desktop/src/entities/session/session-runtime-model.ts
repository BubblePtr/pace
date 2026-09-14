// Structured query model for a session's Agent Runtime Event stream. Entities
// are keyed by protocol identity (runId/messageId/toolCallId), ordering comes
// from the Gateway seq, and Session Status is decided by run/error events
// only — status events never flip it. See docs/adr/0020-agent-runtime-event-model.md.

import type {
  AgentMessagePartType,
  AgentRuntimeEvent,
  AgentRunOutcome,
  AgentRunTrigger,
  AgentStatusCode,
  RuntimePromptImage,
} from "@pace/core";
import { promptImageDataUrl } from "@pace/core";
import type { SessionStatus } from "./session-projection";

export type SessionRuntimeRun = {
  runId: string;
  trigger: AgentRunTrigger;
  outcome?: AgentRunOutcome;
  startedAt: string;
  endedAt?: string;
};

export type SessionRuntimeMessagePart = {
  partId: string;
  partType: AgentMessagePartType;
  body: string;
  done: boolean;
  toolCallId?: string;
  // What the part is called: the tool's name on a tool_call part, the file
  // name on an image part. Both arrive with the part itself, ahead of any
  // execution event that might restate it.
  name?: string;
  // The part(start)/part(end) boundaries, the way startedAt/updatedAt bracket
  // a message. The CoT phase machine anchors its clock and its freeze point on
  // them (ADR-0030 §6), so deltas and the message end snapshot must carry them
  // across rather than restate them. Absent when the boundary never arrived,
  // so consumers can tell "not measured" from "measured as zero".
  startedAt?: string;
  endedAt?: string;
};

export type SessionRuntimeMessage = {
  messageId: string;
  role: "user" | "assistant";
  piEntryId?: string;
  // Absent on Gateway-minted chat entries (user echo, steer control): they
  // are created at command accept, before the Active Run exists. See the
  // design doc §10 open gap on user-message run attribution.
  runId?: string;
  turnId?: string;
  phase: "streaming" | "final";
  // Timestamp of the message(start) boundary — when the model call opened.
  // `updatedAt` closes the pair on a final message, the way a tool's
  // startedAt/updatedAt bracket its execution. Absent when the opening
  // boundary never arrived (a cut journal, a bridge that mints only the end),
  // so consumers can tell "not measured" from "measured as zero".
  startedAt?: string;
  abandoned?: boolean;
  // Set on mirrored control/error entries (Steer echo, run failures) so the
  // chat can render them as control bubbles.
  controlLabel?: string;
  parts: SessionRuntimeMessagePart[];
  updatedAt: string;
};

export type SessionRuntimeTool = {
  toolCallId: string;
  runId: string;
  turnId: string;
  // "announced": only seen as a message tool_call part; "running": execution
  // started; "done": execution ended.
  phase: "announced" | "running" | "done";
  name?: string;
  argsText?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  // Timestamp of the tool(start) event; absent while only announced.
  startedAt?: string;
  updatedAt: string;
};

export type SessionRuntimeStatus = {
  code: string;
  body?: string;
  runId?: string;
  at: string;
};

export type SessionRuntimeError = {
  code: string;
  body: string;
  fatal?: boolean;
  runId?: string;
  at: string;
};

export type SessionRuntimeOrderEntry = {
  kind: "message" | "tool" | "status" | "error";
  id: string;
  seq: number;
};

export type SessionRuntimeModel = {
  runs: ReadonlyMap<string, SessionRuntimeRun>;
  messages: ReadonlyMap<string, SessionRuntimeMessage>;
  tools: ReadonlyMap<string, SessionRuntimeTool>;
  statuses: readonly SessionRuntimeStatus[];
  errors: readonly SessionRuntimeError[];
  order: readonly SessionRuntimeOrderEntry[];
  lastSeq: number;
  updatedAt: string | null;
};

export type AgentRuntimeEventInput = {
  event: AgentRuntimeEvent;
  seq: number;
  timestamp: string;
};

export function createSessionRuntimeModel(): SessionRuntimeModel {
  return {
    runs: new Map(),
    messages: new Map(),
    tools: new Map(),
    statuses: [],
    errors: [],
    order: [],
    lastSeq: 0,
    updatedAt: null,
  };
}

function withOrderEntry(
  order: readonly SessionRuntimeOrderEntry[],
  entry: SessionRuntimeOrderEntry,
): readonly SessionRuntimeOrderEntry[] {
  return order.some((existing) => existing.kind === entry.kind && existing.id === entry.id)
    ? order
    : [...order, entry];
}

function legacyPartsFromEcho(
  messageId: string,
  body: string,
  images?: RuntimePromptImage[],
): SessionRuntimeMessagePart[] {
  const parts: SessionRuntimeMessagePart[] = [];

  if (body) {
    parts.push({
      partId: `${messageId}:legacy`,
      partType: "text",
      body,
      done: true,
    });
  }

  for (const [index, image] of (images ?? []).entries()) {
    parts.push({
      partId: `${messageId}:image-${index}`,
      partType: "image",
      body: promptImageDataUrl(image),
      done: true,
      ...(image.name ? { name: image.name } : {}),
    });
  }

  if (parts.length === 0) {
    parts.push({
      partId: `${messageId}:legacy`,
      partType: "text",
      body: "",
      done: true,
    });
  }

  return parts;
}

function upsertPart(
  parts: SessionRuntimeMessagePart[],
  event: Extract<AgentRuntimeEvent, { type: "message_part" }>,
  timestamp: string,
): SessionRuntimeMessagePart[] {
  const existingIndex = parts.findIndex((part) => part.partId === event.partId);
  const existing = existingIndex === -1 ? null : parts[existingIndex];
  const body =
    event.bodyMode === "delta" ? `${existing?.body ?? ""}${event.body}` : event.body;
  const startedAt = existing?.startedAt ?? (event.phase === "start" ? timestamp : undefined);
  // Only the opening boundary names a tool_call part; later deltas restate the
  // body alone, so the name has to be carried rather than re-read.
  const name = event.toolName ?? existing?.name;
  const next: SessionRuntimeMessagePart = {
    partId: event.partId,
    partType: event.partType,
    body,
    done: event.phase === "end",
    ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
    ...(name ? { name } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(event.phase === "end" ? { endedAt: timestamp } : {}),
  };

  if (existingIndex === -1) {
    return [...parts, next];
  }

  return parts.map((part, index) => (index === existingIndex ? next : part));
}

export function applyAgentRuntimeEvent(
  model: SessionRuntimeModel,
  input: AgentRuntimeEventInput,
): SessionRuntimeModel {
  // Gateway seq is strictly increasing per session; replays are dropped here
  // instead of via renderer-side seen-id bookkeeping.
  if (input.seq <= model.lastSeq) {
    return model;
  }

  const { event, seq, timestamp } = input;
  const base = { lastSeq: seq, updatedAt: timestamp };

  switch (event.type) {
    case "run": {
      const runs = new Map(model.runs);

      if (event.phase === "start") {
        runs.set(event.runId, {
          runId: event.runId,
          trigger: event.trigger,
          startedAt: timestamp,
        });
      } else {
        const existing = runs.get(event.runId);

        runs.set(event.runId, {
          runId: event.runId,
          trigger: existing?.trigger ?? event.trigger,
          startedAt: existing?.startedAt ?? timestamp,
          endedAt: timestamp,
          ...(event.outcome ? { outcome: event.outcome } : {}),
        });
      }

      return { ...model, ...base, runs };
    }

    case "message": {
      const messages = new Map(model.messages);
      const existing = messages.get(event.messageId);

      if (event.phase === "start") {
        // DF-008: a resumed run may reissue run-1:…:msg-1. Do not wipe a
        // finalized answer that already lives under that id.
        if (
          existing?.phase === "final" &&
          !existing.abandoned &&
          existing.parts.some((part) => part.body.trim().length > 0)
        ) {
          return { ...model, ...base };
        }

        messages.set(event.messageId, {
          messageId: event.messageId,
          role: event.role,
          runId: event.runId,
          turnId: event.turnId,
          phase: "streaming",
          // A boundary reissued on resume must not restate when the call
          // opened, so the first start wins — as it does for tools.
          startedAt: existing?.startedAt ?? timestamp,
          parts: existing?.parts ?? [],
          updatedAt: timestamp,
        });
      } else {
        if (
          existing?.phase === "final" &&
          !existing.abandoned &&
          existing.parts.some((part) => part.body.trim().length > 0) &&
          event.parts &&
          event.parts.length === 0
        ) {
          // Empty end after identity collision — keep the earlier answer.
          return { ...model, ...base };
        }

        messages.set(event.messageId, {
          messageId: event.messageId,
          role: event.role,
          runId: event.runId,
          turnId: event.turnId,
          phase: "final",
          // Carry the opening stamp across the close, or the pair the call's
          // duration is read from is gone the moment it completes.
          ...(existing?.startedAt ? { startedAt: existing.startedAt } : {}),
          ...(event.abandoned ? { abandoned: true } : {}),
          // The end snapshot is the authoritative content, but not an
          // authority on time: the part boundaries come from the streamed
          // part, and a part still open here is closed by this boundary.
          parts: event.parts
            ? event.parts.map((part) => {
                const streamed = existing?.parts.find(
                  (candidate) => candidate.partId === part.partId,
                );

                return {
                  partId: part.partId,
                  partType: part.partType,
                  body: part.body,
                  done: true,
                  ...(part.toolCallId ? { toolCallId: part.toolCallId } : {}),
                  ...(streamed?.name ? { name: streamed.name } : {}),
                  ...(streamed?.startedAt ? { startedAt: streamed.startedAt } : {}),
                  endedAt: streamed?.endedAt ?? timestamp,
                };
              })
            : (existing?.parts ?? []).map((part) => ({
                ...part,
                done: true,
                endedAt: part.endedAt ?? timestamp,
              })),
          updatedAt: timestamp,
        });
      }

      return {
        ...model,
        ...base,
        messages,
        order: withOrderEntry(model.order, { kind: "message", id: event.messageId, seq }),
      };
    }

    case "message_part": {
      const messages = new Map(model.messages);
      const existing = messages.get(event.messageId);
      const message: SessionRuntimeMessage = existing ?? {
        messageId: event.messageId,
        role: "assistant",
        runId: event.runId,
        turnId: event.turnId,
        phase: "streaming",
        parts: [],
        updatedAt: timestamp,
      };

      messages.set(event.messageId, {
        ...message,
        parts: upsertPart(message.parts, event, timestamp),
        updatedAt: timestamp,
      });

      const order = withOrderEntry(model.order, {
        kind: "message",
        id: event.messageId,
        seq,
      });
      const next = { ...model, ...base, messages, order };

      // A tool_call part announces the tool before execution starts.
      if (event.partType === "tool_call" && event.phase === "end" && event.toolCallId) {
        const tools = new Map(model.tools);
        const existingTool = tools.get(event.toolCallId);

        tools.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          runId: event.runId,
          turnId: event.turnId,
          phase: existingTool?.phase ?? "announced",
          ...(existingTool?.name ? { name: existingTool.name } : {}),
          argsText: event.body,
          ...(existingTool?.args !== undefined ? { args: existingTool.args } : {}),
          ...(existingTool?.result !== undefined ? { result: existingTool.result } : {}),
          ...(existingTool?.isError !== undefined ? { isError: existingTool.isError } : {}),
          updatedAt: timestamp,
        });

        return {
          ...next,
          tools,
          order: withOrderEntry(next.order, { kind: "tool", id: event.toolCallId, seq }),
        };
      }

      return next;
    }

    case "tool": {
      const tools = new Map(model.tools);
      const existing = tools.get(event.toolCallId);

      tools.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        runId: event.runId,
        turnId: event.turnId,
        phase: event.phase === "end" ? "done" : "running",
        name: event.name || existing?.name,
        ...(existing?.argsText ? { argsText: existing.argsText } : {}),
        // Validated args from tool execution overwrite message-stream args.
        args: event.args !== undefined ? event.args : existing?.args,
        result: event.result !== undefined ? event.result : existing?.result,
        ...(event.isError !== undefined
          ? { isError: event.isError }
          : existing?.isError !== undefined
            ? { isError: existing.isError }
            : {}),
        ...(existing?.startedAt
          ? { startedAt: existing.startedAt }
          : event.phase === "start"
            ? { startedAt: timestamp }
            : {}),
        updatedAt: timestamp,
      });

      return {
        ...model,
        ...base,
        tools,
        order: withOrderEntry(model.order, { kind: "tool", id: event.toolCallId, seq }),
      };
    }

    case "status": {
      const status: SessionRuntimeStatus = {
        code: event.code,
        ...(event.body ? { body: event.body } : {}),
        ...(event.runId ? { runId: event.runId } : {}),
        at: timestamp,
      };

      return {
        ...model,
        ...base,
        statuses: [...model.statuses, status],
        order: withOrderEntry(model.order, { kind: "status", id: `status-${seq}`, seq }),
      };
    }

    case "error": {
      const error: SessionRuntimeError = {
        code: event.code,
        body: event.body,
        ...(event.fatal === false ? { fatal: false } : {}),
        ...(event.runId ? { runId: event.runId } : {}),
        at: timestamp,
      };

      return {
        ...model,
        ...base,
        errors: [...model.errors, error],
        order: withOrderEntry(model.order, { kind: "error", id: `error-${seq}`, seq }),
      };
    }

    // turn boundaries are embedded in message/tool identity; queue and usage
    // are handled by the queued-message and summary projections.
    default:
      return { ...model, ...base };
  }
}

export type LegacyChatEventInput = {
  id: string;
  kind: "message" | "control" | "error";
  role?: "user" | "assistant";
  title?: string;
  body: string;
  images?: RuntimePromptImage[];
  messageId?: string;
  piEntryId?: string;
  timestamp: string;
};

// Mirrors a Gateway-minted legacy chat event (user echo, steer control echo,
// driver/renderer error) into the model so chat can render entirely from it.
// Mirrored entries slot between agent events with a fractional seq and never
// advance the agent seq watermark — advancing it would swallow the next
// Gateway event as a replay.
export function addLegacyChatEventToModel(
  model: SessionRuntimeModel,
  input: LegacyChatEventInput,
): SessionRuntimeModel {
  let messageId = input.messageId ?? input.id;
  const controlLabel =
    input.kind === "control" || input.kind === "error"
      ? (input.title ?? (input.kind === "error" ? "Error" : "Control"))
      : undefined;
  const existing = model.messages.get(messageId);

  // DF-008: resume used to reissue user:0 with a new piEntryId. Keep both
  // turns instead of overwriting the earlier body at the same order slot.
  if (
    existing &&
    (input.role === "user" || existing.role === "user") &&
    input.piEntryId &&
    existing.piEntryId !== input.piEntryId
  ) {
    messageId = `${messageId}#${input.piEntryId}`;
  }

  const messages = new Map(model.messages);
  const stored = model.messages.get(messageId);

  messages.set(messageId, {
    messageId,
    role: input.role ?? (input.kind === "error" ? "assistant" : "user"),
    ...(input.piEntryId ?? stored?.piEntryId
      ? { piEntryId: input.piEntryId ?? stored?.piEntryId }
      : {}),
    ...(stored?.runId ? { runId: stored.runId } : {}),
    ...(stored?.turnId ? { turnId: stored.turnId } : {}),
    phase: "final",
    ...(controlLabel ? { controlLabel } : {}),
    parts: legacyPartsFromEcho(messageId, input.body, input.images),
    updatedAt: input.timestamp,
  });

  return {
    ...model,
    messages,
    order: withOrderEntry(model.order, {
      kind: "message",
      id: messageId,
      seq: model.lastSeq + 0.5,
    }),
    updatedAt: input.timestamp,
  };
}

// Statuses are stored with a widened `code`, so this set is keyed by string.
const COMPACTION_STATUS_CODES = new Set<string>([
  "compacting",
  "compaction_done",
  "compaction_aborted",
] satisfies AgentStatusCode[]);

/**
 * Whether a compaction is still running. Derived from the status stream rather
 * than mirrored into its own field, so the two can never disagree.
 *
 * A compaction only happens inside an Active Run, so a run that has ended
 * closes it too. The Gateway already emits `compaction_aborted` when a run
 * stops mid-compaction; this covers the case it cannot — a journal cut off
 * before any closing event, replayed on resume.
 */
export function isContextCompacting(model: SessionRuntimeModel): boolean {
  if ([...model.runs.values()].every((run) => run.endedAt)) {
    return false;
  }

  for (let index = model.statuses.length - 1; index >= 0; index -= 1) {
    const code = model.statuses[index].code;

    if (COMPACTION_STATUS_CODES.has(code)) {
      return code === "compacting";
    }
  }

  return false;
}

export function sessionStatusFromRuntimeModel(
  model: SessionRuntimeModel,
): SessionStatus | null {
  if (model.runs.size === 0) {
    return null;
  }

  // Only the latest root run determines whether this Session is executing.
  // Interrupted or failed history must not keep a resumed run active/failed.
  const runs = [...model.runs.values()];
  const run = runs[runs.length - 1]!;

  if (run.outcome === "failed" || model.errors.some(error => error.fatal !== false &&
    (error.runId ? error.runId === run.runId : error.at >= run.startedAt))) {
    return "failed";
  }

  if (!run.endedAt) {
    return "running";
  }

  return "completed";
}
