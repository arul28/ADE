/**
 * One provider's page. Two columns: what it is and how to sign in on the left,
 * what it can do on the right. Everything on it comes from the descriptor, so
 * every provider's page has the same shape and the same status vocabulary.
 */
import React, { useMemo, useState } from "react";
import { ArrowLeft, MagnifyingGlass, Star } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import {
  COLORS,
  SANS_FONT,
  SECTION_LABEL_STYLE,
  outlineButton,
} from "../../lanes/laneDesignTokens";
import { settingsRouteFor } from "../settingsManifest";
import { ProviderPanel, panel } from "../providerSectionPrimitives";
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
 * Eight rows, then scroll.
 *
 * A row is 11px text on 6px of padding top and bottom plus a hairline —
 * 6 + 17 + 6 + 1 = 30px. Eight of those is 240, and the half-row the ninth
 * shows through the cut is the cue that there is more. This is a cap, not a
 * preference: OpenCode reports 83 models and Cursor 36, and a panel that grew
 * with them pushed everything else on the page below the fold.
 */
const MODEL_ROW_HEIGHT = 30;
const MODEL_LIST_MAX_HEIGHT = MODEL_ROW_HEIGHT * 8;

function ModelsPanel({
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
    <ProviderPanel
      title="Models"
      count={models.length}
      actions={
        // Always present, never conditional on list length: the field moving in
        // and out as a provider's catalog changes size is worse than a field
        // that is occasionally unnecessary. Its height matches the Add buttons
        // on the panels above it, so the three header strips line up.
        <div style={{ display: "flex", alignItems: "center", gap: 6, height: 26, border: `1px solid ${COLORS.border}`, background: COLORS.cardBg, padding: "0 8px", minWidth: 180 }}>
          <MagnifyingGlass size={12} style={{ color: COLORS.textMuted, flexShrink: 0 }} />
          <input
            aria-label={`Search ${descriptor.label} models`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models"
            style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textPrimary }}
          />
        </div>
      }
    >
      {/* The model list IS the health check: an enumerate that failed says so
          here, in place of a Verify button that would only ask again. Suppressed
          when the left rail already says exactly this — one sentence, once. */}
      {status.errorLine && status.errorLine !== status.message
        ? <ProviderErrorRow message={status.errorLine} />
        : null}

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
          // `tabIndex` makes the overflow box a focus target, without which a
          // keyboard user can Tab past a list of 83 models and never reach the
          // arrow keys that would scroll it.
          tabIndex={0}
          role="group"
          aria-label={`${descriptor.label} models`}
          style={{
            display: "flex",
            flexDirection: "column",
            maxHeight: MODEL_LIST_MAX_HEIGHT,
            overflowY: "auto",
            outline: "none",
          }}
        >
          {filtered.map((model) => (
            <div
              key={model.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 0",
                borderTop: `1px solid ${COLORS.borderMuted}`,
                minWidth: 0,
              }}
            >
              {model.isDefault ? (
                <Star size={11} weight="fill" style={{ color: COLORS.accent, flexShrink: 0 }} />
              ) : (
                <span style={{ width: 11, flexShrink: 0 }} />
              )}
              <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textPrimary, minWidth: 0, overflowWrap: "anywhere" }}>
                {model.label}
              </span>
              {model.label !== model.id ? (
                <span style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim, marginLeft: "auto", overflowWrap: "anywhere" }}>
                  {model.id}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </ProviderPanel>
  );
}

