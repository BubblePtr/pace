import type { PiRuntimeBridge } from "@/entities/runtime/pi-runtime-bridge";
import { createRuntimeGatewayClient } from "@/entities/runtime/runtime-gateway-client";
import { createInMemoryPiRuntimeBridge } from "@/entities/runtime/in-memory-pi-runtime-bridge";
import { isElectronRuntime } from "@/shared/runtime";

export type DefaultPiRuntimeBridgeOptions = {
  now?: () => string;
};

export function createDefaultPiRuntimeBridge(
  options: DefaultPiRuntimeBridgeOptions = {},
): PiRuntimeBridge {
  if (!isElectronRuntime()) {
    return createInMemoryPiRuntimeBridge({
      now: options.now,
    });
  }

  return createRuntimeGatewayClient({
    now: options.now,
  });
}
