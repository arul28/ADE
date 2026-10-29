/**
 * One provider's page, in the provider's own colors.
 *
 * A banner on top carries the logo, the name, the state and this machine's
 * 30-day usage, then the accounts when the provider has several. Below them,
 * the left column holds the state details, the models and troubleshooting;
 * the right column holds the initial context window, then whatever else that
 * provider has (a bespoke body, compaction, API keys). The page scrolls as one column; the model list
 * scrolls inside its card, so a provider with 83 models stays short.
 */
import React, { useCallback, useMemo, useState } from "react";
import { ArrowsClockwise, Cube, MagnifyingGlass, Power, Pulse, Star, Wrench } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import {
  COLORS,
  SANS_FONT,
  outlineButton,
} from "../../lanes/laneDesignTokens";
import { settingsRouteFor } from "../settingsManifest";
import { panel } from "../providerSectionPrimitives";
import {
  CopyReportButton,
  PathLine,
  ProviderErrorRow,
  SubsectionTitle,
  normalizeProviderVersion,
} from "./providerUi";
import { ProviderHero } from "./ProviderHero";
import { ProviderContextPanel } from "./ProviderContextPanel";
import { providerBrand, providerThemeVars } from "./providerBrand";
import "./providerPage.css";
import { providerStatusFor } from "./descriptors";
import { ProviderAccountsPanel } from "./accounts/ProviderAccountsPanel";
import { CompactionSettings } from "./CompactionSettings";
import { ProviderApiKeysPanel } from "./keys/ProviderApiKeysPanel";
import { extraKeyProviders } from "./keys/providerKeySpecs";
import { persistOpenCodeProviderBlock } from "./keys/openCodeCustomProviders";
import { formatProviderDiagnosticsReport } from "./providerDiagnosticsReport";
import type { AcpSettingsProviderId, ProviderDescriptor, ProvidersViewContext } from "./types";
import { isProviderInstanceProvider } from "../../../../shared/types/providerInstances";
import { useSettingsMachineScope } from "../SettingsMachineScope";
import { isWebClientMode } from "../../../lib/webClientMode";
import { usePinnedToolStatus } from "../../../hooks/usePinnedToolStatus";
import { PinnedToolStatusRow } from "./bodies/PinnedToolStatusRow";
import { ReportIssueButton } from "../../app/ReportIssueButton";

/**
 * Whether the status payload already says this provider's runtime is on the
 * machine. It also counts a source checkout's `node_modules` copy and a
 * developer override, which the tools cache does not know about.
 */
function pinnedRuntimeReady(id: string, ctx: ProvidersViewContext): boolean {
  if (id === "claude") return ctx.status?.availableProviders?.claude?.binary.present === true;
  if (id === "opencode") return ctx.status?.opencodeBinaryInstalled === true;
  const connections = ctx.status?.providerConnections as Record<string, { runtimeDetected?: boolean } | undefined> | undefined;
  return connections?.[id]?.runtimeDetected === true;
}

/**
 * The model list body: a search field and an internally-scrolling list. Used
 * inside the left info card, so it never grows the page — the list scrolls.
 */
