import React, { useMemo, useState } from "react";
import { CaretRight, MagnifyingGlass } from "@phosphor-icons/react";
import type { HarnessPresetAccountProvider } from "../../../../shared/harnessPresets";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { ModelRowLogo, ProviderLogo } from "../../shared/ProviderLogos";
import { ProxySignInButton, ReachableModelList } from "../../shared/ModelPicker/ReachableModelList";
import { CustomProviderSourceRail } from "./CustomProviderSourceRail";
import { formatModelLimits, type ReachableGroup, type ReachableModel } from "./harnessReach";
import type { HarnessRouteTestState } from "./useHarnessReach";

/**
 * The Custom provider editor's model pane: the source rail on the left, the
 * chosen source's models on the right.
 *
 * It owns the rail-plus-pane composition, the per-source search field, the
 * subscription Sign in, and the disclosure that names the models a source
 * cannot run in this harness. The editor around it owns the draft; a rail click
 * or a model click is reported back through `onSelectSource` / `onSelectModel`,
 * so merely browsing another provider cannot change what would be saved.
 */

/** The pane's element id, so the rail's `aria-controls` names the real pane. */
export const CUSTOM_PROVIDER_PANE_ID = "custom-provider-model-pane";

export function CustomProviderModelPane({
  groups,
  activeGroup,
  selectedKey,
  query,
  onQueryChange,
  onSelectSource,
  onSelectModel,
  onTest,
  testStateFor,
  loading,
  proxyAvailable,
  proxySigningIn,
  proxySignIn,
  harnessLabel,
}: {
  groups: readonly ReachableGroup[];
  activeGroup: ReachableGroup | null;
  selectedKey: string | null;
  query: string;
  onQueryChange: (value: string) => void;
  onSelectSource: (key: string) => void;
  onSelectModel: (group: ReachableGroup, model: ReachableModel) => void;
  onTest: (group: ReachableGroup, model: ReachableModel) => void;
  testStateFor: (group: ReachableGroup, model: ReachableModel) => HarnessRouteTestState | undefined;
  loading: boolean;
  proxyAvailable: boolean;
  proxySigningIn: HarnessPresetAccountProvider | null;
  proxySignIn: (provider: HarnessPresetAccountProvider) => void;
  harnessLabel: string;
}) {
  const searching = query.trim().length > 0;
  // While searching, the pane spans every source and each result keeps its
  // group header; otherwise it is scoped to the rail's selection.
  const paneGroups = useMemo(() => {
    if (searching) return groups;
    return activeGroup ? [activeGroup] : [];
  }, [searching, groups, activeGroup]);
  const activeSubscription = activeGroup && activeGroup.source.kind === "subscription"
    ? activeGroup.source.provider
    : null;

  return (
    <div
      data-custom-source-pane=""
      style={{
        display: "flex",
        minHeight: 300,
        maxHeight: 360,
        borderRadius: 10,
        border: `1px solid ${COLORS.borderMuted}`,
        background: COLORS.recessedBg,
        overflow: "hidden",
      }}
    >
      <CustomProviderSourceRail
        groups={groups}
        activeKey={activeGroup?.key ?? null}
        onSelect={onSelectSource}
        controlsId={CUSTOM_PROVIDER_PANE_ID}
      />
      <div id={CUSTOM_PROVIDER_PANE_ID} role="tabpanel" style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
        <header style={paneHeaderStyle}>
          {activeGroup ? <ProviderLogo family={activeGroup.logoProvider} size={14} /> : null}
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={paneTitleStyle}>
              {searching ? "Search results" : activeGroup ? activeGroup.label : "Nothing to run yet"}
            </span>
            <span style={paneDetailStyle}>
              {searching ? "Matches across every connected source" : activeGroup?.detail ?? ""}
            </span>
          </span>
          {!searching && activeGroup?.needsProxySignIn && activeSubscription ? (
            <ProxySignInButton
              provider={activeSubscription}
              available={proxyAvailable}
              signingIn={proxySigningIn === activeSubscription}
              onSignIn={proxySignIn}
            />
          ) : null}
          <label style={paneSearchStyle}>
            <MagnifyingGlass size={12} style={{ color: COLORS.textMuted, flexShrink: 0 }} />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search models"
              aria-label="Search models"
              style={paneSearchInputStyle}
            />
          </label>
        </header>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "2px 2px 6px" }}>
          <ReachableModelList
            groups={paneGroups}
            query={searching ? query : ""}
            loading={loading}
            selectedKey={selectedKey}
            onSelect={onSelectModel}
            onTest={onTest}
            testStateFor={testStateFor}
            standalone
            hideGroupHeader={!searching}
            onProxySignIn={proxySignIn}
            proxySignInAvailable={proxyAvailable}
            proxySigningIn={proxySigningIn}
            emptyState={
              <>
                {harnessLabel} has nothing to run from your connections yet. Sign in to
                OpenCode Go or Zen, or store an API key, under Providers.
              </>
            }
          />
          {!searching && activeGroup ? (
            <UnreachableModelsPanel
              key={activeGroup.key}
              group={activeGroup}
              harnessLabel={harnessLabel}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

const paneHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "7px 10px 6px",
  borderBottom: `1px solid ${COLORS.borderMuted}`,
};
const paneTitleStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11.5,
  fontWeight: 600,
  color: COLORS.textPrimary,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const paneDetailStyle: React.CSSProperties = {
  display: "block",
  fontSize: 10,
  lineHeight: 1.4,
  color: COLORS.textMuted,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const paneSearchStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: 200,
  height: 26,
  padding: "0 8px",
  borderRadius: 6,
  border: `1px solid ${COLORS.outlineBorder}`,
  background: COLORS.cardBg,
  flexShrink: 0,
};
const paneSearchInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: "none",
  outline: "none",
  background: "transparent",
  color: COLORS.textPrimary,
  fontFamily: SANS_FONT,
  fontSize: 11.5,
};

