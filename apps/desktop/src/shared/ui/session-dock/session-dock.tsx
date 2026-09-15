import { IconButton } from "@astryxdesign/core/IconButton";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import {
  ToggleButton,
  ToggleButtonGroup,
} from "@astryxdesign/core/ToggleButton";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { AnimatedSidebarRight } from "@/shared/ui/icons";
import {
  sessionSurfaceOrder,
  sessionSurfaces,
  type SessionSurfaceId,
} from "@/shared/ui/session-dock/surface-registry";

/**
 * Session-scoped surface host: one panel plus an icon rail on its own right
 * edge. The rail belongs to the panel, so closing the dock removes both —
 * nothing stays docked against the window (ADR-0028).
 *
 * The host writes nothing above the surface: the rail names the active surface
 * and its tooltip explains it, so the 40px band at the top of the panel is the
 * surface's own first row (`SessionSurfaceBar`), not a header of ours.
 */

/** Panel geometry (ADR-0028); the drag itself is Astryx `useResizable`. */
export const sessionDockDefaultWidthPx = 560;
const minWidthPx = 340;
/**
 * What Chat keeps for itself. The panel may take everything else — a fixed
 * fraction of the viewport used to cap it, which left the Browser surface too
 * narrow on wide windows (ADR-0028, 2026-09-02 revision).
 */
export const sessionDockChatMinWidthPx = 400;

/**
 * @param availableWidth Width Chat and the panel actually share, i.e. the
 * split container minus whatever sits between them (the resize handle's
 * gutter). The caller owns that subtraction because it owns the handle.
 */
export function sessionDockResizableBounds(availableWidth: number) {
  return {
    minSizePx: minWidthPx,
    // Floor, not round: this ceiling exists to protect Chat's minimum, and a
    // fractional container width must not round the panel a pixel over it.
    // A window too narrow for both minimums must not produce an inverted range.
    maxSizePx: Math.max(
      minWidthPx,
      Math.floor(availableWidth - sessionDockChatMinWidthPx),
    ),
  };
}

/**
 * Toolbar affordance for the whole dock. It is the only way back once the
 * panel (and with it the rail) is closed, so it lives with the component.
 */
type SessionDockTriggerOwnProps = {
  /**
   * Docked layouts: seat the toggle on the rail's axis so it reads as the
   * head of the rail column. The slot is rail-width (`w-11`) and cancels the
   * header chrome's 1rem right inset; it stays put whether the panel is open
   * or closed so the toggle never jumps.
   */
  alignToRail?: boolean;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
};

export type SessionDockTriggerProps = Omit<
  ComponentProps<typeof IconButton>,
  keyof SessionDockTriggerOwnProps | "icon" | "label" | "onClick"
> &
  SessionDockTriggerOwnProps;

export function SessionDockTrigger({
  alignToRail = false,
  isOpen,
  onOpenChange,
  className,
  ...rest
}: SessionDockTriggerProps) {
  // A plain ghost button, not a ToggleButton: the panel being open is already
  // obvious, and a pressed fill here would compete with the rail's active
  // surface, which is the selection that matters. aria-pressed keeps the
  // state for assistive tech.
  const toggle = (
    <IconButton
      aria-pressed={isOpen}
      className={`pigui-pressable ${className ?? ""}`.trim()}
      icon={<AnimatedSidebarRight className="size-4" />}
      label="Session dock"
      size="sm"
      tooltip={isOpen ? "Hide dock" : "Show dock"}
      variant="ghost"
      onClick={() => onOpenChange(!isOpen)}
      {...(alignToRail ? undefined : rest)}
    />
  );

  if (!alignToRail) {
    return toggle;
  }

  return (
    <span
      className="-mr-4 flex w-11 shrink-0 justify-center"
      data-testid="session-dock-trigger-rail-slot"
      {...rest}
    >
      {toggle}
    </span>
  );
}

/**
 * Exit is ~28% faster than the 250ms enter. JS unmount must match the CSS
 * duration so a reverse mid-flight still has a node to retarget.
 */
export const sessionDockExitMs = 180;

/**
 * Keep the dock in the tree through its exit transition. Terminal/Browser
 * surfaces own live pty / WebContentsView instances, so the closed dock
 * cannot stay mounted indefinitely — only until the exit finishes.
 */
export function useSessionDockPresence(open: boolean): boolean {
  const [mounted, setMounted] = useState(open);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduced) {
      setMounted(false);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (!openRef.current) {
        setMounted(false);
      }
    }, sessionDockExitMs);

    return () => window.clearTimeout(timeoutId);
  }, [open]);

  return open || mounted;
}

/**
 * True while the panel is sliding open or closed. Surfaces that host native
 * views (Browser) read it to step aside: a `WebContentsView` cannot follow a
 * CSS transform, so it hides behind a still until the dock settles.
 */
export const SessionDockMotionContext = createContext(false);

export function useSessionDockMotion(): boolean {
  return useContext(SessionDockMotionContext);
}

/** Longest dock transition plus slack, in case `transitionend` never fires. */
const dockMotionFallbackMs = 320;

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * "In motion" bookkeeping shared by the dock and the split pane that holds
 * it: true from an open/close flip (or a motion-on mount) until `settle()` —
 * wire that to the element's own `transitionend` — or the fallback timeout.
 */
