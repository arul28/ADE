import { useMemo, type ReactNode } from "react";
import {
  HARNESS_PRESET_AGENT_KEYS,
  HARNESS_PRESET_AGENT_LABELS,
  HARNESS_PRESET_SUBAGENT_INHERIT,
  harnessPresetAgentOverrideNote,
  type HarnessPresetDraft,
  type HarnessPresetSource,
} from "../../../../shared/harnessPresets";
import { COLORS, SANS_FONT, outlineButton } from "../../lanes/laneDesignTokens";
import { providerColor } from "../../usage/providerColors";
import { ProviderLogo } from "../../shared/ProviderLogos";
import { ReasoningEffortPicker } from "../../shared/ModelPicker/ReasoningEffortPicker";
import { SettingsDisclosure } from "../primitives/SettingsDisclosure";
import { SettingsSelect, SettingsTextField } from "../primitives/SettingsControls";
import {
  HARNESS_PROXY_SIGN_IN_UNAVAILABLE,
  harnessSourceRowDetail,
  harnessSourceRowTitle,
  sourceMatchesRow,
  type HarnessModelSource,
} from "./harnessSources";
import { Row, SectionLabel } from "./wizardPrimitives";

const ADVANCED_FOLLOWS = "follows";

/** Stable React key and test hook for one source row. */
function sourceRowKey(row: HarnessModelSource): string {
  if (row.kind === "account") return `account:${row.instanceId}`;
  if (row.kind === "key") return `key:${row.provider}:${row.credentialId}`;
  return `subscription:${row.provider}`;
}

/**
 * One source row: an account, a stored key, or a proxy subscription.
 *
 * Shared by both groups so the two lists cannot drift apart visually; a group
 * that needs a control beside the row — the proxy group's Sign in button —
 * passes it in as `trailing` rather than the row guessing which kind it is.
 */
function SourceRow({
  row,
  selected,
  trailing,
  onChoose,
}: {
  row: HarnessModelSource;
  selected: boolean;
  trailing?: ReactNode;
  onChoose: (row: HarnessModelSource) => void;
}) {
  const key = sourceRowKey(row);
  const accent = row.kind === "account" && row.accentColor ? row.accentColor : providerColor(row.provider);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 11px",
        borderRadius: 9,
        border: `1px solid ${selected ? accent : COLORS.outlineBorder}`,
        background: selected ? `color-mix(in srgb, ${accent} 10%, transparent)` : COLORS.cardBg,
      }}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        data-harness-source={key}
        onClick={() => onChoose(row)}
        style={{
          display: "flex",
          flex: 1,
          minWidth: 0,
          alignItems: "center",
          gap: 10,
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          textAlign: "left",
          fontFamily: SANS_FONT,
        }}
      >
        <ProviderLogo family={row.provider} size={18} />
        <span style={{ minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>
            {harnessSourceRowTitle(row)}
          </span>
          <span style={{ display: "block", fontSize: 10.5, color: COLORS.textMuted }}>
            {harnessSourceRowDetail(row)}
          </span>
        </span>
      </button>
      {trailing ?? null}
    </div>
  );
}

/** The Sign in control the proxy group hangs off each of its rows. */
function ProxySignInButton({ provider, available }: { provider: string; available: boolean }) {
  return (
    <button
      type="button"
      data-harness-proxy-sign-in={provider}
      disabled={!available}
      title={available ? undefined : HARNESS_PROXY_SIGN_IN_UNAVAILABLE}
      onClick={() => {
        const signIn = (window as unknown as {
          ade?: { proxy?: { signIn?: (args: { provider: string }) => Promise<unknown> } };
        }).ade?.proxy?.signIn;
        if (typeof signIn === "function") void signIn({ provider });
      }}
      style={outlineButton({
        opacity: available ? 1 : 0.55,
        cursor: available ? "pointer" : "not-allowed",
      })}
    >
      Sign in
    </button>
  );
}

/**
 * One titled group of source rows.
 *
 * Both groups are the same list with a different heading, so they are the same
 * component: two near-identical copies are how one group quietly loses a
 * radiogroup role or an aria-label the other still has.
 */
function SourceGroup({
  label,
  rows,
  selectedSource,
  onChoose,
  renderTrailing,
  footnote,
}: {
  label: string;
  rows: HarnessModelSource[];
  selectedSource: HarnessPresetSource;
  onChoose: (row: HarnessModelSource) => void;
  renderTrailing?: (row: HarnessModelSource) => ReactNode;
  footnote?: ReactNode;
}) {
  return (
    <section aria-label={label} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <SectionLabel>{label}</SectionLabel>
      <div
        role="radiogroup"
        aria-label={label}
        style={{ display: "flex", flexDirection: "column", gap: 6 }}
      >
        {rows.map((row) => (
          <SourceRow
            key={sourceRowKey(row)}
            row={row}
            selected={sourceMatchesRow(selectedSource, row)}
            trailing={renderTrailing?.(row)}
            onChoose={onChoose}
          />
        ))}
      </div>
      {footnote ?? null}
    </section>
  );
}

