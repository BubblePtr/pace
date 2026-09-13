import type { RuntimeGatewayEventEnvelope, RuntimeToolSchemas } from "./runtime-gateway";

export type SubagentStatus =
  | "queued" | "running" | "stopping" | "completed" | "steered"
  | "aborted" | "stopped" | "error" | "interrupted";

export type SubagentUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
};

export type SubagentRecord = {
  id: string;
  rootSessionId: string;
  rootPiSessionId: string;
  parentAgentId?: string;
  workflowId?: string;
  piSessionId?: string;
  toolCallId?: string;
  type: string;
  description: string;
  status: SubagentStatus;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  sessionFile?: string;
  cwd?: string;
  toolUses: number;
  currentTool?: string;
  usage?: SubagentUsage;
  capabilities: { stop: boolean; steer: boolean };
};

export type SubagentsSnapshot = {
  available: boolean;
  records: SubagentRecord[];
};

export type SubagentSnapshot = {
  record: SubagentRecord;
  events: RuntimeGatewayEventEnvelope[];
  toolSchemas: RuntimeToolSchemas;
};

export function isSubagentActive(record: Pick<SubagentRecord, "status">): boolean {
  return record.status === "queued" || record.status === "running" || record.status === "stopping";
}
