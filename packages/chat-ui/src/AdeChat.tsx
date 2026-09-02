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
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { Composer, type ComposerProps } from "./composer/Composer";
import { AdeChatProvider, useAdeProviders, useAdeThread } from "./context/AdeChatContext";
import { ModelPicker } from "./models/ModelPicker";
import { isModelSelectable } from "./models/modelSearch";
import type { ActivityLabelConfig } from "./activity/labels";
import type { AdeChatClient, ModelDescriptor } from "./sdkTypes";
import { AdeChatStyles } from "./theme/AdeChatStyles";
import type { AdeChatTheme } from "./theme/createTheme";
import { Transcript, type TranscriptProps } from "./transcript/Transcript";

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
  onRequestAttachment?: ComposerProps["onRequestAttachment"];
  hideToolCalls?: TranscriptProps["hideToolCalls"];
  hideReasoning?: TranscriptProps["hideReasoning"];
  renderMarkdown?: TranscriptProps["renderMarkdown"];
  /**
   * Approval card wording, or a replacement card.
   *
   * The card itself is not opt-in: a provider that asks for permission blocks
   * its turn until someone answers, so a host that drew nothing would show a
   * conversation that has silently stopped. This only changes how it looks.
   */
  approvals?: TranscriptProps["approvals"];
  emptyState?: ReactNode;

  /** Hide the model rail when the host pins a model. */
  hideModelPicker?: boolean;
  className?: string;
};

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
  onRequestAttachment,
  hideToolCalls,
  hideReasoning,
  renderMarkdown,
  approvals,
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
  });

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
  const rail = hideModelPicker ? null : (
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
        {selectedLabel ?? activeModel?.displayName ?? activeModelId ?? "Choose model"}
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

  const attachmentProps: Pick<ComposerProps, "onRequestAttachment"> = onRequestAttachment
    ? { onRequestAttachment }
    : {};

  // Passed only when the thread can actually answer. Its ABSENCE is what makes
  // the card read-only with a reason, so a client whose runtime has no answer
  // path shows an honest card rather than a button that would throw.
  const approvalHandler: Pick<TranscriptProps, "onApprove"> = thread.canApprove
    ? { onApprove: thread.approve }
    : {};

  return (
    <div className={["adechat-root", className].filter(Boolean).join(" ")} style={style}>
      {disableStyles ? null : <AdeChatStyles />}
      <Transcript
        rows={thread.rows}
        status={thread.status.state}
        {...(labels ? { labels } : {})}
        {...(hideToolCalls !== undefined ? { hideToolCalls } : {})}
        {...(hideReasoning !== undefined ? { hideReasoning } : {})}
        {...(renderMarkdown ? { renderMarkdown } : {})}
        {...(approvals ? { approvals } : {})}
        {...approvalHandler}
        {...(emptyState !== undefined ? { emptyState } : {})}
      />
      <Composer
        onSend={(input) => thread.send(input)}
        onSteer={(input) => thread.steer(input)}
        onInterrupt={thread.interrupt}
        status={thread.status.state}
        ready={thread.ready}
        {...(placeholder !== undefined ? { placeholder } : {})}
        {...(sendOnEnter !== undefined ? { sendOnEnter } : {})}
        {...attachmentProps}
        modelRail={rail}
        error={thread.error?.message ?? null}
      />
    </div>
  );
}
