import React from "react";

import type { AppPackageChannel } from "../../../shared/packageChannel";
import { packageChannelLabel, rendererPackageChannel } from "../../lib/packageChannel";
import { isWindowsPlatform, requestWindowsBetaNotice } from "../../lib/windowsBetaNotice";

export type ChannelBadgeProps = {
  /** Defaults to the synchronous preload channel. Injected in tests. */
  channel?: AppPackageChannel;
  /** Defaults to an async `app.getInfo()`; injected in tests. */
  version?: string | null;
  /** Defaults to the synchronous preload platform. Injected in tests. */
  platform?: string;
};

/**
 * Channel + version chip in the shell header.
 *
 * Channel-gated, deliberately: this is dev chrome that labels an alpha/beta
 * package as one, and renders nothing on stable — which is why the version
 * fetch is guarded: a stable build never issues the `getInfo()` call at all.
 * It is unrelated to the Windows beta notice, which is platform-gated.
 *
 * It sits in the header's normal left region rather than any platform inset —
 * `--shell-header-inset-start` is only widened on darwin (for the traffic
 * lights), so on Windows and Linux there is no dead space to borrow.
 *
 * On Windows the chip doubles as the re-open affordance for the Windows beta
 * notice. Elsewhere that notice does not exist, so the chip renders as a static
 * label rather than a button that would do nothing when clicked.
 */
export function ChannelBadge({
  channel = rendererPackageChannel(),
  version,
  platform,
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
  const opensNotice = isWindowsPlatform(platform);
  const body = (
    <>
      <span>{label}</span>
      {shownVersion ? <span className="ade-shell-channel-badge-version">{shownVersion}</span> : null}
    </>
  );
  // The header is the window drag surface; every interactive child opts out.
  const dragOptOut = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

  if (!opensNotice) {
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

  return (
    <button
      type="button"
      className="ade-shell-channel-badge shrink-0"
      style={dragOptOut}
      onClick={requestWindowsBetaNotice}
      title={`${label} build — what to expect on Windows, and how to report a bug`}
      aria-label={`${label} build${shownVersion ? ` ${shownVersion}` : ""}. Open the Windows beta notice.`}
    >
      {body}
    </button>
  );
}
