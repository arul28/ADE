import { readDesktopAppRecord, readInstalledDesktopApp } from "./nativeHelperPaths";

/** Installation policy reported by the host, never inferred by a remote client. */
export function readDesktopUpdateInstallMode(): {
  updateInstallMode: "in_place" | "manual_download" | "runtime_only";
  downloadUrl: string | null;
} {
  const app = readInstalledDesktopApp();
  if (!app) return { updateInstallMode: "runtime_only", downloadUrl: null };
  if (process.platform === "linux") {
    const record = readDesktopAppRecord(process.env, process.platform);
    const image = record?.executablePath === app.path
      ? record.linuxAppImage === true
      : app.path.toLowerCase().endsWith(".appimage");
    if (!image) return { updateInstallMode: "manual_download", downloadUrl: record?.downloadUrl ?? "https://github.com/arul28/ADE/releases/latest" };
  }
  return { updateInstallMode: "in_place", downloadUrl: null };
}
