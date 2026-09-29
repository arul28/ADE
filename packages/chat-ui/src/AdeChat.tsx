/**
 * The composed default: transcript on top, composer with the model rail
 * beneath it. No header bar — a host that wants a title already has one.
 *
 * Everything here is assembly. If the layout is wrong for an embed, the pieces
 * (`<Transcript>`, `<Composer>`, `<ModelPicker>`, `<ProviderCard>`) are all
 * exported and usable on their own.
 */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { Composer, type ComposerProps } from "./composer/Composer";
import {
  AdeChatProvider,
  useAdeProviders,
  useAdeThread,
  type ThreadState,
} from "./context/AdeChatContext";
import { ModelPicker, type ModelPickerProps } from "./models/ModelPicker";
import { isModelSelectable } from "./models/modelSearch";
import type { ActivityLabelConfig } from "./activity/labels";
import type { AdeChatClient, ModelDescriptor, SendInput } from "./sdkTypes";
import { AdeChatStyles } from "./theme/AdeChatStyles";
import type { AdeChatTheme } from "./theme/createTheme";
import { Transcript, type TranscriptProps } from "./transcript/Transcript";

/** What `AdeChatProps.onSend` may return. See `onSend`. */
export type AdeChatSendResult = void | boolean | "handled";

export type AdeChatProps = {
  client: AdeChatClient;
  /** Thread key. Changing it opens a different conversation. */
  threadKey: string;

  /** Uncontrolled initial selection; pass `modelId` to control it. */
  defaultModelId?: string;
  modelId?: string;
  onModelChange?: (model: ModelDescriptor) => void;

  labels?: ActivityLabelConfig;
  /** Token overrides, typically from `createTheme()`. */
  theme?: Partial<AdeChatTheme>;
  /** Skip the injected stylesheet if the host bundles its own copy. */
  disableStyles?: boolean;

  placeholder?: ComposerProps["placeholder"];
  sendOnEnter?: ComposerProps["sendOnEnter"];
  /**
   * Controlled draft text, passed to the internal `<Composer>`. Pass with
   * `onValueChange` to fill the composer from outside (prompt cards, a
   * "retry with edits" flow). Omit both to let the composer own the draft.
   */
  value?: ComposerProps["value"];
  /** Called with the next draft text. See `value`. */
  onValueChange?: ComposerProps["onValueChange"];
  /**
   * Called when the person sends a new message, before it reaches the thread.
   * What it returns (or resolves) decides what happens next:
   *   - `false` cancels: nothing is sent, and the composer keeps the draft and
   *     the staged attachments (a confirmation or a validation step);
   *   - `"handled"` means the host sent the message itself (for example with
   *     `thread.send` and other text): nothing more is sent, and the composer
   *     stays cleared;
   *   - anything else sends the message as usual.
   * A throw is shown under the composer as a failed send, and the draft is
   * restored. Steering a running turn does not call this. `thread` is the
   * live thread state (see `children`).
   */
  onSend?: (
    input: SendInput,
    thread: ThreadState,
  ) => AdeChatSendResult | Promise<AdeChatSendResult>;
  /**
   * Render prop drawn between the transcript and the composer, with the live
   * thread state: rows, status, `send`, `update`, the resolved model. Use it
   * for prompt cards, a retry bar, or a status line. Return null to draw
   * nothing there.
   */
  children?: (thread: ThreadState) => ReactNode;
  /**
   * Receives the live thread state on every render (null before mount and
   * after unmount), for host code outside the render tree: a toolbar "Retry"
   * button, a title set after the first reply.
   */
  threadRef?: { current: ThreadState | null };
  onRequestAttachment?: ComposerProps["onRequestAttachment"];
  /**
   * Controlled staged attachments, passed straight to the internal
   * `<Composer>`. Pass with `onAttachmentsChange` to stage files from outside
   * the picker (drag-and-drop, paste). Follow the Composer's merge rule:
   * `onAttachmentsChange` gets the COMPLETE next list — replace your state with
   * it, never append — and items are keyed by `id` (see
   * `ComposerProps["attachments"]`). Omit both to let the composer own the list.
   */
  attachments?: ComposerProps["attachments"];
  /** Called with the complete next attachment list. See `attachments`. */
  onAttachmentsChange?: ComposerProps["onAttachmentsChange"];
  /**
   * Replaces the built-in model picker in the composer rail. Pass any node (a
   * host model chip, a status pill); `null` renders an empty rail. When set,
   * `hideModelPicker`, `reasoningEffort` and `onReasoningEffortChange` do
   * nothing, and model switching is the host's job.
   */
  modelRail?: ComposerProps["modelRail"];
  /** Extra composer controls, rendered after the rail (the Composer's `actions`). */
  actions?: ComposerProps["actions"];
  /**
   * Selected reasoning effort, shown by the built-in picker for a model that
   * lists `reasoningEfforts`. Controlled: pair with `onReasoningEffortChange`.
   */
  reasoningEffort?: ModelPickerProps["reasoningEffort"];
  /**
   * Called when the person picks an effort in the built-in picker. The effort
   * control is drawn only when this is set. Applying it to the thread (for
   * example `thread.update({ reasoningEffort })` on `@ade-dev/sdk` >= 0.3) is the
   * host's job; this component does not call the runtime for it.
   */
  onReasoningEffortChange?: ModelPickerProps["onReasoningEffortChange"];
  hideToolCalls?: TranscriptProps["hideToolCalls"];
  hideReasoning?: TranscriptProps["hideReasoning"];
  renderMarkdown?: TranscriptProps["renderMarkdown"];
  /**
   * Decide what a link in the transcript does. See
   * `TranscriptProps["onLinkClick"]`; an Electron host should pass it.
   */
  onLinkClick?: TranscriptProps["onLinkClick"];
  /**
   * Approval card wording, or a replacement card.
   *
   * The card itself is not opt-in: a provider that asks for permission blocks
   * its turn until someone answers, so a host that drew nothing would show a
   * conversation that has silently stopped. This only changes how it looks.
   */
  approvals?: TranscriptProps["approvals"];
  /** Extra content under a tool chip. See `TranscriptProps["renderToolResult"]`. */
  renderToolResult?: TranscriptProps["renderToolResult"];
  /** Action buttons on a tool chip. See `TranscriptProps["toolChipActions"]`. */
  toolChipActions?: TranscriptProps["toolChipActions"];
  /**
   * Envelopes per history page on a client with `historyPage`; older pages load
   * when the reader scrolls to the top. See `useAdeThread`.
   */
  historyPageSize?: number;
  /**
   * CSP nonce for the injected stylesheet, so a host whose `style-src` has no
   * `'unsafe-inline'` can still use the built-in styles. Ignored with
   * `disableStyles`. Only the first injection per document applies it.
   */
  styleNonce?: string;
  emptyState?: ReactNode;

  /** Hide the model rail when the host pins a model. */
  hideModelPicker?: boolean;
  className?: string;
};

