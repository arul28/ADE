/**
 * The composer: a textarea, a send/steer button, a stop button while running,
 * an optional attachment hook, and a slot for the model rail.
 *
 * Interaction rules follow ADE's desktop composer
 * (`apps/desktop/src/renderer/components/chat/AgentChatComposer.tsx`) — Enter
 * sends, Shift+Enter is a newline, IME composition never sends, Escape stops a
 * running turn — but this is a fresh, small implementation rather than a port
 * of that component's prop surface.
 *
 * Attachments are callback-based on purpose: the package never reaches for a
 * global bridge, so a host on the web, in Electron, or in a test all provide
 * the same `onRequestAttachment`.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import type { ChatAttachment, SendInput, ThreadStatus } from "../sdkTypes";
import {
  blockedHint,
  resolveComposerState,
  resolveKeyIntent,
} from "./composerState";

export type ComposerProps = {
  /** Start a new turn. */
  onSend: (input: SendInput) => void | Promise<void>;
  /** Deliver into a running turn. Omit to disable steering entirely. */
  onSteer?: (input: SendInput) => void | Promise<void>;
  /** Stop the running turn. Omit to hide the stop control. */
  onInterrupt?: () => void | Promise<void>;

  status?: ThreadStatus["state"];
  /** False while the thread handle is still resolving. */
  ready?: boolean;
  disabled?: boolean;

  /** Uncontrolled by default; pass both to control the draft. */
  value?: string;
  onValueChange?: (value: string) => void;

  placeholder?: string;
  /** Enter sends (default). False swaps to Cmd/Ctrl+Enter. */
  sendOnEnter?: boolean;
  autoFocus?: boolean;
  /** Grow up to this many rows before scrolling. */
  maxRows?: number;

  /**
   * Invoked when the attachment button is pressed. Resolve with the
   * attachments to stage, or null to cancel. Omit to hide the button.
   */
  onRequestAttachment?: () => Promise<ChatAttachment[] | null> | ChatAttachment[] | null;
  /** Controlled attachment list; omit to let the composer manage its own. */
  attachments?: ChatAttachment[];
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;

  /** Slot for the model rail (typically `<ModelPicker>` in a trigger). */
  modelRail?: ReactNode;
  /** Extra controls, rendered after the rail. */
  actions?: ReactNode;
  /** Errors from a failed send, surfaced under the input. */
  error?: string | null;
  className?: string;
};

export function Composer({
  onSend,
  onSteer,
  onInterrupt,
  status = "idle",
  ready = true,
  disabled = false,
  value,
  onValueChange,
  placeholder = "Send a message…",
  sendOnEnter = true,
  autoFocus = false,
  maxRows = 12,
  onRequestAttachment,
  attachments,
  onAttachmentsChange,
  modelRail,
  actions,
  error,
  className,
}: ComposerProps) {
  const [internalDraft, setInternalDraft] = useState("");
  const [internalAttachments, setInternalAttachments] = useState<ChatAttachment[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const draft = value ?? internalDraft;
  const staged = attachments ?? internalAttachments;

  const setDraft = useCallback(
    (next: string) => {
      if (value === undefined) setInternalDraft(next);
      onValueChange?.(next);
    },
    [onValueChange, value],
  );

  const setStaged = useCallback(
    (next: ChatAttachment[]) => {
      if (attachments === undefined) setInternalAttachments(next);
      onAttachmentsChange?.(next);
    },
    [attachments, onAttachmentsChange],
  );

  const state = resolveComposerState({
    draft,
    status,
    ready,
    disabled,
    allowSteer: Boolean(onSteer),
    hasAttachments: staged.length > 0,
  });

  // Autosize: reset to auto first so the box can shrink as text is deleted.
  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = "auto";
    const lineHeight = Number.parseFloat(getComputedStyle(node).lineHeight) || 20;
    node.style.height = `${Math.min(node.scrollHeight, lineHeight * maxRows)}px`;
  }, [draft, maxRows]);

  const submit = useCallback(async () => {
    const action = state.action;
    if (action.kind === "blocked") return;
    const input: SendInput = {
      text: action.text,
      ...(staged.length ? { attachments: staged } : {}),
    };
    // Clear optimistically: the transcript echoes the message from the event
    // stream, and leaving the draft in place duplicates it on screen.
    setDraft("");
    setStaged([]);
    setSubmitError(null);
    try {
      if (action.kind === "steer" && onSteer) await onSteer(input);
      else await onSend(input);
    } catch (cause: unknown) {
      // Put the text back rather than losing it to a transport failure.
      setDraft(action.text);
      setStaged(staged);
      setSubmitError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [onSend, onSteer, setDraft, setStaged, staged, state.action]);

  const interrupt = useCallback(async () => {
    if (!onInterrupt || !state.canInterrupt) return;
    await onInterrupt();
  }, [onInterrupt, state.canInterrupt]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      const intent = resolveKeyIntent({
        key: event.key,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        // React's synthetic event exposes composition state on the native event.
        isComposing: (event.nativeEvent as unknown as { isComposing?: boolean }).isComposing === true,
        sendOnEnter,
        running: state.running,
        hasDraft: draft.trim().length > 0,
      });
      if (intent === "submit") {
        event.preventDefault();
        void submit();
        return;
      }
      if (intent === "interrupt" && onInterrupt) {
        event.preventDefault();
        void interrupt();
      }
    },
    [draft, interrupt, onInterrupt, sendOnEnter, state.running, submit],
  );

  const attach = useCallback(async () => {
    if (!onRequestAttachment) return;
    const next = await onRequestAttachment();
    if (!next || next.length === 0) return;
    setStaged([...staged, ...next]);
  }, [onRequestAttachment, setStaged, staged]);

  const hint =
    state.action.kind === "blocked" ? blockedHint(state.action.reason) : null;
  const shownError = error ?? submitError;

  return (
    <div className={["adechat-composer", className].filter(Boolean).join(" ")}>
      <div className="adechat-composer-surface">
        {staged.length ? (
          <div className="adechat-attachments">
            {staged.map((attachment) => (
              <button
                key={attachment.id}
                type="button"
                className="adechat-attachment"
                onClick={() => setStaged(staged.filter((item) => item.id !== attachment.id))}
                aria-label={`Remove ${attachment.name}`}
              >
                {attachment.name} ×
              </button>
            ))}
          </div>
        ) : null}

        <textarea
          ref={inputRef}
          className="adechat-composer-input"
          rows={1}
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Message"
        />

        <div className="adechat-composer-actions">
          {onRequestAttachment ? (
            <button
              type="button"
              className="adechat-button adechat-button-icon"
              onClick={() => void attach()}
              disabled={disabled}
              aria-label="Add attachment"
            >
              +
            </button>
          ) : null}
          {modelRail ? <div className="adechat-composer-rail">{modelRail}</div> : null}
          {actions}
          <div className="adechat-composer-spacer" />
          {hint ? <span className="adechat-composer-hint">{hint}</span> : null}
          {state.canInterrupt && onInterrupt ? (
            <button
              type="button"
              className="adechat-button"
              data-variant="danger"
              onClick={() => void interrupt()}
            >
              Stop
            </button>
          ) : null}
          <button
            type="button"
            className="adechat-button"
            data-variant="primary"
            onClick={() => void submit()}
            disabled={!state.canSubmit}
          >
            {state.submitLabel}
          </button>
        </div>
      </div>
      {shownError ? <div className="adechat-composer-error">{shownError}</div> : null}
    </div>
  );
}
