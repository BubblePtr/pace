import {
  isSubagentActive, shouldJournalRuntimeEvent,
  type RuntimeGatewayEventEnvelope, type RuntimeGatewayEventInput, type RuntimeToolSchemas,
  type SubagentRecord, type SubagentSnapshot, type SubagentsSnapshot,
} from "@pace/core";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createAgentRuntimeEventNormalizer } from "../gateway/agent-runtime-event-normalizer";
import type { SessionEventJournal } from "../persistence/session-event-journal";

// Version 1 is an in-process contract: session references never cross IPC.
export type SubagentHostRecord = Omit<SubagentRecord,
  "rootPiSessionId" | "piSessionId" | "capabilities" | "usage"> & {
  sessionId?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };
};
type ObservedSession = {
  sessionId: string;
  messages: readonly unknown[];
  subscribe(listener: (event: unknown) => void): () => void;
  getToolDefinition?(name: string): { description?: unknown; parameters?: unknown } | undefined;
};
export type SubagentHostEvent =
  | { type: "record" | "released"; record: SubagentHostRecord }
  | { type: "session"; record: SubagentHostRecord; session: ObservedSession };
export type SubagentHostProvider = {
  snapshot(): SubagentHostRecord[];
  subscribe(listener: (event: SubagentHostEvent) => void): () => void;
  stop(agentId?: string): Promise<void>;
  close(): Promise<void>;
  steer?(agentId: string, message: string): Promise<void>;
};
type RootIdentity = { sessionId: string; piSessionId: string };
type Root = RootIdentity & {
  provider: SubagentHostProvider;
  records: Map<string, SubagentRecord>;
  unsubscribe: () => void;
  closing?: Promise<void>;
};
type Child = {
  agentId: string;
  session: ObservedSession;
  events: RuntimeGatewayEventEnvelope[];
  schemas: RuntimeToolSchemas;
  unsubscribe: () => void;
};
type Ready = { version: 1; rootSessionId: string; provider: SubagentHostProvider };

function isReady(value: unknown): value is Ready {
  if (!value || typeof value !== "object") return false;
  const ready = value as Partial<Ready>;
  return ready.version === 1 && typeof ready.rootSessionId === "string"
    && typeof ready.provider?.snapshot === "function" && typeof ready.provider.subscribe === "function"
    && typeof ready.provider.stop === "function" && typeof ready.provider.close === "function";
}