/**
 * `useLayoutEffect` in a browser; `useEffect` during server rendering, where
 * React warns about a layout effect and neither one runs anyway.
 */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function AdeChat(props: AdeChatProps) {
  return (
    <AdeChatProvider client={props.client} {...(props.labels ? { labels: props.labels } : {})}>
      <AdeChatInner {...props} />
    </AdeChatProvider>
  );
}

function AdeChatInner({
  client,
  threadKey,
  defaultModelId,
  modelId,
  onModelChange,
  labels,
  theme,
  disableStyles = false,
  placeholder,
  sendOnEnter,
  value,
  onValueChange,
  onSend,
  children,
  threadRef,
  onRequestAttachment,
  attachments,
  onAttachmentsChange,
  modelRail,
  actions,
  reasoningEffort,
  onReasoningEffortChange,
  hideToolCalls,
  hideReasoning,
  renderMarkdown,
  onLinkClick,
  approvals,
  renderToolResult,
  toolChipActions,
  historyPageSize,
  styleNonce,
  emptyState,
  hideModelPicker = false,
  className,
}: AdeChatProps) {
  const [internalModelId, setInternalModelId] = useState<string | null>(defaultModelId ?? null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);

  // A host that pins neither `modelId` nor `defaultModelId` still has to open
  // the thread with something: an SDK client refuses a create with no model,
  // and the user would meet that error before typing a word. So the catalog's
  // own first selectable model is the fallback, and the thread stays closed
  // until the catalog has been read at least once.
  const { models, statuses, loading: catalogLoading } = useAdeProviders(client);
  const fallbackModel = useMemo(
    () =>
      models.find((model) =>
        isModelSelectable(model, statuses.find((status) => status.id === model.providerId)),
      ) ?? null,
    [models, statuses],
  );
  const activeModelId = modelId ?? internalModelId ?? fallbackModel?.id ?? null;
  const activeModel = useMemo(
    () => models.find((model) => model.id === activeModelId) ?? null,
    [models, activeModelId],
  );

  const thread = useAdeThread(threadKey, {
    client,
    enabled: Boolean(activeModelId) || !catalogLoading,
    ...(activeModelId ? { modelId: activeModelId } : {}),
    ...(historyPageSize !== undefined ? { historyPageSize } : {}),
  });

  // Internal: read after the `await` in the send handler, where the render's
  // own `thread` could be a stale snapshot.
  const threadStateRef = useRef(thread);
  threadStateRef.current = thread;
  // The host's ref is written at commit, not during render, so host code never
  // reads the state of a render React discarded.
  useIsomorphicLayoutEffect(() => {
    if (threadRef) threadRef.current = thread;
  });
  useEffect(() => {
    if (!threadRef) return;
    return () => {
      threadRef.current = null;
    };
  }, [threadRef]);

  // Token overrides are custom properties, which React accepts on `style` but
  // `CSSProperties` has no index signature for.
  const style = useMemo(
    () => (theme ? ({ ...theme } as CSSProperties) : undefined),
    [theme],
  );

  /**
   * Apply a model change to the OPEN thread.
   *
   * The picker used to be create-time only: `modelId` was a dependency of the
   * thread-open effect, so changing it tore the conversation down and re-opened
   * it, dropping the local transcript. Now the open effect ignores later model
   * changes and this drives them in place, so the conversation survives a
   * provider switch.
   *
   * Re-applying the model the thread is already on is a SERVER-side no-op, not
   * a client-side one: the SDK always makes the round trips (a status check,
   * then the update) and the runtime lands on the same selection. That is what
   * makes it safe to run from an effect — it is idempotent, not free. A local
   * short-circuit is deliberately not done in the SDK, because the runtime
   * session is shared: another client (ADE desktop on the same runtime) can
   * change the model out from under a cached value, and a stale cache would
   * then swallow a real switch.
   */
  const { setModel, canSetModel, ready: threadReady, status: threadStatus } = thread;
  // The SDK refuses a mid-turn switch by default, because tearing the runtime
  // down kills the in-flight turn without emitting `error` or `done` — the
  // caller just sees events stop. That refusal is correct, but its message is
  // written for a developer ("pass { force: true }"), and this component would
  // render it verbatim to an end user. So the picker closes the door earlier:
  // no click during a running turn, and a reason a person can act on.
  const turnRunning = threadStatus.state === "running";
  const [modelError, setModelError] = useState<Error | null>(null);
  useEffect(() => {
    if (!threadReady || !activeModelId || !canSetModel || turnRunning) return;
    let cancelled = false;
    setModel(activeModelId)
      .then(() => {
        if (!cancelled) setModelError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // Never silent. A failed switch leaves the OLD model answering while
        // the rail shows the new name, which is the most confusing possible
        // outcome — the user attributes the old model's replies to the new one.
        setModelError(cause instanceof Error ? cause : new Error(String(cause)));
      });
    return () => {
      cancelled = true;
    };
    // `turnRunning` is a dependency, not just a guard: a model chosen while a
    // turn was in flight must still be applied once that turn finishes, or the
    // pick would be silently dropped — the exact failure this whole change set
    // out to remove.
  }, [threadReady, activeModelId, canSetModel, setModel, turnRunning]);

  const pickerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [pickerOpen]);

  // A thread that is open but cannot switch models (a client whose SDK predates
  // setModel) must SAY so. Accepting the click and ignoring it is the bug this
  // whole change exists to remove, so the alternative to switching is a
  // disabled control with a reason, never a silent no-op.
  const modelPickerDisabledReason = threadReady && !canSetModel
    ? "This conversation is already open and its runtime cannot change models mid-thread."
    : turnRunning
      ? "Wait for the current reply to finish before changing model."
      : null;
  // The rail names the model the person picked when the catalog knows it, and
  // otherwise the runtime's own name for what the thread is on — a retired id
  // the runtime resolved forward is not in the catalog, and printing the raw
  // id there is what this replaces. The raw id is the last resort only.
  const resolvedModel = thread.model;
  const resolvedName =
    resolvedModel?.displayName
    && (!activeModelId || resolvedModel.modelId === activeModelId || !activeModel)
      ? resolvedModel.displayName
      : null;
  const railLabel =
    selectedLabel ?? activeModel?.displayName ?? resolvedName ?? activeModelId ?? "Choose model";
  const defaultRail = hideModelPicker ? null : (
    <div ref={pickerRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="adechat-button"
        onClick={() => setPickerOpen((open) => !open)}
        aria-expanded={pickerOpen}
        aria-haspopup="listbox"
        disabled={modelPickerDisabledReason !== null}
        {...(modelPickerDisabledReason ? { title: modelPickerDisabledReason } : {})}
      >
        {railLabel}
      </button>
      {modelError ? (
        <div role="alert" className="adechat-model-error">
          Could not switch model: {modelError.message}
        </div>
      ) : null}
      {pickerOpen ? (
        <div style={{ position: "absolute", bottom: "calc(100% + 8px)", left: 0, zIndex: 20 }}>
          <ModelPicker
            client={client}
            value={activeModelId}
            {...(reasoningEffort !== undefined ? { reasoningEffort } : {})}
            {...(onReasoningEffortChange ? { onReasoningEffortChange } : {})}
            onChange={(model) => {
              if (modelId === undefined) setInternalModelId(model.id);
              setSelectedLabel(model.displayName);
              setPickerOpen(false);
              onModelChange?.(model);
            }}
          />
        </div>
      ) : null}
    </div>
  );

  const attachmentProps: Pick<
    ComposerProps,
    "onRequestAttachment" | "attachments" | "onAttachmentsChange"
  > = {
    ...(onRequestAttachment ? { onRequestAttachment } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(onAttachmentsChange ? { onAttachmentsChange } : {}),
  };

  // Passed only when the thread can actually answer. Its ABSENCE is what makes
  // the card read-only with a reason, so a client whose runtime has no answer
  // path shows an honest card rather than a button that would throw.
  const approvalHandler: Pick<TranscriptProps, "onApprove"> = thread.canApprove
    ? { onApprove: thread.approve }
    : {};

  return (
    <div className={["adechat-root", className].filter(Boolean).join(" ")} style={style}>
      {disableStyles ? null : <AdeChatStyles {...(styleNonce ? { nonce: styleNonce } : {})} />}
      <Transcript
        rows={thread.rows}
        status={thread.status.state}
        {...(labels ? { labels } : {})}
        {...(hideToolCalls !== undefined ? { hideToolCalls } : {})}
        {...(hideReasoning !== undefined ? { hideReasoning } : {})}
        {...(renderMarkdown ? { renderMarkdown } : {})}
        {...(onLinkClick ? { onLinkClick } : {})}
        {...(approvals ? { approvals } : {})}
        {...approvalHandler}
        {...(renderToolResult ? { renderToolResult } : {})}
        {...(toolChipActions ? { toolChipActions } : {})}
        hasOlder={thread.hasOlder}
        loadingOlder={thread.loadingOlder}
        onLoadOlder={thread.loadOlder}
        {...(emptyState !== undefined ? { emptyState } : {})}
      />
      {children ? children(thread) : null}
      <Composer
        onSend={async (input) => {
          const result = onSend ? await onSend(input, threadStateRef.current) : undefined;
          if (result === false) return false;
          if (result === "handled") return;
          await threadStateRef.current.send(input);
        }}
        onSteer={(input) => thread.steer(input)}
        onInterrupt={thread.interrupt}
        status={thread.status.state}
        ready={thread.ready}
        {...(placeholder !== undefined ? { placeholder } : {})}
        {...(sendOnEnter !== undefined ? { sendOnEnter } : {})}
        {...(value !== undefined ? { value } : {})}
        {...(onValueChange ? { onValueChange } : {})}
        {...attachmentProps}
        modelRail={modelRail !== undefined ? modelRail : defaultRail}
        {...(actions !== undefined ? { actions } : {})}
        error={thread.error?.message ?? null}
      />
    </div>
  );
}
