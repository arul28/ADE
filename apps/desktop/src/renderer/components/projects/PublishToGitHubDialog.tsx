import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowSquareOut,
  CheckCircle,
  CircleNotch,
  GithubLogo,
  Key,
  LinkBreak,
  Warning,
  X,
} from "@phosphor-icons/react";
import type { PublishProjectResult } from "../../../shared/types";
import { extractError } from "../../lib/format";
import { fadeScale } from "../../lib/motion";
import {
  COLORS,
  LABEL_STYLE,
  MONO_FONT,
  SANS_FONT,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";

const GITHUB_CLASSIC_TOKEN_NEW_URL =
  "https://github.com/settings/tokens/new?description=ADE%20desktop%20PR%20workflows&scopes=repo,workflow";

export type PublishToGitHubDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultRepoName: string;
  onPublished: () => void;
};

type PublishError = { code: string; message: string };

type NameValidation = { ok: true } | { ok: false; reason: string };

function validateRepoName(rawName: string): NameValidation {
  const name = rawName.trim();
  if (name.length === 0) return { ok: false, reason: "Enter a repository name" };
  if (name.length > 100) return { ok: false, reason: "Name must be 100 characters or fewer" };
  if (name.startsWith(".")) return { ok: false, reason: "Name cannot start with a dot" };
  if (name.includes("..")) return { ok: false, reason: "Name cannot contain '..'" };
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return { ok: false, reason: "Use letters, numbers, '-', '_' or '.'" };
  }
  return { ok: true };
}

function extractCodeFromMessage(err: unknown): string | null {
  const direct = (err as { code?: unknown } | null)?.code;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const message = err instanceof Error ? err.message : String(err ?? "");
  const match = message.match(/^([a-z][a-z0-9_]*)\s*:\s*/i);
  return match?.[1] ?? null;
}

function detectTokenType(token: string): "classic" | "fine-grained" | "unknown" {
  if (token.startsWith("github_pat_")) return "fine-grained";
  if (token.startsWith("ghp_")) return "classic";
  return "unknown";
}

const inputStyle: CSSProperties = {
  height: 36,
  padding: "0 12px",
  fontSize: 13,
  fontFamily: SANS_FONT,
  color: COLORS.textPrimary,
  background: "color-mix(in srgb, var(--color-fg) 4%, transparent)",
  border: `1px solid ${COLORS.border}`,
  borderRadius: 8,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  height: "auto",
  minHeight: 64,
  paddingTop: 8,
  paddingBottom: 8,
  resize: "vertical",
};

