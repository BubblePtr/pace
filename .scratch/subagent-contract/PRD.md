# Subagent contract (generic model + shims)

Status: ready-for-agent
Feature: subagent-contract
Created: 2026-09-15

> Decision: option (d) from the 2026-09-15 assessment — one Pace-internal model matching pico-v3 §8.5 semantics; community extensions shim onto it; native pico maps on later. Pace observes (and later steers) subagents; it does not spawn them.
> Vocabulary: CONTEXT.md **Subagent**, **Session**, **Active Run**, **Tool Call**, **Tool Execution**, **Trajectory**. Architecture: README “Architecture” + ADR-0020 / ADR-0040.
> Current runtime stance: [docs/subagent-observation.md](../../docs/subagent-observation.md). ADR-0018 §91–93 still describes the removed Tintinweb host protocol — listed as a chore below.

## Problem

Pace hosts root Sessions. Community Pi extensions (tintinweb/pi-subagents, nicobailon/pi-subagents) create child conversations the parent never names in a shared vocabulary: different tool names, different events, different cost fields, plugin-private parent→child links. Pico-v3 §8.5 will eventually make a subagent a first-class child conversation, but that design is not shipping (docs on Pi `main`; implementation on the unmerged `pico` branch; `subagent` command tool still a work-plan item).