export function ProviderDetailPage({
  descriptor,
  ctx,
  onBack,
}: {
  descriptor: ProviderDescriptor;
  ctx: ProvidersViewContext;
  onBack: () => void;
}) {
  const status = providerStatusFor(descriptor, ctx);
  const disabled = ctx.disabledProviders.has(descriptor.id);
  const version = normalizeProviderVersion(descriptor.version?.(ctx));
  const facts = descriptor.facts?.(ctx) ?? [];
  const AuthActions = descriptor.AuthActions;
  const Diagnostics = descriptor.Diagnostics;
  const Body = descriptor.Body;
  // Claude and Codex are the only providers that can hold more than one local
  // login, so they are the only ones with an Accounts panel. Everything else
  // has exactly one identity per machine and would get a one-row list that says
  // nothing the left rail does not already say.
  const multiAccountProvider = isProviderInstanceProvider(descriptor.id) ? descriptor.id : null;
  const diagnosticReport = formatProviderDiagnosticsReport({
    label: descriptor.label,
    status,
    version,
    facts,
    acp: ctx.acpDiagnostics[descriptor.id as AcpSettingsProviderId] ?? null,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <button
        type="button"
        aria-label="Back to all providers"
        onClick={onBack}
        style={{ ...outlineButton({ height: 28 }), alignSelf: "flex-start" }}
      >
        <ArrowLeft size={12} weight="bold" /> Back
      </button>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(240px, 300px) minmax(0, 1fr)",
          gap: 16,
          alignItems: "start",
        }}
      >
        {/* ── Left rail: identity, status, auth ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <section style={panel({ padding: 14, borderLeft: `3px solid ${providerStatusColor(status.state)}`, display: "flex", flexDirection: "column", gap: 10 })}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              {descriptor.logo(26)}
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

            <ProviderStatusChip state={status.state} label={status.label} />

            <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
              {status.message}
            </div>

            {version ? (
              <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
                Version {version}
              </div>
            ) : null}

            {facts.map((fact) => (
              <div key={`${fact.label}:${fact.value}`} style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim }}>{fact.label}</div>
                {fact.mono ? (
                  <PathLine value={fact.value} />
                ) : (
                  <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textSecondary, overflowWrap: "anywhere" }}>
                    {fact.value}
                  </div>
                )}
              </div>
            ))}
          </section>

          {/* Claude and Codex sign in from the Accounts panel on the right.
              A second Sign in section here only repeats that, and stays as an
              empty box once the account is already signed in. A missing CLI
              still needs the install command, which the account rows do not
              show. Every other provider has no Accounts panel, so Sign in
              stays here, including while the provider is switched off. */}
          {AuthActions && !multiAccountProvider ? (
            <section style={panel({ padding: 14, display: "flex", flexDirection: "column", gap: 10 })}>
              <SubsectionTitle>Sign in</SubsectionTitle>
              <AuthActions ctx={ctx} />
            </section>
          ) : null}
          {AuthActions && multiAccountProvider && status.state === "not-installed" ? (
            <section style={panel({ padding: 14, display: "flex", flexDirection: "column", gap: 10 })}>
              <SubsectionTitle>Install</SubsectionTitle>
              <AuthActions ctx={ctx} />
            </section>
          ) : null}

          <section style={panel({ padding: 14, display: "flex", flexDirection: "column", gap: 8 })}>
            <SubsectionTitle>Availability</SubsectionTitle>
            <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
              {disabled
                ? `${descriptor.label} is switched off. Turn it back on to offer its models again.`
                : `Turn ${descriptor.label} off to keep its models out of every picker on this machine.`}
            </div>
            <button
              type="button"
              aria-pressed={disabled}
              style={outlineButton({ height: 28 })}
              disabled={ctx.savingDisabledFor === descriptor.id}
              onClick={() => void ctx.actions.setProviderDisabled(descriptor.id, !disabled)}
            >
              {ctx.savingDisabledFor === descriptor.id
                ? "Saving…"
                : disabled
                  ? `Enable ${descriptor.label}`
                  : `Disable ${descriptor.label}`}
            </button>
          </section>

          <section style={panel({ padding: 14, display: "flex", flexDirection: "column", gap: 8 })}>
            <SubsectionTitle>Troubleshooting</SubsectionTitle>
            <button
              type="button"
              style={outlineButton({ height: 28 })}
              disabled={ctx.loading}
              onClick={() => void ctx.actions.refreshStatus({ force: true, refreshOpenCodeInventory: true })}
            >
              {ctx.loading ? "Checking…" : "Check again"}
            </button>
            {Diagnostics ? <Diagnostics ctx={ctx} /> : null}
            <CopyReportButton report={diagnosticReport} label="Copy diagnostics" />
            <Link
              to={settingsRouteFor("storage.diagnostics")}
              style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.accent, textDecoration: "none" }}
            >
              Open diagnostics
            </Link>
          </section>
        </div>

        {/* ── Right: what it can do ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          {/* Above Models on purpose: which account a chat runs as decides what
              quota it spends, which is a more consequential answer than which
              model it picks. */}
          {multiAccountProvider ? (
            <ProviderAccountsPanel provider={multiAccountProvider} providerLabel={descriptor.label} />
          ) : null}
          {/* Keys sit under accounts and above Models for the same reason: what
              a chat spends is decided by the credential it runs on, not by the
              model it picks. */}
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
                    await persistOpenCodeProviderBlock(ctx.status?.customProviders ?? [], draft);
                    await ctx.actions.refreshStatus({ force: true, refreshOpenCodeInventory: true });
                  }
                : undefined
            }
          />
          <ModelsPanel descriptor={descriptor} ctx={ctx} />
          {/* The "Permission default" and "Default model" controls used to sit
              here. Both were removed rather than fixed, because neither
              reached the product: no chat-launch path ever read
              `ai.defaultModel`, and the permission picker wrote
              `ai.permissions.providers.*` while nine of the ten providers read
              a different key entirely. A control that saves and changes nothing
              is worse than no control — it answers a question the user then
              stops asking. Per-chat permission is set at launch, where it
              works. */}
          {Body ? (
            <section style={panel({ padding: 14 })}>
              <Body ctx={ctx} />
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
