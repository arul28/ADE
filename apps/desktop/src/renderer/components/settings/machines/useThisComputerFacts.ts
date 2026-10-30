import { useEffect, useState } from "react";
import type { AppInfo } from "../../../../shared/types";
import type { DiskPressureSnapshot } from "../../../../shared/types/storage";
import { isAdeAvailable } from "../../../lib/adeAvailability";

/**
 * This computer's OS, service state and free disk, for Machines. Two plain
 * IPC reads, once when the page opens (the same reads General's attention
 * check makes); no polling.
 */
export function useThisComputerFacts(): { info: AppInfo | null; pressure: DiskPressureSnapshot | null } {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [pressure, setPressure] = useState<DiskPressureSnapshot | null>(null);
  useEffect(() => {
    let cancelled = false;
    const ade = window.ade;
    void Promise.resolve()
      .then(() => ade.app.getInfo())
      .then((next) => {
        if (!cancelled) setInfo(next);
      })
      .catch(() => undefined);
    if (isAdeAvailable(ade.storage?.getPressure)) {
      void Promise.resolve()
        .then(() => ade.storage.getPressure())
        .then((next) => {
          if (!cancelled) setPressure(next);
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, []);
  return { info, pressure };
}
