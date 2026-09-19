import type { CSSProperties } from "react";

/**
 * Radius's official brand mark (https://radius.earendil.com): the four-piece
 * "R" glyph from its favicon (mono) and word-mark (colour pieces). The hex
 * values below are Radius's brand constants, lifted verbatim from the source
 * SVGs so the mark stays in sync with the gateway's own branding.
 */

type GlyphIconProps = {
  size?: number | string;
  className?: string;
  style?: CSSProperties;
};

export function RadiusMono({ size = "1em", className, style }: GlyphIconProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 560 560"
      width={size}
      height={size}
      className={className}
      style={style}
    >
      <path
        fill="currentColor"
        fill-rule="evenodd"
        clip-rule="evenodd"
        d="M560 140h-70c0 71.3-21.4 137.7-58 193l128 128-99 99-128-128a348 348 0 0 1-193 58v70H0V140h140V0h420zm-420 0v210c116 0 210-94 210-210z"
      />
    </svg>
  );
}

export function RadiusColor({ size = "1em", className, style }: GlyphIconProps) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 12 560 560"
      width={size}
      height={size}
      className={className}
      style={style}
    >
      <path
        fill="#f1be58"
        d="m352.349 265.352 207.625 207.625-98.995 98.995-207.625-207.625z"
      />
      <path fill="#4d9abf" d="M140 572H0V152.398h140z" />
      <path fill="#f09082" d="M560 152.398H140v-140h420z" />
      <path
        fill="#83ccd2"
        d="M478.994 152.398C477.922 339.141 326.743 490.319 140 491.392V351.387c109.422-1.067 197.923-89.566 198.989-198.989z"
      />
    </svg>
  );
}
