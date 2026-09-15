import type {
  SessionDetail,
  SessionSummary,
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
};

export type SubagentShim = {
  source: SubagentSource;
  observe(ctx: SubagentShimContext): () => void;
  fromSession?(detail: SessionDetail, index: SessionSummary[]): SubagentRecord[];
};
