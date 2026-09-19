import type { ComponentType, CSSProperties } from "react";
import {
  AntGroup,
  Anthropic,
  Azure,
  Baseten,
  Bedrock,
  Cerebras,
  Cloudflare,
  DeepSeek,
  Fireworks,
  GithubCopilot,
  Google,
  Grok,
  Groq,
  HuggingFace,
  Kimi,
  Minimax,
  Mistral,
  Moonshot,
  Nvidia,
  OpenAI,
  OpenCode,
  OpenRouter,
  Qwen,
  Together,
  Vercel,
  VertexAI,
  WorkersAI,
  XiaomiMiMo,
  ZAI,
} from "@lobehub/icons";
import { RadiusColor, RadiusMono } from "./radius-mark";

type GlyphIcon = ComponentType<{
  size?: number | string;
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean;
  "data-testid"?: string;
}>;

type LobeMark = GlyphIcon & {
  Color?: GlyphIcon;
  colorPrimary?: string;
};

type ProviderBrand = {
  /** Mono mark (currentColor). */
  Mono: GlyphIcon;
  /** Optional multi-color SVG when LobeHub ships one. */
  Color?: GlyphIcon;
  /** Badge background (brand surface). */
  background: string;
  /** Glyph color when using Mono (ignored for Color). */
  foreground: string;
  /** Optional hairline so light badges read on white cards. */
  ring?: string;
};

function lobeBrand(icon: LobeMark): ProviderBrand {
  const primary = icon.colorPrimary;
  const Color = icon.Color;

  return {
    Mono: icon,
    ...(Color ? { Color } : {}),
    background: primary
      ? `color-mix(in srgb, ${primary} 14%, transparent)`
      : "var(--surface-muted)",
    foreground: primary ?? "var(--foreground)",
  };
}

/**
 * Brand treatment from @lobehub/icons constants / Color variants (Radius's
 * mark is self-built in ./radius-mark — LobeHub does not ship it).
 * Mono alone is flat black — wrap in brand surface + tint (or Color path).
 * Ids without a mark use a letter fallback.
 */
const providerBrands: Record<string, ProviderBrand> = {
  openai: {
    Mono: OpenAI,
    // Official OpenAI: light surface + black mark (#000) — not inverted black badge.
    background: "#ffffff",
    foreground: OpenAI.colorPrimary || "#000000",
    ring: "0 0 0 1px rgba(0,0,0,0.12)",
  },
  "openai-codex": {
    Mono: OpenAI,
    background: "#ffffff",
    foreground: OpenAI.colorPrimary || "#000000",
    ring: "0 0 0 1px rgba(0,0,0,0.12)",
  },
  anthropic: {
    Mono: Anthropic,
    // LobeHub Anthropic avatar pair: cream surface + near-black mark.
    background: Anthropic.colorPrimary || "#F1F0E8",
    foreground: "#141413",
  },
  deepseek: {
    Mono: DeepSeek,
    Color: DeepSeek.Color,
    background: "color-mix(in srgb, #4D6BFE 14%, transparent)",
    foreground: DeepSeek.colorPrimary || "#4D6BFE",
  },
  xai: {
    // Grok mark for xAI/Grok provider.
    Mono: Grok,
    background: Grok.colorPrimary === "#000" || !Grok.colorPrimary ? "#111111" : Grok.colorPrimary,
    foreground: "#ffffff",
  },
  "amazon-bedrock": lobeBrand(Bedrock),
  "ant-ling": lobeBrand(AntGroup),
  "azure-openai-responses": lobeBrand(Azure),
  baseten: lobeBrand(Baseten),
  cerebras: lobeBrand(Cerebras),
  "cloudflare-ai-gateway": lobeBrand(Cloudflare),
  "cloudflare-workers-ai": lobeBrand(WorkersAI),
  fireworks: lobeBrand(Fireworks),
  "github-copilot": {
    Mono: GithubCopilot,
    // Copilot ships a black mark only: light surface + hairline, like OpenAI.
    background: "#ffffff",
    foreground: GithubCopilot.colorPrimary || "#000000",
    ring: "0 0 0 1px rgba(0,0,0,0.12)",
  },
  google: lobeBrand(Google),
  "google-vertex": lobeBrand(VertexAI),
  groq: lobeBrand(Groq),
  huggingface: lobeBrand(HuggingFace),
  "kimi-coding": {
    Mono: Kimi,
    // Kimi's colour mark is blue + white, drawn for a dark surface.
    Color: Kimi.Color,
    background: "#111111",
    foreground: "#ffffff",
  },
  minimax: lobeBrand(Minimax),
  "minimax-cn": lobeBrand(Minimax),
  mistral: lobeBrand(Mistral),
  moonshotai: lobeBrand(Moonshot),
  "moonshotai-cn": lobeBrand(Moonshot),
  nvidia: lobeBrand(Nvidia),
  opencode: lobeBrand(OpenCode),
  "opencode-go": lobeBrand(OpenCode),
  openrouter: {
    Mono: OpenRouter,
    // OpenRouter's lime mark is meant for a dark surface.
    Color: OpenRouter.Color,
    background: "#111111",
    foreground: OpenRouter.colorPrimary || "#ffffff",
  },
  radius: {
    Mono: RadiusMono,
    Color: RadiusColor,
    background: "color-mix(in srgb, #4d9abf 14%, transparent)",
    foreground: "#4d9abf",
  },
  "qwen-token-plan": lobeBrand(Qwen),
  "qwen-token-plan-cn": lobeBrand(Qwen),
  "qwen-token-plan-individual": lobeBrand(Qwen),
  together: lobeBrand(Together),
  "vercel-ai-gateway": lobeBrand(Vercel),
  xiaomi: lobeBrand(XiaomiMiMo),
  "xiaomi-token-plan-ams": lobeBrand(XiaomiMiMo),
  "xiaomi-token-plan-cn": lobeBrand(XiaomiMiMo),
  "xiaomi-token-plan-sgp": lobeBrand(XiaomiMiMo),
  zai: lobeBrand(ZAI),
  "zai-coding-cn": lobeBrand(ZAI),
};

