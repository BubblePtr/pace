import { type ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ChatPromptInput } from "@/shared/ui/chat/chat-prompt-input";

function renderPromptInput({
  value = "",
  status,
  allowSubmitWhileRunning,
  lockInputOnRun,
  hasAttachments,
  drawer,
  accent,
  onSubmit = () => {},
  onStop,
  onValueChange = () => {},
  onFiles,
  error,
}: {
  value?: string;
  status?: "ready" | "submitted" | "streaming" | "error";
  allowSubmitWhileRunning?: boolean;
  lockInputOnRun?: boolean;
  hasAttachments?: boolean;
  drawer?: ReactNode;
  accent?: "brand";
  onSubmit?: () => void;
  onStop?: () => void;
  onValueChange?: (value: string) => void;
  onFiles?: (files: File[]) => void;
  error?: string;
} = {}) {
  return render(
    <ChatPromptInput
      accent={accent}
      allowSubmitWhileRunning={allowSubmitWhileRunning}
      drawer={drawer}
      error={error}
      footer="footer text"
      hasAttachments={hasAttachments}
      lockInputOnRun={lockInputOnRun}
      placeholder="Type here"
      startActions={<span>start</span>}
      status={status}
      value={value}
      onFiles={onFiles}
      onStop={onStop}
      onSubmit={onSubmit}
      onValueChange={onValueChange}
    />,
  );
}

