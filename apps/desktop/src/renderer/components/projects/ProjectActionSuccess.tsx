import React from "react";
import { CheckCircle } from "@phosphor-icons/react";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";

export type ProjectActionSuccessProps = {
  verb: "Created" | "Cloned";
  displayName: string;
  rootPath: string;
  onStay: () => void;
  onOpen: () => void;
};

export function ProjectActionSuccess({
  verb,
  displayName,
  rootPath,
  onStay,
  onOpen,
}: ProjectActionSuccessProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 16,
        padding: "12px 4px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 64,
          height: 64,
          borderRadius: 999,
          background: "color-mix(in srgb, var(--color-success) 14%, transparent)",
          color: COLORS.success,
          boxShadow: "0 0 0 1px color-mix(in srgb, var(--color-success) 32%, transparent)",
        }}
      >
        <CheckCircle size={36} weight="fill" />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center" }}>
        <div
          style={{
            fontFamily: MONO_FONT,
            fontSize: 16,
            fontWeight: 600,
            letterSpacing: "0.04em",
            color: COLORS.textPrimary,
          }}
        >
          {verb}{"  "}
          <span style={{ color: COLORS.accent }}>{displayName}</span>
        </div>
        <div
          style={{
            fontFamily: MONO_FONT,
            fontSize: 11,
            color: COLORS.textDim,
            wordBreak: "break-all",
            maxWidth: 480,
          }}
        >
          {rootPath}
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
        <button type="button" style={outlineButton()} onClick={onStay}>
          Stay here
        </button>
        <button
          type="button"
          style={primaryButton()}
          onClick={onOpen}
          autoFocus
        >
          Open project
          <span style={{ fontFamily: SANS_FONT, marginLeft: 2 }}>→</span>
        </button>
      </div>
    </div>
  );
}
