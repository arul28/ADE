/**
 * Add or replace one provider key.
 *
 * The sheet asks only what the provider's harness reads — the spec table is the
 * single source for that — and every field carries its own line of explanation.
 * There is one Save. The form this replaces had two save buttons that both lit
 * up when either was touched, and six fields of which three did nothing for the
 * provider being configured.
 *
 * It collects and validates; it does not decide where the key goes. Cursor goes
 * through the legacy single slot, OpenCode also writes a provider block, and
 * everything else is a plain credential write — all of that is the caller's,
 * which keeps this component honest about being a form.
 */
import React, { useCallback, useMemo, useRef, useState } from "react";
import { COLORS, MONO_FONT, SANS_FONT } from "../../../lanes/laneDesignTokens";
import { Dialog } from "../../../ui/dialog";
import type { ApiCredentialSummary } from "../../../../../shared/types/apiCredentials";
import {
  PROTOCOL_OPTIONS,
  resolveKeyEnvVar,
  type ProviderKeyProtocol,
  type ProviderKeySpec,
} from "./providerKeySpecs";
import { providerActionMessage } from "../providerErrorMessage";

export type ApiKeyDraft = {
  /** OpenCode only; empty for every other provider. */
  providerId: string;
  label: string;
  key: string;
  baseUrl: string;
  protocol: ProviderKeyProtocol | null;
  models: string[];
};

export type AddApiKeySheetProps = {
  spec: ProviderKeySpec;
  providerLabel: string;
  /** Present when replacing a saved key, which locks the provider id. */
  existing?: ApiCredentialSummary | null;
  /**
   * Let an edit leave the key field empty and keep the saved one.
   *
   * Only true where something other than the key is worth editing on its own —
   * an OpenCode custom provider's endpoint and model list live in the config
   * block, so changing those must not force the key to be re-typed. On a plain
   * key row there is nothing else to change, so Replace means a new key.
   */
  keyOptionalOnReplace?: boolean;
  onSave: (draft: ApiKeyDraft) => Promise<void>;
  onClose: () => void;
};

const FIELD_STYLE: React.CSSProperties = {
  height: 28,
  padding: "0 8px",
  fontSize: 12,
  fontFamily: SANS_FONT,
  color: COLORS.textPrimary,
  background: COLORS.cardBg,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 6,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const MONO_FIELD_STYLE: React.CSSProperties = { ...FIELD_STYLE, fontFamily: MONO_FONT, fontSize: 11 };

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim }}>{label}</span>
      {children}
      <span style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.45 }}>
        {help}
      </span>
    </label>
  );
}

/**
 * "a Claude Code key", "an OpenCode key". Provider labels are product names,
 * not words we control, so the article is derived from the one that is on the
 * page rather than hard-coded to "a".
 */
function indefiniteArticle(word: string): string {
  return /^[aeiou]/i.test(word.trim()) ? "an" : "a";
}

/**
 * An endpoint is typed by hand and read by a CLI that will not report back, so
 * a value that is not an absolute http(s) URL has to be refused here. Saved,
 * it becomes a base URL the harness exports and the only symptom is a chat
 * that fails to connect, hours later, with the provider's own error.
 */
function endpointProblem(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "The endpoint needs to be a full URL, like https://api.example.com/v1.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "The endpoint needs to start with https:// (or http:// on your own machine).";
  }
  if (!parsed.host) return "The endpoint needs a host, like https://api.example.com/v1.";
  return null;
}

