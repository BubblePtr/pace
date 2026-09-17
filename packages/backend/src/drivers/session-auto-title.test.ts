import { describe, expect, it } from "vitest";
import {
  AUTO_TITLE_MAX_LENGTH,
  AUTO_TITLE_SOURCE_CHAR_LIMIT,
  buildSessionTitlePrompt,
  sanitizeSessionTitle,
  sessionTitleTextFromContent,
  shouldGenerateSessionTitle,
} from "./session-auto-title";

describe("session auto-title", () => {
  it.each([
    ['"Fix the flaky terminal test"', "Fix the flaky terminal test"],
    ["「修复终端测试」。", "修复终端测试"],
    ["Refactor the gateway\nbecause the seq counter drifted", "Refactor the gateway"],
    ["  Rename the session dock!  ", "Rename the session dock"],
    ["", ""],
    ["\n  \n", ""],
  ])("sanitizes %j into a bare single-line label", (raw, expected) => {
    expect(sanitizeSessionTitle(raw)).toBe(expected);
  });

  it("caps an over-long title without leaving a trailing space", () => {
    const sanitized = sanitizeSessionTitle(`${"word ".repeat(40)}end`);

    expect(sanitized.length).toBeLessThanOrEqual(AUTO_TITLE_MAX_LENGTH);
    expect(sanitized).toBe(sanitized.trim());
  });

  it("reads text out of both plain and structured message content", () => {
    expect(sessionTitleTextFromContent("plain")).toBe("plain");
    expect(sessionTitleTextFromContent([
      { type: "text", text: "first" },
      { type: "thinking", thinking: "ignored" },
      { type: "text", text: "second" },
    ])).toBe("first\nsecond");
    expect(sessionTitleTextFromContent(undefined)).toBe("");
  });

  it("truncates both sides of the conversation so a long turn cannot blow up the prompt", () => {
    const prompt = buildSessionTitlePrompt({
      userText: "u".repeat(AUTO_TITLE_SOURCE_CHAR_LIMIT + 500),
      assistantText: "a".repeat(AUTO_TITLE_SOURCE_CHAR_LIMIT + 500),
    });

    expect(prompt).toContain("u".repeat(AUTO_TITLE_SOURCE_CHAR_LIMIT));
    expect(prompt).not.toContain("u".repeat(AUTO_TITLE_SOURCE_CHAR_LIMIT + 1));
    expect(prompt).toContain("a".repeat(AUTO_TITLE_SOURCE_CHAR_LIMIT));
    expect(prompt).not.toContain("a".repeat(AUTO_TITLE_SOURCE_CHAR_LIMIT + 1));
  });

  it.each([
    ["names an untitled session once there is something to summarize", { currentName: "", attempted: false, userText: "add a dock", assistantText: "done" }, true],
    ["leaves a name set by the user or a Pi extension alone", { currentName: "Existing", attempted: false, userText: "add a dock", assistantText: "done" }, false],
    ["never retries after an attempt", { currentName: "", attempted: true, userText: "add a dock", assistantText: "done" }, false],
    ["skips an empty exchange", { currentName: undefined, attempted: false, userText: "  ", assistantText: "" }, false],
  ])("%s", (_case, state, expected) => {
    expect(shouldGenerateSessionTitle(state)).toBe(expected);
  });
});