async function bounded<T>(operation: Promise<T>, action: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${action} did not finish; some tools may still be running.`)), 15_000);
      timer.unref?.();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export function createSubagentObserver(options: {
  journal: SessionEventJournal;
  publish(event: RuntimeGatewayEventInput): RuntimeGatewayEventEnvelope | null;
  advanceSequence?(events: RuntimeGatewayEventEnvelope[]): void;
}) {
  const roots = new Map<string, Root>();
  const children = new Map<string, Child>();
  const pendingHistory = new Map<string, Promise<SubagentRecord[]>>();

  const readHistory = (piSessionId: string) => {
    let history = pendingHistory.get(piSessionId);
    if (!history) {
      history = options.journal.read(piSessionId).then(events => {
        options.advanceSequence?.(events);
        const records = new Map<string, SubagentRecord>();
        for (const event of events) {
          if (event.payload.type === "subagent_record" && event.payload.record) {
            const record = event.payload.record as SubagentRecord;
            if (record.rootPiSessionId === piSessionId) records.set(record.id, record);
          }
        }
        return [...records.values()];
      });
      pendingHistory.set(piSessionId, history);
    }
    return history;
  };

  function update(root: Root, record: SubagentHostRecord) {
    if (record.rootSessionId !== root.piSessionId) return;
    const { sessionId, rootSessionId: _root, usage, ...fields } = record;
    const next: SubagentRecord = {
      ...fields, rootSessionId: root.sessionId, rootPiSessionId: root.piSessionId,
      ...(sessionId ? { piSessionId: sessionId } : {}),
      ...(usage ? { usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite, costUsd: usage.cost.total } } : {}),
      capabilities: { stop: isSubagentActive(record), steer: record.status === "running" && !!root.provider.steer },
    };
    root.records.set(next.id, next);
    options.publish({ sessionId: root.sessionId, piSessionId: root.piSessionId,
      type: "subagent_record", payload: { type: "subagent_record", record: next, surface: "hidden" } });
    return next;
  }

  function observe(root: Root, event: SubagentHostEvent) {
    const record = update(root, event.record);
    if (event.type === "released" && record?.piSessionId) {
      const child = children.get(record.piSessionId);
      if (child?.agentId === record.id) {
        child.unsubscribe();
        children.delete(record.piSessionId);
      }
    }
    if (!record || event.type !== "session") return;
    const session = event.session;
    // Repeated allocation notifications within a run must not double-subscribe.
    const previous = children.get(session.sessionId);
    if (previous?.session === session) return;
    previous?.unsubscribe();
    const normalizer = createAgentRuntimeEventNormalizer({ piSessionId: session.sessionId, includeUserMessages: true,
      initialRunSeq: session.messages.filter(message => typeof message === "object" && message !== null && "role" in message && message.role === "user").length });
    const child: Child = { agentId: record.id, session, events: [], schemas: { schemas: {} }, unsubscribe: () => {} };
    children.set(session.sessionId, child);
    child.unsubscribe = session.subscribe(raw => {
      for (const payload of normalizer.normalize(raw)) {
        if (payload.type === "tool" && payload.phase === "start") {
          const definition = session.getToolDefinition?.(payload.name);
          if (definition && typeof definition.description === "string") {
            child.schemas.schemas[payload.name] = { description: definition.description, parameters: definition.parameters };
          }
        }
        const envelope = options.publish({ sessionId: `${root.sessionId}:child:${session.sessionId}`,
          piSessionId: session.sessionId, type: payload.type,
          payload: { ...payload, rootSessionId: root.sessionId, rootPiSessionId: root.piSessionId, subagentId: record.id,
            ...(payload.type === "tool" && payload.phase === "start" ? { toolSchema: child.schemas.schemas[payload.name] } : {}) } });
        if (envelope) child.events.push(envelope);
        if (payload.type === "run" && payload.phase === "end") {
          child.events = child.events.filter(event => shouldJournalRuntimeEvent(event.payload));
        }
      }
    });
  }

  const api = {
    async prepare(piSessionId: string) {
      for (const record of await readHistory(piSessionId)) {
        if (record.piSessionId) options.advanceSequence?.(await options.journal.read(record.piSessionId));
      }
    },
    attach(identity: RootIdentity, provider: SubagentHostProvider) {
      const previous = roots.get(identity.piSessionId);
      if (previous?.provider === provider) return;
      if (previous) throw new Error("A subagent provider is already active for this session.");
      const root: Root = { ...identity, provider, records: new Map(), unsubscribe: () => {} };
      roots.set(identity.piSessionId, root);
      root.unsubscribe = provider.subscribe(event => observe(root, event));
      for (const record of provider.snapshot()) update(root, record);
    },
    extension(sessionId: string): ExtensionFactory {
      return pi => {
        let rootPiSessionId: string | undefined;
        const pending = new Map<string, Ready>();
        const unsubscribe = pi.events.on("subagents:host:ready", data => {
          if (!isReady(data)) return;
          if (rootPiSessionId === data.rootSessionId) api.attach({ sessionId, piSessionId: rootPiSessionId }, data.provider);
          else if (!rootPiSessionId) pending.set(data.rootSessionId, data);
        });
        pi.on("session_start", (_, ctx) => {
          rootPiSessionId = ctx.sessionManager.getSessionId();
          const ready = pending.get(rootPiSessionId);
          pending.clear();
          if (ready) api.attach({ sessionId, piSessionId: rootPiSessionId }, ready.provider);
        });
        pi.on("session_shutdown", async () => {
          if (rootPiSessionId) await api.close(rootPiSessionId);
          unsubscribe();
        });
      };
    },
    async list(piSessionId: string): Promise<SubagentsSnapshot> {
      const root = roots.get(piSessionId);
      const records = new Map((await readHistory(piSessionId)).map(record => [record.id, {
        ...record, status: isSubagentActive(record) ? "interrupted" as const : record.status,
        capabilities: { stop: false, steer: false },
      }]));
      for (const record of root?.records.values() ?? []) records.set(record.id, record);
      return { available: !!root, records: [...records.values()].sort((a, b) => a.startedAt - b.startedAt) };
    },
    async getAgent(piSessionId: string, agentId: string): Promise<SubagentSnapshot> {
      const record = (await api.list(piSessionId)).records.find(item => item.id === agentId);
      if (!record) throw new Error("Subagent not found in this session.");
      const child = record.piSessionId ? children.get(record.piSessionId) : undefined;
      const events = new Map<string, RuntimeGatewayEventEnvelope>();
      if (record.piSessionId) for (const event of await options.journal.read(record.piSessionId)) events.set(event.id, event);
      for (const event of child?.events ?? []) events.set(event.id, event);
      const ordered = [...events.values()].sort((a, b) => a.seq - b.seq);
      const toolSchemas: RuntimeToolSchemas = { schemas: {} };
      for (const event of ordered) {
        if (event.payload.type === "tool" && typeof event.payload.name === "string" && event.payload.toolSchema) {
          toolSchemas.schemas[event.payload.name] = event.payload.toolSchema as RuntimeToolSchemas["schemas"][string];
        }
      }
      return { record, events: ordered, toolSchemas };
    },
    hasActive(piSessionId: string) {
      return [...(roots.get(piSessionId)?.records.values() ?? [])].some(isSubagentActive);
    },
    async stop(piSessionId: string, agentId?: string) {
      const root = roots.get(piSessionId);
      if (!root) { if (agentId) throw new Error("Subagent provider is unavailable."); return; }
      if (agentId && !root.records.has(agentId)) throw new Error("Subagent not found in this session.");
      await bounded(root.provider.stop(agentId), "Subagent cancellation");
    },
    async steer(piSessionId: string, agentId: string, message: string) {
      const root = roots.get(piSessionId);
      if (!root?.records.has(agentId)) throw new Error("Subagent not found in this session.");
      if (!root.provider.steer) throw new Error("Subagent steering is unavailable.");
      await root.provider.steer(agentId, message);
    },
    async close(piSessionId: string) {
      const root = roots.get(piSessionId);
      if (!root) return;
      root.closing ??= bounded(root.provider.close(), "Subagent shutdown").then(() => {
        root.unsubscribe();
        for (const record of root.records.values()) {
          if (record.piSessionId) { children.get(record.piSessionId)?.unsubscribe(); children.delete(record.piSessionId); }
        }
        roots.delete(piSessionId);
        pendingHistory.delete(piSessionId);
      }).catch(error => { root.closing = undefined; throw error; });
      await root.closing;
    },
    async dispose() { await Promise.all([...roots.keys()].map(id => api.close(id))); },
  };
  return api;
}

export type SubagentObserver = ReturnType<typeof createSubagentObserver>;
