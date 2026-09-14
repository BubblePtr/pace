import type { ComponentType } from "react";
import { FileDiff, Files, Globe, Terminal } from "@/shared/ui/icons";

/**
 * Registry of the Session-scoped surfaces the SessionDock can host.
 *
 * Metadata only: the panel content stays with the feature that owns the data
 * (Changes, Files, Terminal, Browser), so the registry never grows a
 * dependency on Session state. ADR-0007 deferred the File surface; it is now
 * unfrozen as a read-only checkout browser — editing stays out of scope.
 */
export type SessionSurfaceId = "changes" | "files" | "terminal" | "browser";

export type SessionSurfaceMeta = {
  id: SessionSurfaceId;
  title: string;
  icon: ComponentType<{ className?: string }>;
  /**
   * One line of context. The rail tooltip is its only consumer — the dock lost
   * its header in the 2026-09-05 ADR-0028 revision, so nothing repeats it
   * above the surface.
   */
  hint: string;
  /**
   * Multi-instance surfaces keep a single rail icon and list their instances
   * in the surface's first row (`SessionSurfaceTabs`, ADR-0028). Terminal is
   * the first one: shells come and go, the rail icon and its instance-count
   * badge stay put.
   */
  multiInstance?: boolean;
  /**
   * Flush surfaces render edge-to-edge: the dock drops its content padding and
   * the surface owns every inset itself (terminal canvases want this;
   * documents and forms want the default padding).
   */
  flushContent?: boolean;
};

export const sessionSurfaceOrder = [
  "changes",
  "files",
  "terminal",
  "browser",
] as const satisfies readonly SessionSurfaceId[];

export const sessionSurfaces: Record<SessionSurfaceId, SessionSurfaceMeta> = {
  changes: {
    id: "changes",
    title: "Changes",
    icon: FileDiff,
    hint: "Working tree for this Session checkout",
    flushContent: true,
  },
  files: {
    id: "files",
    title: "Files",
    icon: Files,
    hint: "Browse this Session's checkout",
    flushContent: true,
  },
  terminal: {
    id: "terminal",
    title: "Terminal",
    icon: Terminal,
    hint: "Shells in this Session's checkout",
    multiInstance: true,
    flushContent: true,
  },
  browser: {
    id: "browser",
    title: "Browser",
    icon: Globe,
    hint: "Preview a running dev server",
    multiInstance: true,
    flushContent: true,
  },
};
