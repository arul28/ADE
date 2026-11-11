import { useEffect, useState } from "react";
import type { AppInfo } from "../../../../shared/types";
import type { DiskPressureSnapshot } from "../../../../shared/types/storage";
import { isAdeAvailable } from "../../../lib/adeAvailability";

/**
 * This computer's OS, service state and free disk, for Machines. Two plain
 * IPC reads, once when the page opens (the same reads General's attention
 * check makes); no polling.
 */
export function useThisComputerFacts(): {
  info: AppInfo | null;
  pressure: DiskPressureSnapshot | null;
  error: { info: boolean; pressure: boolean };
  retry: () => void;
} {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [pressure, setPressure] = useState<DiskPressureSnapshot | null>(null);
  // Each read reports on its own row: a failed disk read must not claim the OS
  // could not be read.
  const [infoError, setInfoError] = useState(false);
  const [pressureError, setPressureError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setInfoError(false);
    setPressureError(false);
    const ade = window.ade;
    void Promise.resolve()
      .then(() => ade.app.getInfo())
      .then((next) => {
        if (!cancelled) setInfo(next);
      })
      .catch(() => {
        if (!cancelled) setInfoError(true);
      });
    if (isAdeAvailable(ade.storage?.getPressure)) {
      void Promise.resolve()
        .then(() => ade.storage.getPressure())
        .then((next) => {
          if (!cancelled) setPressure(next);
        })
        .catch(() => {
          if (!cancelled) setPressureError(true);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);
  return {
    info,
    pressure,
    error: { info: infoError, pressure: pressureError },
    retry: () => setReloadKey((key) => key + 1),
  };
}
