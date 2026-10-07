import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Copy, Eye, EyeSlash, LockKey, Prohibit, Sparkle } from "@phosphor-icons/react";
import type { PendingInputRequest } from "../../../shared/types";
import {
  PROJECT_SECRET_ACTION_QUESTION_ID,
  PROJECT_SECRET_VALUE_QUESTION_ID,
  PROJECT_SECRET_WHERE_IT_GOES,
  generateProjectSecretValue,
  projectSecretNameError,
  type ProjectSecretRequestCard,
} from "../../../shared/projectSecretRequest";
import { ownQuestionValue } from "../../../shared/pendingInputAnswers";
import { pendingInputHeaderLabel } from "../../../shared/pendingInputLabels";
import { ProviderLogo } from "../shared/ProviderLogos";
import { Dialog } from "../ui/dialog";
import { cn } from "../ui/cn";
import { ChatCard, ChatCardRow, ChatCardSub, ChatCardTitle } from "./chatCardPrimitives";

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
const FOOTER_BUTTON = "rounded-lg px-3 py-1.5 font-mono text-[length:calc(var(--chat-font-size)*10/14)] font-bold uppercase tracking-[0.11em] transition-colors disabled:pointer-events-none";
const QUIET_BUTTON = cn(FOOTER_BUTTON, "text-fg/40 hover:bg-fg/[0.05] hover:text-fg/62 disabled:opacity-40");
const PRIMARY_BUTTON = cn(
  FOOTER_BUTTON,
  "bg-[color:color-mix(in_srgb,var(--chat-accent)_92%,black_8%)] text-black hover:bg-[color:var(--chat-accent)]",
  "disabled:bg-fg/[0.055] disabled:text-fg/26",
);

async function copyText(text: string): Promise<boolean> {
  try {
    const bridge = window.ade?.app?.writeClipboardText;
    if (bridge) await bridge(text);
    else await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The value field: password input, show/hide, generate, copy. Controlled, so
 * both the composer card and the dialog own their own state.
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
    <div className="flex flex-col gap-1.5">
      <div
        className={cn(
          "grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1 rounded-lg border bg-black/20 pl-2.5 pr-1",
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
          placeholder="Paste the value"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            onSubmit();
          }}
          className="min-w-0 bg-transparent py-2 font-mono text-[length:calc(var(--chat-font-size)*12.5/14)] text-fg/88 outline-none placeholder:font-sans placeholder:text-fg/26"
        />
        {value ? (
          <button
            type="button"
            disabled={disabled}
            title={copied ? "Copied" : "Copy the value"}
            aria-label="Copy the value"
            data-testid="project-secret-copy"
            onClick={() => { void copyText(value).then((ok) => setCopied(ok)); }}
            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[length:calc(var(--chat-font-size)*10.5/14)] text-fg/40 transition-colors hover:bg-fg/[0.05] hover:text-fg/72 disabled:opacity-40"
          >
            <Copy size={12} weight="regular" />
            {copied ? "Copied" : null}
          </button>
        ) : <span />}
        <button
          type="button"
          disabled={disabled}
          title={revealed ? "Hide the value" : "Show the value"}
          aria-label={revealed ? "Hide the value" : "Show the value"}
          aria-pressed={revealed}
          data-testid="project-secret-reveal"
          onClick={() => setRevealed((prev) => !prev)}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-fg/40 transition-colors hover:bg-fg/[0.05] hover:text-fg/72 disabled:opacity-40"
        >
          {revealed ? <EyeSlash size={13} weight="regular" /> : <Eye size={13} weight="regular" />}
        </button>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          data-testid="project-secret-generate"
          onClick={() => {
            onChange(generateProjectSecretValue());
            // A generated value usually has to be pasted somewhere else too
            // (a webhook form, a provider dashboard), so show it.
            setRevealed(true);
          }}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[length:calc(var(--chat-font-size)*11/14)] transition-colors disabled:opacity-40",
            suggestGenerate ? cn(ACCENT_TEXT, "hover:bg-fg/[0.05]") : "text-fg/45 hover:bg-fg/[0.05] hover:text-fg/72",
          )}
        >
          <Sparkle size={11} weight={suggestGenerate ? "fill" : "regular"} />
          Generate a strong one
        </button>
        {suggestGenerate ? (
          <span className="text-[length:calc(var(--chat-font-size)*10.5/14)] text-fg/32">suggested by the agent</span>
        ) : null}
      </div>
    </div>
  );
}

function WhereItGoes({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-1.5 text-[length:calc(var(--chat-font-size)*11/14)] text-fg/45", className)}>
      <LockKey size={11} weight="regular" className="flex-none" />
      {PROJECT_SECRET_WHERE_IT_GOES}
    </div>
  );
}

/**
 * The agent-raised card, in the composer's place. Enter saves, Esc declines.
 */