export function PublishToGitHubDialog({
  open,
  onOpenChange,
  defaultRepoName,
  onPublished,
}: PublishToGitHubDialogProps) {
  const [name, setName] = useState(defaultRepoName);
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<PublishError | null>(null);
  const [success, setSuccess] = useState<PublishProjectResult | null>(null);

  const [connectMode, setConnectMode] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);

  // Reset all local state whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setName(defaultRepoName);
    setDescription("");
    setIsPrivate(true);
    setPending(false);
    setError(null);
    setSuccess(null);
    setConnectMode(false);
    setTokenDraft("");
    setTokenSaving(false);
    setTokenError(null);
  }, [open, defaultRepoName]);

  const validation = useMemo(() => validateRepoName(name), [name]);
  const trimmedName = name.trim();
  const canSubmit = validation.ok && !pending;

  const handleSubmit = useCallback(async () => {
    if (!validation.ok || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await window.ade.github.publishCurrentProject({
        name: trimmedName,
        description: description.trim() || undefined,
        isPrivate,
      });
      setSuccess(result);
    } catch (err) {
      const code = extractCodeFromMessage(err);
      if (code === "github_not_connected") {
        setConnectMode(true);
      } else if (code === "remote_already_exists") {
        setError({
          code,
          message: "This project already has a GitHub remote.",
        });
      } else {
        setError({
          code: code ?? "unknown",
          message: extractError(err),
        });
      }
    } finally {
      setPending(false);
    }
  }, [description, isPrivate, pending, trimmedName, validation.ok]);

  const handleSaveToken = useCallback(async () => {
    const token = tokenDraft.trim();
    if (!token) {
      setTokenError("Paste a personal access token first.");
      return;
    }
    setTokenSaving(true);
    setTokenError(null);
    try {
      await window.ade.github.setToken(token);
      setTokenDraft("");
      setConnectMode(false);
    } catch (err) {
      setTokenError(extractError(err));
    } finally {
      setTokenSaving(false);
    }
  }, [tokenDraft]);

  const handleOpenOnGitHub = useCallback(() => {
    if (!success) return;
    void window.ade.app.openExternal(success.htmlUrl);
  }, [success]);

  const handleDone = useCallback(() => {
    onPublished();
    onOpenChange(false);
  }, [onOpenChange, onPublished]);

  const handleOpenTokenLink = useCallback(() => {
    void window.ade.app.openExternal(GITHUB_CLASSIC_TOKEN_NEW_URL);
  }, []);

  const headerTitle = success
    ? "Publish to GitHub"
    : connectMode
      ? "Connect GitHub"
      : "Publish to GitHub";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                className="fixed inset-0 z-[120] bg-black/70 backdrop-blur-2xl"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild onOpenAutoFocus={(event) => event.preventDefault()}>
              <motion.div
                className="fixed left-1/2 top-[14%] z-[130] -translate-x-1/2 w-[520px] max-w-[96vw] overflow-hidden rounded-2xl flex flex-col focus:outline-none"
                style={{
                  background:
                    "radial-gradient(120% 120% at 0% 0%, rgba(167,139,250,0.10), transparent 55%), " +
                    "radial-gradient(100% 100% at 100% 100%, rgba(82,56,175,0.10), transparent 60%), " +
                    "var(--color-popup-bg)",
                  border: "1px solid transparent",
                  backgroundClip: "padding-box",
                  boxShadow:
                    "0 36px 100px -28px rgba(0,0,0,0.88), 0 0 0 1px rgba(167,139,250,0.22), 0 18px 48px -24px rgba(167,139,250,0.28)",
                }}
                variants={fadeScale}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                <div
                  className="flex items-center justify-between gap-3 border-b px-4 py-3"
                  style={{
                    background:
                      "color-mix(in srgb, var(--color-surface-recessed) 92%, rgba(167,139,250,0.08))",
                    borderColor: "color-mix(in srgb, var(--color-accent) 14%, var(--color-border))",
                  }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <GithubLogo
                      size={16}
                      weight="regular"
                      className="shrink-0 text-[var(--color-muted-fg)]"
                    />
                    <Dialog.Title
                      style={{
                        fontFamily: SANS_FONT,
                        fontSize: 13,
                        fontWeight: 600,
                        color: COLORS.textPrimary,
                      }}
                    >
                      {headerTitle}
                    </Dialog.Title>
                  </div>
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      aria-label="Close"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-muted-fg)] transition-colors hover:bg-white/10 hover:text-fg"
                    >
                      <X size={14} weight="regular" />
                    </button>
                  </Dialog.Close>
                </div>
                <Dialog.Description className="sr-only">
                  Publish the current project to GitHub.
                </Dialog.Description>

                <div style={{ padding: 20 }}>
                  {success ? (
                    <SuccessBody
                      result={success}
                      onOpenOnGitHub={handleOpenOnGitHub}
                      onDone={handleDone}
                    />
                  ) : connectMode ? (
                    <ConnectBody
                      tokenDraft={tokenDraft}
                      onTokenChange={setTokenDraft}
                      onSaveToken={handleSaveToken}
                      saving={tokenSaving}
                      error={tokenError}
                      onOpenTokenLink={handleOpenTokenLink}
                      onCancel={() => setConnectMode(false)}
                    />
                  ) : (
                    <FormBody
                      name={name}
                      onNameChange={setName}
                      description={description}
                      onDescriptionChange={setDescription}
                      isPrivate={isPrivate}
                      onPrivateChange={setIsPrivate}
                      validation={validation}
                      pending={pending}
                      canSubmit={canSubmit}
                      error={error}
                      onCancel={() => onOpenChange(false)}
                      onSubmit={handleSubmit}
                    />
                  )}
                </div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

