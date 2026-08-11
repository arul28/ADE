import React, { useState } from "react";
import type { PiLoginMethod } from "../../../shared/types/config";
import {
  piLoginMethodLabel,
  piProviderAuthSummary,
  piProviderIsConnected,
  type PiProviderRow,
} from "./piProviderRow";
import {
  COLORS,
  MONO_FONT,
  SECTION_LABEL_STYLE,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { ProviderDetailDialog } from "./providerSectionPrimitives";

const MODEL_PREVIEW_LIMIT = 12;

/**
 * A provider's own page: which models it contributes and how it can be signed
 * into. Starting a sign-in closes this and hands the flow back to the section,
 * so the device code and prompts stay on screen even after the dialog is gone.
 */
export function PiProviderDetailModal({
  provider,
  modelIds,
  onStartSignIn,
  onClose,
}: {
  provider: PiProviderRow;
  /** Native Pi model ids this provider contributes, already decoded. */
  modelIds: string[];
  onStartSignIn: (providerId: string, method: PiLoginMethod) => void;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const connected = piProviderIsConnected(provider);
  const login = provider.login;
  const status = provider.status;
  const shown = expanded ? modelIds : modelIds.slice(0, MODEL_PREVIEW_LIMIT);
  const statusLabel = connected
    ? status
      ? piProviderAuthSummary(status)
      : "Connected"
    : login?.authTypes.length
      ? "Sign-in available"
      : "Not connected";

  return (
    <ProviderDetailDialog
      providerId={provider.id}
      title={provider.name}
      subtitle={`${statusLabel}${status?.authLabel ? ` \u00b7 ${status.authLabel}` : ""}`}
      onClose={onClose}
    >
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={SECTION_LABEL_STYLE}>Sign in</div>
          {login?.authTypes.length ? (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {login.authTypes.map((method) => (
                <button
                  key={method}
                  type="button"
                  style={method === "oauth" ? primaryButton({ height: 28 }) : outlineButton({ height: 28 })}
                  aria-label={`${piLoginMethodLabel(login, method)} \u2014 ${provider.name}`}
                  onClick={() => onStartSignIn(provider.id, method)}
                >
                  {piLoginMethodLabel(login, method)}
                </button>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, lineHeight: 1.5 }}>
              {status?.authType === "local"
                ? "This provider is a server you run, so there is nothing to sign in to."
                : connected
                  ? "Pi resolves this provider's credential itself \u2014 from your environment or its own config \u2014 so there is nothing to sign in to here."
                  : "Pi does not offer an interactive sign-in for this provider."}
            </div>
          )}
          {connected && login?.authTypes.length ? (
            <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>
              Already connected. Signing in again replaces the stored credential.
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={SECTION_LABEL_STYLE}>
            Models{modelIds.length ? ` \u00b7 ${modelIds.length}` : ""}
          </div>
          {shown.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {shown.map((modelId) => (
                <code
                  key={modelId}
                  style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textSecondary, overflowWrap: "anywhere" }}
                >
                  {modelId}
                </code>
              ))}
              {modelIds.length > shown.length ? (
                <button
                  type="button"
                  style={{ ...outlineButton({ height: 24, fontSize: 10 }), alignSelf: "flex-start" }}
                  onClick={() => setExpanded(true)}
                >
                  Show {modelIds.length - shown.length} more
                </button>
              ) : null}
            </div>
          ) : (
            <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>
              {connected
                ? "Pi reports no models for this provider yet. Refresh providers after signing in."
                : "Models appear once this provider is connected."}
            </div>
          )}
        </div>
      </div>
    </ProviderDetailDialog>
  );
}
