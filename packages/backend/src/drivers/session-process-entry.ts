import * as piSdk from "@earendil-works/pi-coding-agent";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { createPiSdkDriver } from "./pi-sdk-driver";
import {
  createPublicPiSdkRuntimeFactory,
  createPublicPiSdkRuntimeForker,
  createPublicPiSdkRuntimeResumer,
} from "./pi-sdk-runtime-adapter";
import { serveSessionProcess } from "./session-process-server";
import { resolveAgentDir } from "../workspace/sessions";

registerBunOAuthFlows();
const agentDir = resolveAgentDir();
const options = {
  sdk: piSdk,
  async sessionOptionsFor(input: { cwd: string }) {
    // Resume/fork use the cwd stored by Pi. This process owns only that root,
    // so changing cwd before loading extensions cannot affect other Sessions.
    process.chdir(input.cwd);
    const settingsManager = piSdk.SettingsManager.create(input.cwd, agentDir);
    const resourceLoader = new piSdk.DefaultResourceLoader({ cwd: input.cwd, agentDir, settingsManager });
    await resourceLoader.reload();
    return { agentDir, settingsManager, resourceLoader };
  },
};
serveSessionProcess(createPiSdkDriver({
  runtimeFactory: createPublicPiSdkRuntimeFactory(options),
  runtimeResumer: createPublicPiSdkRuntimeResumer(options),
  runtimeForker: createPublicPiSdkRuntimeForker(options),
}));
