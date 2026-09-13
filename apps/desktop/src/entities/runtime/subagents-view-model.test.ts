import { describe, expect, it } from "vitest";
import {
  applyAgentRuntimeEvent,
  createSessionRuntimeModel,
} from "@/entities/session/session-runtime-model";
import { subagentTrajectoryTurns } from "./subagents-view-model";
import type { AgentRuntimeEvent } from "@pace/core";

describe("subagent trajectory projection", () => {
  it("replaces partial output for the correct running call without completing it", () => {
    let model = createSessionRuntimeModel();
    let seq = 0;
    const identity = {
      runId: "r",
      turnId: "t",
      messageId: "m",
      origin: "sdk" as const,
      surface: "trace" as const,
    };
    const add = (event: AgentRuntimeEvent) => {
      seq += 1;
      model = applyAgentRuntimeEvent(model, {
        event,
        seq,
        timestamp: new Date(seq * 1000).toISOString(),
      });
    };
    for (const id of ["first", "second"]) {
      add({
        ...identity,
        type: "message_part",
        partId: id,
        partType: "tool_call",
        phase: "end",
        bodyMode: "snapshot",
        body: "{}",
        toolCallId: id,
        toolName: "bash",
      });
      add({
        ...identity,
        type: "tool",
        toolCallId: id,
        name: "bash",
        phase: "start",
      });
    }
    const update = (result: unknown, phase: "update" | "end" = "update") =>
      add({
        ...identity,
        type: "tool",
        toolCallId: "second",
        name: "bash",
        phase,
        result,
      });

    update("building");
    const partial = subagentTrajectoryTurns(model)[0].steps;
    expect(partial[0].output).toBeUndefined();
    expect(partial[1]).toMatchObject({ isRunning: true, output: "building" });
    expect(partial[1].durationMs).toBeUndefined();

    update("building\n2 tests passed");
    const updated = subagentTrajectoryTurns(model)[0].steps[1];
    expect(updated).toMatchObject({
      id: partial[1].id,
      isRunning: true,
      output: "building\n2 tests passed",
    });
    expect(updated.durationMs).toBeUndefined();

    update("all tests passed", "end");
    expect(subagentTrajectoryTurns(model)[0].steps[1]).toMatchObject({
      id: partial[1].id,
      isRunning: false,
      output: "all tests passed",
      durationMs: 3000,
    });
  });

  it("joins validated tool arguments, result and measured timing with its streamed call", () => {
    let model = createSessionRuntimeModel();
    const add = (event: AgentRuntimeEvent, seq: number) => {
      model = applyAgentRuntimeEvent(model, {
        event,
        seq,
        timestamp: new Date(seq * 1000).toISOString(),
      });
    };
    const identity = {
      runId: "r",
      turnId: "t",
      messageId: "m",
      origin: "sdk" as const,
    };
    add(
      {
        ...identity,
        type: "message_part",
        partId: "p",
        partType: "tool_call",
        phase: "end",
        bodyMode: "snapshot",
        body: '{"path":"old"}',
        toolCallId: "c",
        toolName: "read",
        surface: "trace",
      },
      1,
    );
    add(
      {
        ...identity,
        type: "tool",
        toolCallId: "c",
        name: "read",
        phase: "start",
        args: { path: "README.md" },
        surface: "trace",
      },
      2,
    );
    add(
      {
        ...identity,
        type: "tool",
        toolCallId: "c",
        name: "read",
        phase: "end",
        result: { content: [{ type: "text", text: "project docs" }] },
        surface: "trace",
      },
      3,
    );
    const turns = subagentTrajectoryTurns(model);
    expect(turns).toHaveLength(1);
    expect(turns[0].steps).toHaveLength(1);
    expect(turns[0].steps[0]).toMatchObject({
      kind: "tool",
      name: "read",
      isRunning: false,
      durationMs: 1000,
    });
    expect(turns[0].steps[0].argsText).toContain("README.md");
    expect(turns[0].steps[0].output).toContain("project docs");
  });
});
