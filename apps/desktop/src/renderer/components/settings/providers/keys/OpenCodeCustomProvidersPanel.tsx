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
import type { AiCustomProviderConfig } from "../../../../../shared/types/config";
import type { ApiCredentialSummary } from "../../../../../shared/types/apiCredentials";
import type { ProvidersViewContext } from "../types";
import { AddApiKeySheet, type ApiKeyDraft } from "./AddApiKeySheet";
import { providerKeySpec } from "./providerKeySpecs";
import {
  persistOpenCodeProviderBlock,
  protocolForNpm,
  saveCustomProviders,
  withoutCustomProvider,
} from "./openCodeCustomProviders";
import { providerActionMessage } from "../providerErrorMessage";

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
      });
    }
    await persistOpenCodeProviderBlock(entries, draft);
    invalidateAiDiscoveryCache();
    setSheet(null);
    setError(null);
    await ctx.actions.refreshStatus({ force: true, refreshOpenCodeInventory: true });
  }, [ctx.actions, entries]);

  const remove = useCallback(async (entry: AiCustomProviderConfig) => {
    const ok = await confirmDialog({
      title: `Delete ${entry.name || entry.id}?`,
      message: `${entry.id} and its key are removed from this machine. Its models stop appearing in every picker.`,
      confirmLabel: "Delete provider",
      destructive: true,
    });
    if (!ok) return;
    try {
      await saveCustomProviders(withoutCustomProvider(entries, entry.id));
      await window.ade.apiCredentials.remove({ provider: entry.id, credentialId: "default" });
      invalidateAiDiscoveryCache();
      setError(null);
      await ctx.actions.refreshStatus({ force: true, refreshOpenCodeInventory: true });
    } catch (err) {
      setError(providerActionMessage(err, "That custom provider change did not go through."));
    }
  }, [ctx.actions, entries]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={SECTION_LABEL_STYLE}>Custom providers</div>
        <button
          type="button"
          aria-label="Add a custom provider"
          style={outlineButton({ height: 24, padding: "0 8px", fontSize: 11 })}
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
                style={outlineButton({ height: 24, padding: "0 8px", fontSize: 11 })}
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
                style={outlineButton({ height: 24, padding: "0 8px", fontSize: 11, color: COLORS.danger })}
                onClick={() => void remove(entry)}
              >
                Delete
              </button>
            </div>
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
