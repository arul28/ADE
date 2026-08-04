import React from "react";

import type { AppPackageChannel } from "../../../shared/packageChannel";
import {
  packageChannelLabel,
  rendererPackageChannel,
  requestChannelNotice,
} from "../../lib/packageChannel";

export type ChannelBadgeProps = {
  /** Defaults to the synchronous preload channel. Injected in tests. */
  channel?: AppPackageChannel;
  /** Defaults to an async `app.getInfo()`; injected in tests. */
  version?: string | null;
};

/**
 * Channel + version chip in the shell header.
 *
 * Renders nothing on stable, which is why the version fetch is guarded: a
 * stable build never issues the `getInfo()` call at all.
 *
 * It sits in the header's normal left region rather than any platform inset —
 * `--shell-header-inset-start` is only widened on darwin (for the traffic
 * lights), so on Windows and Linux there is no dead space to borrow.
 */
export function ChannelBadge({
  channel = rendererPackageChannel(),
  version,
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

  if (!isPrerelease) return null;
  const shownVersion = version !== undefined ? version : fetchedVersion;
  const label = packageChannelLabel(channel);

  return (
    <button
      type="button"
      className="ade-shell-channel-badge shrink-0"
      // The header is the window drag surface; every interactive child opts out.
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      onClick={requestChannelNotice}
      title={`${label} build — what to expect, and how to report a bug`}
      aria-label={`${label} build${shownVersion ? ` ${shownVersion}` : ""}. Open the early build notice.`}
    >
      <span>{label}</span>
      {shownVersion ? <span className="ade-shell-channel-badge-version">{shownVersion}</span> : null}
    </button>
  );
}
