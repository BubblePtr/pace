import { fork } from "node:child_process";
import type { RuntimeGatewaySnapshot } from "@pace/core";
import type {
  CreateRuntimeSessionInput, ForkRuntimeSessionInput, PiRuntimeDriver,
  ResumeRuntimeSessionInput, RuntimeGatewayDriverEvent,
} from "../gateway/runtime-gateway";
import type {
  SessionProcessArgs, SessionProcessMessage, SessionProcessMethod, SessionProcessResult,
} from "./session-process-protocol";

export type SessionProcessDriverOptions = {
  entryPath: string;
  agentDir: string;
  shutdownTimeoutMs?: number;
};

function startProcess(
  options: SessionProcessDriverOptions,
  cwd: string,
  onEvent: (event: RuntimeGatewayDriverEvent) => void,
  onExit: (error: Error) => void,
) {
  const child = fork(options.entryPath, [], {
    cwd,
    // Electron's bundled Node also works when no system Node is installed.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PI_CODING_AGENT_DIR: options.agentDir },
    execArgv: [],
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.pipe(process.stdout, { end: false });
  child.stderr?.pipe(process.stderr, { end: false });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let sequence = 0;
  let exited = false;
  let closing = false;
  let closure: Promise<void> | undefined;
  let resolveExit: () => void;
  const exit = new Promise<void>(resolve => { resolveExit = resolve; });

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const kill = () => {
    try {
      // Ordinary descendants share this group. Detached daemons remain the
      // extension's responsibility and must be released in session_shutdown.
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
      else if (!exited) child.kill("SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const finish = (error: Error) => {
    if (exited) return;
    exited = true;
    kill();
    rejectPending(error);
    resolveExit();
    if (!closing) onExit(error);
  };
  child.once("error", finish);
  child.once("exit", (code, signal) => finish(new Error(`Session process exited (${signal ?? code}).`)));
  child.on("message", (message: SessionProcessMessage) => {
    if ("type" in message) {
      onEvent(message.event);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  const call = <M extends SessionProcessMethod>(method: M, args: SessionProcessArgs<M>): Promise<SessionProcessResult<M>> => {
    if (exited || (closing && method !== "dispose")) return Promise.reject(new Error("Session process is closed."));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: value => resolve(value as SessionProcessResult<M>), reject });
      child.send({ id, method, args }, error => {
        if (!error) return;
        pending.delete(id);
        reject(error);
      });
    });
  };
  return {
    call,
    close() {
      if (closure) return closure;
      closing = true;
      rejectPending(new Error("Session process is closing."));
      closure = (async () => {
        if (exited) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            call("dispose", []).then(() => exit),
            new Promise<void>(resolve => {
              timer = setTimeout(() => {
                onExit(new Error("Session shutdown timed out; remaining work was forcibly terminated."));
                resolve();
              }, options.shutdownTimeoutMs ?? 25_000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
          kill();
          await exit;
        }
      })();
      return closure;
    },
  };
}

type SessionProcess = ReturnType<typeof startProcess>;
type Root = { process: SessionProcess; initialized: Promise<RuntimeGatewaySnapshot>; piSessionId?: string; snapshot?: RuntimeGatewaySnapshot };

/** Each root owns a process; extensions own any child AgentSessions inside it. */
export function createSessionProcessDriver(options: SessionProcessDriverOptions): PiRuntimeDriver {
  const roots = new Map<string, Root>();
  const piRoots = new Map<string, Root>();
  const failed = new Map<string, RuntimeGatewaySnapshot>();
  const listeners = new Set<(event: RuntimeGatewayDriverEvent) => void>();
  let closing = false;
  let closure: Promise<void> | undefined;
  const emit = (event: RuntimeGatewayDriverEvent) => { for (const listener of listeners) listener(event); };
  const forget = (root: Root, sessionId: string) => {
    if (roots.get(sessionId) === root) roots.delete(sessionId);
    if (root.piSessionId && piRoots.get(root.piSessionId) === root) piRoots.delete(root.piSessionId);
  };
  const launch = (input: CreateRuntimeSessionInput, initialize: (child: SessionProcess) => Promise<RuntimeGatewaySnapshot>) => {
    if (closing) throw new Error("Pi runtime driver is closing.");
    if (roots.has(input.sessionId)) throw new Error("Session already has a running process.");
    const child = startProcess(options, input.cwd, emit, error => {
      forget(root, input.sessionId);
      if (!root.snapshot) return;
      const snapshot = { ...root.snapshot, status: "failed" as const, updatedAt: new Date().toISOString() };
      failed.set(snapshot.piSessionId, snapshot);
      emit({ sessionId: input.sessionId, piSessionId: snapshot.piSessionId, type: "error",
        payload: { kind: "error", title: "Session process stopped", body: error.message } });
    });
    const expectedPiId = "piSessionId" in input && typeof input.piSessionId === "string" ? input.piSessionId : undefined;
    const root: Root = { process: child, piSessionId: expectedPiId, initialized: initialize(child).then(snapshot => {
      if (expectedPiId && snapshot.piSessionId !== expectedPiId) throw new Error("Pi session file does not match the requested Session.");
      root.piSessionId = snapshot.piSessionId;
      root.snapshot = snapshot;
      piRoots.set(snapshot.piSessionId, root);
      failed.delete(snapshot.piSessionId);
      return snapshot;
    }).catch(async error => {
      forget(root, input.sessionId);
      await child.close().catch(() => {});
      throw error;
    }) };
    roots.set(input.sessionId, root);
    if (expectedPiId) piRoots.set(expectedPiId, root);
    return root.initialized;
  };
  const processFor = (piSessionId: string) => {
    if (closing) throw new Error("Pi runtime driver is closing.");
    const root = piRoots.get(piSessionId);
    if (!root) throw new Error(`Pi Session "${piSessionId}" has no running process. Resume it before executing.`);
    return root.process;
  };
  return {
    hasSession: piSessionId => Boolean(piRoots.get(piSessionId)?.snapshot),
    createSession: async input => launch(input, child => child.call("createSession", [input])),
    async resumeSession(input: ResumeRuntimeSessionInput) {
      const root = piRoots.get(input.piSessionId) ?? roots.get(input.sessionId);
      if (root) {
        const snapshot = await root.initialized;
        if (snapshot.sessionId !== input.sessionId || snapshot.piSessionId !== input.piSessionId) {
          throw new Error("A live Pi session belongs to a different Pace session.");
        }
        return processFor(input.piSessionId).call("getSnapshot", [input.piSessionId]);
      }
      return launch(input, child => child.call("resumeSession", [input]));
    },
    async forkSession(input: ForkRuntimeSessionInput) {
      let selectedText: string | undefined;
      const snapshot = await launch(input, async child => {
        const result = await child.call("forkSession", [input]);
        selectedText = result.selectedText;
        return result.snapshot;
      });
      return { snapshot, ...(selectedText ? { selectedText } : {}) };
    },
    sendPrompt: async input => processFor(input.piSessionId).call("sendPrompt", [input]),
    queueFollowUp: async input => processFor(input.piSessionId).call("queueFollowUp", [input]),
    withdrawQueuedMessage: async input => processFor(input.piSessionId).call("withdrawQueuedMessage", [input]),
    steerRun: async input => processFor(input.piSessionId).call("steerRun", [input]),
    stopRun: async input => processFor(input.piSessionId).call("stopRun", [input]),
    configureModel: async input => processFor(input.piSessionId).call("configureModel", [input]),
    resolveToolSchemas: async input => piRoots.has(input.piSessionId)
      ? processFor(input.piSessionId).call("resolveToolSchemas", [input]) : Promise.resolve({ schemas: {} }),
    async getSnapshot(piSessionId) {
      const snapshot = failed.get(piSessionId);
      if (snapshot) return { ...snapshot };
      const root = piRoots.get(piSessionId);
      const next = await processFor(piSessionId).call("getSnapshot", [piSessionId]).catch(error => {
        const interrupted = failed.get(piSessionId);
        if (interrupted) return { ...interrupted };
        throw error;
      });
      if (root) root.snapshot = next;
      return next;
    },
    async disposeSession(piSessionId) {
      const root = piRoots.get(piSessionId);
      if (root) {
        try { await root.process.close(); }
        finally {
          for (const [sessionId, entry] of roots) if (entry === root) forget(root, sessionId);
        }
      }
      failed.delete(piSessionId);
    },
    dispose() {
      closing = true;
      closure ??= (async () => {
        try {
          const results = await Promise.allSettled([...roots.values()].map(root => root.process.close()));
          const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
          if (errors.length) throw new Error(errors.map(result => String(result.reason)).join("; "));
        }
        finally { roots.clear(); piRoots.clear(); failed.clear(); }
      })();
      return closure;
    },
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
