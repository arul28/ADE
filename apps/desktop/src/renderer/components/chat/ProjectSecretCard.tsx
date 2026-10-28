import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, Copy, Eye, EyeSlash, FileLock, LockKey, Prohibit, Sparkle, X } from "@phosphor-icons/react";
import type { PendingInputRequest } from "../../../shared/types";
import {
  PROJECT_SECRET_ACTION_QUESTION_ID,
  PROJECT_SECRET_DELIVERY_OPTIONS,
  PROJECT_SECRET_DELIVERY_QUESTION_ID,
  PROJECT_SECRET_FILE_WHERE_IT_GOES,
  PROJECT_SECRET_VALUE_QUESTION_ID,
  PROJECT_SECRET_WHERE_IT_GOES,
  generateProjectSecretValue,
  projectSecretNameError,
  type ProjectSecretDelivery,
  type ProjectSecretRequestCard,
} from "../../../shared/projectSecretRequest";
import { ownQuestionValue } from "../../../shared/pendingInputAnswers";
import { pendingInputHeaderLabel } from "../../../shared/pendingInputLabels";
import { copyTextToClipboard } from "../../lib/launchPromptClipboard";
import { ProviderLogo } from "../shared/ProviderLogos";
import { Dialog } from "../ui/dialog";
import { cn } from "../ui/cn";
import { Banner } from "../ui/notice";
import { ChatCard, ChatCardRow, ChatCardSub, ChatCardTitle } from "./chatCardPrimitives";
import { isImeComposing } from "../../lib/imeComposition";

/**
 * The private secret card.
 *
 * Two ways in, one form:
 *
 * - An agent runs `ade secrets request NAME --reason …`. The card takes over
 *   the composer exactly the way an ask-question card does (same frame, same
 *   hairline accent edge), and the answer goes back through `respondToInput`
 *   as the answer to an `isSecret` question. The host stores it and hands the
 *   agent only the outcome.
 * - The person picks "Add secret…" in the composer's overflow menu. The same
 *   fields open in a dialog and save through `projectSecrets.set`.
 *
 * Nothing here logs, toasts, or echoes the value. It lives only in component
 * state until Save.
 */

const ACCENT_TEXT = "text-[color:color-mix(in_srgb,var(--chat-accent)_78%,white_22%)]";
const HAIRLINE = "border-[color:color-mix(in_srgb,white_6.5%,transparent)]";
const ICON_BUTTON = "inline-flex h-6 w-6 flex-none items-center justify-center rounded-md text-fg/40 transition-colors hover:bg-fg/[0.05] hover:text-fg/72 disabled:opacity-40";
const ROW_BUTTON = "inline-flex h-8 flex-none items-center justify-center rounded-lg px-3 text-[length:calc(var(--chat-font-size)*12/14)] font-medium transition-colors disabled:pointer-events-none";
const QUIET_BUTTON = cn(ROW_BUTTON, "text-fg/55 hover:bg-fg/[0.05] hover:text-fg/80 disabled:opacity-40");
const PRIMARY_BUTTON = cn(
  ROW_BUTTON,
  "bg-[color:color-mix(in_srgb,var(--chat-accent)_92%,black_8%)] text-black hover:bg-[color:var(--chat-accent)]",
  "disabled:bg-fg/[0.055] disabled:text-fg/26",
);

/**
 * The value field: one row with the password input and its tools (generate,
 * copy, show/hide). Controlled, so both the composer card and the dialog own
 * their own state.
 */
