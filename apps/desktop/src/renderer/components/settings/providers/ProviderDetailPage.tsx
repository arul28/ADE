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
import { PermissionModePicker } from "../../shared/PermissionModePicker";
import { getPermissionOptions } from "../../shared/permissionOptions";
import { toPermissionPickerOption } from "../../chat/crossMachineHandoffPresentation";
import type { AgentChatPermissionMode } from "../../../../shared/types";
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
import { formatProviderDiagnosticsReport } from "./providerDiagnosticsReport";
import type { AcpSettingsProviderId, ProviderDescriptor, ProvidersViewContext } from "./types";

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
    <section style={panel({ padding: 14, display: "flex", flexDirection: "column", gap: 10 })}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={SECTION_LABEL_STYLE}>Models · {models.length}</div>
        {/* Always present, never conditional on list length: the field moving in
            and out as a provider's catalog changes size is worse than a field
            that is occasionally unnecessary. */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, border: `1px solid ${COLORS.border}`, background: COLORS.cardBg, padding: "4px 8px", minWidth: 180 }}>
          <MagnifyingGlass size={12} style={{ color: COLORS.textMuted, flexShrink: 0 }} />
          <input
            aria-label={`Search ${descriptor.label} models`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models"
            style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textPrimary }}
          />
        </div>
      </div>

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
    </section>
  );
}

function DefaultsPanel({
  descriptor,
  ctx,
}: {
  descriptor: ProviderDescriptor;
  ctx: ProvidersViewContext;
}) {
  const options = useMemo(
    () => getPermissionOptions({
      family: descriptor.permissions.family,
      isCliWrapped: descriptor.permissions.isCliWrapped,
    }).map(toPermissionPickerOption),
    [descriptor],
  );
  const current = (ctx.permissionDefaults[descriptor.permissions.key] as AgentChatPermissionMode | undefined)
    ?? options[0]?.value as AgentChatPermissionMode;
  const models = descriptor.models(ctx);
  const defaultModelIsThisProvider = ctx.defaultModelId != null
    && models.some((model) => model.id === ctx.defaultModelId);

  return (
    <section style={panel({ padding: 14, display: "flex", flexDirection: "column", gap: 14 })}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={SECTION_LABEL_STYLE}>Permission default</div>
        <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
          What new {descriptor.label} chats start with. Each chat can still change it.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <PermissionModePicker
            ariaLabel={`${descriptor.label} permission default`}
            selectedValue={current}
            options={options}
            disabled={ctx.savingPermissionFor === descriptor.id}
            onSelect={(value) => void ctx.actions.setPermissionDefault(descriptor.id, value as AgentChatPermissionMode)}
          />
          {ctx.savingPermissionFor === descriptor.id ? (
            <span style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted }}>Saving…</span>
          ) : null}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={SECTION_LABEL_STYLE}>Default model</div>
        <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
          ADE has one default model across providers.
          {ctx.defaultModelId && !defaultModelIsThisProvider ? ` It is currently ${ctx.defaultModelId}.` : ""}
        </div>
        <select
          aria-label={`Default model for ${descriptor.label}`}
          value={defaultModelIsThisProvider ? String(ctx.defaultModelId) : ""}
          disabled={ctx.savingDefaultModel || models.length === 0}
          onChange={(event) => void ctx.actions.setDefaultModel(event.target.value || null)}
          style={{ border: `1px solid ${COLORS.border}`, background: COLORS.cardBgSolid, color: COLORS.textPrimary, padding: "8px 10px", fontSize: 11, fontFamily: SANS_FONT }}
        >
          <option value="">Not set</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>{model.label}</option>
          ))}
        </select>
      </div>
    </section>
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

          {/* Sign in stays reachable while disabled: switching a provider off is
              about what ADE offers, not about locking you out of its account. */}
          {AuthActions ? (
            <section style={panel({ padding: 14, display: "flex", flexDirection: "column", gap: 10 })}>
              <SubsectionTitle>Sign in</SubsectionTitle>
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
          <ModelsPanel descriptor={descriptor} ctx={ctx} />
          <DefaultsPanel descriptor={descriptor} ctx={ctx} />
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
