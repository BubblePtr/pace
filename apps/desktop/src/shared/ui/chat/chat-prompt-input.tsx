import {
  type ClipboardEvent,
  type ComponentProps,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ChatComposer,
  ChatSendButton,
  useChatComposerContext,
} from "@astryxdesign/core/Chat";

export type PromptInputStatus = "ready" | "submitted" | "streaming" | "error";

/**
 * Native textarea wired into the Astryx composer context. Kept native (not
 * the contentEditable ChatComposerInput) for the platform textarea behavior
 * and the placeholder/value test surface, per issue 09.
 */
function PromptTextArea({
  disabled = false,
  inputRef,
  onFiles,
  onSubmitRequest,
}: {
  disabled?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onFiles?: (files: File[]) => void;
  onSubmitRequest: () => void;
}) {
  const context = useChatComposerContext();
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaRef = inputRef ?? localRef;

  useEffect(() => {
    const control = context?.inputControlRef;

    if (!control) {
      return;
    }

    control.current = { focus: () => textareaRef.current?.focus() };
    return () => {
      control.current = null;
    };
  }, [context?.inputControlRef, textareaRef]);

  if (!context) {
    return null;
  }

  const autosize = () => {
    const textarea = textareaRef.current;

    if (!textarea) {
      return;
    }

    textarea.style.height = "auto";

    if (textarea.scrollHeight > 0) {
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME confirmation belongs to text entry; 229 covers composition ending before keydown.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      return;
    }

    if (event.key !== "Enter") {
      return;
    }

    // Shift+Enter inserts a newline; Enter and Cmd/Ctrl+Enter submit.
    if (event.shiftKey) {
      return;
    }

    event.preventDefault();
    // Submit through our own path: the composer's context.onSubmit eagerly
    // clears the value via onChange("") even in controlled mode, but the
    // caller owns clearing (a failed submit must keep the draft).
    onSubmitRequest();
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...(event.clipboardData?.files ?? [])];

    if (!files.length || !onFiles) {
      return;
    }

    event.preventDefault();
    onFiles(files);
  };

  return (
    <textarea
      ref={textareaRef}
      className="prompt-input__textarea"
      data-slot="prompt-input-textarea"
      disabled={disabled}
      placeholder={context.placeholder}
      rows={1}
      value={context.value}
      onChange={(event) => {
        context.onChange(event.target.value);
        autosize();
      }}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
    />
  );
}

/**
 * Prompt composer over Astryx ChatComposer. The shell, slot layout, send/stop
 * button, and error status are Astryx; the textarea stays native and the
 * neutral footer hint is ours (Astryx status only carries error/warning).
 */
type ChatPromptInputOwnProps = {
  value: string;
  status?: PromptInputStatus;
  placeholder?: string;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  allowSubmitWhileRunning?: boolean;
  lockInputOnRun?: boolean;
  startActions?: ReactNode;
  endActions?: ReactNode;
  drawer?: ReactNode;
  footer?: ReactNode;
  error?: string | null;
  hasAttachments?: boolean;
  onSubmit?: () => void;
  onStop?: () => void;
  onValueChange?: (value: string) => void;
  onFiles?: (files: File[]) => void;
};

export type ChatPromptInputProps = Omit<
  ComponentProps<"div">,
  keyof ChatPromptInputOwnProps | "children"
> &
  ChatPromptInputOwnProps;

export function ChatPromptInput({
  value,
  status = "ready",
  className = "",
  placeholder,
  inputRef,
  allowSubmitWhileRunning = false,
  lockInputOnRun = false,
  startActions,
  endActions,
  drawer,
  footer,
  error,
  hasAttachments = false,
  onSubmit,
  onStop,
  onValueChange,
  onFiles,
  ...rest
}: ChatPromptInputProps) {
  const isRunning = status === "streaming" || status === "submitted";
  const isStopShown = isRunning && !value.trim() && !hasAttachments && Boolean(onStop);
  const canSubmit =
    (Boolean(value.trim()) || hasAttachments) &&
    (!isRunning || allowSubmitWhileRunning);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const handleSubmit = () => {
    if (!canSubmit) {
      return;
    }

    onSubmit?.();
  };

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!onFiles) {
      return;
    }

    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!onFiles) {
      return;
    }

    event.preventDefault();
    dragDepth.current -= 1;

    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragging(false);
    }
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!onFiles) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!onFiles) {
      return;
    }

    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    onFiles([...event.dataTransfer.files]);
  };

  return (
    <div
      className={`prompt-input ${className}`.trim()}
      data-drop={dragging ? "" : undefined}
      data-slot="prompt-input"
      data-status={status}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      {...rest}
    >
      <ChatComposer
        drawer={drawer}
        elevation="low"
        footerActions={startActions}
        input={
          <PromptTextArea
            disabled={lockInputOnRun && isRunning}
            inputRef={inputRef}
            onFiles={onFiles}
            onSubmitRequest={handleSubmit}
          />
        }
        isStopShown={isStopShown}
        placeholder={placeholder}
        sendActions={endActions}
        sendButton={
          <ChatSendButton
            className="pigui-pressable"
            isDisabled={!isStopShown && !canSubmit}
            // Bypass the composer's submit path, which force-clears the value.
            onSend={handleSubmit}
          />
        }
        status={error ? { type: "error", message: error } : undefined}
        value={value}
        onChange={(next) => onValueChange?.(next)}
        onStop={onStop}
        onSubmit={handleSubmit}
      />
      {footer ? (
        <div className="prompt-input__footer" data-slot="prompt-input-footer">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
