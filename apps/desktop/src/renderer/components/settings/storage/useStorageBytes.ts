import React from "react";
import { formatMeasuredBytes, formatStorageBytes, type StoragePlatform } from "./storageView";

/**
 * The platform of the machine the storage pages show (the snapshot's
 * `platform`), so every disk size under it prints in that machine's units,
 * also when the page shows another machine's project. Set by the page that
 * reads the snapshot.
 */
export const StoragePlatformContext = React.createContext<StoragePlatform>(undefined);

/** Disk-size formatters in the shown machine's units. */
export function useStorageBytes(): {
  platform: StoragePlatform;
  bytes: (value: number) => string;
  measured: (value: number, partial: boolean | undefined) => string;
} {
  const platform = React.useContext(StoragePlatformContext);
  return React.useMemo(() => ({
    platform,
    bytes: (value: number) => formatStorageBytes(value, platform),
    measured: (value: number, partial: boolean | undefined) => formatMeasuredBytes(value, partial, platform),
  }), [platform]);
}