export function ProjectSecretRequestComposer({
  request,
  card,
  responding,
  onSave,
  onKeepExisting,
  onDecline,
}: {
  request: PendingInputRequest;
  card: ProjectSecretRequestCard;
  responding: boolean;
  onSave: (value: string) => void;
  onKeepExisting: () => void;
  onDecline: () => void;
}) {
  const [value, setValue] = useState("");
  const [replacing, setReplacing] = useState(!card.exists);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const canSave = value.trim().length > 0 && !responding;

  const save = useCallback(() => {
    if (!canSave) return;
    onSave(value);
  }, [canSave, onSave, value]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
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
      className="border-t-[1.5px] border-[color:color-mix(in_srgb,var(--chat-accent)_30%,transparent)] outline-none"
    >
      <div className="flex items-center gap-2.5 px-3.5 pt-3">
        <span className="inline-flex h-[17px] w-[17px] flex-none items-center justify-center rounded-full bg-[color:color-mix(in_srgb,var(--chat-accent)_16%,transparent)]">
          <ProviderLogo family={request.source} size={10} />
        </span>
        <span className={cn("font-mono text-[length:calc(var(--chat-font-size)*10/14)] font-bold uppercase tracking-[0.15em]", ACCENT_TEXT)}>
          Secret needed
        </span>
      </div>
      <div className="flex items-center gap-2 px-3.5 pt-2">
        <LockKey size={14} weight="bold" className="flex-none text-fg/55" />
        <span
          data-testid="project-secret-name"
          className="min-w-0 truncate font-mono text-[length:calc(var(--chat-font-size)*14/14)] font-semibold text-fg/92"
        >
          {card.name}
        </span>
      </div>
      {card.reason ? (
        <div className="px-3.5 pb-1 pt-1.5 text-[length:calc(var(--chat-font-size)*12.5/14)] leading-[1.55] text-fg/68">
          {card.reason}
        </div>
      ) : null}

      <div className="px-3.5 pb-3 pt-2">
        {replacing ? (
          <SecretValueField
            value={value}
            onChange={setValue}
            onSubmit={save}
            disabled={responding}
            suggestGenerate={card.generate}
            inputRef={inputRef}
          />
        ) : (
          <div
            data-testid="project-secret-exists"
            className={cn("rounded-lg border bg-black/15 px-3 py-2 text-[length:calc(var(--chat-font-size)*12/14)] text-fg/68", HAIRLINE)}
          >
            {card.name} already has a value in this project. Keep it, or replace it with a new one.
          </div>
        )}
        <WhereItGoes className="mt-2" />
      </div>

      <div className={cn("flex items-center gap-2.5 border-t px-3 py-2.5", HAIRLINE)}>
        <button
          type="button"
          disabled={responding}
          data-testid="project-secret-decline"
          onClick={onDecline}
          className={QUIET_BUTTON}
        >
          Decline
        </button>
        <span className="flex-1" />
        <span className="hidden font-mono text-[length:calc(var(--chat-font-size)*10/14)] tracking-[0.04em] text-fg/26 sm:inline">
          <kbd className="text-fg/40">↵</kbd> {replacing ? "save" : "keep"} · <kbd className="text-fg/40">esc</kbd> decline
        </span>
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
            {card.exists ? (
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
              {responding ? "Saving…" : card.exists ? "Replace" : "Save"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** The answers payload for each outcome — the value only ever in the secret slot. */
export function projectSecretSaveAnswers(card: ProjectSecretRequestCard, value: string): Record<string, string> {
  return {
    ...(card.exists ? { [PROJECT_SECRET_ACTION_QUESTION_ID]: "replace" } : {}),
    [PROJECT_SECRET_VALUE_QUESTION_ID]: value,
  };
}

export function projectSecretKeepAnswers(): Record<string, string> {
  return { [PROJECT_SECRET_ACTION_QUESTION_ID]: "keep" };
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
  const kept = resolution === "accepted"
    && (Array.isArray(action) ? action.includes("keep") : action === "keep");
  let text: string;
  if (resolution === "accepted") {
    text = kept
      ? "· kept the existing value"
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
      setSaving(false);
      return;
    }
    let cancelled = false;
    void window.ade.projectSecrets.list()
      .then((result) => {
        if (!cancelled) setExisting(new Set(result.secrets.map((secret) => secret.name)));
      })
      .catch(() => { /* the list only powers the "replaces" hint */ });
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
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              void save();
            }}
            className={cn(
              "rounded-lg border bg-black/20 px-2.5 py-2 font-mono text-[13px] text-fg/88 outline-none placeholder:text-fg/26",
              nameError ? "border-amber-300/50" : cn(HAIRLINE, "focus:border-[color:color-mix(in_srgb,var(--chat-accent)_40%,transparent)]"),
            )}
          />
          {nameError ? (
            <span className="text-[11.5px] text-[var(--color-warning)]">{nameError}</span>
          ) : replaces ? (
            <span className="text-[11.5px] text-fg/50">{trimmedName} already exists. Saving replaces its value.</span>
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
          <div role="alert" className="text-[12px] text-[var(--color-warning)]">{error}</div>
        ) : null}
      </div>
    </Dialog>
  );
}
