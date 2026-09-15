import { describe, expect, it } from "vitest";
import type { SessionTurn } from "@pace/core";
import { buildTrajectoryRuns, buildTrajectoryTurns } from "./trajectory-model";

function userTurn(text: string, timestamp = "2026-08-17T14:00:00.000Z"): SessionTurn {
  return { kind: "message", role: "user", timestamp, parts: [{ partType: "text", text, payload: {} }] };
}

function assistantTurn(parts: SessionTurn["parts"], timestamp = "2026-08-17T14:01:00.000Z"): SessionTurn {
  return {
    kind: "message",
    role: "assistant",
    timestamp,
    model: "gpt-5-codex",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
    },
    cost: { inputUsd: 0.01, outputUsd: 0.02, cacheReadUsd: 0, cacheWriteUsd: 0, totalUsd: 0.03 },
    parts,
  };
}

describe("buildTrajectoryTurns", () => {
  it("assigns run indices: a run starts at each user message, preamble joins run 0", () => {
    const turns = buildTrajectoryTurns([
      assistantTurn([{ partType: "text", text: "resumed preamble", payload: {} }]),
      userTurn("first input"),
      assistantTurn([{ partType: "text", text: "reply", payload: {} }]),
      userTurn("second input"),
      assistantTurn([{ partType: "text", text: "reply 2", payload: {} }]),
    ]);

    expect(turns.map((turn) => turn.runIndex)).toEqual([0, 0, 0, 1, 1]);
  });

  it("pairs toolCall with its toolResult by toolCallId into one step", () => {
    const [turn] = buildTrajectoryTurns([
      assistantTurn([
        {
          partType: "toolCall",
          name: "bash",
          payload: { id: "call_1", arguments: { command: "git diff --stat" } },
        },
        {
          partType: "toolResult",
          name: "bash",
          text: "3 files changed",
          isError: false,
          durationMs: 340,
          payload: { toolCallId: "call_1" },
        },
      ]),
    ]);

    expect(turn.steps).toHaveLength(1);
    const [step] = turn.steps;
    expect(step.kind).toBe("tool");
    expect(step.name).toBe("bash");
    expect(step.target).toBe("git diff --stat");
    expect(step.output).toBe("3 files changed");
    expect(step.isError).toBe(false);
    expect(step.isRunning).toBe(false);
    expect(step.durationMs).toBe(340);
    expect(step.toolCallId).toBe("call_1");
  });

  it("keeps an unmatched toolCall in the running state", () => {
    const [turn] = buildTrajectoryTurns([
      assistantTurn([
        { partType: "toolCall", name: "bash", payload: { id: "call_x", arguments: {} } },
      ]),
    ]);

    expect(turn.steps[0].isRunning).toBe(true);
  });

  it("surfaces an orphan toolResult as its own step", () => {
    const [turn] = buildTrajectoryTurns([
      assistantTurn([
        {
          partType: "toolResult",
          name: "bash",
          text: "late output",
          isError: false,
          payload: { toolCallId: "never-seen" },
        },
      ]),
    ]);

    expect(turn.steps).toHaveLength(1);
    expect(turn.steps[0].kind).toBe("tool");
    expect(turn.steps[0].output).toBe("late output");
  });

  it("derives image steps from url or data+mimeType payloads", () => {
    const [turn] = buildTrajectoryTurns([
      assistantTurn([
        { partType: "image", payload: { url: "https://example.com/a.png", alt: "A" } },
        { partType: "image", payload: { data: "abc", mimeType: "image/png", name: "shot.png" } },
      ]),
    ]);

    expect(turn.steps[0].imageUrl).toBe("https://example.com/a.png");
    expect(turn.steps[1].imageUrl).toBe("data:image/png;base64,abc");
    expect(turn.steps[1].imageAlt).toBe("shot.png");
  });

  it("maps annotation turns to config steps that stay inside the current run", () => {
    const turns = buildTrajectoryTurns([
      userTurn("input"),
      {
        kind: "annotation",
        title: "Model changed",
        timestamp: "2026-08-17T14:02:00.000Z",
        model: "gpt-5-codex",
        parts: [{ partType: "model_change", payload: { model: "gpt-5-codex" } }],
      },
    ]);

    expect(turns[1].role).toBe("annotation");
    expect(turns[1].runIndex).toBe(0);
    expect(turns[1].steps[0].kind).toBe("config");
    expect(turns[1].steps[0].target).toBe("Model changed");
  });

  it("gives every step a unique id", () => {
    const turns = buildTrajectoryTurns([
      userTurn("input"),
      assistantTurn([
        { partType: "thinking", text: "plan", payload: {} },
        { partType: "text", text: "done", payload: {} },
      ]),
    ]);

    const ids = turns.flatMap((turn) => turn.steps).map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("buildTrajectoryRuns", () => {
  it("aggregates cost, tokens, and error state per run", () => {
    const runs = buildTrajectoryRuns(
      buildTrajectoryTurns([
        userTurn("first"),
        assistantTurn([
          { partType: "toolCall", name: "bash", payload: { id: "c1", arguments: {} } },
          {
            partType: "toolResult",
            name: "bash",
            text: "boom",
            isError: true,
            payload: { toolCallId: "c1" },
          },
        ]),
        userTurn("second", "2026-08-17T14:05:00.000Z"),
        assistantTurn([{ partType: "text", text: "ok", payload: {} }], "2026-08-17T14:06:00.000Z"),
      ]),
    );

    expect(runs).toHaveLength(2);
    expect(runs[0].hasError).toBe(true);
    expect(runs[0].costUsd).toBeCloseTo(0.03);
    expect(runs[0].totalTokens).toBe(150);
    expect(runs[1].hasError).toBe(false);
    expect(runs[0].turns).toHaveLength(2);
  });
});
