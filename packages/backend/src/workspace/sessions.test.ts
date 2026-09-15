import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@pace/core";
import {
  annotateSessionPresence,
  buildSessionIndex,
  buildSessionIndexWithCache,
  classifyTitle,
  createSessionIndexCache,
  deriveProjectName,
  loadSessionDetail,
  parseSession,
  type SessionPresenceProjection,
} from "./sessions";

function fixtureAgentDir() {
  return join(process.cwd(), "fixtures/pi-agent");
}

async function tempAgentDir() {
  return mkdtemp(join(tmpdir(), "pig-agent-"));
}

async function writeSession(agentDir: string, project: string, file: string, jsonl: string) {
  const sessionDir = join(agentDir, "sessions", project);

  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, file), jsonl);
}

function expectCost(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThan(1e-12);
}

const unusedDataDir = "/tmp/pigui-unused-data";

describe("backend session parser", () => {
  it("builds the session index newest first with projects and title chips", async () => {
    const sessions = await buildSessionIndex(fixtureAgentDir(), unusedDataDir);

    expect(sessions).toHaveLength(3);
    expect(sessions.map((session) => session.id)).toEqual([
      "newest-session",
      "middle-session",
      "oldest-session",
    ]);
    expect(sessions.map((session) => session.project)).toEqual(["gamma", "beta", "alpha"]);
    expect(sessions.map((session) => session.title)).toEqual([
      { kind: "command", name: "review", args: "" },
      { kind: "text", sentence: "Show project status." },
      { kind: "text", sentence: "Show project status." },
    ]);
  });

  it("attributes managed worktree sessions to their original project", async () => {
    const agentDir = await tempAgentDir();

    await writeSession(
      agentDir,
      "managed-worktree",
      "2026-06-29T15-01-27-454Z_managed-session.jsonl",
      `{"type":"session","version":3,"id":"session-64372af7-2bf3-4238-9cbb-6d41ad451fed","timestamp":"2026-06-29T15:01:27.454Z","cwd":"/Users/void/code/opensource/.pig-worktrees/Pig/session-64372af7-2bf3-4238-9cbb-6d41ad451fed"}`,
    );

    const sessions = await buildSessionIndex(agentDir, unusedDataDir);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].project).toBe("Pig");
  });

  it("labels chat workspace cwds as Chat", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pigui-chats-"));

    expect(deriveProjectName(join(dataDir, "chats", "session-abc"), dataDir)).toBe("Chat");
    expect(deriveProjectName(join(dataDir, "chats-extra", "session-abc"), dataDir)).toBe(
      "session-abc",
    );
    expect(deriveProjectName("/Users/void/code/opensource/Pig", dataDir)).toBe("Pig");
  });

  it("reconstructs detail turn order and merges tool results into assistant turns", async () => {
    const jsonl = await readFile(
      join(
        fixtureAgentDir(),
        "sessions/project-beta/2026-01-03T12-00-00-000Z_middle-session.jsonl",
      ),
      "utf8",
    );

    const detail = parseSession(jsonl, unusedDataDir);

    expect(detail.id).toBe("middle-session");
    expect(detail.project).toBe("beta");
    expect(detail.turns.map((turn) => [turn.kind, turn.role ?? null])).toEqual([
      ["annotation", null],
      ["annotation", null],
      ["message", "user"],
      ["message", "assistant"],
    ]);
    expect(detail.turns[3].parts.map((part) => part.partType)).toEqual([
      "thinking",
      "text",
      "toolCall",
      "image",
      "toolResult",
    ]);
    expect(detail.turns[3].parts[0].text).toBe("Need to inspect the tree.");
    expect(detail.turns[3].parts[2].name).toBe("list_files");
    expect(detail.turns[3].parts[4]).toMatchObject({
      partType: "toolResult",
      text: "src/main.tsx\nsrc-tauri/src/lib.rs",
    });
  });

  it("aggregates cost and tokens across model changes", () => {
    const detail = parseSession(`{"type":"session","id":"multi-model-session","timestamp":"2026-01-07T10:00:00.000Z","cwd":"/Users/example/code/delta","model":"gpt-5-mini"}
{"type":"message","role":"user","timestamp":"2026-01-07T10:00:01.000Z","content":[{"type":"text","text":"Compare these files."}]}
{"type":"message","role":"assistant","timestamp":"2026-01-07T10:00:02.000Z","usage":{"inputTokens":100,"outputTokens":50,"cost":{"inputUsd":0.01,"outputUsd":0.02,"totalUsd":0.03}},"content":[{"type":"text","text":"I will inspect both files."}]}
{"type":"model_change","timestamp":"2026-01-07T10:00:03.000Z","from":"gpt-5-mini","to":"gpt-5-codex"}
{"type":"message","role":"assistant","timestamp":"2026-01-07T10:00:04.000Z","usage":{"input_tokens":150,"output_tokens":50,"cache_read_tokens":20,"total_tokens":220},"cost":{"input_usd":0.04,"output_usd":0.08,"cache_read_usd":0.01,"total_usd":0.13},"content":[{"type":"text","text":"The second file changed the API contract."}]}`, unusedDataDir);

    expect(detail.totalTokens).toBe(370);
    expectCost(detail.totalCostUsd, 0.16);
    expect(detail.primaryModel).toBe("gpt-5-codex");
    expect(detail.turnCount).toBe(3);
    expect(detail.durationSeconds).toBe(4);
    expect(detail.turns.filter((turn) => turn.role === "assistant").map((turn) => ({
      model: turn.model,
      totalTokens: turn.usage?.totalTokens,
      totalUsd: turn.cost?.totalUsd,
    }))).toEqual([
      { model: "gpt-5-mini", totalTokens: 150, totalUsd: 0.03 },
      { model: "gpt-5-codex", totalTokens: 220, totalUsd: 0.13 },
    ]);
  });

  it("exposes model breakdown, tool counts, and skill counts in summaries", async () => {
    const agentDir = await tempAgentDir();

    await writeSession(
      agentDir,
      "metrics",
      "2026-01-09T10-00-00-000Z_metrics-session.jsonl",
      `{"type":"session","id":"metrics-session","timestamp":"2026-01-09T10:00:00.000Z","cwd":"/Users/example/code/metrics","model":"gpt-5-mini"}
{"type":"message","role":"user","timestamp":"2026-01-09T10:00:01.000Z","content":[{"type":"text","text":"Use <skill name=\\"kami\\"> and inspect files."}]}
{"type":"message","role":"assistant","timestamp":"2026-01-09T10:00:02.000Z","usage":{"inputTokens":100,"outputTokens":50,"cost":{"totalUsd":0.03}},"content":[{"type":"toolCall","name":"list_files"},{"type":"toolCall","name":"read_file"},{"type":"text","text":"Switching to <skill-review>."}]}
{"type":"model_change","timestamp":"2026-01-09T10:00:03.000Z","to":"gpt-5-codex"}
{"type":"message","role":"assistant","timestamp":"2026-01-09T10:00:04.000Z","usage":{"totalTokens":220},"cost":{"totalUsd":0.13},"content":[{"type":"toolCall","name":"list_files"}]}`,
    );

    const sessions = await buildSessionIndex(agentDir, unusedDataDir);

    expect(sessions[0]).toMatchObject({
      id: "metrics-session",
      totalTokens: 370,
      totalCostUsd: 0.16,
      primaryModel: "gpt-5-codex",
      modelBreakdown: [
        { model: "gpt-5-codex", costUsd: 0.13, tokens: 220 },
        { model: "gpt-5-mini", costUsd: 0.03, tokens: 150 },
      ],
      toolCounts: [
        { name: "list_files", count: 2 },
        { name: "read_file", count: 1 },
      ],
      skillCounts: [
        { name: "kami", count: 1 },
        { name: "review", count: 1 },
      ],
    });
  });

  it("reuses cached summaries when file mtimes are unchanged", async () => {
    const cache = createSessionIndexCache();

    const first = await buildSessionIndexWithCache(
      fixtureAgentDir(),
      cache,
      unusedDataDir,
    );
    const second = await buildSessionIndexWithCache(
      fixtureAgentDir(),
      cache,
      unusedDataDir,
    );

    expect(second).toEqual(first);
    expect(cache.misses).toBe(3);
    expect(cache.hits).toBe(3);
  });

  it("parses nested message records used by current Pi sessions", () => {
    const detail = parseSession(`{"type":"session","id":"test-nested","timestamp":"2026-06-23T10:00:00.000Z","cwd":"/Users/test/proj"}
{"type":"message","id":"msg1","parentId":null,"timestamp":"2026-06-23T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Hello world"}]}}
{"type":"message","id":"msg2","parentId":"msg1","timestamp":"2026-06-23T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Let me think."},{"type":"text","text":"Hi there!"},{"type":"toolCall","name":"list_files","arguments":{"path":"."}}],"model":"gpt-5","usage":{"input":100,"output":50,"totalTokens":150},"cost":{"input":0.01,"output":0.02,"total":0.03}}}`, unusedDataDir);

    expect(detail.turns).toHaveLength(2);
    expect(detail.turns[0].parts[0]).toMatchObject({ partType: "text", text: "Hello world" });
    expect(detail.turns[1].parts.map((part) => part.partType)).toEqual([
      "thinking",
      "text",
      "toolCall",
    ]);
    expect(detail.turns[1].parts[0].text).toBe("Let me think.");
    expect(detail.turns[1].parts[2].name).toBe("list_files");
    expect(detail.turns[1].model).toBe("gpt-5");
    expect(detail.turns[1].usage?.totalTokens).toBe(150);
    expectCost(detail.totalCostUsd, 0.03);
  });

  it("carries isError, duration, and raw payload through merged tool results", () => {
    const detail = parseSession(`{"type":"session","id":"tool-result-fields","timestamp":"2026-06-23T10:00:00.000Z","cwd":"/Users/test/proj"}
{"type":"message","id":"m1","parentId":null,"timestamp":"2026-06-23T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"List files then fail."}]}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-06-23T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_1","name":"bash","arguments":{"command":"ls src"}}],"model":"gpt-5","stopReason":"toolUse"}}
{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-06-23T10:00:02.071Z","message":{"role":"toolResult","toolCallId":"call_1","toolName":"bash","content":[{"type":"text","text":"src/main.tsx"}],"isError":false,"timestamp":1750672802071}}
{"type":"message","id":"m4","parentId":"m3","timestamp":"2026-06-23T10:00:03.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_2","name":"bash","arguments":{"command":"cat missing.txt"}}],"model":"gpt-5","stopReason":"toolUse"}}
{"type":"message","id":"m5","parentId":"m4","timestamp":"2026-06-23T10:00:05.500Z","message":{"role":"toolResult","toolCallId":"call_2","toolName":"bash","content":[{"type":"text","text":"cat: missing.txt: No such file or directory"}],"isError":true,"timestamp":1750672805500}}`, unusedDataDir);

    const assistantTurns = detail.turns.filter((turn) => turn.role === "assistant");
    const okResult = assistantTurns[0].parts.find((part) => part.partType === "toolResult");
    const failedResult = assistantTurns[1].parts.find((part) => part.partType === "toolResult");

    expect(okResult).toMatchObject({
      partType: "toolResult",
      name: "bash",
      isError: false,
      durationMs: 71,
    });
    expect(failedResult).toMatchObject({
      partType: "toolResult",
      name: "bash",
      isError: true,
      durationMs: 2500,
    });
    expect(okResult?.payload).toMatchObject({
      toolCallId: "call_1",
      content: [{ type: "text", text: "src/main.tsx" }],
    });
  });

  it("measures model latency only from a plausible inner/outer span", () => {
    // Pi stamps message.timestamp (epoch ms) when the provider stream opens and
    // the outer record timestamp when the message ends. Every record after the
    // first is a degenerate shape that must fall back to nothing rather than a
    // bogus span: no inner stamp, a stamp after the end (clock skew), a garbage
    // stamp, epoch 0, and a span too long for any real model call.
    const detail = parseSession(`{"type":"session","id":"model-latency","timestamp":"2026-06-23T10:00:00.000Z","cwd":"/Users/test/proj"}
{"type":"message","id":"m1","timestamp":"2026-06-23T10:00:08.000Z","message":{"role":"assistant","timestamp":1782208802500,"content":[{"type":"text","text":"Measured."}],"model":"gpt-5"}}
{"type":"message","id":"m2","timestamp":"2026-06-23T10:00:10.000Z","message":{"role":"assistant","content":[{"type":"text","text":"No inner stamp."}],"model":"gpt-5"}}
{"type":"message","id":"m3","timestamp":"2026-06-23T10:00:12.000Z","message":{"role":"assistant","timestamp":1782208820000,"content":[{"type":"text","text":"Clock skew."}],"model":"gpt-5"}}
{"type":"message","id":"m4","timestamp":"2026-06-23T10:00:14.000Z","message":{"role":"assistant","timestamp":"whenever","content":[{"type":"text","text":"Garbage stamp."}],"model":"gpt-5"}}
{"type":"message","id":"m5","timestamp":"2026-06-23T10:00:16.000Z","message":{"role":"assistant","timestamp":0,"content":[{"type":"text","text":"Epoch zero."}],"model":"gpt-5"}}
{"type":"message","id":"m6","timestamp":"2026-06-23T10:00:18.000Z","message":{"role":"assistant","timestamp":1782198018000,"content":[{"type":"text","text":"Three hours."}],"model":"gpt-5"}}`, unusedDataDir);

    expect(detail.turns.map((turn) => turn.modelDurationMs)).toEqual([
      5_500,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("classifies command, skill, natural-language, trivial, and unicode titles", () => {
    expect(classifyTitle("/grilling sharpen this plan")).toEqual({
      kind: "command",
      name: "grilling",
      args: "sharpen this plan",
    });
    expect(classifyTitle("<skill name=\"kami\">make this one-pager</skill>")).toEqual({
      kind: "skill",
      name: "kami",
    });
    expect(classifyTitle("Show me the latest task status. Then explain blockers.")).toEqual({
      kind: "text",
      sentence: "Show me the latest task status.",
    });
    expect(classifyTitle("echo test")).toEqual({ kind: "raw", text: "echo test" });
    expect(
      classifyTitle("🙂".repeat(97)),
    ).toEqual({
      kind: "text",
      sentence: `${"🙂".repeat(96)}...`,
    });
  });
});

describe("loadSessionDetail tintinweb cold pass", () => {
  it("attaches SubagentRecords from parent Agent tools and the session index", async () => {
    const agentDir = await tempAgentDir();
    await writeSession(
      agentDir,
      "demo",
      "child-cold.jsonl",
      `{"type":"session","id":"child-cold","timestamp":"2026-09-15T12:00:00.000Z","cwd":"/tmp/demo"}
`,
    );
    await writeSession(
      agentDir,
      "demo",
      "parent.jsonl",
      `{"type":"session","id":"parent-session","timestamp":"2026-09-15T12:00:00.000Z","cwd":"/tmp/demo"}
{"type":"message","id":"m1","timestamp":"2026-09-15T12:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"explore"}]}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-09-15T12:00:02.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"call-cold","name":"Agent","arguments":{"subagent_type":"Explore","prompt":"map the repo","description":"Explore","run_in_background":true}}],"model":"gpt-5"}}
{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-09-15T12:00:03.000Z","message":{"role":"toolResult","toolCallId":"call-cold","toolName":"Agent","content":[{"type":"text","text":"Agent ID: ag-cold"}],"details":{"agentId":"ag-cold","status":"background","sessionFile":"/tmp/demo/child-cold.jsonl"}}}
`,
    );

    const parsed = parseSession(
      await readFile(join(agentDir, "sessions", "demo", "parent.jsonl"), "utf8"),
      unusedDataDir,
    );
    expect(parsed.subagents).toBeUndefined();

    const detail = await loadSessionDetail(agentDir, "parent-session", unusedDataDir);
    expect(detail.subagents).toEqual([
      expect.objectContaining({
        childSessionId: "child-cold",
        parentSessionId: "parent-session",
        ownerToolCallId: "call-cold",
        sourceAgentId: "ag-cold",
        state: "started",
        source: "tintinweb",
      }),
    ]);
  });
});

describe("annotateSessionPresence", () => {
  function summary(id: string): SessionSummary {
    return {
      id,
      timestamp: "2026-08-27T10:00:00.000Z",
      project: "alpha",
      title: { kind: "raw", text: id },
      totalCostUsd: 0,
      totalTokens: 0,
      modelBreakdown: [],
      toolCounts: [],
      skillCounts: [],
      presence: "external",
    };
  }

  function projection(
    piSessionId: string,
    overrides: Partial<SessionPresenceProjection> = {},
  ): SessionPresenceProjection {
    return { piSessionId, status: "completed", ...overrides };
  }

  it("marks sessions active, archived, or external against the projections", () => {
    const annotated = annotateSessionPresence(
      [summary("live"), summary("archived-status"), summary("archived-at"), summary("cli-only")],
      [
        projection("live"),
        projection("archived-status", { status: "archived" }),
        projection("archived-at", { archivedAt: "2026-08-27T09:00:00.000Z" }),
      ],
    );

    expect(annotated.map((session) => [session.id, session.presence])).toEqual([
      ["live", "active"],
      ["archived-status", "archived"],
      ["archived-at", "archived"],
      ["cli-only", "external"],
    ]);
  });

  it("keeps a session active when any projection of it is unarchived", () => {
    const annotated = annotateSessionPresence(
      [summary("shared")],
      [
        projection("shared", { status: "archived" }),
        projection("shared"),
        projection("shared", { archivedAt: "2026-08-27T09:00:00.000Z" }),
      ],
    );

    expect(annotated[0].presence).toBe("active");
  });
});
