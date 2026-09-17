import { Button } from "@astryxdesign/core/Button";
import type { ComponentProps } from "react";
import type { PresenceMotion } from "@/shared/ui/chat/use-presence-list";

/**
 * One waiting-area row under a running session: a queued follow-up rendered on
 * a single truncating line, carrying its own routing actions. Steer promotes
 * the message into the current run (only offered while a run is active);
 * Withdraw removes it. Pending rows are whole-card draggable; order is
 * expressed by position, not numbering.
 * Decision record: .scratch/composer-redesign/PRD.md
 */
type ChatQueuedMessageOwnProps = {
  body: string;
  isWithdrawn?: boolean;
  /** Whole-card drag; 45% opacity. Decision: .scratch/composer-redesign/PRD.md */
  isDragging?: boolean;
  /** Accent line on the top or bottom edge of the drop target. */
  dropTarget?: "before" | "after";
  /** List presence; omit on first paint so a restored queue does not enter. */
  presence?: PresenceMotion;
  onExitTransitionEnd?: () => void;
  /** Omit when no run is active: Steer must not render as a dead action. */
  onSteer?: () => void;
  onWithdraw?: () => void;
};

export type ChatQueuedMessageProps = Omit<
  ComponentProps<"div">,
  keyof ChatQueuedMessageOwnProps | "children"
> &
  ChatQueuedMessageOwnProps;

export function ChatQueuedMessage({
  body,
  isWithdrawn = false,
  isDragging = false,
  dropTarget,
  presence = "none",
  onExitTransitionEnd,
  onSteer,
  onWithdraw,
  className,
  onTransitionEnd,
  ...rest
}: ChatQueuedMessageProps) {
  return (
    <div
      className={`chat-queued-message flex min-w-0 items-center rounded-lg border border-border bg-surface text-sm ${
        isWithdrawn ? "gap-3 px-3 py-2" : "gap-2 py-1.5 pl-3 pr-2"
      } ${className ?? ""}`.trim()}
      aria-hidden={presence === "exit" ? true : undefined}
      data-dragging={isDragging ? "" : undefined}
      data-drop-target={dropTarget}
      data-presence={presence === "none" ? undefined : presence}
      data-testid="chat-queued-message"
      data-withdrawn={isWithdrawn ? "" : undefined}
      {...rest}
      onTransitionEnd={(event) => {
        onTransitionEnd?.(event);
        if (
          presence === "exit" &&
          event.target === event.currentTarget &&
          event.propertyName === "opacity"
        ) {
          onExitTransitionEnd?.();
        }
      }}
    >
      <p
        className="chat-queued-message__body min-w-0 flex-1 truncate"
        data-slot="queued-message-body"
        title={body}
      >
        {body}
      </p>
      {isWithdrawn ? (
        <span className="shrink-0 text-xs font-medium text-muted">Withdrawn</span>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          {onSteer ? (
            <Button
              className="pigui-pressable"
              label="Steer the run with this message"
              size="sm"
              variant="secondary"
              onClick={onSteer}
            >
              Steer
            </Button>
          ) : null}
          {onWithdraw ? (
            <Button
              className="pigui-pressable"
              label="Withdraw queued message"
              size="sm"
              variant="ghost"
              onClick={onWithdraw}
            >
              Withdraw
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
