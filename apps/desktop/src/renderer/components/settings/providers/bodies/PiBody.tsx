/**
 * Pi's own page, reparented.
 *
 * `PiProvidersPanel` is Pi's provider catalog and in-app login flow; it is not
 * rewritten here, only given a home. The nested `ProviderDetailDialog` it opens
 * for one of Pi's ~40 sub-providers stays a dialog — that is a provider inside
 * a provider, not a peer of Claude.
 */
import React from "react";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { openExternalUrl } from "../../../../lib/openExternal";
import { PiProvidersPanel } from "../../PiProvidersPanel";
import type { ProvidersViewContext } from "../types";

export function PiBody({ ctx }: { ctx: ProvidersViewContext }) {
  const piInstallation = ctx.status?.piInstallation ?? null;
  const statusLoadFailed = ctx.isInitialCheckInFlight && !ctx.loading && ctx.statusLoadError !== null;

  if (statusLoadFailed) {
    return (
      <button type="button" style={outlineButton({ height: 28 })} onClick={() => void ctx.actions.refreshStatus({ force: true })}>
        Retry Pi status
      </button>
    );
  }

  if (!piInstallation) return null;

  const openPath = (path: string) => {
    void window.ade.app.openPath(path).catch((reason: unknown) => {
      ctx.actions.setError(reason instanceof Error ? reason.message : String(reason));
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {piInstallation.error ? (
        <div style={{ fontSize: 11, fontFamily: SANS_FONT, lineHeight: 1.5, color: COLORS.warning }}>
          Inventory fallback: {piInstallation.error}
        </div>
      ) : null}

      <PiProvidersPanel
        installation={piInstallation}
        runtimeConnections={ctx.status?.runtimeConnections ?? {}}
        onSignedIn={() => void ctx.actions.refreshStatus({ force: true })}
        onRefreshStatus={() => void ctx.actions.refreshStatus({ force: true })}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", paddingTop: 12, borderTop: `1px solid ${COLORS.border}` }}>
        {!piInstallation.sdkAvailable ? (
          <button type="button" style={outlineButton({ height: 28 })} onClick={() => openExternalUrl("https://github.com/earendil-works/pi")}>Pi docs</button>
        ) : null}
        {piInstallation.settingsFileDetected ? (
          <button type="button" style={outlineButton({ height: 28 })} onClick={() => openPath(piInstallation.settingsPath)}>
            Open settings.json
          </button>
        ) : (
          <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>settings.json not found</span>
        )}
        {piInstallation.authFileDetected ? (
          <button type="button" style={outlineButton({ height: 28 })} onClick={() => openPath(piInstallation.authPath)}>
            Open auth.json
          </button>
        ) : (
          <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>auth.json not found</span>
        )}
        {piInstallation.modelsFileDetected ? (
          <button type="button" style={outlineButton({ height: 28 })} onClick={() => openPath(piInstallation.modelsPath)}>
            Open models.json
          </button>
        ) : (
          <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>models.json not found</span>
        )}
      </div>
    </div>
  );
}
