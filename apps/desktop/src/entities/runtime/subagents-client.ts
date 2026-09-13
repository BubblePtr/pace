import type {
  RuntimeGatewayEventEnvelope,
  RuntimeToolSchema,
  SubagentRecord,
  SubagentSnapshot,
  SubagentsSnapshot,
} from "@pace/core";
import { invoke, onBackendEvent } from "@/shared/runtime";
import type { RuntimeGatewayClientOptions } from "./runtime-gateway-client";

export type ObservationState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
};
export type SubagentObservation = { refresh: () => void; dispose: () => void };

function mergeEvents(
  snapshot: RuntimeGatewayEventEnvelope[],
  live: RuntimeGatewayEventEnvelope[],
) {
  const byId = new Map(snapshot.map((event) => [event.id, event]));
  for (const event of live) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

export function createSubagentsClient(
  options: RuntimeGatewayClientOptions = {},
) {
  const request = options.invoke ?? invoke;
  const subscribe = options.onBackendEvent ?? onBackendEvent;

  function observe<T>(
    command: string,
    args: Record<string, unknown>,
    reduce: (data: T | null, event: RuntimeGatewayEventEnvelope) => T | null,
    changed: (state: ObservationState<T>) => void,
    accepts: (event: RuntimeGatewayEventEnvelope) => boolean,
  ): SubagentObservation {
    let disposed = false;
    let generation = 0;
    let pending = false;
    let live: RuntimeGatewayEventEnvelope[] = [];
    const lastSequence = new Map<string, number>();
    let state: ObservationState<T> = { data: null, loading: true, error: null };
    const publish = () => {
      if (!disposed) changed(state);
    };
    const unsubscribe = subscribe((event) => {
      if (disposed || event.type !== "event" || !accepts(event.event)) return;
      if (event.event.seq <= (lastSequence.get(event.event.piSessionId) ?? -1))
        return;
      lastSequence.set(event.event.piSessionId, event.event.seq);
      const data = reduce(state.data, event.event);
      if (pending) live.push(event.event);
      if (data !== state.data) {
        state = { ...state, data };
        publish();
      }
    });
    const refresh = () => {
      if (disposed) return;
      const current = ++generation;
      pending = true;
      live = [];
      state = { ...state, loading: true, error: null };
      publish();
      void request<T>(command, args).then(
        (snapshot) => {
          if (disposed || current !== generation) return;
          let data: T | null = snapshot;
          for (const event of live) data = reduce(data, event);
          pending = false;
          live = [];
          state = { data, loading: false, error: null };
          publish();
        },
        (error: unknown) => {
          if (disposed || current !== generation) return;
          pending = false;
          live = [];
          state = {
            ...state,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          };
          publish();
        },
      );
    };
    refresh();
    return {
      refresh,
      dispose: () => {
        disposed = true;
        unsubscribe();
      },
    };
  }

  return {
    observeRecords(
      piSessionId: string,
      changed: (state: ObservationState<SubagentsSnapshot>) => void,
    ) {
      return observe<SubagentsSnapshot>(
        "get_subagents",
        { piSessionId },
        (data, event) => {
          if (
            event.piSessionId !== piSessionId ||
            event.type !== "subagent_record"
          )
            return data;
          const record = event.payload.record as SubagentRecord;
          const records = data?.records ?? [];
          return {
            available: true,
            records: records.some((item) => item.id === record.id)
              ? records.map((item) => (item.id === record.id ? record : item))
              : [...records, record],
          };
        },
        changed,
        (event) =>
          event.piSessionId === piSessionId && event.type === "subagent_record",
      );
    },
    observeSession(
      piSessionId: string,
      agentId: string,
      changed: (state: ObservationState<SubagentSnapshot>) => void,
    ) {
      return observe<SubagentSnapshot>(
        "get_subagent_snapshot",
        { piSessionId, agentId },
        (data, event) => {
          if (!data) return data;
          if (
            event.piSessionId === piSessionId &&
            event.type === "subagent_record"
          ) {
            const record = event.payload.record as SubagentRecord;
            return record.id === agentId ? { ...data, record } : data;
          }
          if (
            event.payload.rootPiSessionId !== piSessionId ||
            event.payload.subagentId !== agentId
          )
            return data;
          if (
            data.events.some(
              (item) => item.id === event.id || item.seq === event.seq,
            )
          )
            return data;
          const schema = event.payload.toolSchema as
            RuntimeToolSchema | undefined;
          const name = event.payload.name;
          return {
            ...data,
            events: mergeEvents(data.events, [event]),
            toolSchemas:
              event.payload.type === "tool" &&
              schema &&
              typeof name === "string"
                ? { schemas: { ...data.toolSchemas.schemas, [name]: schema } }
                : data.toolSchemas,
          };
        },
        changed,
        (event) =>
          (event.piSessionId === piSessionId &&
            event.type === "subagent_record" &&
            (event.payload.record as SubagentRecord).id === agentId) ||
          (event.payload.rootPiSessionId === piSessionId &&
            event.payload.subagentId === agentId),
      );
    },
    stop(piSessionId: string, agentId: string) {
      return request<void>("stop_subagent", { piSessionId, agentId });
    },
    steer(piSessionId: string, agentId: string, message: string) {
      return request<void>("steer_subagent", { piSessionId, agentId, message });
    },
  };
}

export const subagentsClient = createSubagentsClient();
