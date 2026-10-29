import React from "react";

import type { AppPackageChannel } from "../../../shared/packageChannel";
import type { UpdateTrack } from "../../../shared/updateTrack";
import { packageChannelLabel, rendererPackageChannel, rendererUpdateTrack } from "../../lib/packageChannel";

export type ChannelBadgeProps = {
  /** Defaults to the synchronous preload channel. Injected in tests. */
  channel?: AppPackageChannel;
  /** Defaults to an async `app.getInfo()`; injected in tests. */
  version?: string | null;
  /** Defaults to the synchronous preload track. Injected in tests. */
  track?: UpdateTrack;
};

/**
 * Channel + version chip in the shell header.
 *
 * Channel-gated, deliberately: this is dev chrome that labels an alpha/beta
 * package as one, and renders nothing on stable — which is why the version
 * fetch is guarded: a stable build never issues the `getInfo()` call at all.
 *
 * It sits in the header's normal left region rather than any platform inset —
 * `--shell-header-inset-start` is only widened on darwin (for the traffic
 * lights), so on Windows and Linux there is no dead space to borrow.
 */
export function ChannelBadge({
  channel = rendererPackageChannel(),
  version,
  track = rendererUpdateTrack(),
}: ChannelBadgeProps): React.ReactElement | null {
  const isPrerelease = channel !== "stable";
  const [fetchedVersion, setFetchedVersion] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isPrerelease || version !== undefined) return;
    let cancelled = false;
    void window.ade?.app
      ?.getInfo?.()
      .then((info) => {
        if (!cancelled) setFetchedVersion(info.appVersion);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isPrerelease, version]);

  // Beta is a track of the normal install, not dev chrome: a tiny "BETA" next
  // to the logo, no version (Settings › About has it), no IPC.
  if (!isPrerelease && track === "beta") {
    return (
      <span
        className="ade-shell-channel-badge ade-shell-track-badge shrink-0"
        data-static="true"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        title="ADE Beta. Settings › About shows the version and the update track."
        aria-label="ADE Beta"
      >
        BETA
      </span>
    );
  }
  if (!isPrerelease) return null;
  const shownVersion = version !== undefined ? version : fetchedVersion;
  const label = packageChannelLabel(channel);
  const body = (
    <>
      <span>{label}</span>
      {shownVersion ? <span className="ade-shell-channel-badge-version">{shownVersion}</span> : null}
    </>
  );
  // Keep the badge outside the header's drag region so its title remains usable.
  const dragOptOut = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

  return (
    <span
      className="ade-shell-channel-badge shrink-0"
      data-static="true"
      style={dragOptOut}
      title={`${label} build`}
      aria-label={`${label} build${shownVersion ? ` ${shownVersion}` : ""}`}
    >
      {body}
    </span>
  );
}