function ModelsListBody({
  descriptor,
  ctx,
  models,
}: {
  descriptor: ProviderDescriptor;
  ctx: ProvidersViewContext;
  /** `descriptor.models(ctx)`, computed once by the page. */
  models: ReturnType<ProviderDescriptor["models"]>;
}) {
  const [query, setQuery] = useState("");
  const status = providerStatusFor(descriptor, ctx);
  const modelsNote = descriptor.modelsNote?.(ctx) ?? null;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((model) => model.id.toLowerCase().includes(q) || model.label.toLowerCase().includes(q));
  }, [models, query]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 auto", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, height: 28, border: `1px solid ${COLORS.border}`, borderRadius: 8, background: COLORS.cardBg, padding: "0 9px" }}>
        <MagnifyingGlass size={12} style={{ color: COLORS.textMuted, flexShrink: 0 }} />
        <input
          aria-label={`Search ${descriptor.label} models`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search models"
          style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textPrimary }}
        />
      </div>
      {/* The model list IS the health check: an enumerate that failed says so
          here, in place of a Verify button that would only ask again. */}
      {status.errorLine && status.errorLine !== status.message ? <ProviderErrorRow message={status.errorLine} /> : null}
      {modelsNote ? (
        <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.45 }}>{modelsNote}</div>
      ) : null}
      {filtered.length === 0 ? (
        <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>
          {status.state === "checking"
            ? "Checking…"
            : models.length === 0
              ? "No models reported yet."
              : "No models match your search."}
        </div>
      ) : (
        <div
          tabIndex={0}
          role="group"
          aria-label={`${descriptor.label} models`}
          // A max-height keeps the list scrolling inside the card even when the
          // page is not height-locked, so a provider with 83 models cannot grow
          // the card and push the bottom actions below the fold.
          style={{ display: "flex", flexDirection: "column", overflowY: "auto", flex: "1 1 auto", minHeight: 0, maxHeight: 264, outline: "none" }}
        >
          {filtered.map((model) => (
            <div
              key={model.id}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderTop: `1px solid ${COLORS.borderMuted}`, minWidth: 0 }}
            >
              {model.isDefault ? (
                <Star size={11} weight="fill" style={{ color: COLORS.accent, flexShrink: 0 }} />
              ) : (
                <span style={{ width: 11, flexShrink: 0 }} />
              )}
              <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textPrimary, minWidth: 0, overflowWrap: "anywhere" }}>
                {model.label}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ProviderDetailPage({
  descriptor,
  ctx,
}: {
  descriptor: ProviderDescriptor;
  ctx: ProvidersViewContext;
}) {
  const { pin, isThisMachine } = useSettingsMachineScope();
  const status = providerStatusFor(descriptor, ctx);
  const disabled = ctx.disabledProviders.has(descriptor.id);
  const version = normalizeProviderVersion(descriptor.version?.(ctx));
  const facts = descriptor.facts?.(ctx) ?? [];
  const AuthActions = descriptor.AuthActions;
  const Diagnostics = descriptor.Diagnostics;
  const Body = descriptor.Body;
  const connected = status.state === "connected";
  // Claude and Codex are the only providers that can hold more than one local
  // login, so they are the only ones with an Accounts panel.
  const multiAccountProvider = isProviderInstanceProvider(descriptor.id) ? descriptor.id : null;
  // ADE's pinned copy of this provider on the page's machine. Muse keeps its
  // own download row (MuseAuthActions), so it is not read twice.
  const refreshStatus = ctx.actions.refreshStatus;
  const pinnedTool = usePinnedToolStatus(descriptor.id === "muse" ? null : descriptor.id, pin, {
    onReady: () => void refreshStatus({ force: true, silent: true }),
  });
  const runtimeReady = pinnedRuntimeReady(descriptor.id, ctx);
  // The pinned line says why a not-downloaded provider is not ready, and says
  // it better; the status sentence would only repeat it.
  const showStatusMessage = !connected && Boolean(status.message)
    && !(status.state === "not-installed" && pinnedTool.status);
  const diagnosticReport = formatProviderDiagnosticsReport({
    label: descriptor.label,
    status,
    version,
    facts,
    acp: ctx.acpDiagnostics[descriptor.id as AcpSettingsProviderId] ?? null,
  });

  const brand = providerBrand(descriptor.id);
  const models = useMemo(() => descriptor.models(ctx), [descriptor, ctx]);
  const modelLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const model of models) {
      labels.set(model.id, model.label);
      const bare = model.id.includes("/") ? model.id.slice(model.id.indexOf("/") + 1) : model.id;
      if (!labels.has(bare)) labels.set(bare, model.label);
    }
    return labels;
  }, [models]);
  const modelLabel = useCallback((id: string) => modelLabels.get(id) ?? id, [modelLabels]);
  // Cursor also owns its OAuth sign-out action after connection.
  const showAuthActions = Boolean(AuthActions) && (!connected || descriptor.id === "cursor");
  const hasStatusDetails = showStatusMessage || Boolean(pinnedTool.status) || facts.length > 0 || showAuthActions;

  return (
    <div className="ade-pv-provider" style={providerThemeVars(brand)}>
      <ProviderHero descriptor={descriptor} status={status} version={version} pin={pin} modelLabel={modelLabel} />

      {/* Right under the banner, full width: which account a chat runs as
          decides what quota it spends, and the cards sit side by side. */}
      {multiAccountProvider ? (
        <ProviderAccountsPanel provider={multiAccountProvider} providerLabel={descriptor.label} />
      ) : null}

      <div className="ade-pv-provider-body">
        {/* ── Left: state, models, troubleshooting ── */}
        <div className="ade-pv-provider-col">
          {hasStatusDetails ? (
            <section className="kit-card">
              <header className="kit-card-head">
                <Pulse size={14} />
                Status
              </header>
              <div className="kit-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {/* One short line, only when there is something to say beyond "Connected". */}
                {showStatusMessage ? (
                  <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.45 }}>
                    {status.message}
                  </div>
                ) : null}

                <PinnedToolStatusRow handle={pinnedTool} runtimeReady={runtimeReady} />

                {facts.map((fact) => (
                  <div key={`${fact.label}:${fact.value}`} style={{ display: "flex", alignItems: "flex-start", gap: 6, minWidth: 0 }}>
                    {fact.icon ? (
                      <span style={{ color: COLORS.textMuted, flexShrink: 0, marginTop: 1, display: "inline-flex" }}>{fact.icon}</span>
                    ) : null}
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                      {fact.mono ? (
                        <PathLine value={fact.value} />
                      ) : (
                        <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary, overflowWrap: "anywhere" }}>
                          {fact.value}
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {AuthActions && showAuthActions ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: `1px solid ${COLORS.borderMuted}`, paddingTop: 10 }}>
                    <SubsectionTitle>{connected ? "Cursor account" : "Sign in"}</SubsectionTitle>
                    <AuthActions ctx={ctx} />
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          <section className="kit-card">
            <header className="kit-card-head">
              <Cube size={14} />
              Models
              <span className="kit-card-head-count">{models.length}</span>
            </header>
            <div className="kit-card-body">
              <ModelsListBody descriptor={descriptor} ctx={ctx} models={models} />
            </div>
          </section>

          <section className="kit-card">
            <header className="kit-card-head">
              <Wrench size={14} />
              Troubleshooting
            </header>
            <div className="kit-card-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  style={{ ...outlineButton({ height: 26 }), display: "inline-flex", alignItems: "center", gap: 5 }}
                  disabled={ctx.loading}
                  onClick={() => void ctx.actions.refreshStatus({ force: true, refreshOpenCodeInventory: true })}
                >
                  <ArrowsClockwise size={12} weight="bold" />
                  {ctx.loading ? "Checking…" : "Check again"}
                </button>
                <button
                  type="button"
                  aria-pressed={disabled}
                  style={{ ...outlineButton({ height: 26 }), display: "inline-flex", alignItems: "center", gap: 5 }}
                  disabled={ctx.savingDisabledFor === descriptor.id}
                  onClick={() => void ctx.actions.setProviderDisabled(descriptor.id, !disabled)}
                >
                  <Power size={12} weight="bold" />
                  {ctx.savingDisabledFor === descriptor.id
                    ? "Saving…"
                    : disabled
                      ? `Enable ${descriptor.label}`
                      : `Disable ${descriptor.label}`}
                </button>
              </div>
              {Diagnostics ? <Diagnostics ctx={ctx} /> : null}
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <CopyReportButton report={diagnosticReport} label="Copy diagnostics" />
                <ReportIssueButton
                  variant="ghost"
                  context={{ surface: "provider_settings", headline: `${descriptor.label} provider`, code: `provider_${descriptor.id}`, technicalDetail: diagnosticReport }}
                />
              </div>
              <Link
                to={settingsRouteFor("storage.diagnostics")}
                style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.accent, textDecoration: "none" }}
              >
                Open diagnostics
              </Link>
            </div>
          </section>
        </div>

        {/* ── Right: the starting context, then this provider's own settings ── */}
        <div className="ade-pv-provider-col">
          <ProviderContextPanel providerId={descriptor.id} providerLabel={descriptor.label} providerLogo={descriptor.logo(14)} pin={pin}
            canReveal={isThisMachine && !pin && !isWebClientMode()} />
          {/* The provider's bespoke extra (e.g. Devin Cloud) sits above the API
              keys: it is what makes this provider different, keys are generic. */}
          {Body ? (
            <section style={panel({ padding: 14 })}>
              <Body ctx={ctx} />
            </section>
          ) : null}
          <CompactionSettings provider={descriptor.id} value={ctx.projectConfigSnapshot?.effective.ai?.compaction?.[descriptor.id]}
            onChange={async (value) => {
              await window.ade.ai.updateConfig({ compaction: { [descriptor.id]: value ?? {} } }, pin);
              await ctx.actions.refreshStatus();
            }} />
          <ProviderApiKeysPanel
            provider={descriptor.id}
            providerLabel={descriptor.label}
            additionalProviders={extraKeyProviders(descriptor.id, ctx.status?.customProviders)}
            onAfterSave={
              descriptor.id === "opencode"
                ? async (draft) => {
                    // OpenCode needs a provider block as well as a key: the key
                    // alone gives its config nothing to attach the endpoint and
                    // the model ids to.
                    await persistOpenCodeProviderBlock(ctx.status?.customProviders ?? [], draft, pin);
                    await ctx.actions.refreshStatus({ force: true, refreshOpenCodeInventory: true });
                  }
                : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}
