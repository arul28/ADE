/**
 * OpenCode's own page, reparented.
 *
 * OpenCode is one provider on the grid but ~40 model sources behind it, so its
 * detail page carries the sub-provider catalog, the local model servers, and
 * the advanced custom-provider escape hatch. Sub-providers open in a dialog:
 * they are inside OpenCode, not peers of it.
 */
import React from "react";
import { ArrowsClockwise, Cpu } from "@phosphor-icons/react";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  SECTION_LABEL_STYLE,
  outlineButton,
  primaryButton,
} from "../../../lanes/laneDesignTokens";
import { ProviderLogo } from "../../../shared/ProviderLogos";
import {
  getLocalModelIdTail,
  getLocalProviderDefaultEndpoint,
  getModelById,
  LOCAL_PROVIDER_LABELS,
  parseLocalProviderFromModelId,
} from "../../../../../shared/modelRegistry";
import {
  ConnectedTag,
  ProviderGrid,
  ProviderSearchField,
  ProviderTile,
  ProviderTileBadge,
} from "../../providerSectionPrimitives";
import type { OpenCodeProviderDetail } from "../../OpenCodeProviderDetailModal";
import { CopyableCommand } from "../providerUi";
import { openCodeInstallCommands } from "../cliTools";
import type { ProvidersViewContext } from "../types";

const CUSTOM_PROVIDER_NPM_OPTIONS = [
  "@ai-sdk/openai-compatible",
  "@ai-sdk/openai",
  "@ai-sdk/anthropic",
];

function formatLocalModelLabel(modelId: string): string {
  const descriptor = getModelById(modelId);
  if (descriptor) return descriptor.displayName;
  const provider = parseLocalProviderFromModelId(modelId);
  if (provider) {
    const tail = getLocalModelIdTail(modelId, provider);
    const brand = LOCAL_PROVIDER_LABELS[provider];
    return tail.length ? `${tail} (${brand})` : String(modelId ?? "").trim();
  }
  return String(modelId ?? "").trim();
}

function OpenCodeProviderCard({
  provider,
  onOpen,
}: {
  provider: OpenCodeProviderDetail;
  onOpen: () => void;
}) {
  const badge = provider.connected
    ? "Connected"
    : provider.hasKey
      ? "Key"
      : provider.methods.some((m) => m.type === "oauth")
        ? "OAuth"
        : "Add";
  return (
    <ProviderTile
      id={provider.id}
      name={provider.name}
      ariaLabel={provider.connected || provider.hasKey ? `Open ${provider.name}` : `Connect ${provider.name}`}
      badge={provider.connected ? <ConnectedTag /> : <ProviderTileBadge>{badge}</ProviderTileBadge>}
      onOpen={onOpen}
      footer={typeof provider.modelCount === "number" ? (
        <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
          {provider.modelCount} model{provider.modelCount === 1 ? "" : "s"}
        </div>
      ) : undefined}
    />
  );
}