function FormBody({
  name,
  onNameChange,
  description,
  onDescriptionChange,
  isPrivate,
  onPrivateChange,
  validation,
  pending,
  canSubmit,
  error,
  onCancel,
  onSubmit,
}: {
  name: string;
  onNameChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  isPrivate: boolean;
  onPrivateChange: (value: boolean) => void;
  validation: NameValidation;
  pending: boolean;
  canSubmit: boolean;
  error: PublishError | null;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Field label="REPOSITORY NAME">
        <input
          autoFocus
          type="text"
          value={name}
          placeholder="my-project"
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canSubmit) {
              event.preventDefault();
              onSubmit();
            }
          }}
          style={inputStyle}
          disabled={pending}
        />
        {!validation.ok && name.length > 0 ? (
          <InlineHint tone="danger">{validation.reason}</InlineHint>
        ) : null}
      </Field>

      <Field label="DESCRIPTION (OPTIONAL)">
        <textarea
          value={description}
          placeholder="What is this project?"
          onChange={(event) => onDescriptionChange(event.target.value)}
          style={textareaStyle}
          disabled={pending}
          rows={2}
        />
      </Field>

      <Field label="VISIBILITY">
        <div style={{ display: "flex", gap: 8 }}>
          <VisibilityRadio
            label="Private"
            description="Only you can see it"
            selected={isPrivate}
            onSelect={() => onPrivateChange(true)}
            disabled={pending}
          />
          <VisibilityRadio
            label="Public"
            description="Anyone can see it"
            selected={!isPrivate}
            onSelect={() => onPrivateChange(false)}
            disabled={pending}
          />
        </div>
      </Field>

      {error ? <InlineHint tone="danger">{error.message}</InlineHint> : null}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
        <button
          type="button"
          style={outlineButton()}
          onClick={onCancel}
          disabled={pending}
        >
          Cancel
        </button>
        <button
          type="button"
          style={primaryButton({
            opacity: canSubmit ? 1 : 0.55,
            cursor: canSubmit ? "pointer" : "not-allowed",
          })}
          onClick={onSubmit}
          disabled={!canSubmit}
        >
          {pending ? (
            <>
              <CircleNotch size={12} weight="bold" className="animate-spin" />
              Publishing…
            </>
          ) : (
            "Publish"
          )}
        </button>
      </div>
    </div>
  );
}