/**
 * `providerId` is a plain string: auth and model catalogs share ids, and an
 * id without a brand mark falls back to the label's first letter.
 */
export function ProviderIcon({
  providerId,
  label,
  size = 20,
  className,
}: {
  providerId: string;
  label?: string;
  size?: number;
  className?: string;
}) {
  const brand = providerBrands[providerId];
  const badgeClassName =
    className ?? "inline-flex size-9 shrink-0 items-center justify-center rounded-lg";

  if (!brand) {
    return (
      <span
        aria-hidden
        data-testid={`provider-icon-${providerId}`}
        data-provider-brand="fallback"
        className={`${badgeClassName} text-sm font-medium`}
        style={{
          backgroundColor: "var(--surface-muted)",
          color: "var(--foreground)",
          boxShadow: "0 0 0 var(--border-width) var(--separator)",
        }}
      >
        {(label ?? providerId).trim().charAt(0).toLocaleUpperCase("en-US")}
      </span>
    );
  }

  const Icon = brand.Color ?? brand.Mono;
  const usesColorSvg = Boolean(brand.Color);

  return (
    <span
      aria-hidden
      data-testid={`provider-icon-${providerId}`}
      data-provider-brand={providerId}
      className={badgeClassName}
      style={{
        backgroundColor: brand.background,
        color: usesColorSvg ? undefined : brand.foreground,
        boxShadow: brand.ring,
      }}
    >
      <Icon size={size} />
    </span>
  );
}

/**
 * Bare provider glyph in currentColor, no badge surface — for inline
 * placement next to text (model selector trigger/list rows) where the
 * Settings badge treatment (background, ring, letter fallback) is too heavy.
 * Unknown providers render nothing by default: there is no glyph to draw,
 * and a letter fallback would read as a real brand mark inline.
 *
 * `reserveSlot` swaps that to an empty same-size box instead, for contexts
 * (model list rows) where several marks sit in one column and an unknown
 * provider's missing glyph must not pull its neighbouring label left.
 */
export function ProviderMark({
  providerId,
  size = 14,
  className,
  reserveSlot = false,
}: {
  providerId: string;
  size?: number;
  className?: string;
  reserveSlot?: boolean;
}) {
  const brand = providerBrands[providerId];

  if (!brand) {
    return reserveSlot ? (
      <span className={className} data-testid="provider-mark-placeholder" />
    ) : null;
  }

  return (
    <brand.Mono
      aria-hidden
      className={className}
      data-testid={`provider-mark-${providerId}`}
      size={size}
    />
  );
}
