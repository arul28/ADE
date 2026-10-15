/**
 * The custom providers OpenCode is configured with — readable at last.
 *
 * These were write-only: the form added one and then never showed it again, so
 * the only way to find out what was configured was to open the generated config
 * on disk, and the only way to change an entry was to re-type it from memory
 * and rely on the id collision to overwrite it. This lists what is there and
 * gives each row the two verbs it was missing.
 *
 * Add and Edit both open the same key sheet the rest of Settings uses, so a
 * custom provider is entered once, in one shape, with the same explanations.
 */
import React, { useCallback, useMemo, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT, SECTION_LABEL_STYLE, outlineButton } from "../../../lanes/laneDesignTokens";
import { confirmDialog } from "../../../ui/dialog";
import { invalidateAiDiscoveryCache } from "../../../../lib/aiDiscoveryCache";
import { ProviderErrorRow, prettifyProviderId } from "../providerUi";
import type {
  AiCustomProviderCacheFormat,
  AiCustomProviderConfig,
  AiCustomProviderEncoding,
} from "../../../../../shared/types/config";
import type { ApiCredentialSummary } from "../../../../../shared/types/apiCredentials";
import type { ProvidersViewContext } from "../types";
import { AddApiKeySheet, type ApiKeyDraft } from "./AddApiKeySheet";
import { providerKeySpec } from "./providerKeySpecs";
import {
  persistOpenCodeProviderBlock,
  protocolForNpm,
  saveCustomProviders,
  withCustomProvider,
  withoutCustomProvider,
} from "./openCodeCustomProviders";
import { providerActionMessage } from "../providerErrorMessage";
import { useSettingsMachineScope } from "../../SettingsMachineScope";
import { useApiCredentialsPin } from "./useApiCredentials";

const ENCODING_CHOICES: Array<{ value: AiCustomProviderEncoding | ""; label: string }> = [
  { value: "", label: "Off" },
  { value: "gzip", label: "gzip" },
  { value: "zstd", label: "zstd" },
];

const CACHE_FORMAT_CHOICES: Array<{ value: AiCustomProviderCacheFormat | ""; label: string }> = [
  { value: "", label: "Default" },
  { value: "anthropic", label: "Anthropic style" },
  { value: "alibaba", label: "Alibaba style" },
];

/**
 * Two request options OpenCode 2.0.28 added for an endpoint it does not know:
 * compressing request bodies, and which prompt-cache markers to send. Both
 * stay off by default: an endpoint that cannot read a compressed body or a
 * cache marker rejects every request.
 */
