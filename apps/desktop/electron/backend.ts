import type { MessagePortMain } from "electron";
import { homedir } from "node:os";
import { createBackendService, migrateDataDir } from "@pace/backend";

const { parentPort } = process;
const service = createBackendService({
  dataDir: migrateDataDir(process.env, homedir()),
});

parentPort.on("message", async (event) => {
  if (event.data?.type === "shutdown") {
    try {
      await service.dispose();
      parentPort.postMessage({ type: "shutdown_complete" });
    } catch (error) {
      parentPort.postMessage({ type: "shutdown_complete", error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (event.data?.type === "connect") {
    const [port] = event.ports;
    if (port) {
      connect(port);
    }
  }
});

function connect(port: MessagePortMain) {
  const unsubscribe = service.onEvent((event) => {
    port.postMessage(event);
  });
  port.on("message", async ({ data }) => {
    port.postMessage(await service.handleRequest(data));
  });
  port.on("close", unsubscribe);
  port.start();
}
