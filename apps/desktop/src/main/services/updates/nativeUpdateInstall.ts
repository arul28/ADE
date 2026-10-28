import { dialog, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import type { AutoUpdateSnapshot } from "../../../shared/types";

/**
 * "Install update" from outside the page: the macOS ADE menu and the Windows
 * taskbar jump list.
 *
 * Both are drawn by the OS, so they keep working when the page cannot take a
 * click. In 1.2.124 the whole window acted as its title bar (Electron 44) and
 * the update's own confirm dialog could not be pressed, which left people
 * stuck on the build that broke them. The confirm here is a native dialog for
 * the same reason.
 *
 * This updates only this computer; the in-app button also offers to update
 * the account's other machines.
 */

/** Argument the Windows jump-list task starts ADE with; the running ADE receives it. */
export const INSTALL_UPDATE_ARG = "--ade-install-update";

type NativeUpdateService = {
  getSnapshot: () => AutoUpdateSnapshot;
  checkForUpdates: (options?: { userInitiated?: boolean }) => Promise<void>;
  quitAndInstall: (resumeChats?: boolean) => Promise<boolean>;
};

function versionLabel(version: string | null): string {
  return version ? `v${version.replace(/^v/i, "")}` : "the update";
}

/** The menu item's label for the current update state. */
export function nativeUpdateMenuLabel(snapshot: AutoUpdateSnapshot): string {
  switch (snapshot.status) {
    case "ready":
      return `Install Update ${versionLabel(snapshot.version)} and Restart…`;
    case "checking":
      return "Checking for Updates…";
    case "downloading":
      return `Downloading ${versionLabel(snapshot.version)}…`;
    case "installing":
      return "Installing Update…";
    default:
      return "Check for Updates…";
  }
}

export function nativeUpdateMenuItem(
  snapshot: AutoUpdateSnapshot,
  run: (win: BrowserWindow | null) => void,
): MenuItemConstructorOptions {
  const busy = snapshot.status === "checking" || snapshot.status === "downloading" || snapshot.status === "installing";
  return {
    label: nativeUpdateMenuLabel(snapshot),
    enabled: !busy,
    click: (_item, win) => run((win as BrowserWindow | undefined) ?? null),
  };
}

async function message(win: BrowserWindow | null, options: Electron.MessageBoxOptions) {
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

function notReadyMessage(snapshot: AutoUpdateSnapshot): Electron.MessageBoxOptions {
  const releases = "You can also download ADE from https://github.com/arul28/ADE/releases/latest.";
  switch (snapshot.status) {
    case "error":
      return { type: "warning", message: "ADE could not check for updates.", detail: `${snapshot.error ?? "The update check failed."} ${releases}`, buttons: ["OK"] };
    case "downloading":
      return { type: "info", message: `ADE is downloading ${versionLabel(snapshot.version)}.`, detail: "Choose Install Update from this menu again when it finishes.", buttons: ["OK"] };
    case "checking":
      return { type: "info", message: "ADE is still checking for updates.", detail: "Try again in a moment.", buttons: ["OK"] };
    case "installing":
      return { type: "info", message: "ADE is already installing an update.", detail: "It restarts when the install finishes.", buttons: ["OK"] };
    default:
      return { type: "info", message: `ADE is up to date (${versionLabel(snapshot.currentVersion)}).`, buttons: ["OK"] };
  }
}

/**
 * Installs a downloaded update after a native confirm, or checks for one and
 * then offers it. Never throws: every outcome ends in a native message.
 */
export async function runNativeUpdateInstall(service: NativeUpdateService, win: BrowserWindow | null): Promise<void> {
  let snapshot = service.getSnapshot();
  if (snapshot.status !== "ready") {
    if (snapshot.status === "idle" || snapshot.status === "error") {
      await service.checkForUpdates({ userInitiated: true }).catch(() => undefined);
    }
    snapshot = service.getSnapshot();
  }
  if (snapshot.status !== "ready" || !snapshot.version) {
    await message(win, notReadyMessage(snapshot));
    return;
  }
  const { response } = await message(win, {
    type: "question",
    message: `Install ADE ${versionLabel(snapshot.version)} and restart?`,
    detail: "ADE quits, installs the update and opens again. Running chats resume when it is back; any unsaved work may be lost. Your other machines are not updated from here.",
    buttons: ["Install and Restart", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  const started = await service.quitAndInstall(true).catch(() => false);
  if (!started) {
    await message(win, {
      type: "warning",
      message: "The update did not start.",
      detail: "Try again in a moment, or download ADE from https://github.com/arul28/ADE/releases/latest and install it over this copy.",
      buttons: ["OK"],
    });
  }
}
