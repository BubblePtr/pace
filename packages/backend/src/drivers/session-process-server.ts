import type { PiRuntimeDriver } from "../gateway/runtime-gateway";
import type { SessionProcessMessage, SessionProcessRequest } from "./session-process-protocol";

/** The channel carries the existing driver commands, never plugin objects. */
export function serveSessionProcess(driver: PiRuntimeDriver) {
  let started = false;
  let closing = false;
  let shutdown: Promise<void> | undefined;
  const send = (message: SessionProcessMessage, complete?: () => void) => {
    if (!process.connected) { complete?.(); return; }
    process.send!(message, error => {
      if (error) void close();
      complete?.();
    });
  };
  const close = () => {
    closing = true;
    shutdown ??= driver.dispose?.() ?? Promise.resolve();
    return shutdown;
  };
  driver.onEvent(event => send({ type: "event", event }));
  process.on("message", async (request: SessionProcessRequest) => {
    const { id, method, args } = request;
    if (method === "dispose") {
      try {
        await close();
        send({ id, result: null }, () => process.exit(0));
      } catch (error) {
        send({ id, error: error instanceof Error ? error.message : String(error) }, () => process.exit(1));
      }
      return;
    }
    try {
      if (closing) throw new Error("Session is closing.");
      if (["createSession", "resumeSession", "forkSession"].includes(method)) {
        if (started) throw new Error("A Session process can own only one root.");
        started = true;
      }
      const handler = driver[method];
      if (!handler) throw new Error(`Unsupported Session command: ${method}`);
      const result: unknown = await Reflect.apply(handler, driver, args);
      send({ id, result });
    } catch (error) {
      send({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });
  // A crashed backend must not leave its Sessions running without an owner.
  process.once("disconnect", () => {
    const terminate = () => {
      if (process.platform !== "win32") process.kill(-process.pid, "SIGKILL");
      else process.exit(1);
    };
    const deadline = setTimeout(terminate, 25_000);
    void close().finally(() => { clearTimeout(deadline); terminate(); });
  });
}