/**
 * The models a source serves that this harness can never run, with the route
 * decision's own reason.
 *
 * They stay visible on purpose: a list that silently hides a whole provider's
 * catalog leaves "why can't I use this here" with no answer anywhere in the
 * product. Collapsed to one line while other models of the source can run;
 * already open when the source can serve nothing at all.
 */
function UnreachableModelsPanel({
  group,
  harnessLabel,
}: {
  group: ReachableGroup;
  harnessLabel: string;
}) {
  const [open, setOpen] = useState(group.models.length === 0);
  if (group.unreachable.length === 0) return null;
  const reasons = [...new Set(group.unreachable.map((entry) => entry.reason))];
  const count = group.unreachable.length;
  return (
    <div
      data-custom-unreachable=""
      style={{ margin: "6px 8px 8px", borderTop: `1px solid ${COLORS.borderMuted}`, paddingTop: 6 }}
    >
      <button
        type="button"
        data-custom-unreachable-toggle=""
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: 0,
          border: "none",
          background: "transparent",
          color: COLORS.textMuted,
          fontFamily: SANS_FONT,
          fontSize: 10.5,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        <CaretRight size={10} weight="bold" style={{ transform: open ? "rotate(90deg)" : "none" }} />
        {count === 1 ? `1 model can't run in ${harnessLabel}` : `${count} models can't run in ${harnessLabel}`}
      </button>
      {open ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
          {reasons.map((reason) => (
            <p key={reason} style={{ margin: 0, fontSize: 10.5, lineHeight: 1.5, color: COLORS.textMuted }}>
              {reason}
            </p>
          ))}
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {group.unreachable.map(({ model }) => {
              const limits = formatModelLimits(model.contextWindow, model.maxOutputTokens);
              return (
                <div
                  key={model.key}
                  data-custom-unreachable-model={model.id}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", borderRadius: 6, opacity: 0.6 }}
                >
                  {model.family ? (
                    <ModelRowLogo modelFamily={model.family} modelId={model.id} size={13} />
                  ) : (
                    <span aria-hidden style={{ display: "inline-block", width: 13, flexShrink: 0 }} />
                  )}
                  <span
                    style={{
                      minWidth: 0,
                      flex: 1,
                      fontSize: 12,
                      color: COLORS.textPrimary,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {model.label}
                  </span>
                  {limits ? <span style={{ flexShrink: 0, fontSize: 10, color: COLORS.textMuted }}>{limits}</span> : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
