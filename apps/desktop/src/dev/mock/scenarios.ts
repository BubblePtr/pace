import type { PersistedSessionProjection } from "@pace/backend";
import type {
  AgentRuntimeEvent,
  RuntimeGatewaySnapshot,
  SessionChanges,
  SessionDirectoryListing,
  SessionFileContent,
  SessionSummary,
} from "@pace/core";
import { invokeBrowserFallback, type PaceRendererApi } from "@/shared/runtime";

import { createMockPackages } from "./packages";

export const mockProject = "/dev/Pace-Mock";
const timestamp = "2026-09-09T08:00:00.000Z";
const summary = {
  provider: "openai",
  model: "gpt-4.1",
  totalTokens: 4200,
  totalCostUsd: 0.018,
};
const definitions = [
  { id: "review", title: "01 · 会话、Changes 与 Files", status: "completed" },
  {
    id: "long",
    title: "02 · 长会话与长输出：检查滚动、折叠和工具栏布局",
    status: "completed",
  },
  { id: "clean", title: "03 · 无变更与空目录", status: "idle" },
  { id: "error", title: "04 · 工具失败与 Dock 读取错误", status: "failed" },
  { id: "archived", title: "05 · 已归档会话", status: "archived" },
  ...Array.from({ length: 12 }, (_, index) => ({
    id: `list-${index + 1}`,
    title: `列表样例 ${index + 1} · ${index % 2 ? "检查长标题截断、悬浮菜单与历史会话滚动" : "历史会话"}`,
    status: "completed" as const,
  })),
] as const;

const projections: PersistedSessionProjection[] = definitions.map(
  (item, index) => ({
    sessionId: `mock-${item.id}`,
    runtimeId: `runtime-${item.id}`,
    piSessionId: `pi-${item.id}`,
    projectId: mockProject,
    initialPrompt: "请检查会话展示，并在 Dock 中查看文件和修改。",
    title: item.title,
    cwd: mockProject,
    status: item.status,
    sessionFile: `/dev/mock-sessions/${item.id}.jsonl`,
    checkout: {
      mode: "foreground-local",
      root: mockProject,
      runtimeCwd: mockProject,
      diffRoot: mockProject,
      repoRoot: mockProject,
    },
    summary,
    updatedAt: new Date(Date.parse(timestamp) - index * 86400000).toISOString(),
    ...(item.status === "archived" ? { archivedAt: timestamp } : {}),
  }),
);

// Usage page input: one summary per projection, spread over the same days
// with a deterministic cost/token ramp so the dashboard has a shape.
const sessionSummaries: SessionSummary[] = projections.map((item, index) => {
  const tokens = summary.totalTokens * (1 + (index % 5)) * (index % 3 === 0 ? 4 : 1);
  const costUsd = (tokens / summary.totalTokens) * summary.totalCostUsd;
  return {
    id: item.sessionId,
    timestamp: item.updatedAt,
    project: item.projectId,
    title: { kind: "text", sentence: item.title ?? item.sessionId },
    totalCostUsd: costUsd,
    totalTokens: tokens,
    primaryModel: summary.model,
    modelBreakdown: [{ model: summary.model, costUsd, tokens }],
    toolCounts: [
      { name: "Read", count: 3 + index },
      { name: "Edit", count: 1 + (index % 4) },
    ],
    skillCounts: index % 4 === 0 ? [{ name: "code-review", count: 1 }] : [],
    presence: item.status === "archived" ? "archived" : "active",
  };
});

const source = "export const greeting = '你好，Pace';\n";
const files: Record<
  string,
  { content: string; binary?: boolean; truncated?: boolean }
> = {
  "README.md": { content: "# Pace Mock\n\n固定场景：会话、Changes、Files。\n" },
  "src/greeting.ts": { content: source },
  "src/new-file.ts": { content: "export const ready = true;\n" },
  "docs/guide.md": {
    content: "# 使用说明\n\n展开目录、选择文件，再切换 Changes 检查 diff。\n",
  },
  "assets/logo.png": { content: "", binary: true },
  "logs/large.txt": {
    content: Array.from(
      { length: 500 },
      (_, i) => `Line ${i + 1}: static output`,
    ).join("\n"),
    truncated: true,
  },
};