Two earlier attempts bent Pace around plugin internals (`subagents:host:ready` + Dock, #288 nicobailon detached runner). Both were reverted. ADR-0040 is the remaining truth: plugins own child Sessions; Pace sees the parent’s tool call/result, uses Pi’s aggregate usage, emits `session_shutdown` on delete/quit, and replays any child JSONL that lands in the scanned session dir as an ordinary Session. No tree, no per-child cost, no live child trace.

Users still cannot go from an `Agent` step on Trajectory to that child’s replay, even when the JSONL is already indexed.

## Non-goals

- Pace does not generate, schedule, or host subagents. No Pace-owned extension, no `createAgentSession` for children, no revival of `subagents:host:ready` / `get_subagents` / `stop_subagent` / Dock counts.
- Parent Session Stop stays Pi abort of the current Active Run. It is not “stop every child” (ADR-0040). Child stop is an optional capability on this contract, wired later.
- Nested / workflow children that the source does not emit (tintinweb: lifecycle events are top-level only).
- nicobailon detached background runner / host-runner contract (#288).
- Per-child live trace, tree view, cost rollup, or a Subagent Dock Surface.
- Changing CONTEXT.md **Subagent**: still plugin-owned, not a sidebar root Session, not an OS process.

## Contract

Types live in `packages/core` (same seam as `AgentRuntimeEvent`). Shims and the session-worker emit them; renderer and Trajectory only consume.

```ts
type SubagentSource = "tintinweb" | "nicobailon" | "pico";

type SubagentState = "created" | "started" | "completed" | "failed" | "stopped";

type SubagentUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};

/** Optional. Absent means “this source does not expose that control.” */
type SubagentCapabilities = {
  send?: boolean; // pico `send` / tintinweb steer / nicobailon steer
  stop?: boolean;
};

type SubagentRecord = {
  childSessionId: string;     // Pi session id = SessionSummary.id once known
  parentSessionId: string;    // Pi session id of the owning root (or immediate parent)
  ownerToolCallId: string;    // native toolCallId on the parent Tool Call
  state: SubagentState;
  source: SubagentSource;
  createdAt: string;          // ISO
  updatedAt: string;
  usage?: SubagentUsage;
  startedAt?: string;
  endedAt?: string;
  capabilities?: SubagentCapabilities;
  sourceAgentId?: string;     // plugin-private id (tintinweb AgentRecord.id, nicobailon runId)
  sessionFile?: string;       // child JSONL path; used to resolve childSessionId
};
```

`childSessionId` is the join key to Trajectory (`/sessions/$sessionId`). Until the child’s Pi session id is known, the shim may emit with `sourceAgentId` + `sessionFile` and leave `childSessionId` empty; consumers must treat a missing id as “no replay yet” (in-memory session, or file outside the scan dir — same limit as today).

### State machine

```text
created ──start──► started ──complete──► completed
              │            ├──fail─────► failed
              │            └──stop─────► stopped
              ├──fail──► failed
              └──stop──► stopped
```

Terminal: `completed` | `failed` | `stopped`. No reverse transitions. `steered` / compact / queue are not states (control or source-private).

| State | Means |
| --- | --- |
| `created` | Child conversation registered, not yet running (pico `spawn` return; tintinweb `queued` / `subagents:created`) |
| `started` | Child is executing (pico `run` / first generation; tintinweb `subagents:started`) |
| `completed` | Child finished successfully |
| `failed` | Child errored |
| `stopped` | Child aborted / stopped (distinct from failed) |

### Control surface

`send` and `stop` are **optional capabilities**, advertised on the record (and later on Runtime Gateway capability advertisement, same pattern as model/thinking/queue/steer — ADR-0024). Slice 1 does not add Gateway methods.

- `send(childSessionId, text)` — queue/deliver text to the child. Not parent `steer_run`.
- `stop(childSessionId)` — cancel that child. Not parent Stop.

A source that only observes sets neither flag. UI must hide controls the source did not advertise.

## Event pipeline

A subagent record is a first-class `AgentRuntimeEvent`, not a revival of the dropped `subagent_record` envelope (`runtime-gateway-client.ts` keeps dropping that old type).

```ts
// added to AgentRuntimeEvent in packages/core/src/agent-runtime-event.ts
| {
    type: "subagent";
    phase: "start" | "update" | "end";
    record: SubagentRecord;
    surface: "hidden";
    origin: AgentEventOrigin;
    runId?: string;
    turnId?: string;
  }
```

Flow (README prompt path, extra hop in bold):

1. Root Session process (`apps/desktop/electron/session-worker.ts` → `session-process-entry` → `pi-sdk-runtime-adapter`) already subscribes to the parent `AgentSession` and runs `agent-runtime-event-normalizer`.
2. **A `SubagentShim` in that same process** listens to `pi.events` (and/or parent `tool` events), correlates by tool-call / plugin id, and calls `onRecord`.
3. The adapter emits `RuntimeGatewayDriverEvent` `{ type: "subagent", payload: { type: "subagent", … } }` over the existing IPC (`session-process-server`).
4. Runtime Gateway (`packages/backend/src/gateway/runtime-gateway.ts`) sequences it like any other event. `shouldJournalRuntimeEvent` already journals everything except `message_part`/`tool` `update` — `subagent` boundaries persist to the Session Event Journal (`~/.pace` / `~/.pace-dev`).
5. Renderer routes `surface: "hidden"`: no Live Chat bubble, no Trajectory row. A small lookup keyed by `ownerToolCallId` is enough for the first UI.
6. Cold Trajectory continues to parse Pi JSONL via `packages/backend/src/workspace/sessions.ts`. Slice 1 also runs a **cold pass** of the same tintinweb mapper over parent turns + the session index, so CLI-recorded sessions get the deep-link without a Pace journal.

Do not subscribe to child `AgentSession` objects (ADR-0040: plugin objects do not cross the process boundary; Pace does not bind child sessions). Child replay is the already-scanned JSONL.

## Source adapters (shims)

```ts
type SubagentShimContext = {
  parentSessionId: string;
  onRecord: (record: SubagentRecord, phase: "start" | "update" | "end") => void;
};

type SubagentShim = {
  source: SubagentSource;
  /** Live: subscribe to pi.events / parent tool stream; return unsubscribe. */
  observe(ctx: SubagentShimContext): () => void;
  /** Cold: reconstruct records from a parsed parent SessionDetail + session index. */
  fromSession?(detail: SessionDetail, index: SessionSummary[]): SubagentRecord[];
};
```

Shims never spawn children. Unknown fields are ignored. A source that is not loaded is a no-op.

### tintinweb/pi-subagents (slice 1 — concrete)

Verified against [tintinweb/pi-subagents README](https://github.com/tintinweb/pi-subagents/blob/master/README.md) + `src/types.ts` (`AgentRecord`). Baseline already in-tree: 0.19.0 @ `e955e29` (`docs/subagent-observation.md`). In-process via `createAgentSession`. Nested/workflow children emit no lifecycle events — out of scope.

| Source | Maps to |
| --- | --- |
| `Agent` Tool Call (`toolCallId`, args `subagent_type` / `prompt` / `description` / `run_in_background`) | `ownerToolCallId`; start of correlation |
| `AgentRecord.id` / `subagents:created`·`id` / `subagents:started`·`id` / background `Agent` result id / `get_subagent_result.agent_id` | `sourceAgentId` |
| `AgentRecord.sessionFile` (`onSessionCreated` → `session.sessionManager.getSessionFile()`); session header `id` inside that JSONL | `sessionFile`, then `childSessionId` |
| Parent `ctx.sessionManager.getSessionId()` | `parentSessionId` |
| `AgentRecord.toolCallId` | `ownerToolCallId` (authoritative join to the parent `tool` event) |
| `subagents:created` (bg `Agent` spawn / detached resume only) | `state: "created"` |
| `subagents:started` (`id`, `type`, `description`) | `state: "started"` |
| `subagents:completed` (`usage` as Pi `Usage` incl. `cacheRead` + `cost.total`; `tokens` is display-only — prefer `usage`) | `state: "completed"`, `usage?` |
| `subagents:failed` (error / abort / stop; same payload shape, `status` / `error` set) | `status` in `{aborted, stopped}` → `"stopped"`, else `"failed"` |
| `steer_subagent` / `subagents:rpc:stop` | capabilities `{ send: true, stop: true }` advertised, **not invoked** in slice 1 |
| `subagents:steered` / `:compacted` / `:scheduled` / RPC spawn without `Agent` tool | ignore for v1 (no `ownerToolCallId`) |

`rememberAgents` / `persist_session` default true: first-level children write a Pi session and nest under the parent in `/resume`. Memory-only children never get a Trajectory link.

### nicobailon/pi-subagents (sketch, later slice)

Verified against [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) `docs/observability.md`, `docs/tool-reference.md`, `src/shared/types.ts` `SingleResult`. Single `subagent` tool with `action` (run / status / resume / stop / steer / …). Foreground in-process; background = detached Node runner (not this contract).

| Source | Maps to |
| --- | --- |
| Parent `subagent` Tool Call | `ownerToolCallId` |
| `SingleResult.sessionFile` → JSONL header `id`; `sessionName` is display-only | `sessionFile` / `childSessionId` |
| `SingleResult.usage` (`Usage`); `totalTokens` / `totalCost` on status snapshots | `usage` |
| `SingleResult.stopped` / `interrupted` / `timedOut` / `error` / `exitCode` | `stopped` / `failed` / `completed` |
| Status snapshot `state` + `startedAt` / `endedAt` | lifecycle timestamps |
| RPC `subagent:child-status` (`type: "subagent.child-status"`, `status: "stopping" \| "stopped"`) | observer hint toward `stopped` — snapshots remain authoritative; not replayed after host restart |
| `action: "steer"` / `"stop"` | capabilities `{ send: true, stop: true }` |

Do not parse `asyncDir/events.jsonl` or stand up a host runner.

### pico-v3 §8.5 native (sketch, when it ships)

Verified against Pi `packages/agent/docs/pico/pico-v3.md` on `main` (2026-09). Design, not product: Experimental, not exported from `@earendil-works/pi-agent`, not wired into the CLI. A subagent **is** a conversation; one tool `subagent`; no separate registry (`runtime.conversation(id)`).

```ts
type SubagentCommand =
  | { command: "run";   prompt: string; context?: "fresh" | "inherit"; tools?: string[] } // fg
  | { command: "spawn"; prompt: string; context?: "fresh" | "inherit"; tools?: string[] } // bg
  | { command: "send";  id: Id; text: string }
  | { command: "status"; id: Id }
  | { command: "wait";  id: Id }
  | { command: "stop";  id: Id };
```

| Command | Maps to |
| --- | --- |
| `run` | `created` + `started`; parent tool waits on `child.drive`; settle → `completed` / `failed` |
| `spawn` | `created` (+ `started` as the child runs); parent tool settles immediately with child `id` |
| `id` returned by `spawn` / conversation id | `childSessionId` |
| launching tool call | `ownerToolCallId` |
| `send` / `stop` | capabilities (this is the native control surface) |
| `status` / `wait` | observation only; `wait` does not change the child’s state |

When pico is the runtime, this source replaces the community shims for that Session. Shims stay for users still on extension-based subagents.

## UI consumers

**Slice 1 (Trajectory only).** `apps/desktop/src/pages/session-detail.tsx` + `PiTrajectoryInspector`: selecting a step whose tool name is `Agent` (tintinweb) and that has a `SubagentRecord` with a `childSessionId` present in `list_sessions` shows an “Open child session” action → `/sessions/$childSessionId`. Missing JSONL: disabled, not an error. No new Dock Surface. No change to Live Chat.

**Deferred:** tree of records, per-child cost in the ledger, live child trace (subscribing to the child session), stop/steer chrome, nicobailon `subagent` tool name, workflow children.

## Slices

Each slice is one PR. Issues to be filed after this PRD lands (`docs/agents/issue-tracker.md`).

| # | PR | Contents |
| --- | --- | --- |
| 0 | chore | ADR-0018 §91–93: delete the stale `subagents:host:ready` / `get_subagents` / `subagent_record` Dock text (already superseded by ADR-0040 on 2026-09-14). Point at this PRD + `docs/subagent-observation.md`. |
| 1 | feat | **Tintinweb `SubagentLink` normalizer + Trajectory deep-link.** Core types + `type: "subagent"` event; tintinweb shim (`observe` in the session-worker + `fromSession` cold pass); Inspector “Open child session”. Fixture tests from recorded `subagents:*` + `Agent` tool streams. Keep dropping legacy `subagent_record`. |
| 2 | feat | nicobailon foreground shim (`SingleResult` + optional `subagent:child-status`). Same Inspector affordance for the `subagent` tool. No detached runner. |
| 3 | feat | Control surface: Gateway methods `send_subagent` / `stop_subagent` gated on `capabilities`, routed to the active shim. Tintinweb: `steer_subagent` / `subagents:rpc:stop`. Parent Stop unchanged. |
| 4 | feat | pico-v3 source, when the `subagent` command tool exists in a released Pi. Retire shims only for Sessions whose runtime is pico. |

## Open questions

1. **Cold join without `sessionFile`.** If a CLI parent JSONL’s `Agent` result has only the plugin id, and the child session’s header does not name that id, can we join without using Pi `parentSession` (forks also set that — rejected in the 2026-09-13 plan)? Slice 1 should prefer `ownerToolCallId` + `sessionFile`; anything else needs evidence from real sessions.
2. **Empty `childSessionId` on the wire.** Allow it (partial record) or withhold the event until the session file exists? Partial records unblock “running” UI later; slice 1 can wait for an id before showing the link.
3. **Immediate vs root parent.** Nested tintinweb children are silent. When pico allows a tree, is `parentSessionId` the immediate parent or always the root Session Pace owns?
4. **Usage double-count.** Parent totals already include plugin-reported tool usage when `reportUsage` is on (tintinweb). Per-child `usage` on the record is observational; do not subtract it from the parent (ADR-0040). Confirm before any cost UI.
5. **Capability advertisement.** Per-record flags vs a session-level Gateway capability like today’s model controls? Per-record is more honest (RPC-spawned tintinweb agents have no `Agent` tool row).
6. **pico timing.** Treat §8.5 as months-scale and unstable; do not block slices 1–3 on it.
