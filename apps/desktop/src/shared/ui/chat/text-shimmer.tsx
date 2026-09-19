import type { ComponentProps, ReactNode } from "react";

/**
 * CSS-only shimmer for short loading/brand text. The gradient sweep lives in
 * chat.css so the component stays a single styled span. `tone="brand"` swaps
 * the grey runtime-activity sweep for the coral -> yellow -> blue Pi mark
 * colors; it exists for the one place color marks "Pi is here" (the empty
 * state's "Pace" word), never for ambient loading copy like "Thinking…".
 */
export type TextShimmerTone = "default" | "brand";

export type TextShimmerProps = ComponentProps<"span"> & {
  children: ReactNode;
  tone?: TextShimmerTone;
};

export function TextShimmer({
  children,
  className = "",
  tone = "default",
  ...rest
}: TextShimmerProps) {
  const toneClass = tone === "brand" ? " text-shimmer--brand" : "";

  return (
    <span
      className={`text-shimmer${toneClass} ${className}`.trim()}
      data-slot="text-shimmer"
      data-tone={tone}
      {...rest}
    >
      {children}
    </span>
  );
}