function snapshot(record: PersistedSessionProjection): RuntimeGatewaySnapshot {
  const events: AgentRuntimeEvent[] = [];
  const count = record.sessionId === "mock-long" ? 32 : 1;
  for (let index = 0; index < count; index++) {
    const runId = `run-${index}`;
    const turnId = `turn-${index}`;
    const common = { runId, turnId, origin: "sdk" as const };
    const failed = record.status === "failed";
    const messageId = `assistant-${index}`;
    const toolCallId = `tool-${index}`;
    events.push(
      {
        type: "run",
        runId,
        phase: "start",
        trigger: "prompt",
        surface: "hidden",
        origin: "sdk",
      },
      { ...common, type: "turn", phase: "start", surface: "hidden" },
      {
        ...common,
        type: "message",
        messageId: `user-${index}`,
        role: "user",
        phase: "end",
        surface: "chat",
        parts: [
          {
            partId: `prompt-${index}`,
            partType: "text",
            body:
              index === 0
                ? record.initialPrompt!
                : `继续检查第 ${index + 1} 轮的文件与布局。`,
          },
        ],
      },
      {
        ...common,
        type: "message",
        messageId,
        role: "assistant",
        phase: "start",
        surface: "chat",
      },
      {
        ...common,
        type: "message_part",
        messageId,
        partId: `thinking-${index}`,
        partType: "thinking",
        phase: "end",
        bodyMode: "snapshot",
        body: "先读取文件，再检查变更。这个固定快照用于反复验证折叠、排版和工具详情。",
        surface: "trace",
      },
      {
        ...common,
        type: "message_part",
        messageId,
        partId: `call-${index}`,
        partType: "tool_call",
        toolCallId,
        toolName: "read",
        phase: "end",
        bodyMode: "snapshot",
        body: JSON.stringify({ path: "src/greeting.ts" }),
        surface: "trace",
      },
      {
        ...common,
        type: "tool",
        toolCallId,
        name: "read",
        phase: "start",
        args: { path: "src/greeting.ts" },
        surface: "trace",
      },
      {
        ...common,
        type: "tool",
        toolCallId,
        name: "read",
        phase: "end",
        result: {
          content: [
            {
              type: "text",
              text: failed
                ? "EACCES: permission denied (mock)"
                : count > 1
                  ? files["logs/large.txt"].content
                  : source,
            },
          ],
        },
        isError: failed,
        surface: "trace",
      },
      {
        ...common,
        type: "message",
        messageId,
        role: "assistant",
        phase: "end",
        surface: "chat",
        parts: [
          {
            partId: `thinking-${index}`,
            partType: "thinking",
            body: "先读取文件，再检查变更。这个固定快照用于反复验证折叠、排版和工具详情。",
          },
          {
            partId: `call-${index}`,
            partType: "tool_call",
            toolCallId,
            body: JSON.stringify({ path: "src/greeting.ts" }),
          },
          {
            partId: `answer-${index}`,
            partType: "text",
            body: failed
              ? "读取失败。这是固定错误场景，可检查错误信息和重试入口。"
              : `## 检查结果 ${index + 1}\n\n已检查 **会话内容** 和工具输出。打开右侧 Dock 的 Changes / Files 检查同一份文件。\n\n\`\`\`ts\n${source}\`\`\`\n\n| 区域 | 检查内容 |\n| --- | --- |\n| Changes | 修改、新增、删除、重命名、二进制 |\n| Files | 目录展开、代码预览、空目录、大文件 |\n\n- [x] 固定数据可重复查看\n- [ ] 流式、停止和终端请用真实会话验证\n\n> 这是静态 mock；刷新恢复初始场景。`,
          },
        ],
      },
      { ...common, type: "turn", phase: "end", surface: "hidden" },
      {
        type: "run",
        runId,
        phase: "end",
        trigger: "prompt",
        outcome: failed ? "failed" : "completed",
        surface: "hidden",
        origin: "sdk",
      },
    );
  }
  return {
    ...record,
    status: record.status === "archived" ? "completed" : record.status,
    contextUsage: { tokens: 4200, contextWindow: 128000, percent: 3.28125 },
    events: events.map((event, index) => ({
      id: `${record.sessionId}-${index}`,
      seq: index + 1,
      sessionId: record.sessionId,
      piSessionId: record.piSessionId,
      ts: new Date(Date.parse(record.updatedAt) + index * 1000).toISOString(),
      type: "agent_event",
      payload: { ...event },
    })),
  };
}

function changes(sessionId: string): SessionChanges {
  const changedFiles: SessionChanges["files"] =
    sessionId === "mock-clean"
      ? []
      : [
          {
            path: "src/greeting.ts",
            kind: "modified",
            staged: false,
            unstaged: true,
            additions: 1,
            deletions: 1,
            binary: false,
            patchTruncated: false,
            patch: `diff --git a/src/greeting.ts b/src/greeting.ts\n--- a/src/greeting.ts\n+++ b/src/greeting.ts\n@@ -1 +1 @@\n-export const greeting = 'Hello';\n+${source}`,
          },
          {
            path: "src/new-file.ts",
            kind: "added",
            staged: true,
            unstaged: false,
            additions: 1,
            deletions: 0,
            binary: false,
            patchTruncated: false,
            patch:
              "diff --git a/src/new-file.ts b/src/new-file.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new-file.ts\n@@ -0,0 +1 @@\n+export const ready = true;\n",
          },
          {
            path: "old.txt",
            kind: "deleted",
            staged: false,
            unstaged: true,
            additions: 0,
            deletions: 1,
            binary: false,
            patchTruncated: false,
            patch:
              "diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-obsolete\n",
          },
          {
            path: "docs/guide.md",
            previousPath: "docs/old-guide.md",
            kind: "renamed",
            staged: true,
            unstaged: false,
            additions: 0,
            deletions: 0,
            binary: false,
            patchTruncated: false,
            patch:
              "diff --git a/docs/old-guide.md b/docs/guide.md\nsimilarity index 100%\nrename from docs/old-guide.md\nrename to docs/guide.md\n",
          },
          {
            path: "assets/logo.png",
            kind: "untracked",
            staged: false,
            unstaged: true,
            additions: null,
            deletions: null,
            binary: true,
            patchTruncated: false,
          },
        ];
  return {
    sessionId,
    state: changedFiles.length ? "ready" : "clean",
    checkoutRoot: mockProject,
    repositoryRoot: mockProject,
    generatedAt: timestamp,
    head: { oid: "abc123", branch: "feat/mock-review", detached: false },
    branches: ["feat/mock-review", "main"],
    files: changedFiles,
    totals: {
      files: changedFiles.length,
      additions: changedFiles.length ? 2 : 0,
      deletions: changedFiles.length ? 2 : 0,
      binaryFiles: changedFiles.length ? 1 : 0,
      conflictedFiles: 0,
    },
    truncated: false,
    omittedFileCount: 0,
  };
}

