import type { MacosVmStatus } from "../../../../shared/types";

export function defaultSnapshotName(status: MacosVmStatus | null | undefined): string {
  return status?.defaultBase?.name ?? "clean macOS";
}

export function seedSnapshotName(
  status: MacosVmStatus | null | undefined,
  clonedFromName: string | null | undefined,
): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const today = `${year}-${month}-${day}`;
  const seed = clonedFromName?.trim() ? clonedFromName.trim() : defaultSnapshotName(status);
  return `${seed} - ${today}`;
}