function SecretValueField({
  value,
  onChange,
  onSubmit,
  disabled,
  suggestGenerate,
  inputRef,
  inputId,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  suggestGenerate: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  inputId?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const handle = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(handle);
  }, [copied]);

  return (
    <div
      className={cn(
        "flex h-8 min-w-0 items-center gap-0.5 rounded-lg border bg-black/20 pl-2.5 pr-1",
        HAIRLINE,
        "focus-within:border-[color:color-mix(in_srgb,var(--chat-accent)_40%,transparent)]",
      )}
    >
      <input
        ref={inputRef}
        id={inputId}
        type={revealed ? "text" : "password"}
        value={value}
        disabled={disabled}
        autoComplete="new-password"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        data-testid="project-secret-value"
        aria-label="Secret value"
        placeholder={suggestGenerate ? "Paste the value, or generate one" : "Paste the value"}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || isImeComposing(event)) return;
          event.preventDefault();
          onSubmit();
        }}
        className="min-w-0 flex-1 bg-transparent font-mono text-[length:calc(var(--chat-font-size)*12.5/14)] text-fg/88 outline-none placeholder:font-sans placeholder:text-fg/26"
      />
      <button
        type="button"
        disabled={disabled}
        title={suggestGenerate ? "Generate a strong value (the agent suggested it)" : "Generate a strong value"}
        aria-label="Generate a strong value"
        data-testid="project-secret-generate"
        onClick={() => {
          onChange(generateProjectSecretValue());
          // A generated value usually has to be pasted somewhere else too
          // (a webhook form, a provider dashboard), so show it.
          setRevealed(true);
        }}
        className={cn(ICON_BUTTON, suggestGenerate && ACCENT_TEXT)}
      >
        <Sparkle size={12} weight={suggestGenerate ? "fill" : "regular"} />
      </button>
      {value ? (
        <button
          type="button"
          disabled={disabled}
          title={copied ? "Copied" : "Copy the value"}
          aria-label="Copy the value"
          data-testid="project-secret-copy"
          onClick={() => { void copyTextToClipboard(value).then((ok) => setCopied(ok)); }}
          className={ICON_BUTTON}
        >
          {copied ? <Check size={12} weight="bold" /> : <Copy size={12} weight="regular" />}
        </button>
      ) : null}
      <button
        type="button"
        disabled={disabled}
        title={revealed ? "Hide the value" : "Show the value"}
        aria-label={revealed ? "Hide the value" : "Show the value"}
        aria-pressed={revealed}
        data-testid="project-secret-reveal"
        onClick={() => setRevealed((prev) => !prev)}
        className={ICON_BUTTON}
      >
        {revealed ? <EyeSlash size={13} weight="regular" /> : <Eye size={13} weight="regular" />}
      </button>
    </div>
  );
}

function WhereItGoes({ className, delivery = "secrets" }: { className?: string; delivery?: ProjectSecretDelivery }) {
  const Icon = delivery === "file" ? FileLock : LockKey;
  return (
    <div
      data-testid="project-secret-where"
      data-delivery={delivery}
      className={cn("flex items-start gap-1.5 text-[length:calc(var(--chat-font-size)*11/14)] leading-[1.45] text-fg/40", className)}
    >
      <Icon size={11} weight="regular" className="mt-[2px] flex-none" />
      {delivery === "file" ? PROJECT_SECRET_FILE_WHERE_IT_GOES : PROJECT_SECRET_WHERE_IT_GOES}
    </div>
  );
}

/**
 * Where the value goes, as a small segmented control in the card's header.
 * The agent's ask is the default; the person decides, and the hint line under
 * the field says what that choice means.
 */
function DeliveryChoice({
  value,
  onChange,
  disabled,
  suggested,
}: {
  value: ProjectSecretDelivery;
  onChange: (next: ProjectSecretDelivery) => void;
  disabled: boolean;
  suggested: ProjectSecretDelivery;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Where ADE keeps it"
      data-testid="project-secret-delivery"
      className="inline-flex flex-none rounded-md bg-fg/[0.04] p-0.5"
    >
      {PROJECT_SECRET_DELIVERY_OPTIONS.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            title={option.value === suggested ? `${option.description} The agent asked for this.` : option.description}
            data-testid={`project-secret-delivery-${option.value}`}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-[5px] px-2 py-0.5 text-[length:calc(var(--chat-font-size)*11/14)] transition-colors disabled:opacity-40",
              selected ? "bg-fg/[0.09] text-fg/85" : "text-fg/40 hover:text-fg/70",
            )}
          >
            {option.value === "file" ? "Temporary file" : "ADE secrets"}
          </button>
        );
      })}
    </div>
  );
}

function saveLabel(responding: boolean, delivery: ProjectSecretDelivery, exists: boolean): string {
  if (responding) return "Saving…";
  if (delivery === "file") return "Save to file";
  return exists ? "Replace" : "Save";
}

/**
 * The agent-raised card, in the composer's place. Enter saves, Esc declines.
 *
 * Compact on purpose: a header (who asks, the name, where it goes, close), the
 * reason, one row with the field and its button, and one hint line. No footer
 * of its own; the composer's stop row sits under it while the turn runs.
 */
