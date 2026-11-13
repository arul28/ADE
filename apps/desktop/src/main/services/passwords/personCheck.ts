import { execFile } from "node:child_process";
import { BrowserWindow, dialog, systemPreferences } from "electron";

/**
 * "Is it really the person?" before ADE shows or copies a saved value, saves
 * a passkey, or resets Passwords.
 *
 * - macOS: Touch ID. A Mac with no sensor (a Mac Studio without the Touch ID
 *   keyboard) gets a confirm dialog instead.
 * - Windows: Windows Hello (`UserConsentVerifier`), else the confirm dialog.
 * - Linux: the confirm dialog.
 *
 * Returns how it was checked, or null when the person said no. `biometric`
 * is what a passkey's user-verification flag may claim; a dialog is only
 * presence.
 */
export type PersonCheck = "biometric" | "presence";

const WINDOWS_HELLO_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
  "$null = [Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]",
  "$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  "function Await($op, $type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $task.Wait() | Out-Null; $task.Result }",
  "$availability = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])",
  "if ($availability -ne 'Available') { Write-Output 'unavailable'; exit 0 }",
  "$result = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($env:ADE_HELLO_REASON)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])",
  "Write-Output $result",
].join("; ");

function windowsHello(reason: string): Promise<"verified" | "denied" | "unavailable"> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_HELLO_SCRIPT],
      // The reason goes in the environment, never into the script text.
      { env: { ...process.env, ADE_HELLO_REASON: reason }, windowsHide: true, timeout: 120_000 },
      (error, stdout) => {
        if (error) return resolve("unavailable");
        const answer = String(stdout).trim();
        resolve(answer === "Verified" ? "verified" : answer === "unavailable" ? "unavailable" : "denied");
      },
    );
  });
}

async function confirmDialog(reason: string, actionLabel: string): Promise<boolean> {
  const parent = BrowserWindow.getFocusedWindow() ?? undefined;
  const options = {
    type: "question" as const,
    buttons: [actionLabel, "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: reason,
    detail: "ADE Passwords",
  };
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response === 0;
}

/** `reason` completes "ADE wants to …" on Touch ID's sheet, e.g. "show the password for github.com". */
export async function checkPerson(reason: string, actionLabel = "Continue"): Promise<PersonCheck | null> {
  if (process.platform === "darwin" && systemPreferences.canPromptTouchID()) {
    try {
      await systemPreferences.promptTouchID(reason);
      return "biometric";
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    const hello = await windowsHello(`ADE wants to ${reason}`);
    if (hello === "verified") return "biometric";
    if (hello === "denied") return null;
  }
  return (await confirmDialog(`ADE wants to ${reason}.`, actionLabel)) ? "presence" : null;
}