export function useSessionDockMotionState(open: boolean, mountMotion: boolean) {
  const [moving, setMoving] = useState(() => mountMotion && !prefersReducedMotion());
  const openRef = useRef(open);

  useEffect(() => {
    if (openRef.current === open) {
      return;
    }
    openRef.current = open;
    setMoving(!prefersReducedMotion());
  }, [open]);

  useEffect(() => {
    if (!moving) {
      return;
    }
    const timeoutId = window.setTimeout(() => setMoving(false), dockMotionFallbackMs);
    return () => window.clearTimeout(timeoutId);
  }, [moving]);

  return { moving, settle: () => setMoving(false) };
}

type SessionDockOwnProps = {
  activeSurfaceId: SessionSurfaceId;
  /** Live counts per surface, e.g. changed file count. */
  badges?: Partial<Record<SessionSurfaceId, string>>;
  children: ReactNode;
  /**
   * Play the enter transition when this instance is inserted. Off by default
   * so always-mounted hosts (the design gallery) do not animate on page load.
   */
  mountMotion?: boolean;
  isOpen?: boolean;
  onActiveSurfaceChange: (surfaceId: SessionSurfaceId) => void;
};

export type SessionDockProps = Omit<ComponentProps<"aside">, keyof SessionDockOwnProps> &
  SessionDockOwnProps;

export function SessionDock({
  activeSurfaceId,
  badges,
  children,
  mountMotion = false,
  isOpen = true,
  onActiveSurfaceChange,
  className,
  onTransitionEnd,
  ...rest
}: SessionDockProps) {
  const surface = sessionSurfaces[activeSurfaceId];
  const motion = useSessionDockMotionState(isOpen, mountMotion);
  // Pointer vs keyboard is cheaper to remember on the rail than to thread
  // through Astryx's ToggleButtonGroup, which only reports the next value.
  const pointerSurfaceChangeRef = useRef(false);
  const surfaceMotionRef = useRef({ id: activeSurfaceId, enter: false });

  if (surfaceMotionRef.current.id !== activeSurfaceId) {
    surfaceMotionRef.current = {
      id: activeSurfaceId,
      enter: pointerSurfaceChangeRef.current,
    };
    pointerSurfaceChangeRef.current = false;
  }

  return (
    <aside
      aria-hidden={isOpen ? undefined : true}
      aria-label={surface.title}
      className={`pigui-session-dock flex h-full min-h-0 min-w-0 bg-surface ${className ?? ""}`.trim()}
      data-mount-motion={mountMotion ? "true" : undefined}
      data-open={isOpen ? "true" : "false"}
      data-testid="session-dock"
      inert={isOpen ? undefined : true}
      {...rest}
      onTransitionEnd={(event) => {
        onTransitionEnd?.(event);
        // Only the aside's own slide counts; surface fades bubble up too.
        if (event.target === event.currentTarget) {
          motion.settle();
        }
      }}
    >
      {/* Flush surfaces (registry flushContent) own every inset themselves, so
          their first row and content run edge-to-edge to the rail. */}
      <div
        key={activeSurfaceId}
        className={
          surface.flushContent
            ? "pigui-session-dock-surface min-h-0 min-w-0 flex-1 overflow-y-auto"
            : "pigui-session-dock-surface min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pt-3 pb-4"
        }
        data-motion={surfaceMotionRef.current.enter ? "enter" : undefined}
        data-testid="session-dock-surface"
      >
        <SessionDockMotionContext.Provider value={motion.moving}>
          {children}
        </SessionDockMotionContext.Provider>
      </div>
      <nav
        className="pigui-session-dock-rail flex w-11 shrink-0 flex-col items-center border-l border-separator bg-surface"
        onKeyDownCapture={() => {
          pointerSurfaceChangeRef.current = false;
        }}
        onPointerDownCapture={() => {
          pointerSurfaceChangeRef.current = true;
        }}
      >
        {/* The toolbar toggle (header chrome) floats over this cell, so the
            rail reads as toggle / hairline / surfaces. */}
        <div aria-hidden="true" className="h-10 w-full shrink-0" />
        <div className="flex flex-col items-center py-2">
        <ToggleButtonGroup
          label="Session surfaces"
          orientation="vertical"
          type="single"
          value={activeSurfaceId}
          onChange={(value) => {
            // Astryx reports null when the pressed button is clicked again;
            // the dock always shows exactly one surface.
            if (value !== null) {
              onActiveSurfaceChange(value as SessionSurfaceId);
            }
          }}
        >
          {sessionSurfaceOrder.map((surfaceId) => {
            const meta = sessionSurfaces[surfaceId];
            const RailIcon = meta.icon;
            const badge = badges?.[surfaceId];

            return (
              <Tooltip
                key={surfaceId}
                content={`${meta.title} — ${meta.hint}`}
                placement="start"
              >
                <ToggleButton
                  icon={
                    <span className="relative flex items-center justify-center">
                      <RailIcon className="size-4" />
                      {badge ? (
                        <span className="absolute -top-1.5 -right-2 rounded-full bg-primary px-1 text-[10px] leading-4 font-medium text-background tabular-nums">
                          {badge}
                        </span>
                      ) : null}
                    </span>
                  }
                  isIconOnly
                  label={meta.title}
                  // Same size as the toolbar toggle so the column reads as one.
                  size="sm"
                  value={surfaceId}
                />
              </Tooltip>
            );
          })}
        </ToggleButtonGroup>
        </div>
      </nav>
    </aside>
  );
}