export function ProjectSecretRequestComposer({
  request,
  card,
  responding,
  onSave,
  onKeepExisting,
  onDecline,
  fileDeliveryAvailable = true,
}: {
  request: PendingInputRequest;
  card: ProjectSecretRequestCard;
  responding: boolean;
  onSave: (value: string, delivery: ProjectSecretDelivery) => void;
  onKeepExisting: () => void;
  onDecline: () => void;
  /** This chat's runtime can write temporary files (it says so by asking where). */
  fileDeliveryAvailable?: boolean;
}) {
  const [value, setValue] = useState("");
  const [chosenDelivery, setDelivery] = useState<ProjectSecretDelivery>(card.delivery);
  // A runtime that cannot write temporary files never asked where: it saves to secrets.
  const delivery: ProjectSecretDelivery = fileDeliveryAvailable ? chosenDelivery : "secrets";
  const [replacingExisting, setReplacing] = useState(!card.exists);
  // A file never touches the project's secret, so there is nothing to keep.
  const replacing = replacingExisting || delivery === "file";
  const inputRef = useRef<HTMLInputElement | null>(null);
  const canSave = value.trim().length > 0 && !responding;

  const save = useCallback(() => {
    if (!canSave) return;
    onSave(value, delivery);
  }, [canSave, delivery, onSave, value]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!responding) onDecline();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !replacing) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("button")) return;
      event.preventDefault();
      if (!responding) onKeepExisting();
    }
  };

  const label = pendingInputHeaderLabel(request.source, request.kind, { blocking: request.blocking });

  return (
    <div
      role="group"
      aria-label={`${label}: secret ${card.name}`}
      data-testid="project-secret-request-composer"
      onKeyDown={onKeyDown}
      tabIndex={-1}
      onMouseDown={(event) => {
        const target = event.target as HTMLElement | null;
        if (!target || target.closest("button, a, input, textarea, select")) return;
        event.currentTarget.focus({ preventScroll: true });
      }}
      className="border-t-[1.5px] border-[color:color-mix(in_srgb,var(--chat-accent)_30%,transparent)] px-3.5 pb-2 pt-2.5 outline-none"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex h-[17px] w-[17px] flex-none items-center justify-center rounded-full bg-[color:color-mix(in_srgb,var(--chat-accent)_16%,transparent)]">
          <ProviderLogo family={request.source} size={10} />
        </span>
        <span className={cn("flex-none font-mono text-[length:calc(var(--chat-font-size)*10/14)] font-bold uppercase tracking-[0.15em]", ACCENT_TEXT)}>
          Secret needed
        </span>
        <span
          data-testid="project-secret-name"
          title={card.name}
          className="min-w-0 truncate font-mono text-[length:calc(var(--chat-font-size)*12.5/14)] font-semibold text-fg/90"
        >
          {card.name}
        </span>
        <span className="flex-1" />
        {fileDeliveryAvailable ? (
          <DeliveryChoice value={delivery} onChange={setDelivery} disabled={responding} suggested={card.delivery} />
        ) : null}
        <button
          type="button"
          disabled={responding}
          title="Decline (Esc)"
          aria-label="Decline"
          data-testid="project-secret-decline"
          onClick={onDecline}
          className="flex-none rounded px-1 py-0.5 text-fg/26 transition-colors hover:bg-fg/[0.05] hover:text-fg/62 disabled:pointer-events-none disabled:opacity-40"
        >
          <X size={13} weight="bold" />
        </button>
      </div>
      {card.reason ? (
        <div className="pt-1.5 text-[length:calc(var(--chat-font-size)*12.5/14)] leading-[1.5] text-fg/65">
          {card.reason}
        </div>
      ) : null}

      <div className="flex items-center gap-1.5 pt-2.5">
        {replacing ? (
          <div className="min-w-0 flex-1">
            <SecretValueField
              value={value}
              onChange={setValue}
              onSubmit={save}
              disabled={responding}
              suggestGenerate={card.generate}
              inputRef={inputRef}
            />
          </div>
        ) : (
          <div
            data-testid="project-secret-exists"
            className="min-w-0 flex-1 truncate text-[length:calc(var(--chat-font-size)*12/14)] text-fg/62"
          >
            {card.name} already has a value in this project.
          </div>
        )}
        {card.exists && !replacing ? (
          <>
            <button
              type="button"
              disabled={responding}
              data-testid="project-secret-replace"
              onClick={() => {
                setReplacing(true);
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
              className={QUIET_BUTTON}
            >
              Replace
            </button>
            <button
              type="button"
              disabled={responding}
              data-testid="project-secret-keep"
              onClick={onKeepExisting}
              className={PRIMARY_BUTTON}
            >
              {responding ? "Sending…" : "Keep existing"}
            </button>
          </>
        ) : (
          <>
            {card.exists && delivery !== "file" ? (
              <button
                type="button"
                disabled={responding}
                data-testid="project-secret-keep"
                onClick={onKeepExisting}
                className={QUIET_BUTTON}
              >
                Keep existing
              </button>
            ) : null}
            <button
              type="button"
              disabled={!canSave}
              data-testid="project-secret-save"
              onClick={save}
              className={PRIMARY_BUTTON}
            >
              {saveLabel(responding, delivery, card.exists)}
            </button>
          </>
        )}
      </div>
      <WhereItGoes className="pt-2" delivery={delivery} />
    </div>
  );
}

/** The answers payload for each outcome — the value only ever in the secret slot. */
export function projectSecretSaveAnswers(
  card: ProjectSecretRequestCard,
  value: string,
  delivery: ProjectSecretDelivery = "secrets",
): Record<string, string> {
  return {
    [PROJECT_SECRET_DELIVERY_QUESTION_ID]: delivery,
    ...(card.exists && delivery === "secrets" ? { [PROJECT_SECRET_ACTION_QUESTION_ID]: "replace" } : {}),
    [PROJECT_SECRET_VALUE_QUESTION_ID]: value,
  };
}

export function projectSecretKeepAnswers(): Record<string, string> {
  return { [PROJECT_SECRET_DELIVERY_QUESTION_ID]: "secrets", [PROJECT_SECRET_ACTION_QUESTION_ID]: "keep" };
}

/**
 * The transcript record. One line, like every other answered question: open
 * while the card waits, then the receipt.
 */
export function ProjectSecretRequestReceipt({
  card,
  resolution,
  answers,
}: {
  card: ProjectSecretRequestCard;
  /** Null while the card is still open. */
  resolution: "accepted" | "declined" | "cancelled" | null;
  answers?: Record<string, string | string[]> | undefined;
}) {
  if (resolution === null) {
    return (
      <ChatCard skin="line" data-testid="project-secret-receipt-open">
        <ChatCardRow tone="running" icon={LockKey} meta="awaiting you">
          <ChatCardTitle>
            <span className="font-normal text-fg/55">Secret needed · </span>
            <span className="font-mono">{card.name}</span>
          </ChatCardTitle>
          <ChatCardSub>Answer it in the composer below.</ChatCardSub>
        </ChatCardRow>
      </ChatCard>
    );
  }
  const action = ownQuestionValue(answers, PROJECT_SECRET_ACTION_QUESTION_ID);
  const deliveryAnswer = ownQuestionValue(answers, PROJECT_SECRET_DELIVERY_QUESTION_ID);
  const chosen = Array.isArray(deliveryAnswer) ? deliveryAnswer[0] : deliveryAnswer;
  // An answer with no pick (an older client) went where the agent asked.
  const toFile = (chosen ?? card.delivery) === "file";
  const kept = resolution === "accepted"
    && !toFile
    && (Array.isArray(action) ? action.includes("keep") : action === "keep");
  let text: string;
  if (resolution === "accepted") {
    text = kept
      ? "· kept the existing value"
      : toFile
        ? "· in a temporary private file · kept out of chat"
        : "saved to this project · never shown to the agent";
  } else {
    text = resolution === "declined" ? "· declined" : "· closed before it was answered";
  }
  return (
    <ChatCard skin="line" data-testid="project-secret-receipt">
      <ChatCardRow
        tone={resolution === "accepted" ? "ok" : "idle"}
        icon={resolution === "accepted" ? LockKey : Prohibit}
      >
        <ChatCardTitle>
          <span className="font-mono">{card.name}</span>
          <span className="font-normal text-fg/55"> {text}</span>
        </ChatCardTitle>
      </ChatCardRow>
    </ChatCard>
  );
}

/**
 * "Add secret…" from the composer: the same fields in a dialog. Saves to this
 * project's secrets and reports only the name back to the caller.
 */
export function AddProjectSecretDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [existing, setExisting] = useState<Set<string>>(() => new Set());
  const [listFailed, setListFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameTouched, setNameTouched] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setName("");
      setValue("");
      setError(null);
      setNameTouched(false);
      setListFailed(false);
      setSaving(false);
      return;
    }
    let cancelled = false;
    setListFailed(false);
    void window.ade.projectSecrets.list()
      .then((result) => {
        if (!cancelled) setExisting(new Set(result.secrets.map((secret) => secret.name)));
      })
      .catch(() => {
        // A failed list is not "no secrets": say the check failed so the hint
        // does not promise the name is free.
        if (!cancelled) setListFailed(true);
      });
    return () => { cancelled = true; };
  }, [open]);

  const trimmedName = name.trim();
  const nameError = nameTouched || trimmedName ? projectSecretNameError(trimmedName) : null;
  const replaces = !nameError && existing.has(trimmedName);
  const canSave = !saving && !projectSecretNameError(trimmedName) && value.trim().length > 0;

  const save = async () => {
    setNameTouched(true);
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await window.ade.projectSecrets.set({ name: trimmedName, value });
      setValue("");
      onSaved(trimmedName);
      onOpenChange(false);
    } catch (cause) {
      // The service's messages carry the name at most, never the value.
      setError(cause instanceof Error ? cause.message : "Could not save the secret.");
    } finally {
      setSaving(false);
    }
  };

  // The composer re-renders on every streamed event and `onSaved` is an inline
  // closure, so a closed dialog would re-render its whole Radix tree each time.
  // Closed: render nothing. The effect above still resets the form on close.
  if (!open) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!saving) onOpenChange(next); }}
      title="Add a project secret"
      description={PROJECT_SECRET_WHERE_IT_GOES}
      icon={<LockKey size={16} weight="bold" />}
      tone="accent"
      size="sm"
      dismissible={!saving}
      initialFocusRef={nameRef}
      testId="add-project-secret-dialog"
      actions={[
        {
          label: saving ? "Saving…" : replaces ? "Replace" : "Save",
          onClick: () => { void save(); },
          disabled: !canSave,
          busy: saving,
        },
        { label: "Cancel", onClick: () => onOpenChange(false), disabled: saving },
      ]}
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-fg/70">Name</span>
          <input
            ref={nameRef}
            value={name}
            disabled={saving}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="GITHUB_WEBHOOK_SECRET"
            data-testid="add-project-secret-name"
            aria-invalid={Boolean(nameError)}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || isImeComposing(event)) return;
              event.preventDefault();
              void save();
            }}
            className={cn(
              "rounded-lg border bg-black/20 px-2.5 py-2 font-mono text-[13px] text-fg/88 outline-none placeholder:text-fg/26",
              nameError ? "border-[color-mix(in_srgb,var(--color-warning)_50%,transparent)]" : cn(HAIRLINE, "focus:border-[color:color-mix(in_srgb,var(--chat-accent)_40%,transparent)]"),
            )}
          />
          {nameError ? (
            <span className="text-[11.5px] text-[var(--color-warning)]">{nameError}</span>
          ) : replaces ? (
            <span className="text-[11.5px] text-fg/50">{trimmedName} already exists. Saving replaces its value.</span>
          ) : listFailed && trimmedName ? (
            <span className="text-[11.5px] text-fg/50">{`Couldn't check whether ${trimmedName} exists. Saving replaces any existing value.`}</span>
          ) : null}
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-fg/70">Value</span>
          <SecretValueField
            value={value}
            onChange={setValue}
            onSubmit={() => { void save(); }}
            disabled={saving}
            suggestGenerate={false}
          />
        </div>
        {error ? (
          <Banner
            layout="inline"
            model={{
              id: "project-secret-save-error",
              tone: "error",
              title: error,
              report: { surface: "project_secret_save" },
              dismiss: { onDismiss: () => setError(null) },
            }}
          />
        ) : null}
      </div>
    </Dialog>
  );
}
