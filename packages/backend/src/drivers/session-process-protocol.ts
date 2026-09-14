import type { PiRuntimeDriver, RuntimeGatewayDriverEvent } from "../gateway/runtime-gateway";

export type SessionProcessMethod = Exclude<keyof PiRuntimeDriver, "onEvent">;
export type SessionProcessArgs<M extends SessionProcessMethod> = Parameters<NonNullable<PiRuntimeDriver[M]>>;
export type SessionProcessResult<M extends SessionProcessMethod> = Awaited<ReturnType<NonNullable<PiRuntimeDriver[M]>>>;
export type SessionProcessRequest = {
  [M in SessionProcessMethod]: { id: number; method: M; args: SessionProcessArgs<M> }
}[SessionProcessMethod];

export type SessionProcessMessage =
  | { id: number; result?: unknown; error?: string }
  | { type: "event"; event: RuntimeGatewayDriverEvent };