function LocalModelServers({ ctx }: { ctx: ProvidersViewContext }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={SECTION_LABEL_STYLE}>Local Model Servers</div>
        <button
          type="button"
          style={outlineButton({ height: 26, padding: "0 10px", fontSize: 11 })}
          disabled={ctx.loading}
          onClick={() => void ctx.actions.refreshStatus({ force: true, refreshOpenCodeInventory: true })}
        >
          <ArrowsClockwise size={11} weight="bold" /> {ctx.loading ? "Checking..." : "Refresh"}
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: 8 }}>
        {ctx.localRuntimes.map((entry) => {
          const isEditing = ctx.editingLocalProvider === entry.provider;
          const isSaving = ctx.savingLocalProvider === entry.provider;
          const draft = ctx.localProviderDrafts[entry.provider];
          const hasReadyRuntime = entry.runtimeAvailable || (entry.detected && entry.hasModels);
          const needsModelLoad = !hasReadyRuntime && !entry.hasModels && (entry.health === "reachable" || entry.health === "reachable_no_models");
          const tone = hasReadyRuntime
            ? { color: COLORS.success, label: entry.hasModels ? "Ready" : "Connected" }
            : needsModelLoad
              ? { color: COLORS.warning, label: "Load a model" }
              : entry.blocker
                ? { color: COLORS.warning, label: "Blocked" }
                : { color: COLORS.warning, label: "Not detected" };
          const loadedModels = entry.modelIds.slice(0, 4);
          const extraModelCount = Math.max(0, entry.modelIds.length - loadedModels.length);
          const message = entry.blocker
            ? entry.blocker
            : entry.detected
              ? entry.hasModels
                ? `${entry.label} is reachable at ${entry.endpoint}. ADE can use ${entry.modelIds.length} loaded model${entry.modelIds.length === 1 ? "" : "s"} from this runtime${entry.health ? ` (${entry.health})` : ""}.`
                : `${entry.label} responded, but no loaded models were reported yet. Load a model in ${entry.label} and refresh.`
              : `${entry.label} was not detected. Start it, load at least one model, then refresh so ADE can discover its OpenAI-compatible server.`;

          return (
            <div
              key={entry.provider}
              style={{ border: `1px solid ${COLORS.border}`, borderLeft: `3px solid ${tone.color}`, background: COLORS.recessedBg, padding: 12, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <ProviderLogo family={entry.provider} size={20} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>{entry.label}</div>
                    <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.35 }}>{entry.description}</div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 4, color: tone.color }}>
                  <span style={{ fontSize: 11, fontFamily: SANS_FONT }}>{tone.label}</span>
                </div>
              </div>

              <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.55, overflowWrap: "break-word", wordBreak: "break-word" }}>{message}</div>

              <code style={{ display: "block", width: "100%", boxSizing: "border-box", minWidth: 0, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textSecondary, background: "color-mix(in srgb, var(--color-muted-fg) 12%, transparent)", border: `1px solid ${COLORS.border}`, padding: "6px 8px", overflowWrap: "anywhere", wordBreak: "break-all" }}>
                {draft?.endpoint?.trim() || entry.endpoint}
              </code>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {loadedModels.length > 0 ? (
                  <>
                    {loadedModels.map((modelId) => (
                      <span key={modelId} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", border: `1px solid ${COLORS.border}`, background: "color-mix(in srgb, var(--color-muted-fg) 10%, transparent)", fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textPrimary }} title={modelId}>
                        <Cpu size={11} />
                        {formatLocalModelLabel(modelId)}
                      </span>
                    ))}
                    {extraModelCount > 0 ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", border: `1px solid ${COLORS.border}`, background: "color-mix(in srgb, var(--color-muted-fg) 10%, transparent)", fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                        +{extraModelCount} more
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted }}>No loaded models reported yet.</span>
                )}
              </div>

              {isEditing && draft ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 4, borderTop: `1px solid ${COLORS.border}` }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: COLORS.textSecondary }}>
                    <input type="checkbox" checked={draft.enabled} onChange={(event) => ctx.actions.updateLocalProviderDraft(entry.provider, { enabled: event.target.checked })} />
                    Enable {entry.label}
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
                    <span>Endpoint</span>
                    <input value={draft.endpoint} onChange={(event) => ctx.actions.updateLocalProviderDraft(entry.provider, { endpoint: event.target.value })} placeholder={getLocalProviderDefaultEndpoint(entry.provider)} style={{ width: "100%", border: `1px solid ${COLORS.border}`, background: COLORS.cardBgSolid, color: COLORS.textPrimary, padding: "8px 10px", fontSize: 11, fontFamily: MONO_FONT }} />
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: COLORS.textSecondary }}>
                    <input type="checkbox" checked={draft.autoDetect} onChange={(event) => ctx.actions.updateLocalProviderDraft(entry.provider, { autoDetect: event.target.checked })} />
                    Fall back to the default detected endpoint
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
                    <span>Preferred model</span>
                    <select value={draft.preferredModelId} onChange={(event) => ctx.actions.updateLocalProviderDraft(entry.provider, { preferredModelId: event.target.value })} style={{ width: "100%", border: `1px solid ${COLORS.border}`, background: COLORS.cardBgSolid, color: COLORS.textPrimary, padding: "8px 10px", fontSize: 11, fontFamily: MONO_FONT }}>
                      <option value="">Require explicit selection</option>
                      {entry.modelIds.map((modelId) => (
                        <option key={modelId} value={modelId}>{formatLocalModelLabel(modelId)}</option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : null}

              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {isEditing ? (
                  <>
                    <button type="button" style={primaryButton()} disabled={isSaving} onClick={() => void ctx.actions.saveLocalProvider(entry.provider)}>{isSaving ? "Saving..." : "Save"}</button>
                    <button type="button" style={outlineButton()} disabled={isSaving} onClick={ctx.actions.cancelEditingLocalRuntime}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button type="button" style={outlineButton({ height: 28 })} onClick={() => ctx.actions.beginEditingLocalRuntime(entry.provider)}>Edit</button>
                    <button type="button" style={outlineButton({ height: 28 })} disabled={ctx.loading} onClick={() => void ctx.actions.refreshStatus({ force: true })}>Test</button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AdvancedOpenCode({ ctx }: { ctx: ProvidersViewContext }) {
  return (
    <details style={{ border: `1px solid ${COLORS.border}`, background: COLORS.cardBg }}>
      <summary style={{ cursor: "pointer", padding: "10px 12px", fontSize: 11, fontFamily: SANS_FONT, fontWeight: 600, color: COLORS.textSecondary, listStyle: "none" }}>
        Advanced — custom providers &amp; model slugs
      </summary>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 18, borderTop: `1px solid ${COLORS.border}` }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={SECTION_LABEL_STYLE}>Custom provider</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))", gap: 8 }}>
            <input aria-label="Provider id" value={ctx.customProviderDraft.id} onChange={(e) => ctx.actions.setCustomProviderDraft((d) => ({ ...d, id: e.target.value }))} placeholder="provider-id" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "8px 10px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, outline: "none" }} />
            <input aria-label="Provider name" value={ctx.customProviderDraft.name} onChange={(e) => ctx.actions.setCustomProviderDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Display name" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "8px 10px", fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textPrimary, outline: "none" }} />
            <input aria-label="Base URL" value={ctx.customProviderDraft.baseUrl} onChange={(e) => ctx.actions.setCustomProviderDraft((d) => ({ ...d, baseUrl: e.target.value }))} placeholder="https://api.example.com/v1" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "8px 10px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, outline: "none" }} />
            <select aria-label="npm package" value={ctx.customProviderDraft.npm} onChange={(e) => ctx.actions.setCustomProviderDraft((d) => ({ ...d, npm: e.target.value }))} style={{ background: COLORS.cardBgSolid, border: `1px solid ${COLORS.border}`, padding: "8px 10px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>
              {CUSTOM_PROVIDER_NPM_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
            <input aria-label="Model slugs" value={ctx.customProviderDraft.slugs} onChange={(e) => ctx.actions.setCustomProviderDraft((d) => ({ ...d, slugs: e.target.value }))} placeholder="model-a, model-b" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "8px 10px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, outline: "none" }} />
            <input aria-label="Provider API key" value={ctx.customProviderDraft.apiKey} onChange={(e) => ctx.actions.setCustomProviderDraft((d) => ({ ...d, apiKey: e.target.value }))} placeholder="API key (optional)" type="password" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "8px 10px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, outline: "none" }} />
          </div>
          <div>
            <button type="button" style={primaryButton()} disabled={ctx.savingAdvanced} onClick={() => void ctx.actions.saveAdvancedProvider()}>{ctx.savingAdvanced ? "Saving…" : "Add provider"}</button>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={SECTION_LABEL_STYLE}>Custom model slugs</div>
          <input aria-label="Custom model slugs" value={ctx.customModelSlugs} onChange={(e) => ctx.actions.setCustomModelSlugs(e.target.value)} placeholder="provider/model-a, provider/model-b" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, padding: "8px 10px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, outline: "none" }} />
          <div>
            <button type="button" style={primaryButton()} disabled={ctx.savingAdvanced} onClick={() => void ctx.actions.saveCustomModelSlugs()}>{ctx.savingAdvanced ? "Saving…" : "Save model slugs"}</button>
          </div>
        </div>
      </div>
    </details>
  );
}

export function OpenCodeBody({ ctx }: { ctx: ProvidersViewContext }) {
  const statusKnown = ctx.status !== null;
  const statusLoadFailed = !statusKnown && !ctx.loading && ctx.statusLoadError !== null;
  const installed = ctx.status?.opencodeBinaryInstalled !== false;
  const providersStale = ctx.status?.opencodeProvidersStale === true;

  if (!statusKnown && statusLoadFailed) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {/* The status line in the left rail already says what went wrong. */}
        <button
          type="button"
          aria-label="Re-check OpenCode"
          style={outlineButton()}
          disabled={ctx.loading}
          onClick={() => void ctx.actions.refreshStatus({ force: true, refreshOpenCodeInventory: true })}
        >
          <ArrowsClockwise size={12} weight="bold" /> {ctx.loading ? "Checking..." : "Re-check OpenCode"}
        </button>
      </div>
    );
  }

  if (!statusKnown) {
    return (
      <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
        Checking OpenCode and its provider catalog…
      </div>
    );
  }

  if (!installed) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.55 }}>
          OpenCode powers every subscription, API key, and local model below. Install it, then re-check:
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {openCodeInstallCommands().map((cmd) => (
            <CopyableCommand key={cmd} command={cmd} />
          ))}
        </div>
        <div>
          <button
            type="button"
            style={outlineButton()}
            disabled={ctx.loading}
            onClick={() => void ctx.actions.refreshStatus({ force: true, refreshOpenCodeInventory: true })}
          >
            <ArrowsClockwise size={12} weight="bold" /> {ctx.loading ? "Checking..." : "Re-check"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 12, flexWrap: "wrap" }}>
        {providersStale ? (
          <span style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim, fontStyle: "italic", marginRight: "auto" }}>
            Updating provider catalog…
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void ctx.actions.refreshCatalog()}
          disabled={ctx.refreshingCatalog}
          title="Refresh the models.dev catalog"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "transparent", border: "none", cursor: "pointer", fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted }}
        >
          <ArrowsClockwise size={11} weight="bold" />
          {ctx.refreshingCatalog ? "syncing…" : "catalog · refresh"}
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={SECTION_LABEL_STYLE}>Connected</div>
        {ctx.connectedOpenCodeProviders.length === 0 ? (
          <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>
            No providers connected yet. Pick one below to sign in or add a key.
          </div>
        ) : (
          <ProviderGrid>
            {ctx.connectedOpenCodeProviders.map((row) => (
              <OpenCodeProviderCard key={row.id} provider={row} onOpen={() => ctx.actions.openOpenCodeProviderDetail(row.id)} />
            ))}
          </ProviderGrid>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <div style={SECTION_LABEL_STYLE}>All providers · {ctx.openCodeCatalog.length}</div>
          <ProviderSearchField
            label="Search all OpenCode providers"
            value={ctx.providerSearch}
            onChange={ctx.actions.setProviderSearch}
          />
        </div>

        {!ctx.providerSearch.trim() ? (
          <>
            <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted }}>Popular</div>
            <ProviderGrid>
              {ctx.popularOpenCodeProviders.map((row) => (
                <OpenCodeProviderCard key={row.id} provider={row} onOpen={() => ctx.actions.openOpenCodeProviderDetail(row.id)} />
              ))}
            </ProviderGrid>
          </>
        ) : ctx.searchableOpenCodeProviders.length === 0 ? (
          <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>
            No providers match your search.
          </div>
        ) : (
          <ProviderGrid>
            {ctx.searchableOpenCodeProviders.map((row) => (
              <OpenCodeProviderCard key={row.id} provider={row} onOpen={() => ctx.actions.openOpenCodeProviderDetail(row.id)} />
            ))}
          </ProviderGrid>
        )}
      </div>

      <LocalModelServers ctx={ctx} />

      <AdvancedOpenCode ctx={ctx} />
    </div>
  );
}
