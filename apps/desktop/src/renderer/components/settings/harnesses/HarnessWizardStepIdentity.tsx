import React, { useRef } from "react";
import { UploadSimple } from "@phosphor-icons/react";
import {
  HARNESS_PRESET_NAME_MAX_LENGTH,
  harnessBodyLabel,
  type HarnessPresetDraft,
  type HarnessPresetLogo,
} from "../../../../shared/harnessPresets";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { HarnessLogo } from "../../shared/HarnessLogo";
import { SettingsTextField } from "../primitives/SettingsControls";
import { harnessModelLabel } from "./harnessModels";
import { FieldError, Row, SectionLabel } from "./wizardPrimitives";

export function StepIdentity({
  draft,
  generateAvailable,
  generating,
  logoError,
  nameError,
  onNameTouched,
  accentError,
  onPatch,
  onPickFile,
  onGenerate,
}: {
  draft: HarnessPresetDraft;
  generateAvailable: boolean;
  generating: boolean;
  logoError: string | null;
  nameError?: string;
  onNameTouched: () => void;
  accentError?: string;
  onPatch: (next: Partial<HarnessPresetDraft>) => void;
  onPickFile: (file: File | null | undefined) => void;
  onGenerate: () => void;
}) {
  // The step unmounts whenever the wizard leaves it, so the ref belongs here
  // rather than with a coordinator that renders none of the logo controls.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const tiles: Array<{ id: HarnessPresetLogo["kind"]; label: string; onSelect: () => void }> = [
    { id: "ade", label: "Default", onSelect: () => onPatch({ logo: { kind: "ade" } }) },
    {
      id: "provider",
      label: "Provider logo",
      onSelect: () => onPatch({ logo: { kind: "provider", providerId: draft.harness } }),
    },
    { id: "upload", label: "Upload", onSelect: () => fileInputRef.current?.click() },
  ];
  if (generateAvailable) {
    tiles.push({ id: "generated", label: generating ? "Generating…" : "Generate", onSelect: onGenerate });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <Row label="Name" htmlFor="harness-name">
        <SettingsTextField
          id="harness-name"
          value={draft.name}
          onChange={(value) => onPatch({ name: value.slice(0, HARNESS_PRESET_NAME_MAX_LENGTH) })}
          onBlur={onNameTouched}
          placeholder="Opus on work"
          ariaLabel="Name"
          fullWidth={false}
        />
      </Row>
      {nameError ? <FieldError>{nameError}</FieldError> : null}

      <Row label="Accent" htmlFor="harness-accent">
        <input
          id="harness-accent"
          type="color"
          aria-label="Accent"
          value={draft.accentColor}
          onChange={(event) => onPatch({ accentColor: event.target.value.toLowerCase() })}
          style={{
            width: 42,
            height: 28,
            padding: 0,
            border: `1px solid ${COLORS.outlineBorder}`,
            borderRadius: 8,
            background: "transparent",
            cursor: "pointer",
          }}
        />
      </Row>
      {accentError ? <FieldError>{accentError}</FieldError> : null}

      <section aria-label="Logo" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionLabel>Logo</SectionLabel>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {tiles.map((tile) => {
            const isSelected = draft.logo.kind === tile.id;
            return (
              <button
                key={tile.id}
                type="button"
                data-harness-logo-tile={tile.id}
                aria-pressed={isSelected}
                onClick={tile.onSelect}
                disabled={tile.id === "generated" && generating}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 6,
                  width: 96,
                  padding: 10,
                  borderRadius: 10,
                  cursor: "pointer",
                  fontFamily: SANS_FONT,
                  fontSize: 10.5,
                  color: COLORS.textPrimary,
                  border: `1px solid ${isSelected ? draft.accentColor : COLORS.outlineBorder}`,
                  background: isSelected ? `color-mix(in srgb, ${draft.accentColor} 12%, transparent)` : COLORS.cardBg,
                }}
              >
                {tile.id === "upload" ? (
                  <UploadSimple size={20} />
                ) : (
                  <HarnessLogo
                    logo={
                      tile.id === "provider"
                        ? { kind: "provider", providerId: draft.harness }
                        : tile.id === "generated" && draft.logo.kind === "generated"
                          ? draft.logo
                          : { kind: "ade" }
                    }
                    size={20}
                  />
                )}
                {tile.label}
              </button>
            );
          })}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label="Upload a logo"
          style={{ display: "none" }}
          onChange={(event) => {
            onPickFile(event.target.files?.[0]);
            // Reset so picking the same file twice still fires a change.
            event.target.value = "";
          }}
        />
        {logoError ? <FieldError>{logoError}</FieldError> : null}
      </section>

      <section aria-label="Preview" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <SectionLabel>Preview</SectionLabel>
        <span
          data-harness-preview-chip=""
          style={{
            display: "inline-flex",
            alignSelf: "flex-start",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            borderRadius: 999,
            border: `1px solid ${draft.accentColor}`,
            background: `color-mix(in srgb, ${draft.accentColor} 12%, transparent)`,
            fontSize: 12,
            fontWeight: 600,
            color: COLORS.textPrimary,
          }}
        >
          <HarnessLogo logo={draft.logo} size={18} accentColor={draft.accentColor} />
          {draft.name.trim() || harnessBodyLabel(draft.harness)}
          <span style={{ fontWeight: 400, color: COLORS.textMuted }}>
            {harnessBodyLabel(draft.harness)} · {draft.model ? harnessModelLabel(draft.model) : "no model"}
          </span>
        </span>
      </section>
    </div>
  );
}
