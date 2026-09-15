import type {
  SessionDetail,
  SessionSummary,
  SubagentControlId,
  SubagentEventPhase,
  SubagentRecord,
  SubagentSource,
} from "@pace/core";

export type SubagentShimContext = {
  parentSessionId: string;
  onRecord: (record: SubagentRecord, phase: SubagentEventPhase) => void;
};

export type PiEventBus = {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit?(channel: string, data: unknown): void;
};

export type SubagentSendInput = SubagentControlId & { text: string };

export type SubagentStopInput = SubagentControlId;

export type SubagentShim = {
  source: SubagentSource;
  observe(ctx: SubagentShimContext): () => void;
  fromSession?(detail: SessionDetail, index: SessionSummary[]): SubagentRecord[];
  send?(input: SubagentSendInput): Promise<void>;
  stop?(input: SubagentStopInput): Promise<void>;
};
