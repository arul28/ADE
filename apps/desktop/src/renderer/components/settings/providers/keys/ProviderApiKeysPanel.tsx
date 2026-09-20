/**
 * Settings → Agents & Models → <provider> → API keys.
 *
 * Every provider whose harness can run on a key gets this panel, and it is the
 * only place those keys are visible: what each one is, which variable it is
 * exported as, where it came from, and — for the ones ADE actually holds — how
 * to replace or delete it.
 *
 * Two rules the old single-key field broke. A key ADE did not write is shown
 * but never offered a Delete, because deleting it is not something ADE can do:
 * an environment variable is cleared where it was set. And Verify is offered
 * only where a probe exists — a button that always answers "this provider does
 * not support verification" teaches people to stop pressing buttons.
 */
import React, { useCallback, useMemo, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { ProviderPanel } from "../../providerSectionPrimitives";
import { ConfirmDialog, useConfirmDialog } from "../../../shared/InlineDialogs";
import { ProviderErrorRow, SourceBadge } from "../providerUi";
import {
  DEFAULT_API_CREDENTIAL_ID,
  type ApiCredentialSummary,
} from "../../../../../shared/types/apiCredentials";
import type { SettingsProviderId } from "../types";
import { AddApiKeySheet, type ApiKeyDraft } from "./AddApiKeySheet";
import { useApiCredentials } from "./useApiCredentials";
import {
  endpointHost,
  providerKeySpec,
  resolveKeyEnvVar,
  type ProviderKeySpec,
} from "./providerKeySpecs";
import { providerActionMessage } from "../providerErrorMessage";

export type ProviderApiKeysPanelProps = {
  provider: SettingsProviderId;
  providerLabel: string;
  /**
   * Extra store ids whose keys belong on this page — OpenCode's custom provider
   * blocks, each of which files its key under its own provider id.
   */
  additionalProviders?: readonly string[];
  /** Run after a successful write, for a page that mirrors the key elsewhere. */
  onAfterSave?: (draft: ApiKeyDraft) => Promise<void>;
  /** Run after a successful delete, for the same reason. */
  onAfterRemove?: (credential: ApiCredentialSummary) => Promise<void>;
};

const READ_ONLY_LINE = "Managed outside ADE — clear the env/config value to remove.";

function KeyRow({
  credential,
  spec,
  verifyState,
  onReplace,
  onDelete,
  onVerify,
}: {
  credential: ApiCredentialSummary;
  spec: ProviderKeySpec;
  verifyState: { busy: boolean; message: string | null; ok: boolean | null };
  onReplace: () => void;
  onDelete: () => void;
  onVerify: () => void;
}) {
  const envVar = credential.envVar ?? resolveKeyEnvVar(spec, credential.baseUrl);
  const host = endpointHost(credential.baseUrl);
  const editable = credential.source === "store";
  // Only the default slot is reachable from the verification path — it reads
  // one key per provider — so a second key gets no button rather than a button
  // that would verify a different key than the row it sits on.
  const canVerify = spec.verifiable && editable && credential.credentialId === DEFAULT_API_CREDENTIAL_ID;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "8px 0",
        borderTop: `1px solid ${COLORS.borderMuted}`,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
        <span style={{ fontSize: 11, fontFamily: SANS_FONT, fontWeight: 600, color: COLORS.textPrimary }}>
          {credential.label}
        </span>
        {envVar ? (
          <code style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textSecondary }}>{envVar}</code>
        ) : null}
        {credential.maskedTail ? (
          <code style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, marginLeft: "auto" }}>
            {credential.maskedTail}
          </code>
        ) : null}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
        <SourceBadge source={credential.source} />
        {host ? (
          <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>{host}</span>
        ) : null}
        {credential.models?.length ? (
          <span style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
            {credential.models.length} model{credential.models.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {editable ? null : (
          <span style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted }}>{READ_ONLY_LINE}</span>
        )}

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          {canVerify ? (
            <button
              type="button"
              style={outlineButton({ height: 24, padding: "0 8px", fontSize: 11 })}
              disabled={verifyState.busy}
              onClick={onVerify}
            >
              {verifyState.busy ? "Verifying…" : "Verify"}
            </button>
          ) : null}
          {editable ? (
            <>
              <button
                type="button"
                style={outlineButton({ height: 24, padding: "0 8px", fontSize: 11 })}
                onClick={onReplace}
              >
                Replace
              </button>
              <button
                type="button"
                style={outlineButton({ height: 24, padding: "0 8px", fontSize: 11, color: COLORS.danger })}
                onClick={onDelete}
              >
                Delete
              </button>
            </>
          ) : null}
        </div>
      </div>

      {verifyState.message ? (
        <div
          role="status"
          style={{
            fontSize: 10,
            fontFamily: SANS_FONT,
            color: verifyState.ok ? COLORS.success : COLORS.danger,
            overflowWrap: "anywhere",
          }}
        >
          {verifyState.message}
        </div>
      ) : null}
    </div>
  );
}

