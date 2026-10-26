import { useEffect, useState } from "react";
import { Broom } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../../shared/types";
import type { StorageItem } from "../../../../shared/types/storage";
import { relativeWhen } from "../../../lib/format";
import { Banner } from "../../ui/notice";
import { formatMeasuredBytes } from "../../settings/storage/storageView";

type Removed = NonNullable<StorageItem["buildOutputRemoved"]>;

/** Dismissed for this app session, per cleanup, so a later cleanup shows again. */
const dismissed = new Set<string>();

/**
 * "Build output was removed 9d ago to free 1.3 GB: node_modules. Reinstall or
 * build before you run it."
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
    const read = window.ade?.storage?.laneBuildOutputRemoved;
    if (!active || typeof read !== "function") return;
    let cancelled = false;
    read(laneId, pin)
      .then((next) => {
        if (!cancelled) setRemoved(next ?? null);
      })
      // An older machine without the read, or a lane it no longer has: no notice.
      .catch(() => {});
    return () => {
      cancelled = true;
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
        title: `Build output was removed ${relativeWhen(removed.at)}${freed}: ${removed.folders.join(", ")}. Reinstall or build before you run it.`,
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