function ConnectBody({
  tokenDraft,
  onTokenChange,
  onSaveToken,
  saving,
  error,
  onOpenTokenLink,
  onCancel,
}: {
  tokenDraft: string;
  onTokenChange: (value: string) => void;
  onSaveToken: () => void;
  saving: boolean;
  error: string | null;
  onOpenTokenLink: () => void;
  onCancel: () => void;
}) {
  const detected = tokenDraft.trim() ? detectTokenType(tokenDraft.trim()) : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          padding: "10px 12px",
          fontSize: 12,
          fontFamily: SANS_FONT,
          color: COLORS.textSecondary,
          background: "color-mix(in srgb, var(--color-warning) 8%, transparent)",
          border: "1px solid color-mix(in srgb, var(--color-warning) 28%, var(--color-border))",
          borderRadius: 8,
          lineHeight: "18px",
        }}
      >
        <LinkBreak size={14} weight="regular" style={{ color: COLORS.warning, flexShrink: 0, marginTop: 2 }} />
        <span>GitHub is not connected. Paste a personal access token to publish this project.</span>
      </div>

      <Field label="PERSONAL ACCESS TOKEN">
        <input
          autoFocus
          type="password"
          value={tokenDraft}
          placeholder="ghp_… or github_pat_…"
          onChange={(event) => onTokenChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && tokenDraft.trim() && !saving) {
              event.preventDefault();
              onSaveToken();
            }
          }}
          style={inputStyle}
          disabled={saving}
        />
        {detected ? (
          <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>
            Detected:{" "}
            {detected === "classic"
              ? "Classic token"
              : detected === "fine-grained"
                ? "Fine-grained token"
                : "Unknown format"}
          </span>
        ) : null}
      </Field>

      <button
        type="button"
        onClick={onOpenTokenLink}
        style={{
          alignSelf: "flex-start",
          background: "transparent",
          border: "none",
          padding: 0,
          fontSize: 11,
          fontFamily: SANS_FONT,
          color: COLORS.accent,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          textDecoration: "underline",
          textUnderlineOffset: 2,
        }}
      >
        Generate a PAT on GitHub
        <ArrowSquareOut size={11} weight="regular" />
      </button>

      {error ? <InlineHint tone="danger">{error}</InlineHint> : null}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
        <button
          type="button"
          style={outlineButton()}
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          style={primaryButton()}
          onClick={onSaveToken}
          disabled={saving || tokenDraft.trim().length === 0}
        >
          {saving ? (
            <>
              <CircleNotch size={12} weight="bold" className="animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <Key size={12} weight="bold" />
              Save token
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function SuccessBody({
  result,
  onOpenOnGitHub,
  onDone,
}: {
  result: PublishProjectResult;
  onOpenOnGitHub: () => void;
  onDone: () => void;
}) {
  const subtitle =
    result.state === "remote_added"
      ? "Remote added — push when you're ready"
      : result.htmlUrl;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 16,
        padding: "8px 4px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 60,
          height: 60,
          borderRadius: 999,
          background: "color-mix(in srgb, var(--color-success) 14%, transparent)",
          color: COLORS.success,
          boxShadow: "0 0 0 1px color-mix(in srgb, var(--color-success) 32%, transparent)",
        }}
      >
        <CheckCircle size={32} weight="fill" />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center" }}>
        <div
          style={{
            fontFamily: SANS_FONT,
            fontSize: 14,
            fontWeight: 600,
            color: COLORS.textPrimary,
          }}
        >
          Published to GitHub
        </div>
        <div
          style={{
            fontFamily: result.state === "remote_added" ? SANS_FONT : MONO_FONT,
            fontSize: 11,
            color: COLORS.textDim,
            wordBreak: "break-all",
            maxWidth: 460,
          }}
        >
          {subtitle}
        </div>
        {result.state === "remote_added" ? (
          <div
            style={{
              fontFamily: MONO_FONT,
              fontSize: 11,
              color: COLORS.textDim,
              wordBreak: "break-all",
              maxWidth: 460,
            }}
          >
            {result.htmlUrl}
          </div>
        ) : null}
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        <button type="button" style={outlineButton()} onClick={onOpenOnGitHub}>
          <ArrowSquareOut size={12} weight="regular" />
          Open on GitHub
        </button>
        <button type="button" style={primaryButton()} onClick={onDone} autoFocus>
          Done
        </button>
      </div>
    </div>
  );
}

function VisibilityRadio({
  label,
  description,
  selected,
  onSelect,
  disabled,
}: {
  label: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      style={{
        flex: 1,
        textAlign: "left",
        padding: "10px 12px",
        background: selected
          ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
          : "color-mix(in srgb, var(--color-fg) 3%, transparent)",
        border: `1px solid ${
          selected
            ? "color-mix(in srgb, var(--color-accent) 50%, var(--color-border))"
            : COLORS.border
        }`,
        borderRadius: 8,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <span
        style={{
          fontFamily: SANS_FONT,
          fontSize: 12,
          fontWeight: 600,
          color: selected ? COLORS.accent : COLORS.textPrimary,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 10,
            height: 10,
            borderRadius: 999,
            border: `1px solid ${selected ? COLORS.accent : COLORS.border}`,
            background: selected ? COLORS.accent : "transparent",
            boxShadow: selected
              ? "inset 0 0 0 2px var(--color-popup-bg)"
              : "none",
          }}
        />
        {label}
      </span>
      <span
        style={{
          fontFamily: SANS_FONT,
          fontSize: 11,
          color: COLORS.textMuted,
        }}
      >
        {description}
      </span>
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ ...LABEL_STYLE, letterSpacing: "0.08em", textTransform: "uppercase" }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function InlineHint({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "danger" | "muted";
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        fontFamily: SANS_FONT,
        color: tone === "danger" ? COLORS.danger : COLORS.textMuted,
      }}
    >
      {tone === "danger" ? <Warning size={12} weight="fill" /> : null}
      {children}
    </span>
  );
}
