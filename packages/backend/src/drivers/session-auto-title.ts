// Pure parts of Pace's session auto-naming: prompt, sanitizer and the
// once-per-session decision. Kept out of the adapter so they are testable
// without an SDK AgentSession; the adapter only wires the trigger.

/** Each side of the exchange is truncated so one long turn cannot blow up the naming prompt. */
export const AUTO_TITLE_SOURCE_CHAR_LIMIT = 1000;
/** The session list shows one short line; longer names are just truncated on screen. */
export const AUTO_TITLE_MAX_LENGTH = 60;
/** Naming is best-effort background work — it must never outlive the turn it describes. */
export const AUTO_TITLE_TIMEOUT_MS = 15_000;

/** Pi message content is either a bare string or a list of typed parts. */
export function sessionTitleTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
}

// Models tend to wrap titles in quotes or add trailing punctuation; the session
// list wants a bare single-line label. Peeling repeats until stable because the
// two can nest either way («"Title."» as well as «"Title".»).
export function sanitizeSessionTitle(raw: string): string {
  let name = (raw.split("\n")[0] ?? "").trim();

  for (let previous = ""; name !== previous; ) {
    previous = name;
    name = name
      .replace(/^["'“”「『]+|["'“”」』]+$/g, "")
      .replace(/[.!?:;，。！？：；]+$/, "")
      .trim();
  }

  return name.slice(0, AUTO_TITLE_MAX_LENGTH).trim();
}

export function buildSessionTitlePrompt(source: { userText: string; assistantText: string }): string {
  return [
    "Generate a short title for this coding session.",
    "Rules: max 8 words, same language as the request, no quotes, no trailing punctuation.",
    "Reply with the title only.",
    "",
    "<request>",
    source.userText.slice(0, AUTO_TITLE_SOURCE_CHAR_LIMIT),
    "</request>",
    "",
    "<reply>",
    source.assistantText.slice(0, AUTO_TITLE_SOURCE_CHAR_LIMIT),
    "</reply>",
  ].join("\n");
}

/**
 * Name a session at most once: an existing name (user rename or a Pi auto-name
 * extension) wins, and a failed attempt is not retried on every later reply.
 */
export function shouldGenerateSessionTitle(state: {
  currentName?: string;
  attempted: boolean;
  userText: string;
  assistantText: string;
}): boolean {
  return (
    !state.attempted &&
    !state.currentName?.trim() &&
    Boolean(state.userText.trim() || state.assistantText.trim())
  );
}
