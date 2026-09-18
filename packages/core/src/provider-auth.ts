// Provider auth contracts for Pace Settings (DF-002 / S3).
// Credentials live in Pi's auth.json via AuthStorage; this package only
// defines the IPC-facing status shape (never raw secrets). Provider ids
// come from the bundled Pi runtime, not a hard-coded catalog.

export type ProviderAuthId = string;

export type ProviderAuthMode = "none" | "api_key" | "oauth";

export type ProviderAuthStatusItem = {
  id: ProviderAuthId;
  label: string;
  supportsApiKey: boolean;
  supportsOAuth: boolean;
  mode: ProviderAuthMode;
  configured: boolean;
  /** Masked hint only, e.g. "…ae1d". Never a full key. */
  keyHint?: string;
  statusLabel?: string;
};

export type ProviderAuthStatusReport = {
  agentDir: string;
  authPath: string;
  providers: ProviderAuthStatusItem[];
  configuredCount: number;
};

/** Labels Pace keeps when they differ from Pi's provider.name. */
export const PROVIDER_DISPLAY_OVERRIDES: Readonly<Record<string, string>> = {
  "openai-codex": "ChatGPT / Codex",
  xai: "Grok (xAI)",
};

export const FEATURED_PROVIDER_ORDER: readonly string[] = [
  "openai-codex",
  "anthropic",
  "radius",
  "openai",
  "deepseek",
  "xai",
  "google",
  "github-copilot",
  "openrouter",
];

const featuredIndex = new Map(
  FEATURED_PROVIDER_ORDER.map((id, index) => [id, index]),
);

/** Configured first, then featured order, then alphabetical by label. */
export function sortProvidersForDisplay<
  T extends { id: string; label: string; configured: boolean },
>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => {
    if (left.configured !== right.configured) {
      return left.configured ? -1 : 1;
    }

    const leftFeatured = featuredIndex.get(left.id) ?? Number.POSITIVE_INFINITY;
    const rightFeatured = featuredIndex.get(right.id) ?? Number.POSITIVE_INFINITY;
    if (leftFeatured !== rightFeatured) {
      return leftFeatured - rightFeatured;
    }

    return left.label.localeCompare(right.label, "en");
  });
}
