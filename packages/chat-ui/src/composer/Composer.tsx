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
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import type { ChatAttachment, SendInput, SlashCommand, ThreadStatus } from "../sdkTypes";
import {
  blockedHint,
  resolveComposerState,
  resolveKeyIntent,
} from "./composerState";

/**
 * Merge `incoming` into `current`, keyed by `id`.
 *
 * An id already staged is replaced in place (newer metadata, same position);
 * a new id is appended; duplicate ids inside either list collapse to their
 * last occurrence's data at their first occurrence's position. The result
 * never holds one id twice.
 */
export function mergeAttachments(
  current: readonly ChatAttachment[],
  incoming: readonly ChatAttachment[] = [],
): ChatAttachment[] {
  const merged: ChatAttachment[] = [];
  const indexById = new Map<string, number>();
  for (const attachment of [...current, ...incoming]) {
    const existing = indexById.get(attachment.id);
    if (existing === undefined) {
      indexById.set(attachment.id, merged.length);
      merged.push(attachment);
    } else {
      merged[existing] = attachment;
    }
  }
  return merged;
}

export type ComposerProps = {
  /**
   * Start a new turn. Resolve `false` to decline: the composer puts the draft
   * and the staged attachments back, with no error shown. Any other result
   * leaves the composer cleared.
   */
  onSend: (input: SendInput) => unknown;
  /**
   * Deliver into a running turn. Omit to disable steering entirely.
   *
   * Receives the staged attachments exactly like `onSend`, and is called with
   * empty text when only attachments are staged. The composer clears its
   * staged files when the steer is handed off and puts them back if it throws.
   */
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
   *
   * The composer stages what this returns itself — do NOT also add the
   * returned items to a controlled `attachments` list, or they are merged a
   * second time (harmlessly, since ids de-duplicate, but pointlessly). See
   * `attachments` for the merge rule.
   */
  onRequestAttachment?: () => Promise<ChatAttachment[] | null> | ChatAttachment[] | null;
  /**
   * Controlled attachment list; omit to let the composer manage its own.
   *
   * MERGE RULE. `onAttachmentsChange` is always called with the COMPLETE next
   * list; replace your state with it, never append it. The composer computes
   * that list as follows:
   *   - Picker (`onRequestAttachment`): once the picker resolves, the returned
   *     items are merged into the LATEST `attachments` value (read after the
   *     await), so anything the host staged while the picker was open — a
   *     drop, a paste — is kept.
   *   - Merge is by `id`: an id already staged is replaced in place, a new id
   *     is appended. Duplicate ids in the list you pass are shown once.
   *   - Remove (the × on a chip) drops that one id and keeps everything else.
   *   - Submit sends the list and then calls `onAttachmentsChange([])`; a
   *     failed send or steer restores the sent items merged with whatever was
   *     staged meanwhile.
   * A host adding its own items (drag-and-drop, paste) merges them into its
   * state by `id` the same way (`mergeAttachments` is exported for this).
   */
  attachments?: ChatAttachment[];
  /** Called with the complete next attachment list. See `attachments`. */
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;

  /** Slot for the model rail (typically `<ModelPicker>` in a trigger). */
  modelRail?: ReactNode;
  /** Extra controls, rendered after the rail. */
  actions?: ReactNode;
  /** Errors from a failed send, surfaced under the input. */
  error?: string | null;
  /** Runtime commands for slash autocomplete. Omit when unsupported. */
  slashCommands?: readonly SlashCommand[] | null;
  slashCommandsLoading?: boolean;
  slashCommandsError?: string | null;
  onRetrySlashCommands?: () => void | Promise<void>;
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
  slashCommands,
  slashCommandsLoading = false,
  slashCommandsError = null,
  onRetrySlashCommands,
  className,
}: ComposerProps) {
  const [internalDraft, setInternalDraft] = useState("");
  const [internalAttachments, setInternalAttachments] = useState<ChatAttachment[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [cursorPosition, setCursorPosition] = useState<number | null>(null);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [dismissedSlashQuery, setDismissedSlashQuery] = useState<string | null>(null);
  const slashMenuId = `adechat-slash-${useId()}`;

  const draft = value ?? internalDraft;
  // De-duplicated for display and for sending: two chips under one React key
  // clash, and one × click used to remove every copy.
  const staged = useMemo(
    () => mergeAttachments(attachments ?? internalAttachments),
    [attachments, internalAttachments],
  );
  /**
   * The latest staged list, readable after an `await`. A closure captured
   * before the picker opened would otherwise overwrite whatever the host
   * staged while it was open. Updated during render for the controlled prop;
   * `setStaged` writes it too, so two changes in one tick see each other.
   */
  const stagedRef = useRef(staged);
  stagedRef.current = staged;

  const setDraft = useCallback(
    (next: string) => {
      if (value === undefined) setInternalDraft(next);
      onValueChange?.(next);
    },
    [onValueChange, value],
  );

  const controlled = attachments !== undefined;
  const setStaged = useCallback(
    (next: ChatAttachment[]) => {
      stagedRef.current = next;
      if (!controlled) setInternalAttachments(next);
      onAttachmentsChange?.(next);
    },
    [controlled, onAttachmentsChange],
  );

  const state = resolveComposerState({
    draft,
    status,
    ready,
    disabled,
    allowSteer: Boolean(onSteer),
    hasAttachments: staged.length > 0,
  });

  const slashMatch = useMemo(() => {
    const cursor = cursorPosition ?? draft.length;
    const before = draft.slice(0, cursor);
    const match = /^\/([^\s/]*)$/.exec(before);
    return match ? { start: 0, query: match[1] ?? "" } : null;
  }, [cursorPosition, draft]);
  const slashSuggestions = useMemo(() => {
    if (!slashMatch || !slashCommands) return [];
    const query = slashMatch.query.toLocaleLowerCase();
    return slashCommands
      .filter((command) => command.name.replace(/^\//, "").toLocaleLowerCase().startsWith(query))
      .slice(0, 10);
  }, [slashCommands, slashMatch]);
  const slashMenuOpen = Boolean(
    slashMatch
    && dismissedSlashQuery !== slashMatch.query
    && (slashCommands !== undefined || slashCommandsLoading || slashCommandsError),
  );

  useEffect(() => setSelectedSlashIndex(0), [slashMatch?.query]);

  const selectSlashCommand = useCallback((command: SlashCommand) => {
    if (!slashMatch) return;
    const cursor = inputRef.current?.selectionStart ?? draft.length;
    const before = draft.slice(0, slashMatch.start);
    const after = draft.slice(cursor);
    const name = command.name.replace(/^\//, "");
    const next = `${before}/${name} ${after}`;
    const nextCursor = before.length + name.length + 2;
    setDraft(next);
    setCursorPosition(nextCursor);
    setDismissedSlashQuery(null);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      input?.focus();
      input?.setSelectionRange(nextCursor, nextCursor);
    });
  }, [draft, setDraft, slashMatch]);

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
    // Put the text back, and the files with it — merged, so nothing staged
    // meanwhile is dropped.
    const restore = () => {
      setDraft(action.text);
      setStaged(mergeAttachments(staged, stagedRef.current));
    };
    try {
      if (action.kind === "steer" && onSteer) await onSteer(input);
      else if ((await onSend(input)) === false) restore();
    } catch (cause: unknown) {
      // A transport failure must not lose the message.
      restore();
      setSubmitError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [onSend, onSteer, setDraft, setStaged, staged, state.action]);

  const interrupt = useCallback(async () => {
    if (!onInterrupt || !state.canInterrupt) return;
    await onInterrupt();
  }, [onInterrupt, state.canInterrupt]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (slashMenuOpen) {
        if (event.key === "ArrowDown" && slashSuggestions.length > 0) {
          event.preventDefault();
          setSelectedSlashIndex((current) => (current + 1) % slashSuggestions.length);
          return;
        }
        if (event.key === "ArrowUp" && slashSuggestions.length > 0) {
          event.preventDefault();
          setSelectedSlashIndex((current) => (current - 1 + slashSuggestions.length) % slashSuggestions.length);
          return;
        }
        if ((event.key === "Enter" || event.key === "Tab") && slashSuggestions.length > 0) {
          event.preventDefault();
          selectSlashCommand(slashSuggestions[selectedSlashIndex] ?? slashSuggestions[0]!);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setDismissedSlashQuery(slashMatch?.query ?? "");
          return;
        }
      }
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
    [draft, interrupt, onInterrupt, sendOnEnter, slashMatch, slashMenuOpen, slashSuggestions, selectedSlashIndex, selectSlashCommand, state.running, submit],
  );

  const attach = useCallback(async () => {
    if (!onRequestAttachment) return;
    const next = await onRequestAttachment();
    if (!next || next.length === 0) return;
    // `stagedRef`, not `staged`: the list may have changed while the picker
    // was open, and the closure's copy is from before it opened.
    setStaged(mergeAttachments(stagedRef.current, next));
  }, [onRequestAttachment, setStaged]);

  const remove = useCallback(
    (id: string) => setStaged(stagedRef.current.filter((item) => item.id !== id)),
    [setStaged],
  );

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
                onClick={() => remove(attachment.id)}
                aria-label={`Remove ${attachment.name}`}
              >
                {attachment.name} ×
              </button>
            ))}
          </div>
        ) : null}

        {slashMenuOpen ? (
          <div className="adechat-slash-menu" id={slashMenuId} role="listbox" aria-label="Slash commands">
            {slashCommandsLoading && slashCommands === null ? <p className="adechat-slash-state">Loading commands…</p> : null}
            {slashCommandsError ? (
              <div className="adechat-slash-error" role="alert">
                <span>Couldn’t load slash commands.</span>
                {onRetrySlashCommands ? <button type="button" className="adechat-button" onClick={() => void onRetrySlashCommands()} disabled={slashCommandsLoading}>Retry</button> : null}
              </div>
            ) : null}
            {slashSuggestions.map((command, index) => {
              const name = command.name.replace(/^\//, "");
              const optionId = `${slashMenuId}-${index}`;
              return (
                <button
                  type="button"
                  role="option"
                  id={optionId}
                  aria-selected={index === selectedSlashIndex}
                  className="adechat-slash-option"
                  key={`${command.name}-${index}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectSlashCommand(command)}
                >
                  <span>/{name}</span>
                  {command.argumentHint ? <small>{command.argumentHint}</small> : null}
                  {command.description ? <span className="adechat-slash-description">{command.description}</span> : null}
                </button>
              );
            })}
            {!slashCommandsLoading && !slashCommandsError && slashCommands !== null && slashSuggestions.length === 0 ? (
              <p className="adechat-slash-state">No matching commands.</p>
            ) : null}
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
          onChange={(event) => {
            setDraft(event.target.value);
            setCursorPosition(event.currentTarget.selectionStart);
            setDismissedSlashQuery(null);
          }}
          onKeyDown={handleKeyDown}
          onClick={(event) => setCursorPosition(event.currentTarget.selectionStart)}
          onKeyUp={(event) => setCursorPosition(event.currentTarget.selectionStart)}
          aria-label="Message"
          {...(slashMenuOpen ? {
            "aria-autocomplete": "list" as const,
            "aria-controls": slashMenuId,
            "aria-expanded": true,
            ...(slashSuggestions[selectedSlashIndex] ? { "aria-activedescendant": `${slashMenuId}-${selectedSlashIndex}` } : {}),
          } : {})}
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
