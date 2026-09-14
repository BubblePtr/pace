import { writeFileSync } from "node:fs";
import { join } from "node:path";

let snapshot;
let starts = 0;
let hangShutdown = false;
let holdSnapshot = false;
process.on("message", async ({ id, method, args }) => {
  if (method === "dispose") {
    if (hangShutdown) return;
    writeFileSync(join(process.cwd(), `closed-${process.pid}`), "closed");
    process.send({ id, result: null }, () => process.exit(0));
    return;
  }
  if (method === "createSession" || method === "resumeSession" || method === "forkSession") {
    const input = args[0];
    starts++;
    snapshot = {
      ...input, piSessionId: input.piSessionId ?? `pi-${input.sessionId}`,
      runtimeId: String(process.pid), cwd: process.cwd(), status: "idle",
      sessionName: String(starts), events: [], updatedAt: new Date().toISOString(),
    };
    process.send({ id, result: method === "forkSession" ? { snapshot } : snapshot });
    return;
  }
  if (method === "sendPrompt") {
    if (args[0].prompt === "crash") process.exit(7);
    if (args[0].prompt === "hold") return;
    if (args[0].prompt === "hang-shutdown") hangShutdown = true;
    if (args[0].prompt === "hold-snapshot") holdSnapshot = true;
    process.send({ type: "event", event: { piSessionId: snapshot.piSessionId,
      type: "message_update", payload: { kind: "message", body: args[0].prompt } } });
    process.send({ id, result: { piSessionId: snapshot.piSessionId,
      type: "status", payload: { kind: "status", title: "Accepted" } } });
    return;
  }
  if (method === "getSnapshot" && !holdSnapshot) process.send({ id, result: snapshot });
});
