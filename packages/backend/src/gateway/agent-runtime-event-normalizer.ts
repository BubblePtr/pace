// Semantic normalization layer: agent-core raw events in, AgentRuntimeEvent
// out. A pure synchronous state machine — the only place SDK/RPC event shapes
// are mapped to the product contract. Identity is derived by counting
// lifecycle events, never from timestamps or in-process randomness, so a
// replayed fixture always yields the same ids.
// See docs/adr/0020-agent-runtime-event-model.md.

import {
  AGENT_STATUS_SURFACES,
  surfaceForMessagePart,
  type AgentEventOrigin,
  type AgentMessagePartSnapshot,
  type AgentMessagePartType,
  type AgentRuntimeEvent,
  type AgentRunTrigger,
  type AgentStatusCode,
  type RuntimeContextUsage,
} from "@pace/core";

export type AgentRuntimeEventNormalizerInput = {
  piSessionId: string;
  origin?: AgentEventOrigin;
  // Root sessions already receive a Gateway user echo; observed children do not.
  includeUserMessages?: boolean;
  /**
   * High-water mark for Active Run identity on reattach/resume/fork.
   * The next `agent_start` becomes `run-{initialRunSeq + 1}`.
   * ADR-0020: counters must continue after reattach, never reset to 0.
   */
  initialRunSeq?: number;
  /**
   * Live context-window read, injected by the driver: Pi exposes occupancy as
   * a session method, not as an event payload. Called only at the boundaries
   * where context can have changed, so identity derivation stays pure.
   * Absent (RPC driver, fixture replay) means no context_usage events.
   */
  readContextUsage?: () => RuntimeContextUsage | undefined;
};

export type AgentRuntimeEventNormalizer = {
  normalize(rawEvent: unknown): AgentRuntimeEvent[];
  // Drivers call this when a command is accepted so the next agent_start can
  // attribute the Active Run to what actually triggered it.
  noteRunTrigger(trigger: Exclude<AgentRunTrigger, "unknown">): void;
};

type PartState = {
  partId: string;
  partType: AgentMessagePartType;
  body: string;
  toolCallId?: string;
  toolName?: string;
};

type MessageState = {
  messageId: string;
  role: "user" | "assistant";
  parts: Map<number, PartState>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The tool's name out of the partial assistant message the SDK sends with
 * every stream event: `partial.content[contentIndex]` is the ToolCall block,
 * named from the first boundary even though its arguments still stream.
 * A bridge that sends no usable partial yields nothing rather than a guess.
 */
function toolNameFromPartial(partial: unknown, contentIndex: number) {
  const content = isRecord(partial) && Array.isArray(partial.content) ? partial.content : null;
  const block = content?.[contentIndex];
  const toolName = isRecord(block) && typeof block.name === "string" ? block.name : "";

  return toolName ? { toolName } : {};
}

// Token/cost truth rides on the assistant message's usage block; it becomes a
// hidden usage event so projections can aggregate without parsing messages.
function usageSummaryFromMessage(message: Record<string, unknown>) {
  const usage = isRecord(message.usage) ? message.usage : null;

  if (!usage) {
    return null;
  }

  const cost = isRecord(usage.cost) ? usage.cost : null;
  const summary: {
    provider?: string;
    model?: string;
    totalTokens?: number;
    totalCostUsd?: number;
  } = {};

  if (typeof message.provider === "string") {
    summary.provider = message.provider;
  }

  if (typeof message.model === "string") {
    summary.model = message.model;
  }

  if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) {
    summary.totalTokens = usage.totalTokens;
  }

  if (typeof cost?.total === "number" && Number.isFinite(cost.total)) {
    summary.totalCostUsd = cost.total;
  }

  return Object.keys(summary).length ? summary : null;
}