export function AddApiKeySheet({
  spec,
  providerLabel,
  existing,
  keyOptionalOnReplace = false,
  onSave,
  onClose,
}: AddApiKeySheetProps) {
  const replacing = Boolean(existing);
  // OpenCode files a custom provider's key under the provider id itself, so
  // that — not the credential id — is what prefills the id field on a replace.
  const [providerId, setProviderId] = useState(spec.providerId ? existing?.provider ?? "" : "");
  const [label, setLabel] = useState(existing?.label ?? "");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
  const [protocol, setProtocol] = useState<ProviderKeyProtocol>(
    existing?.protocol ?? "openai-compatible",
  );
  const [models, setModels] = useState((existing?.models ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labelInputRef = useRef<HTMLInputElement | null>(null);

  const envVar = useMemo(() => resolveKeyEnvVar(spec, baseUrl), [spec, baseUrl]);

  const keyOptional = replacing && keyOptionalOnReplace;
  const canSave = label.trim().length > 0
    && (keyOptional || key.trim().length > 0)
    && (!spec.providerId || providerId.trim().length > 0);

  const save = useCallback(async () => {
    if (!canSave || busy) return;
    const endpointError = spec.endpoint ? endpointProblem(baseUrl) : null;
    if (endpointError) {
      setError(endpointError);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave({
        providerId: providerId.trim(),
        label: label.trim(),
        key: key.trim(),
        baseUrl: spec.endpoint ? baseUrl.trim() : "",
        protocol: spec.protocol ? protocol : null,
        models: spec.models
          ? models.split(",").map((entry) => entry.trim()).filter(Boolean)
          : [],
      });
    } catch (err) {
      setError(providerActionMessage(err, "That key could not be saved."));
      setBusy(false);
    }
  }, [baseUrl, busy, canSave, key, label, models, onSave, protocol, providerId, spec]);

  const title = replacing
    ? `Replace ${existing?.label ?? providerLabel} key`
    : `Add ${indefiniteArticle(providerLabel)} ${providerLabel} key`;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      // JSX title keeps the close button's exact "Close add key" label.
      title={<>{title}</>}
      closeLabel="Close add key"
      width={512}
      maxHeight="82vh"
      initialFocusRef={labelInputRef}
      bodyPadding={false}
      bodyStyle={{ marginTop: 14 }}
      tone="accent"
      actions={[
        { label: "Cancel", onClick: onClose, disabled: busy, variant: "secondary" },
        {
          label: busy ? "Saving…" : replacing ? "Replace key" : "Save key",
          onClick: () => void save(),
          disabled: busy || !canSave,
          variant: "solid",
        },
      ]}
    >
      {error ? (
        <div
          role="alert"
          style={{
            padding: "8px 20px",
            fontSize: 11,
            fontFamily: SANS_FONT,
            lineHeight: 1.5,
            color: COLORS.danger,
            background: "color-mix(in srgb, var(--color-error) 10%, transparent)",
            borderBottom: `1px solid ${COLORS.border}`,
            overflowWrap: "anywhere",
          }}
        >
          {error}
        </div>
      ) : null}

      <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 20px 4px" }}>
        {spec.providerId ? (
          <Field
            label="Provider id"
            help="OpenCode's name for this provider. Model ids are written as provider/model."
          >
            <input
              aria-label="Provider id"
              value={providerId}
              readOnly={replacing}
              placeholder="my-gateway"
              onChange={(event) => setProviderId(event.target.value)}
              style={{ ...MONO_FIELD_STYLE, opacity: replacing ? 0.6 : 1 }}
            />
          </Field>
        ) : null}

        <Field label="Label" help="What this key is, in your words. Shown on the key row.">
          <input
            ref={labelInputRef}
            aria-label="Key label"
            value={label}
            autoFocus
            placeholder={providerLabel}
            onChange={(event) => setLabel(event.target.value)}
            style={FIELD_STYLE}
          />
        </Field>

        <Field
          label="Key"
          help={
            keyOptional
              ? "Leave empty to keep the saved key."
              : replacing
                ? `Paste a new key to replace the saved one.${envVar ? ` Exported as ${envVar}.` : ""}`
                : `${spec.keyHelp}${envVar ? ` Exported as ${envVar}.` : ""}`
          }
        >
          <input
            aria-label="API key"
            value={key}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-…"
            onChange={(event) => setKey(event.target.value)}
            style={MONO_FIELD_STYLE}
          />
        </Field>

        {spec.endpoint ? (
          <Field label="Endpoint" help={spec.endpoint.help}>
            <input
              aria-label="Endpoint"
              value={baseUrl}
              placeholder={spec.endpoint.placeholder}
              onChange={(event) => setBaseUrl(event.target.value)}
              style={MONO_FIELD_STYLE}
            />
          </Field>
        ) : null}

        {spec.protocol ? (
          <Field label="Protocol" help="How this endpoint expects requests. Ask the provider if unsure.">
            <select
              aria-label="Protocol"
              value={protocol}
              onChange={(event) => setProtocol(event.target.value as ProviderKeyProtocol)}
              style={{ ...FIELD_STYLE, background: COLORS.cardBgSolid }}
            >
              {PROTOCOL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </Field>
        ) : null}

        {spec.models ? (
          <Field label="Models" help="Shown under this provider in the model picker. Optional, comma separated.">
            <input
              aria-label="Models"
              value={models}
              placeholder="model-a, model-b"
              onChange={(event) => setModels(event.target.value)}
              style={MONO_FIELD_STYLE}
            />
          </Field>
        ) : null}

        {spec.note ? (
          <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
            {spec.note}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
