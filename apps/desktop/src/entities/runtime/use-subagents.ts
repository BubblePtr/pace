import { useCallback, useEffect, useRef, useState } from "react";
import {
  isSubagentActive,
  type SubagentSnapshot,
  type SubagentsSnapshot,
} from "@pace/core";
import {
  subagentsClient,
  type ObservationState,
  type SubagentObservation,
} from "./subagents-client";

const emptyRecords: ObservationState<SubagentsSnapshot> = {
  data: null,
  loading: false,
  error: null,
};
const emptySession: ObservationState<SubagentSnapshot> = {
  data: null,
  loading: false,
  error: null,
};

export function useSubagents(
  piSessionId: string | null,
  runtimeGeneration = 0,
) {
  const [scopedState, setState] = useState({
    root: piSessionId,
    value: emptyRecords,
  });
  const state =
    scopedState.root === piSessionId ? scopedState.value : emptyRecords;
  const observation = useRef<SubagentObservation | null>(null);
  useEffect(() => {
    setState({ root: piSessionId, value: emptyRecords });
    if (!piSessionId) return;
    const current = subagentsClient.observeRecords(piSessionId, (value) =>
      setState({ root: piSessionId, value }),
    );
    observation.current = current;
    return () => {
      current.dispose();
      observation.current = null;
    };
  }, [piSessionId, runtimeGeneration]);
  const refresh = useCallback(() => observation.current?.refresh(), []);
  return {
    ...state,
    records: state.data?.records ?? [],
    activeCount: state.data?.records.filter(isSubagentActive).length ?? 0,
    refresh,
  };
}

export function useSubagentSnapshot(
  piSessionId: string | null,
  agentId: string | null,
  runtimeGeneration = 0,
) {
  const [scopedState, setState] = useState({
    root: piSessionId,
    agentId,
    value: emptySession,
  });
  const state =
    scopedState.root === piSessionId && scopedState.agentId === agentId
      ? scopedState.value
      : emptySession;
  const observation = useRef<SubagentObservation | null>(null);
  useEffect(() => {
    setState({ root: piSessionId, agentId, value: emptySession });
    if (!piSessionId || !agentId) return;
    const current = subagentsClient.observeSession(
      piSessionId,
      agentId,
      (value) => setState({ root: piSessionId, agentId, value }),
    );
    observation.current = current;
    return () => {
      current.dispose();
      observation.current = null;
    };
  }, [piSessionId, agentId, runtimeGeneration]);
  const refresh = useCallback(() => observation.current?.refresh(), []);
  return { ...state, refresh };
}