export function StepModel({
  draft,
  ownedSources,
  proxySources,
  modelChoices,
  modelsLoading,
  freeTextModel,
  freeTextPlaceholder,
  proxyAvailable,
  onChooseSource,
  onPatch,
}: {
  draft: HarnessPresetDraft;
  /** Accounts and stored keys — the identities this computer holds. */
  ownedSources: HarnessModelSource[];
  /** Subscriptions reached through ADE's proxy. */
  proxySources: HarnessModelSource[];
  modelChoices: Array<{ id: string; label: string }>;
  /** True while the live catalog request for this provider is in flight. */
  modelsLoading: boolean;
  freeTextModel: boolean;
  freeTextPlaceholder: string;
  proxyAvailable: boolean;
  onChooseSource: (row: HarnessModelSource) => void;
  onPatch: (next: Partial<HarnessPresetDraft>) => void;
}) {
  const subagentOptions = useMemo(
    () => [
      { value: HARNESS_PRESET_SUBAGENT_INHERIT, label: "Same as main" },
      ...modelChoices.map((choice) => ({ value: choice.id, label: choice.label })),
    ],
    [modelChoices],
  );
  // The empty option carries the state of the list, so a select that is still
  // filling says so instead of reading as a provider with no models.
  const modelPlaceholder = modelsLoading
    ? "Loading models…"
    : modelChoices.length === 0
      ? "No models reported yet"
      : "Choose a model";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
        {ownedSources.length > 0 ? (
          <SourceGroup
            label="Your accounts and keys"
            rows={ownedSources}
            selectedSource={draft.source}
            onChoose={onChooseSource}
          />
        ) : null}

        {proxySources.length > 0 ? (
          <SourceGroup
            label="Through ADE's proxy"
            rows={proxySources}
            selectedSource={draft.source}
            onChoose={onChooseSource}
            renderTrailing={(row) => <ProxySignInButton provider={row.provider} available={proxyAvailable} />}
            footnote={
              !proxyAvailable ? (
                <p style={{ margin: 0, fontSize: 10.5, color: COLORS.textMuted }}>
                  {HARNESS_PROXY_SIGN_IN_UNAVAILABLE}
                </p>
              ) : null
            }
          />
        ) : null}

        {ownedSources.length === 0 && proxySources.length === 0 ? (
          <p style={{ margin: 0, fontSize: 11.5, color: COLORS.textMuted }}>
            No accounts or keys yet. Add one on the AI providers page, then come back.
          </p>
        ) : null}
      </div>

      <Row label="Model" htmlFor="harness-model">
        {freeTextModel ? (
          <SettingsTextField
            id="harness-model"
            value={draft.model}
            onChange={(value) => onPatch({ model: value })}
            placeholder={freeTextPlaceholder}
            ariaLabel="Model"
            mono
            fullWidth={false}
          />
        ) : (
          <SettingsSelect
            id="harness-model"
            ariaLabel="Model"
            value={draft.model}
            options={[{ value: "", label: modelPlaceholder }, ...modelChoices.map((choice) => ({ value: choice.id, label: choice.label }))]}
            onChange={(value) => onPatch({ model: value })}
          />
        )}
      </Row>

      {draft.model ? (
        <Row label="Effort">
          <ReasoningEffortPicker
            modelId={draft.model}
            reasoningEffort={draft.reasoningEffort ?? null}
            useFamilyDefaults={false}
            onChange={(effort) =>
              onPatch(effort ? { reasoningEffort: effort } : { reasoningEffort: undefined })
            }
          />
        </Row>
      ) : null}

      <Row label="Subagents" htmlFor="harness-subagent-model">
        <SettingsSelect
          id="harness-subagent-model"
          ariaLabel="Subagent model"
          value={draft.subagentModel}
          options={subagentOptions}
          onChange={(value) => onPatch({ subagentModel: value })}
        />
      </Row>

      {draft.harness === "claude" ? (
        <SettingsDisclosure summary="Advanced" gap={12}>
          {HARNESS_PRESET_AGENT_KEYS.map((agent) => {
            const value = draft.agentOverrides[agent] ?? ADVANCED_FOLLOWS;
            const pinned = value !== ADVANCED_FOLLOWS;
            return (
              <div key={agent} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <Row label={HARNESS_PRESET_AGENT_LABELS[agent]} htmlFor={`harness-agent-${agent}`}>
                  <SettingsSelect
                    id={`harness-agent-${agent}`}
                    ariaLabel={`${HARNESS_PRESET_AGENT_LABELS[agent]} model`}
                    value={value}
                    options={[
                      { value: ADVANCED_FOLLOWS, label: "Follows subagents" },
                      ...modelChoices.map((choice) => ({ value: choice.id, label: choice.label })),
                    ]}
                    onChange={(next) => {
                      const overrides = { ...draft.agentOverrides };
                      if (next === ADVANCED_FOLLOWS) delete overrides[agent];
                      else overrides[agent] = next;
                      onPatch({ agentOverrides: overrides });
                    }}
                  />
                </Row>
                {pinned ? (
                  <p
                    data-harness-agent-note={agent}
                    style={{ margin: 0, fontSize: 10.5, lineHeight: 1.5, color: COLORS.textMuted }}
                  >
                    {harnessPresetAgentOverrideNote(agent)}
                  </p>
                ) : null}
              </div>
            );
          })}
        </SettingsDisclosure>
      ) : null}
    </div>
  );
}