export function ProviderApiKeysPanel({
  provider,
  providerLabel,
  additionalProviders,
  onAfterSave,
  onAfterRemove,
}: ProviderApiKeysPanelProps) {
  const spec = providerKeySpec(provider);
  const extraKey = (additionalProviders ?? []).join(",");
  const providers = useMemo(
    () => [spec.credentialProvider, ...extraKey.split(",").filter(Boolean)],
    [extraKey, spec.credentialProvider],
  );
  const { credentials, loading, bridgeMissing, error, reload, store, remove } = useApiCredentials(providers);
  const [sheet, setSheet] = useState<{ existing: ApiCredentialSummary | null } | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [verify, setVerify] = useState<Record<string, { busy: boolean; message: string | null; ok: boolean | null }>>({});
  const { state: confirmState, confirmAsync, close: closeConfirm } = useConfirmDialog();

  const hasDefaultStoreRow = credentials.some(
    (row) => row.source === "store"
      && row.provider === spec.credentialProvider
      && row.credentialId === DEFAULT_API_CREDENTIAL_ID,
  );

  const persist = useCallback(async (draft: ApiKeyDraft) => {
    const writeProvider = spec.providerId ? draft.providerId : spec.credentialProvider;
    const existing = sheet?.existing ?? null;
    // The first key a provider holds claims the default slot, because that is
    // the slot every single-key consumer in the app already reads. OpenCode's
    // per-provider blocks are the same story one level down: one key per
    // provider id.
    const credentialId = existing?.credentialId
      ?? (spec.providerId || !hasDefaultStoreRow ? DEFAULT_API_CREDENTIAL_ID : undefined);

    if (spec.legacyDefaultSlot) {
      // Cursor's SDK signs in from the legacy single slot, and writing anywhere
      // else leaves it signed out while this panel claims a key is saved.
      await window.ade.ai.storeApiKey(spec.credentialProvider, draft.key);
    } else {
      await store({
        provider: writeProvider,
        ...(credentialId ? { credentialId } : {}),
        label: draft.label,
        key: draft.key,
        ...(resolveKeyEnvVar(spec, draft.baseUrl) ? { envVar: resolveKeyEnvVar(spec, draft.baseUrl)! } : {}),
        ...(draft.baseUrl ? { baseUrl: draft.baseUrl } : {}),
        ...(draft.protocol ? { protocol: draft.protocol } : {}),
        ...(draft.models.length ? { models: draft.models } : {}),
      });
    }
    await onAfterSave?.(draft);
    await reload();
    setSheet(null);
    setWriteError(null);
  }, [hasDefaultStoreRow, onAfterSave, reload, sheet, spec, store]);

  const onDelete = useCallback(async (credential: ApiCredentialSummary) => {
    const ok = await confirmAsync({
      title: "Delete this key?",
      message: `${credential.label} is removed from this machine. Chats already using it stop working until another key is added.`,
      confirmLabel: "Delete key",
      danger: true,
    });
    if (!ok) return;
    try {
      if (spec.legacyDefaultSlot && credential.credentialId === DEFAULT_API_CREDENTIAL_ID) {
        await window.ade.ai.deleteApiKey(credential.provider);
      } else {
        await remove(credential.provider, credential.credentialId);
      }
      await onAfterRemove?.(credential);
      await reload();
      setWriteError(null);
    } catch (err) {
      setWriteError(providerActionMessage(err, "That key change did not go through."));
    }
  }, [confirmAsync, onAfterRemove, reload, remove, spec.legacyDefaultSlot]);

  const onVerify = useCallback(async (credential: ApiCredentialSummary) => {
    const id = `${credential.provider}#${credential.credentialId}`;
    setVerify((prev) => ({ ...prev, [id]: { busy: true, message: null, ok: null } }));
    try {
      const result = await window.ade.ai.verifyApiKey(credential.provider);
      setVerify((prev) => ({ ...prev, [id]: { busy: false, message: result.message, ok: result.ok } }));
    } catch (err) {
      setVerify((prev) => ({
        ...prev,
        [id]: { busy: false, message: providerActionMessage(err, "This key could not be checked."), ok: false },
      }));
    }
  }, []);

  if (bridgeMissing) return null;

  return (
    <ProviderPanel
      title="API keys"
      count={credentials.length}
      actions={
        <button
          type="button"
          aria-label={`Add a ${providerLabel} API key`}
          style={outlineButton({ height: 26, padding: "0 9px", fontSize: 11 })}
          onClick={() => {
            setWriteError(null);
            setSheet({ existing: null });
          }}
        >
          <Plus size={11} weight="bold" /> Add key
        </button>
      }
    >
      {error ? <ProviderErrorRow message={error} /> : null}
      {writeError ? <ProviderErrorRow message={writeError} /> : null}

      {credentials.length === 0 ? (
        <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>
          {loading ? "Checking…" : `No API key saved for ${providerLabel}.`}
        </div>
      ) : (
        credentials.map((credential) => (
          <KeyRow
            key={`${credential.provider}#${credential.credentialId}`}
            credential={credential}
            spec={spec}
            verifyState={
              verify[`${credential.provider}#${credential.credentialId}`]
              ?? { busy: false, message: null, ok: null }
            }
            onReplace={() => {
              setWriteError(null);
              setSheet({ existing: credential });
            }}
            onDelete={() => void onDelete(credential)}
            onVerify={() => void onVerify(credential)}
          />
        ))
      )}

      {sheet ? (
        <AddApiKeySheet
          spec={spec}
          providerLabel={providerLabel}
          existing={sheet.existing}
          onSave={persist}
          onClose={() => setSheet(null)}
        />
      ) : null}

      <ConfirmDialog state={confirmState} onClose={closeConfirm} />
    </ProviderPanel>
  );
}
