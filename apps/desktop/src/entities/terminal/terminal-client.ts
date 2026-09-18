import type { BackendRpcEvent } from "@pace/backend";
import {
  invoke as invokeRuntime,
  onBackendEvent as onRuntimeBackendEvent,
} from "@/shared/runtime";

/**
 * Renderer client for the backend terminal service. Each terminal is a PTY
 * rooted in a Session's checkout; the backend owns the process and buffers
 * output, the renderer attaches, replays scrollback, and streams input.
 * Invoke and event-subscription injection points so tests never touch the
 * Electron bridge.
 */
export type TerminalInstanceInfo = {
  terminalId: string;
  sessionId: string;
  cwd: string;
  status: "running" | "exited";
  exitCode?: number;
};

type InvokeCommand = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

type SubscribeBackendEvent = (listener: (event: BackendRpcEvent) => void) => () => void;

export type TerminalClientOptions = {
  invoke?: InvokeCommand;
  onBackendEvent?: SubscribeBackendEvent;
};

function resolveInvoke(options: TerminalClientOptions) {
  return options.invoke ?? invokeRuntime;
}

export function listTerminals(sessionId: string, options: TerminalClientOptions = {}) {
  return resolveInvoke(options)<TerminalInstanceInfo[]>("list_terminals", { sessionId });
}

/** Always creates a new instance; the backend never reuses a live one. */
export function openTerminal(
  input: { sessionId: string; cols: number; rows: number },
  options: TerminalClientOptions = {},
) {
  return resolveInvoke(options)<TerminalInstanceInfo>("open_terminal", {
    sessionId: input.sessionId,
    cols: input.cols,
    rows: input.rows,
  });
}

/** Replays buffered output; `end` is the cumulative stream offset at attach
 *  time, so live events buffered during the round-trip can be de-duplicated. */
export function attachTerminal(terminalId: string, options: TerminalClientOptions = {}) {
  return resolveInvoke(options)<{ scrollback: string; end: number }>("attach_terminal", {
    terminalId,
  });
}

export function sendTerminalInput(
  terminalId: string,
  data: string,
  options: TerminalClientOptions = {},
) {
  return resolveInvoke(options)<null>("terminal_input", { terminalId, data });
}

export function resizeTerminal(
  terminalId: string,
  cols: number,
  rows: number,
  options: TerminalClientOptions = {},
) {
  return resolveInvoke(options)<null>("resize_terminal", { terminalId, cols, rows });
}

export function closeTerminal(terminalId: string, options: TerminalClientOptions = {}) {
  return resolveInvoke(options)<null>("close_terminal", { terminalId });
}

/**
 * Subscribes to backend terminal events and routes them by the payload's
 * terminalId. Non-terminal events, and terminal events without a usable
 * payload, are dropped. Returns the unsubscribe function; outside Electron
 * the runtime's no-op subscription means nothing ever fires.
 */
export function subscribeTerminalEvents(
  handlers: {
    /** `end` is the cumulative stream offset after this chunk. */
    onOutput?: (terminalId: string, data: string, end?: number) => void;
    onExit?: (terminalId: string, exitCode: number) => void;
  },
  options: TerminalClientOptions = {},
): () => void {
  const onBackendEvent = options.onBackendEvent ?? onRuntimeBackendEvent;

  return onBackendEvent((event) => {
    if (event.type !== "event") {
      return;
    }

    const { type, payload } = event.event;
    const terminalId = typeof payload.terminalId === "string" ? payload.terminalId : null;

    if (!terminalId) {
      return;
    }

    if (type === "terminal_output" && typeof payload.data === "string") {
      handlers.onOutput?.(
        terminalId,
        payload.data,
        typeof payload.end === "number" ? payload.end : undefined,
      );
    } else if (type === "terminal_exit" && typeof payload.exitCode === "number") {
      handlers.onExit?.(terminalId, payload.exitCode);
    }
  });
}
