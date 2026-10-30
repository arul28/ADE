import React from "react";

import type { AppPackageChannel } from "../../../shared/packageChannel";
import { updateTrackLabel, type UpdateTrack } from "../../../shared/updateTrack";
import { packageChannelLabel, rendererPackageChannel } from "../../lib/packageChannel";
import { rendererUpdateTrack } from "../../lib/updateTrack";

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

  // Beta is a track of the normal install, not dev chrome: the same chip with
  // only the word. Settings › About has the version.
  const betaTrack = !isPrerelease && track === "beta";
  if (!isPrerelease && !betaTrack) return null;
  const shownVersion = betaTrack ? null : version !== undefined ? version : fetchedVersion;
  const label = betaTrack ? "BETA" : packageChannelLabel(channel);
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
      title={betaTrack ? "ADE Beta. Settings › About shows the version and the update track." : `${label} build`}
      aria-label={betaTrack ? "ADE Beta" : `${label} build${shownVersion ? ` ${shownVersion}` : ""}`}
    >
      {body}
    </span>
  );
}

/**
 * A machine's update track as the header's chip: the amber BETA chip, or a
 * quiet STABLE one beside it when both tracks are in one list.
 */
export function UpdateTrackChip({ track }: { track: UpdateTrack }): React.ReactElement {
  return (
    <span
      className="ade-shell-channel-badge shrink-0"
      data-static="true"
      data-track={track}
      aria-label={updateTrackLabel(track)}
    >
      {track === "beta" ? "BETA" : "STABLE"}
    </span>
  );
}
