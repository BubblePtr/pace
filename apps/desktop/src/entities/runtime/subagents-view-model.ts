import type {
  SessionContentPart,
  SessionTurn,
  SubagentRecord,
} from "@pace/core";
import type {
  SessionRuntimeModel,
  SessionRuntimeTool,
} from "@/entities/session/session-runtime-model";
import { buildTrajectoryTurns } from "@/entities/session/trajectory-model";

function toolParts(tool: SessionRuntimeTool): SessionContentPart[] {
  const parts: SessionContentPart[] = [
    {
      partType: "toolCall",
      name: tool.name,
      payload: { id: tool.toolCallId, arguments: tool.args ?? tool.argsText },
    },
  ];
  if (tool.phase === "done") {
    const durationMs = tool.startedAt
      ? Date.parse(tool.updatedAt) - Date.parse(tool.startedAt)
      : undefined;
    parts.push({
      partType: "toolResult",
      name: tool.name,
      isError: tool.isError,
      durationMs:
        durationMs !== undefined && durationMs >= 0 ? durationMs : undefined,
      payload: { toolCallId: tool.toolCallId, result: tool.result },
      text:
        typeof tool.result === "string"
          ? tool.result
          : JSON.stringify(tool.result, null, 2),
    });
  }
  return parts;
}

/** Project the existing live read model into the shared Trajectory contract. */
export function subagentTrajectoryTurns(model: SessionRuntimeModel) {
  const turns: SessionTurn[] = [];
  const toolIdsByTurn: Array<Array<string | undefined>> = [];
  const renderedTools = new Set<string>();
  for (const item of model.order) {
    if (item.kind === "message") {
      const message = model.messages.get(item.id);
      if (!message) continue;
      const parts: SessionContentPart[] = [];
      const toolIds: Array<string | undefined> = [];
      for (const part of message.parts) {
        if (part.partType === "tool_call") toolIds.push(part.toolCallId);
        const tool = part.toolCallId
          ? model.tools.get(part.toolCallId)
          : undefined;
        if (part.partType === "tool_call" && tool) {
          parts.push(...toolParts(tool));
          renderedTools.add(tool.toolCallId);
        } else {
          parts.push({
            partType:
              part.partType === "tool_call" ? "toolCall" : part.partType,
            name: part.name,
            text: part.body,
            payload:
              part.partType === "tool_call"
                ? { id: part.toolCallId, arguments: part.body }
                : { url: part.partType === "image" ? part.body : undefined },
          });
        }
      }
      const duration =
        message.startedAt && message.phase === "final"
          ? Date.parse(message.updatedAt) - Date.parse(message.startedAt)
          : undefined;
      turns.push({
        kind: "message",
        role: message.role,
        timestamp: message.startedAt ?? message.updatedAt,
        modelDurationMs:
          duration !== undefined && duration >= 0 ? duration : undefined,
        parts,
      });
      toolIdsByTurn.push(toolIds);
    } else if (item.kind === "tool" && !renderedTools.has(item.id)) {
      const tool = model.tools.get(item.id);
      if (tool) {
        turns.push({
          kind: "message",
          role: "assistant",
          timestamp: tool.startedAt ?? tool.updatedAt,
          parts: toolParts(tool),
        });
        toolIdsByTurn.push([tool.toolCallId]);
        renderedTools.add(tool.toolCallId);
      }
    }
  }
  const trajectory = buildTrajectoryTurns(turns);
  for (const turn of trajectory) {
    let toolIndex = 0;
    for (const step of turn.steps) {
      if (step.kind !== "tool") continue;
      const toolId = toolIdsByTurn[turn.index][toolIndex++];
      const tool = toolId ? model.tools.get(toolId) : undefined;
      // Partial snapshots carry output without ending the shared Trace step.
      if (tool && tool.phase !== "done" && tool.result !== undefined) {
        step.output =
          typeof tool.result === "string"
            ? tool.result
            : JSON.stringify(tool.result, null, 2);
      }
    }
  }
  return trajectory;
}

export function subagentTree(
  records: SubagentRecord[],
): { record: SubagentRecord; depth: number }[] {
  const result: { record: SubagentRecord; depth: number }[] = [];
  const seen = new Set<string>();
  const byParent = new Map<string | undefined, SubagentRecord[]>();
  const ids = new Set(records.map((record) => record.id));
  for (const record of records) {
    const parent =
      record.parentAgentId && ids.has(record.parentAgentId)
        ? record.parentAgentId
        : undefined;
    byParent.set(parent, [...(byParent.get(parent) ?? []), record]);
  }
  const visit = (record: SubagentRecord, depth: number) => {
    if (seen.has(record.id)) return;
    seen.add(record.id);
    result.push({ record, depth });
    for (const child of byParent.get(record.id) ?? []) visit(child, depth + 1);
  };
  for (const record of byParent.get(undefined) ?? []) visit(record, 0);
  for (const record of records) visit(record, 0);
  return result;
}
