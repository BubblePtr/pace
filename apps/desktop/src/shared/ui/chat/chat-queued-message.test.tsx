import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatQueuedMessage } from "@/shared/ui/chat/chat-queued-message";

const longBody =
  "顺便把 usage 页面上那个 KPI 卡片的 loading 骨架也统一一下,现在三个卡片的骨架高度不一致,切换 tab 的时候会跳。";

describe("ChatQueuedMessage", () => {
  it("renders the body on a single truncating line with the full text on title", () => {
    render(<ChatQueuedMessage body={longBody} onWithdraw={() => {}} />);

    const card = screen.getByTestId("chat-queued-message");
    const body = card.querySelector('[data-slot="queued-message-body"]');

    expect(body).toHaveTextContent(longBody);
    expect(body).toHaveAttribute("title", longBody);
    expect(body).toHaveClass("truncate");
  });

  it("shows Steer only when steering is available and wires both actions", async () => {
    const user = userEvent.setup();
    const onSteer = vi.fn();
    const onWithdraw = vi.fn();
    render(
      <ChatQueuedMessage body="Queued task" onSteer={onSteer} onWithdraw={onWithdraw} />,
    );

    await user.click(
      screen.getByRole("button", { name: "Steer the run with this message" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Withdraw queued message" }),
    );

    expect(onSteer).toHaveBeenCalledTimes(1);
    expect(onWithdraw).toHaveBeenCalledTimes(1);
  });

  it("hides Steer when no onSteer handler is given (idle run)", () => {
    render(<ChatQueuedMessage body="Queued task" onWithdraw={() => {}} />);

    expect(
      screen.queryByRole("button", { name: "Steer the run with this message" }),
    ).not.toBeInTheDocument();
  });

  it("renders the withdrawn state without actions", () => {
    render(
      <ChatQueuedMessage
        body="Old task"
        isWithdrawn
        onSteer={() => {}}
        onWithdraw={() => {}}
      />,
    );

    expect(screen.getByText("Withdrawn")).toBeInTheDocument();
    expect(screen.getByTestId("chat-queued-message")).toHaveAttribute("data-withdrawn", "");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("exposes list presence on the row so enter/exit can be CSS-driven", () => {
    render(
      <ChatQueuedMessage body="Queued task" presence="enter" onWithdraw={() => {}} />,
    );

    expect(screen.getByTestId("chat-queued-message")).toHaveAttribute(
      "data-presence",
      "enter",
    );
  });

  it("marks the dragging and drop-target states used by waiting-area reorder", () => {
    const { rerender } = render(
      <ChatQueuedMessage body="Queued task" isDragging onWithdraw={() => {}} />,
    );

    expect(screen.getByTestId("chat-queued-message")).toHaveAttribute("data-dragging");

    rerender(
      <ChatQueuedMessage body="Queued task" dropTarget="before" onWithdraw={() => {}} />,
    );

    expect(screen.getByTestId("chat-queued-message")).toHaveAttribute("data-drop-target", "before");
    expect(screen.getByTestId("chat-queued-message")).not.toHaveAttribute("data-dragging");

    rerender(
      <ChatQueuedMessage body="Queued task" dropTarget="after" onWithdraw={() => {}} />,
    );

    expect(screen.getByTestId("chat-queued-message")).toHaveAttribute("data-drop-target", "after");
  });
});