describe("ChatPromptInput", () => {
  it("renders the Astryx composer shell with a native textarea and footer", () => {
    const { container } = renderPromptInput({ status: "streaming" });

    const root = container.querySelector('[data-slot="prompt-input"]');
    const textarea = screen.getByPlaceholderText("Type here");

    expect(root).toBeInTheDocument();
    expect(root).toHaveAttribute("data-status", "streaming");
    expect(root?.querySelector(".astryx-chat-composer")).toBeInTheDocument();
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea).toHaveAttribute("data-slot", "prompt-input-textarea");
    expect(screen.getByText("footer text")).toBeInTheDocument();
    expect(screen.getByText("start")).toBeInTheDocument();
  });

  it("has no accent attribute by default, opting into the brand accent explicitly", () => {
    const { container: withoutAccent } = renderPromptInput();
    expect(
      withoutAccent.querySelector('[data-slot="prompt-input"]'),
    ).not.toHaveAttribute("data-accent");

    const { container: withAccent } = renderPromptInput({ accent: "brand" });
    expect(withAccent.querySelector('[data-slot="prompt-input"]')).toHaveAttribute(
      "data-accent",
      "brand",
    );
  });

  it("surfaces errors through the Astryx composer status", () => {
    renderPromptInput({ error: "Runtime rejected the prompt" });

    expect(screen.getByText("Runtime rejected the prompt")).toBeInTheDocument();
  });

  it("submits on Enter and inserts a newline on Shift+Enter", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    renderPromptInput({ value: "hello", onSubmit });

    const textarea = screen.getByPlaceholderText("Type here");

    await user.type(textarea, "{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await user.type(textarea, "{Shift>}{Enter}{/Shift}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it.each([
    { isComposing: true, keyCode: 13 },
    { isComposing: false, keyCode: 229 },
  ])("preserves the draft on IME Enter ($isComposing, $keyCode)", (ime) => {
    const onSubmit = vi.fn();
    const onValueChange = vi.fn();
    renderPromptInput({ value: "你好", onSubmit, onValueChange });
    const textarea = screen.getByPlaceholderText("Type here");

    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      ...ime,
    });
    fireEvent(textarea, event);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onValueChange).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("你好");
    expect(event.defaultPrevented).toBe(false);

    fireEvent.keyDown(textarea, { key: "Enter", isComposing: false, keyCode: 13 });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("submits on Cmd+Enter", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    renderPromptInput({ value: "hello", onSubmit });

    await user.type(screen.getByPlaceholderText("Type here"), "{Meta>}{Enter}{/Meta}");

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not submit an empty value", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    renderPromptInput({ value: "   ", onSubmit });

    await user.type(screen.getByPlaceholderText("Type here"), "{Enter}");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("locks the textarea while running when lockInputOnRun is set", () => {
    renderPromptInput({ status: "streaming", lockInputOnRun: true });

    expect(screen.getByPlaceholderText("Type here")).toBeDisabled();
  });

  it("keeps the textarea editable while running when submits are allowed", () => {
    renderPromptInput({
      status: "streaming",
      allowSubmitWhileRunning: true,
      lockInputOnRun: false,
    });

    expect(screen.getByPlaceholderText("Type here")).not.toBeDisabled();
  });

  it("calls onStop instead of onSubmit when running with an empty value", async () => {
    const onStop = vi.fn();
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    renderPromptInput({
      value: "",
      status: "streaming",
      allowSubmitWhileRunning: true,
      lockInputOnRun: false,
      onStop,
      onSubmit,
    });

    await user.click(screen.getByRole("button", { name: "Stop" }));

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps Send while running when attachments are present", async () => {
    const onStop = vi.fn();
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    renderPromptInput({
      value: "",
      status: "streaming",
      allowSubmitWhileRunning: true,
      hasAttachments: true,
      lockInputOnRun: false,
      onStop,
      onSubmit,
    });

    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("submits while running when a value is present and submits are allowed", async () => {
    const onStop = vi.fn();
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    renderPromptInput({
      value: "queued follow-up",
      status: "streaming",
      allowSubmitWhileRunning: true,
      lockInputOnRun: false,
      onStop,
      onSubmit,
    });

    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("uses the Astryx send/stop accessible names", () => {
    renderPromptInput({ value: "go" });

    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("forwards text edits through onValueChange", async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();

    renderPromptInput({ onValueChange });

    await user.type(screen.getByPlaceholderText("Type here"), "a");

    expect(onValueChange).toHaveBeenCalledWith("a");
  });

  it("renders a drawer above the input", () => {
    renderPromptInput({ drawer: <div>2 attachments</div> });

    expect(screen.getByText("2 attachments")).toBeInTheDocument();
  });

  it("submits an empty value when attachments are present", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    renderPromptInput({ hasAttachments: true, onSubmit });

    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("forwards pasted files", () => {
    const onFiles = vi.fn();
    const image = new File(["png"], "shot.png", { type: "image/png" });

    renderPromptInput({ onFiles });

    fireEvent.paste(screen.getByPlaceholderText("Type here"), {
      clipboardData: { files: [image] },
    });

    expect(onFiles).toHaveBeenCalledWith([image]);
  });

  it("recedes the empty-state placeholder below composer chrome", () => {
    const css = readFileSync(
      join(process.cwd(), "apps/desktop/src/shared/ui/chat/chat.css"),
      "utf8",
    );
    const trigger = readFileSync(
      join(
        process.cwd(),
        "apps/desktop/src/shared/ui/model-selector/model-selector-control.tsx",
      ),
      "utf8",
    );

    // Model selector sits on --color-text-secondary via text-muted; the
    // placeholder must use the next weaker Astryx step so the hint recedes.
    expect(trigger).toMatch(
      /className="[^"]*text-muted[^"]*"[\s\S]*?data-testid="model-thinking-trigger"/,
    );
    expect(css).toMatch(
      /\.prompt-input__textarea::placeholder\s*\{[^}]*color:\s*var\(--color-text-disabled\)/,
    );
  });

  it("separates the input from the model-selector row by one extra spacing step", () => {
    const css = readFileSync(
      join(process.cwd(), "apps/desktop/src/shared/ui/chat/chat.css"),
      "utf8",
    );

    expect(css).toMatch(
      /\.astryx-chat-composer\s*>\s*div:has\(\.prompt-input__textarea\)\s*\{[^}]*gap:\s*var\(--spacing-3\)/,
    );
  });

  it("tightens ChatComposer body padding by one spacing step", () => {
    const css = readFileSync(
      join(process.cwd(), "apps/desktop/src/shared/ui/chat/chat.css"),
      "utf8",
    );

    expect(css).toMatch(
      /\.prompt-input\s+\.astryx-chat-composer\s*\{[^}]*--_chat-composer-padding:\s*var\(--spacing-2\)/,
    );
  });

  it("keeps the composer radius concentric with the circular send button", () => {
    const css = readFileSync(
      join(process.cwd(), "apps/desktop/src/shared/ui/chat/chat.css"),
      "utf8",
    );

    // Astryx: inner button radius = outer − padding. The md send button is
    // --size-element-md (32px), so a circle is half that. Outer must be
    // padding + that half, or the corner gutter pinches.
    expect(css).toMatch(
      /\.prompt-input\s+\.astryx-chat-composer\s*\{[^}]*--_chat-composer-radius:\s*calc\(\s*var\(--_chat-composer-padding\)\s*\+\s*var\(--size-element-md\)\s*\/\s*2\s*\)/,
    );
  });
});
