/**
 * One provider's page.
 *
 * One info card on the left holds the provider's identity, its models, its
 * sign-in (only while it is not connected), and — pinned at the bottom —
 * troubleshooting and the disable switch. The right column holds whatever else
 * that provider has (accounts, API keys, a bespoke body). The page is locked to
 * the viewport: the model list and the right column scroll internally, never the
 * page, so a provider with 83 models and one with 3 read at the same height.
 */
import React, { useMemo, useState } from "react";
import { ArrowsClockwise, MagnifyingGlass, Power, Star } from "@phosphor-icons/react";
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
  PreviewChip,
  ProviderErrorRow,
  ProviderStatusChip,
  SubsectionTitle,
  normalizeProviderVersion,
  providerStatusColor,
} from "./providerUi";
import { providerStatusFor } from "./descriptors";
import { ProviderAccountsPanel } from "./accounts/ProviderAccountsPanel";
import { ProviderApiKeysPanel } from "./keys/ProviderApiKeysPanel";
import { extraKeyProviders } from "./keys/providerKeySpecs";
import { persistOpenCodeProviderBlock } from "./keys/openCodeCustomProviders";
import { formatProviderDiagnosticsReport } from "./providerDiagnosticsReport";
import type { AcpSettingsProviderId, ProviderDescriptor, ProvidersViewContext } from "./types";
import { isProviderInstanceProvider } from "../../../../shared/types/providerInstances";

/**
 * The model list body: a search field and an internally-scrolling list. Used
 * inside the left info card, so it never grows the page — the list scrolls.
 */
function ModelsListBody({
  descriptor,
  ctx,
}: {
  descriptor: ProviderDescriptor;
  ctx: ProvidersViewContext;
}) {
  const [query, setQuery] = useState("");
  const models = descriptor.models(ctx);
  const status = providerStatusFor(descriptor, ctx);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((model) => model.id.toLowerCase().includes(q) || model.label.toLowerCase().includes(q));
  }, [models, query]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 auto", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <SubsectionTitle>Models</SubsectionTitle>
        <span style={{ marginLeft: "auto", fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim }}>
          {models.length}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, height: 26, border: `1px solid ${COLORS.border}`, background: COLORS.cardBg, padding: "0 8px" }}>
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
  const diagnosticReport = formatProviderDiagnosticsReport({
    label: descriptor.label,
    status,
    version,
    facts,
    acp: ctx.acpDiagnostics[descriptor.id as AcpSettingsProviderId] ?? null,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(280px, 340px) minmax(0, 1fr)",
          gap: 16,
          alignItems: "stretch",
          flex: "1 1 auto",
          minHeight: 0,
        }}
      >
        {/* ── Left: one info card ── */}
        <section
          style={panel({
            padding: 14,
            borderLeft: `3px solid ${providerStatusColor(status.state)}`,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            minHeight: 0,
          })}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            {descriptor.logo(28)}
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ fontSize: 13, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>
                  {descriptor.label}
                </div>
                {descriptor.preview ? <PreviewChip /> : null}
              </div>
              <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.35 }}>
                {descriptor.tagline}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <ProviderStatusChip state={status.state} label={status.label} />
            {version ? (
              <span style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim }}>v{version}</span>
            ) : null}
          </div>

          {/* One short line, only when there is something to say beyond "Connected". */}
          {!connected && status.message ? (
            <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.45 }}>
              {status.message}
            </div>
          ) : null}

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

          <ModelsListBody descriptor={descriptor} ctx={ctx} />

          {/* Sign-in only while disconnected — never a box that says "Sign in"
              after a working login. */}
          {AuthActions && !connected ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: `1px solid ${COLORS.borderMuted}`, paddingTop: 10 }}>
              <SubsectionTitle>Sign in</SubsectionTitle>
              <AuthActions ctx={ctx} />
            </div>
          ) : null}

          {/* Pinned to the bottom of the card: troubleshooting + disable. */}
          <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 8, borderTop: `1px solid ${COLORS.borderMuted}`, paddingTop: 10 }}>
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
            <CopyReportButton report={diagnosticReport} label="Copy diagnostics" />
            <Link
              to={settingsRouteFor("storage.diagnostics")}
              style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.accent, textDecoration: "none" }}
            >
              Open diagnostics
            </Link>
          </div>
        </section>

        {/* ── Right: this provider's extras (scrolls on its own) ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0, overflowY: "auto" }}>
          {/* Above keys/models elsewhere: which account a chat runs as decides
              what quota it spends, which matters more than which model it picks. */}
          {multiAccountProvider ? (
            <ProviderAccountsPanel provider={multiAccountProvider} providerLabel={descriptor.label} />
          ) : null}
          {/* The provider's bespoke extra (e.g. Devin Cloud) sits above the API
              keys: it is what makes this provider different, keys are generic. */}
          {Body ? (
            <section style={panel({ padding: 14 })}>
              <Body ctx={ctx} />
            </section>
          ) : null}
          <ProviderApiKeysPanel
            provider={descriptor.id}
            providerLabel={descriptor.label}
            additionalProviders={extraKeyProviders(descriptor.id, ctx.status?.customProviders)}
            onAfterSave={
              descriptor.id === "opencode"
                ? async (draft) => {
                    await persistOpenCodeProviderBlock(ctx.status?.customProviders ?? [], draft);
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