function listing(sessionId: string, path: string): SessionDirectoryListing {
  const entries = new Map<string, SessionDirectoryListing["entries"][number]>();
  if (sessionId !== "mock-clean") {
    for (const [filePath, file] of Object.entries(files)) {
      const prefix = path ? `${path}/` : "";
      if (!filePath.startsWith(prefix)) continue;
      const relative = filePath.slice(prefix.length);
      const name = relative.split("/")[0];
      entries.set(name, {
        name,
        path: `${prefix}${name}`,
        kind: relative.includes("/") ? "directory" : "file",
        size: relative.includes("/") ? null : file.content.length,
      });
    }
    if (!path)
      entries.set("empty", {
        name: "empty",
        path: "empty",
        kind: "directory",
        size: null,
      });
  }
  if (path && !entries.size && path !== "empty" && sessionId !== "mock-clean")
    throw new Error(`Mock directory not found: ${path}`);
  return {
    sessionId,
    path,
    rootName: "Pace-Mock",
    entries: [...entries.values()].sort((a, b) => {
      if (a.kind !== b.kind) {
        if (a.kind === "directory") return -1;
        if (b.kind === "directory") return 1;
      }
      return a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
        a.name.localeCompare(b.name, "en");
    }),
    truncated: false,
  };
}

export function createMockApi(): PaceRendererApi {
  const packageCommand = createMockPackages();
  return {
    async invoke<T>(
      command: string,
      args: Record<string, unknown> = {},
    ): Promise<T> {
      let result: unknown;
      const sessionId = String(args.sessionId ?? "");
      const record = projections.find(
        (item) =>
          item.sessionId === sessionId || item.runtimeId === args.runtimeId,
      );
      switch (command) {
        case "list_session_projections":
          result = projections;
          break;
        case "list_sessions":
          result = sessionSummaries;
          break;
        case "resume_session":
        case "get_runtime_snapshot":
          if (!record) throw new Error(`Mock session not found: ${sessionId}`);
          result = snapshot(record);
          break;
        case "get_session_changes":
        case "list_session_directory":
        case "read_session_file": {
          if (!record) throw new Error(`Mock session not found: ${sessionId}`);
          if (sessionId === "mock-error")
            throw new Error("静态场景：无权读取此工作目录（mock EACCES）。");
          const path = String(args.path ?? "");
          if (command === "get_session_changes") result = changes(sessionId);
          else if (command === "list_session_directory")
            result = listing(sessionId, path);
          else {
            const file = sessionId !== "mock-clean" ? files[path] : undefined;
            if (!file) throw new Error(`Mock file not found: ${path}`);
            result = {
              sessionId,
              path,
              size: file.binary
                ? 2048
                : new TextEncoder().encode(file.content).length,
              content: file.content,
              binary: file.binary ?? false,
              truncated: file.truncated ?? false,
            } satisfies SessionFileContent;
          }
          break;
        }
        case "search_package_catalog":
        case "check_package_updates":
        case "get_config_inventory":
        case "install_package":
        case "remove_package":
        case "update_package":
        case "set_resource_enabled":
          result = packageCommand(command, args);
          break;
        case "get_environment_preflight_status":
        case "list_available_model_controls":
        case "resolve_tool_schemas":
        case "list_provider_auth_status":
        case "update:status":
        case "get_chat_workspace_root":
          return invokeBrowserFallback<T>(command, args);
        default:
          throw new Error(
            `静态 mock 不执行 ${command}；请使用真实 dev 会话验证此操作。`,
          );
      }
      return structuredClone(result) as T;
    },
    onBackendEvent: () => () => {},
    onBrowserEvent: () => () => {},
    onUpdateEvent: () => () => {},
    onWindowFocusChanged: () => () => {},
    onNavigateRequest: () => () => {},
  };
}