function CustomProviderRequestOptions({
  entry,
  disabled,
  onChange,
}: {
  entry: AiCustomProviderConfig;
  disabled: boolean;
  onChange: (next: AiCustomProviderConfig) => void;
}) {
  const name = entry.name || entry.id;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, width: "100%" }}>
      <label
        style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}
        title="Compress each request. Only for endpoints that accept compressed bodies; the request fails otherwise."
      >
        Compression
        <select
          className="kit-input"
          style={{ height: 24, padding: "0 6px", fontSize: 11 }}
          aria-label={`Compression for ${name}`}
          disabled={disabled}
          value={entry.encoding ?? ""}
          onChange={(event) => {
            const value = event.target.value as AiCustomProviderEncoding | "";
            const { encoding: _drop, ...rest } = entry;
            onChange(value ? { ...rest, encoding: value } : rest);
          }}
        >
          {ENCODING_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>{choice.label}</option>
          ))}
        </select>
      </label>
      <label
        style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}
        title="Mark the start of each prompt so the endpoint can cache it: later requests are cheaper and faster. Pick the style the endpoint documents."
      >
        Prompt caching
        <select
          className="kit-input"
          style={{ height: 24, padding: "0 6px", fontSize: 11 }}
          aria-label={`Prompt caching for ${name}`}
          disabled={disabled}
          value={entry.cacheFormat ?? ""}
          onChange={(event) => {
            const value = event.target.value as AiCustomProviderCacheFormat | "";
            const { cacheFormat: _drop, ...rest } = entry;
            onChange(value ? { ...rest, cacheFormat: value } : rest);
          }}
        >
          {CACHE_FORMAT_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>{choice.label}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** A config entry, shaped as the key sheet's "already saved" prefill. */
function asCredential(entry: AiCustomProviderConfig): ApiCredentialSummary {
  const stamp = new Date(0).toISOString();
  return {
    provider: entry.id,
    credentialId: "default",
    label: entry.name || prettifyProviderId(entry.id),
    baseUrl: entry.baseURL,
    protocol: protocolForNpm(entry.npm),
    models: entry.models,
    source: "store",
    createdAt: stamp,
    updatedAt: stamp,
  };
}

export function OpenCodeCustomProvidersPanel({ ctx }: { ctx: ProvidersViewContext }) {
  const spec = providerKeySpec("opencode");
  const entries = useMemo(() => ctx.status?.customProviders ?? [], [ctx.status?.customProviders]);
  const [sheet, setSheet] = useState<{ existing: ApiCredentialSummary | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Config goes to the page's machine; the key store follows the same rule as
  // every other key read on this page (This computer stays on desktop IPC).
  const { pin } = useSettingsMachineScope();
  const credentialPin = useApiCredentialsPin();

  const save = useCallback(async (draft: ApiKeyDraft) => {
    const id = draft.providerId.trim();
    if (!id) throw new Error("A custom provider needs an id.");
    if (draft.models.length === 0) throw new Error("A custom provider needs at least one model id.");
    if (!draft.baseUrl.trim()) throw new Error("A custom provider needs an endpoint.");
    // The key lands in the default slot for this provider id, which is the slot
    // the generated OpenCode config reads. An edit that left the key empty
    // keeps the saved one — only the config block below changes.
    if (draft.key) {
      await window.ade.apiCredentials.store({
        provider: id,
        credentialId: "default",
        label: draft.label,
        key: draft.key,
        baseUrl: draft.baseUrl,
        ...(draft.protocol ? { protocol: draft.protocol } : {}),
        models: draft.models,
      }, credentialPin);
    }
    await persistOpenCodeProviderBlock(entries, draft, pin);
    invalidateAiDiscoveryCache();
    setSheet(null);
    setError(null);
    await ctx.actions.refreshStatus({ force: true, refreshOpenCodeInventory: true });
  }, [credentialPin, ctx.actions, entries, pin]);

  const [savingOptionsFor, setSavingOptionsFor] = useState<string | null>(null);
  const saveOptions = useCallback(async (next: AiCustomProviderConfig) => {
    setSavingOptionsFor(next.id);
    try {
      await saveCustomProviders(withCustomProvider(entries, next), pin);
      setError(null);
      await ctx.actions.refreshStatus({ force: true });
    } catch (err) {
      setError(providerActionMessage(err, "That custom provider change did not go through."));
    } finally {
      setSavingOptionsFor(null);
    }
  }, [ctx.actions, entries, pin]);

  const remove = useCallback(async (entry: AiCustomProviderConfig) => {
    const ok = await confirmDialog({
      title: `Delete ${entry.name || entry.id}?`,
      message: `${entry.id} and its key are removed from this machine. Its models stop appearing in every picker.`,
      confirmLabel: "Delete provider",
      destructive: true,
    });
    if (!ok) return;
    try {
      await saveCustomProviders(withoutCustomProvider(entries, entry.id), pin);
      await window.ade.apiCredentials.remove({ provider: entry.id, credentialId: "default" }, credentialPin);
      invalidateAiDiscoveryCache();
      setError(null);
      await ctx.actions.refreshStatus({ force: true, refreshOpenCodeInventory: true });
    } catch (err) {
      setError(providerActionMessage(err, "That custom provider change did not go through."));
    }
  }, [credentialPin, ctx.actions, entries, pin]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={SECTION_LABEL_STYLE}>Custom providers</div>
        <button
          type="button"
          aria-label="Add a custom provider"
          style={outlineButton({ height: 24, padding: "0 8px", fontSize: 12 })}
          onClick={() => {
            setError(null);
            setSheet({ existing: null });
          }}
        >
          <Plus size={11} weight="bold" /> Add
        </button>
      </div>

      {error ? <ProviderErrorRow message={error} /> : null}

      {entries.length === 0 ? (
        <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>
          No custom providers. Add one to point OpenCode at an endpoint it does not know.
        </div>
      ) : (
        entries.map((entry) => (
          <div
            key={entry.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
              padding: "8px 0",
              borderTop: `1px solid ${COLORS.borderMuted}`,
              minWidth: 0,
            }}
          >
            <span style={{ fontSize: 11, fontFamily: SANS_FONT, fontWeight: 600, color: COLORS.textPrimary }}>
              {entry.name || prettifyProviderId(entry.id)}
            </span>
            <code style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textSecondary }}>{entry.id}</code>
            <code style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, overflowWrap: "anywhere" }}>
              {entry.baseURL}
            </code>
            <span style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
              {entry.models.length} model{entry.models.length === 1 ? "" : "s"}
            </span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button
                type="button"
                aria-label={`Edit ${entry.id}`}
                style={outlineButton({ height: 24, padding: "0 8px", fontSize: 12 })}
                onClick={() => {
                  setError(null);
                  setSheet({ existing: asCredential(entry) });
                }}
              >
                Edit
              </button>
              <button
                type="button"
                aria-label={`Delete ${entry.id}`}
                style={outlineButton({ height: 24, padding: "0 8px", fontSize: 12, color: COLORS.danger })}
                onClick={() => void remove(entry)}
              >
                Delete
              </button>
            </div>
            <CustomProviderRequestOptions
              entry={entry}
              disabled={savingOptionsFor !== null}
              onChange={(next) => void saveOptions(next)}
            />
          </div>
        ))
      )}

      {sheet ? (
        <AddApiKeySheet
          spec={spec}
          providerLabel="OpenCode"
          existing={sheet.existing}
          keyOptionalOnReplace
          onSave={save}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </div>
  );
}
