import React from "react";
import {
  HARNESS_PRESET_SUBAGENT_INHERIT,
  harnessBodyLabel,
  type HarnessPreset,
  type HarnessPresetBody,
} from "../../../../shared/harnessPresets";
import type { ProviderFamily } from "../../../../shared/modelRegistry";
import { ModelRowLogo, ProviderLogo } from "../../shared/ProviderLogos";
import { harnessModelFamily, harnessModelLabel, providerFamilyForSource } from "./harnessModels";

/**
 * The pieces a custom setup is described with, wherever it is listed.
 *
 * Settings and the model picker both have to say the same four things about a
 * preset — which harness runs it, which model it thinks with, which model its
 * subagents think with, and where its intelligence comes from — and both had
 * been saying them as run-on strings ("Claude Code · claude-opus-4-1"). A
 * string cannot carry a logo, so neither surface could show whose model it
 * actually was. These are the labelled, logo-carrying versions, defined once so
 * the two lists cannot drift.
 */

/**
 * The brand mark for a harness body.
 *
 * The body ids and `ProviderLogo`'s families agree everywhere except Copilot,
 * so the map is one entry plus a pass-through rather than a cast.
 */
const BODY_LOGO_FAMILY: Partial<Record<HarnessPresetBody, string>> = {
  copilot: "github-copilot",
};

export function bodyLogoFamily(harness: HarnessPresetBody | string): string {
  return BODY_LOGO_FAMILY[harness as HarnessPresetBody] ?? String(harness);
}

/**
 * The harness that runs a preset: its mark and its name, on one line.
 *
 * The export and its `data-preset-agent` hook keep the old word because they
 * are code, not copy. A harness is not an agent, so every string this renders
 * — and every label a caller puts beside it — says "harness".
 */
export function PresetAgent({
  harness,
  size = 14,
  className,
}: {
  harness: HarnessPresetBody | string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      data-preset-agent={String(harness)}
      className={className}
      style={{ display: "inline-flex", minWidth: 0, alignItems: "center", gap: 6 }}
    >
      <ProviderLogo family={bodyLogoFamily(harness)} size={size} />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {harnessBodyLabel(String(harness))}
      </span>
    </span>
  );
}

/**
 * One model with the role it plays: `Main · ◆ Claude Opus 4.5`.
 *
 * The role label is the point. Two model names stacked with nothing to tell
 * them apart is the "plain-text dump" version of this row — which one the chat
 * thinks with and which one its subagents get is the whole reason both are
 * shown.
 */
export function PresetModel({
  role,
  modelId,
  fallbackFamily,
  size = 13,
  roleWidth = 58,
  className,
  catalogScopeKey,
}: {
  role: string;
  modelId: string;
  /**
   * Which runtime catalog bucket the display name comes from. Settings reads
   * the default one; the composer's picker may be pinned to a machine, and a
   * runtime-only model resolved against the wrong bucket falls back to its raw
   * slug.
   */
  catalogScopeKey?: string;
  /**
   * The family to wear when the registry has never seen this id — a custom
   * endpoint's model, or one added upstream since this build. It is the
   * preset's own source family, which is a fact rather than a guess at the
   * brand from the id's spelling.
   */
  fallbackFamily?: ProviderFamily | null;
  size?: number;
  /** Fixed so the two role labels in a row line their models up. */
  roleWidth?: number;
  className?: string;
}) {
  const family = harnessModelFamily(modelId) ?? fallbackFamily ?? null;
  const label = harnessModelLabel(modelId, catalogScopeKey);
  return (
    <span
      data-preset-model={role.toLowerCase()}
      className={className}
      style={{ display: "flex", minWidth: 0, alignItems: "center", gap: 6 }}
    >
      <span
        style={{
          width: roleWidth,
          flexShrink: 0,
          opacity: 0.6,
          fontSize: "0.9em",
          textTransform: "lowercase",
        }}
      >
        {role}
      </span>
      {/* Registry family first, then the source it came from. Neither known
          means no mark at all, never a guessed one. */}
      {family ? <ModelRowLogo modelFamily={family} modelId={modelId} size={size} /> : null}
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
    </span>
  );
}

/**
 * Main and subagents, stacked.
 *
 * A preset on "same as main" shows one line, not two: repeating the model name
 * under itself says nothing, and the second line is what makes a *different*
 * subagent model visible at a glance.
 */
export function PresetModels({
  preset,
  size = 13,
  roleWidth = 58,
  catalogScopeKey,
}: {
  preset: Pick<HarnessPreset, "model" | "subagentModel" | "source">;
  size?: number;
  roleWidth?: number;
  /** See `PresetModel` — the bucket the display names resolve against. */
  catalogScopeKey?: string;
}) {
  const inherits = preset.subagentModel === HARNESS_PRESET_SUBAGENT_INHERIT;
  const fallbackFamily = providerFamilyForSource(preset.source);
  return (
    <span data-preset-models="" style={{ display: "flex", minWidth: 0, flexDirection: "column", gap: 3 }}>
      <PresetModel
        role="Main"
        modelId={preset.model}
        fallbackFamily={fallbackFamily}
        size={size}
        roleWidth={roleWidth}
        catalogScopeKey={catalogScopeKey}
      />
      {inherits ? (
        <span style={{ display: "flex", minWidth: 0, alignItems: "center", gap: 6 }}>
          <span style={{ width: roleWidth, flexShrink: 0, opacity: 0.6, fontSize: "0.9em" }}>subagents</span>
          <span style={{ opacity: 0.6 }}>Same as main</span>
        </span>
      ) : (
        <PresetModel
          role="Subagents"
          modelId={preset.subagentModel}
          fallbackFamily={fallbackFamily}
          size={size}
          roleWidth={roleWidth}
          catalogScopeKey={catalogScopeKey}
        />
      )}
    </span>
  );
}
