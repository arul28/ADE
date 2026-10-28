import { useEffect, useState } from "react";
import { Broom } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../../shared/types";
import type { StorageItem } from "../../../../shared/types/storage";
import { isAdeAvailable } from "../../../lib/adeAvailability";
import { relativeWhen } from "../../../lib/format";
import { Banner } from "../../ui/notice";
import { formatMeasuredBytes } from "../../settings/storage/storageView";

type Removed = NonNullable<StorageItem["buildOutputRemoved"]>;

/** While the notice shows: how often to look for the folders coming back. */
const RECHECK_MS = 60_000;

/** Folders named in the notice; the rest are counted. */
const MAX_LISTED_FOLDERS = 3;

function folderList(folders: string[]): string {
  const listed = folders.slice(0, MAX_LISTED_FOLDERS).join(", ");
  const more = folders.length - MAX_LISTED_FOLDERS;
  return more > 0 ? `${listed} and ${more} more` : listed;
}

/** Dismissed for this app session, per cleanup, so a later cleanup shows again. */
const dismissed = new Set<string>();

/**
 * "Build output was removed 9d ago to free 1.3 GB", then which folders and
 * "Reinstall or build before you run it."
 *
 * The idle-lane cleanup removes rebuildable folders from lanes nobody used
 * for a week. Coming back to such a lane, a missing node_modules otherwise
 * shows up as a confusing failure on the first run. The read goes to the
 * lane's own machine (`pin`) and ends once the folders are back.
 */
export function LaneBuildOutputNotice({
  laneId,
  pin,
  active,
}: {
  laneId: string;
  /** The lane's machine when it is not the tab's; null keeps the unpinned route. */
  pin: OpenProjectBinding | null;
  active: boolean;
}) {
  const [removed, setRemoved] = useState<Removed | null>(null);
  const [, setDismissTick] = useState(0);
  const pinKey = pin?.key ?? null;

  useEffect(() => {
    setRemoved(null);
    if (!active || !isAdeAvailable(window.ade?.storage?.laneBuildOutputRemoved)) return;
    let cancelled = false;
    let showing = false;
    const refresh = () => {
      const read = window.ade?.storage?.laneBuildOutputRemoved;
      if (!isAdeAvailable(read)) return;
      read(laneId, pin)
        .then((next) => {
          if (cancelled) return;
          showing = Boolean(next && next.folders.length > 0);
          setRemoved(next ?? null);
        })
        // An older machine without the read, or a lane it no longer has: no notice.
        .catch(() => {});
    };
    refresh();
    // A reinstall or build in a terminal or another app brings the folders
    // back; re-check when the window comes back and, only while the notice
    // shows, once a minute, so it goes away without reopening the lane.
    const onFocus = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const timer = window.setInterval(() => {
      if (showing && document.visibilityState === "visible") refresh();
    }, RECHECK_MS);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.clearInterval(timer);
    };
    // `pin` is read through its key: a rebuilt pin with the same key is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, laneId, pinKey]);

  if (!removed || removed.folders.length === 0) return null;
  const dismissKey = `${pinKey ?? "local"}:${laneId}:${removed.at}`;
  if (dismissed.has(dismissKey)) return null;
  const freed = removed.bytes > 0 || removed.partial
    ? ` to free ${formatMeasuredBytes(removed.bytes, removed.partial)}`
    : "";

  return (
    <Banner
      layout="inline"
      testId="lane-build-output-notice"
      style={{ margin: "0 -8px" }}
      model={{
        id: `lane-build-output-notice:${laneId}`,
        tone: "info",
        icon: <Broom size={13} weight="bold" />,
        title: `Build output was removed ${relativeWhen(removed.at)}${freed}`,
        detail: `${folderList(removed.folders)}. Reinstall or build before you run it.`,
        dismiss: {
          onDismiss: () => {
            dismissed.add(dismissKey);
            setDismissTick((tick) => tick + 1);
          },
          label: "Dismiss",
        },
      }}
    />
  );
}