export function createAgentRuntimeEventNormalizer(
  input: AgentRuntimeEventNormalizerInput,
): AgentRuntimeEventNormalizer {
  const origin = input.origin ?? "sdk";
  let runSeq =
    typeof input.initialRunSeq === "number" &&
    Number.isFinite(input.initialRunSeq) &&
    input.initialRunSeq > 0
      ? Math.floor(input.initialRunSeq)
      : 0;
  let turnSeq = 0;
  let messageSeq = 0;
  let runId: string | null = null;
  let turnId: string | null = null;
  let runTrigger: AgentRunTrigger = "unknown";
  let pendingTrigger: AgentRunTrigger | null = null;
  let message: MessageState | null = null;
  // Pi emits compaction_end only on the happy path; an aborted or failed run
  // just stops. Tracking the open compaction lets run closure end it too, so
  // no consumer is left holding a compaction that never finishes.
  let compacting = false;

  function partSnapshots(state: MessageState): AgentMessagePartSnapshot[] {
    return [...state.parts.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, part]) => ({
        partId: part.partId,
        partType: part.partType,
        body: part.body,
        ...(part.toolCallId ? { toolCallId: part.toolCallId } : {}),
      }));
  }

  function userParts(state: MessageState, content: unknown) {
    const blocks = typeof content === "string" ? [{ type: "text", text: content }]
      : Array.isArray(content) ? content : [];
    state.parts.clear();
    blocks.forEach((block, index) => {
      if (!isRecord(block)) return;
      const partId = `${state.messageId}:part-${index}`;
      if (block.type === "text" && typeof block.text === "string") {
        state.parts.set(index, { partId, partType: "text", body: block.text });
      } else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
        state.parts.set(index, { partId, partType: "image", body: `data:${block.mimeType};base64,${block.data}` });
      }
    });
  }

  function partEvent(
    part: PartState,
    phase: "start" | "update" | "end",
    bodyMode: "delta" | "snapshot",
    body: string,
  ): AgentRuntimeEvent {
    if (!runId || !turnId || !message) {
      throw new Error("Agent message part event arrived outside an active message.");
    }

    return {
      type: "message_part",
      runId,
      turnId,
      messageId: message.messageId,
      partId: part.partId,
      partType: part.partType,
      phase,
      bodyMode,
      body,
      ...(part.toolCallId ? { toolCallId: part.toolCallId } : {}),
      ...(part.toolName ? { toolName: part.toolName } : {}),
      surface: surfaceForMessagePart(part.partType),
      origin,
    };
  }

  const STREAM_PART_TYPES: Record<string, AgentMessagePartType> = {
    text: "text",
    thinking: "thinking",
    toolcall: "tool_call",
  };

  function streamPartEvents(assistantMessageEvent: Record<string, unknown>): AgentRuntimeEvent[] {
    if (!message || typeof assistantMessageEvent.contentIndex !== "number") {
      return [];
    }

    const eventType =
      typeof assistantMessageEvent.type === "string" ? assistantMessageEvent.type : "";
    const [prefix, lifecycle] = [
      eventType.slice(0, eventType.lastIndexOf("_")),
      eventType.slice(eventType.lastIndexOf("_") + 1),
    ];
    const partType = STREAM_PART_TYPES[prefix];

    if (!partType) {
      return [];
    }

    const contentIndex = assistantMessageEvent.contentIndex;
    const existing = message.parts.get(contentIndex);

    if (lifecycle === "start") {
      const part: PartState = {
        partId: `${message.messageId}:part-${contentIndex}`,
        partType,
        body: "",
        // The partial message already holds the parsed ToolCall block at this
        // boundary; the arguments are what still stream.
        ...(partType === "tool_call"
          ? toolNameFromPartial(assistantMessageEvent.partial, contentIndex)
          : {}),
      };

      message.parts.set(contentIndex, part);

      return [partEvent(part, "start", "snapshot", "")];
    }

    if (!existing) {
      return [];
    }

    if (lifecycle === "delta") {
      const delta = typeof assistantMessageEvent.delta === "string" ? assistantMessageEvent.delta : "";

      existing.body += delta;

      return [partEvent(existing, "update", "delta", delta)];
    }

    if (lifecycle === "end") {
      // toolcall_end carries the parsed ToolCall block instead of text content;
      // its native id becomes the join key with tool execution events.
      const toolCall = isRecord(assistantMessageEvent.toolCall)
        ? assistantMessageEvent.toolCall
        : null;

      if (partType === "tool_call" && toolCall) {
        existing.body = JSON.stringify(toolCall.arguments ?? {});
        existing.toolCallId = typeof toolCall.id === "string" ? toolCall.id : undefined;

        // Some bridges (openai-completions) stream the call id before the
        // function name, so the partial at toolcall_start was nameless and the
        // parsed block here is the first place the name exists.
        if (!existing.toolName && typeof toolCall.name === "string" && toolCall.name) {
          existing.toolName = toolCall.name;
        }

        return [partEvent(existing, "end", "snapshot", existing.body)];
      }

      const content =
        typeof assistantMessageEvent.content === "string"
          ? assistantMessageEvent.content
          : existing.body;

      existing.body = content;

      return [partEvent(existing, "end", "snapshot", content)];
    }

    return [];
  }

  function toolExecutionEvent(rawEvent: Record<string, unknown>): AgentRuntimeEvent[] {
    if (!runId || !turnId || typeof rawEvent.toolCallId !== "string") {
      return [];
    }

    const name = typeof rawEvent.toolName === "string" ? rawEvent.toolName : "";

    if (rawEvent.type === "tool_execution_start") {
      return [
        {
          type: "tool",
          runId,
          turnId,
          toolCallId: rawEvent.toolCallId,
          phase: "start",
          name,
          args: rawEvent.args,
          surface: "trace",
          origin,
        },
      ];
    }

    if (rawEvent.type === "tool_execution_update") {
      return [
        {
          type: "tool",
          runId,
          turnId,
          toolCallId: rawEvent.toolCallId,
          phase: "update",
          name,
          args: rawEvent.args,
          result: rawEvent.partialResult,
          surface: "trace",
          origin,
        },
      ];
    }

    return [
      {
        type: "tool",
        runId,
        turnId,
        toolCallId: rawEvent.toolCallId,
        phase: "end",
        name,
        result: rawEvent.result,
        isError: typeof rawEvent.isError === "boolean" ? rawEvent.isError : undefined,
        surface: "trace",
        origin,
      },
    ];
  }

  function statusEvent(code: AgentStatusCode, body: string | undefined): AgentRuntimeEvent {
    return {
      type: "status",
      ...(runId ? { runId } : {}),
      code,
      ...(body ? { body } : {}),
      surface: AGENT_STATUS_SURFACES[code],
      origin,
    };
  }

  function contextUsageEvents(): AgentRuntimeEvent[] {
    const usage = input.readContextUsage?.();

    if (!usage) {
      return [];
    }

    return [
      {
        type: "context_usage",
        ...(runId ? { runId } : {}),
        usage,
        surface: "hidden",
        origin,
      },
    ];
  }

  function closeOpenMessage(options: { abandoned?: boolean } = {}): AgentRuntimeEvent[] {
    if (!runId || !turnId || !message) {
      return [];
    }

    const openMessage = message;

    message = null;

    return [
      {
        type: "message",
        runId,
        turnId,
        messageId: openMessage.messageId,
        role: openMessage.role,
        phase: "end",
        ...(options.abandoned ? { abandoned: true } : {}),
        parts: partSnapshots(openMessage),
        surface: "chat",
        origin,
      },
    ];
  }

  return {
    noteRunTrigger(trigger) {
      pendingTrigger = trigger;
    },

    normalize(rawEvent) {
      if (!isRecord(rawEvent)) {
        return [];
      }

      if (rawEvent.type === "agent_start") {
        runSeq += 1;
        turnSeq = 0;
        runId = `${input.piSessionId}:run-${runSeq}`;
        runTrigger = pendingTrigger ?? "unknown";
        pendingTrigger = null;

        return [{ type: "run", runId, phase: "start", trigger: runTrigger, surface: "hidden", origin }];
      }

      if (rawEvent.type === "turn_start" && runId) {
        turnSeq += 1;
        messageSeq = 0;
        turnId = `${runId}:turn-${turnSeq}`;

        return [{ type: "turn", runId, turnId, phase: "start", surface: "hidden", origin }];
      }

      if (rawEvent.type === "message_start" && runId && turnId) {
        const rawMessage = isRecord(rawEvent.message) ? rawEvent.message : null;

        const role = rawMessage?.role;
        if (role !== "assistant" && !(input.includeUserMessages && role === "user")) {
          return [];
        }

        messageSeq += 1;
        message = {
          messageId: `${turnId}:msg-${messageSeq}`,
          role,
          parts: new Map(),
        };
        if (role === "user") userParts(message, rawMessage?.content);

        return [
          {
            type: "message",
            runId,
            turnId,
            messageId: message.messageId,
            role,
            phase: "start",
            ...(role === "user" ? { parts: partSnapshots(message) } : {}),
            surface: "chat",
            origin,
          },
        ];
      }

      if (rawEvent.type === "message_update" && message?.role === "assistant") {
        const assistantMessageEvent = isRecord(rawEvent.assistantMessageEvent)
          ? rawEvent.assistantMessageEvent
          : null;

        if (!assistantMessageEvent) {
          return [];
        }

        return streamPartEvents(assistantMessageEvent);
      }

      if (rawEvent.type === "message_end" && runId && turnId && message) {
        const endedMessage = message;
        const rawMessage = isRecord(rawEvent.message) ? rawEvent.message : null;
        if (rawMessage?.role !== endedMessage.role) return [];
        if (endedMessage.role === "user") userParts(endedMessage, rawMessage.content);
        const usageSummary = endedMessage.role === "assistant" ? usageSummaryFromMessage(rawMessage) : null;

        message = null;

        return [
          {
            type: "message",
            runId,
            turnId,
            messageId: endedMessage.messageId,
            role: endedMessage.role,
            phase: "end",
            parts: partSnapshots(endedMessage),
            surface: "chat",
            origin,
          },
          ...(usageSummary
            ? [
                {
                  type: "usage",
                  runId,
                  summary: usageSummary,
                  surface: "hidden",
                  origin,
                } satisfies AgentRuntimeEvent,
              ]
            : []),
        ];
      }

      if (
        rawEvent.type === "tool_execution_start" ||
        rawEvent.type === "tool_execution_update" ||
        rawEvent.type === "tool_execution_end"
      ) {
        return toolExecutionEvent(rawEvent);
      }

      if (rawEvent.type === "queue_update") {
        return [
          {
            type: "queue",
            steering: Array.isArray(rawEvent.steering)
              ? rawEvent.steering.filter((entry): entry is string => typeof entry === "string")
              : [],
            followUp: Array.isArray(rawEvent.followUp)
              ? rawEvent.followUp.filter((entry): entry is string => typeof entry === "string")
              : [],
            surface: "hidden",
            origin,
          },
        ];
      }

      if (rawEvent.type === "compaction_start") {
        compacting = true;

        return [
          statusEvent("compacting", typeof rawEvent.reason === "string" ? rawEvent.reason : undefined),
        ];
      }

      if (rawEvent.type === "compaction_end") {
        compacting = false;

        // Right after compaction the runtime reports an unknown token count;
        // reading here is what makes the drop visible instead of stale.
        return [statusEvent("compaction_done", undefined), ...contextUsageEvents()];
      }

      if (rawEvent.type === "auto_retry_start" && runId) {
        return [
          // Retry interrupts the in-flight message; close it with an explicit
          // abandoned boundary before reporting the retry status.
          ...closeOpenMessage({ abandoned: true }),
          statusEvent("retrying", typeof rawEvent.errorMessage === "string" ? rawEvent.errorMessage : undefined),
        ];
      }

      if (rawEvent.type === "auto_retry_end" && runId) {
        if (rawEvent.success === true) {
          return [statusEvent("retry_succeeded", undefined)];
        }

        return [
          statusEvent(
            "retry_failed",
            typeof rawEvent.finalError === "string" ? rawEvent.finalError : undefined,
          ),
        ];
      }

      if (rawEvent.type === "turn_end" && runId && turnId) {
        return [
          { type: "turn", runId, turnId, phase: "end", surface: "hidden", origin },
          ...contextUsageEvents(),
        ];
      }

      if (rawEvent.type === "agent_end" && runId) {
        const endedRunId = runId;
        // Outcome comes from the last assistant message's stopReason — the
        // only termination signal agent-core exposes on agent_end.
        const messages = Array.isArray(rawEvent.messages) ? rawEvent.messages : [];
        const lastAssistant = [...messages]
          .reverse()
          .find((entry): entry is Record<string, unknown> => isRecord(entry) && entry.role === "assistant");
        const stopReason = lastAssistant?.stopReason;
        const outcome =
          stopReason === "aborted" ? "aborted" : stopReason === "error" ? "failed" : "completed";
        const errorEvents: AgentRuntimeEvent[] =
          outcome === "failed"
            ? [
                {
                  type: "error",
                  runId: endedRunId,
                  code: "run_error",
                  body:
                    typeof lastAssistant?.errorMessage === "string"
                      ? lastAssistant.errorMessage
                      : "Active Run failed.",
                  surface: "chat",
                  origin,
                },
              ]
            : [];
        const closureEvents = closeOpenMessage();
        // A compaction still open here never got its own end event — the run
        // stopped first. Close it, or every consumer stays stuck compacting.
        const compactionClosure = compacting
          ? [statusEvent("compaction_aborted", undefined)]
          : [];

        compacting = false;
        runId = null;
        turnId = null;

        return [
          ...closureEvents,
          ...compactionClosure,
          ...errorEvents,
          {
            type: "run",
            runId: endedRunId,
            phase: "end",
            trigger: runTrigger,
            outcome,
            surface: "hidden",
            origin,
          },
        ];
      }

      return [];
    },
  };
}
