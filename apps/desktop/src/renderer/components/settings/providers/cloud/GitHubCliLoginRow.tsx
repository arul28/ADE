/**
 * The GitHub CLI login on a computer's Copilot page: whether ADE copies that
 * computer's `gh` login for Copilot on ADE Cloud. The choice is per computer
 * and off at the start.
 *
 * - On: only on this computer's own page, never pinned (the preload refuses
 *   it for another computer: the GitHub CLI can ask to unlock the keychain
 *   there). It can wait up to 2 min for that prompt; the row says so, and a
 *   second press does nothing (`useAllowKeychain`, its own slot).
 * - Off: on any computer's page, with that page's pin, after a confirm. The
 *   answer is that computer's status, so the page shows it at once.
 * - A failed read does not throw: the row shows its words in place, with
 *   "Try again".
 */
import React, { useCallback } from "react";
import type { ProviderLoginProviderStatus, ProviderLoginStatus } from "../../../../../shared/types/providerLogins";
import type { OpenProjectBinding } from "../../../../../shared/types";
import { ipcErrorMessage } from "../../../../lib/format";
import { COLORS, SANS_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { showToast } from "../../../app/toast/toastStore";
import { confirmDialog } from "../../../ui/dialog/confirm";
import { SettingsToggle } from "../../primitives/SettingsControls";
import { COPILOT_REPO_LINE } from "./adeCloudSignInModel";
import { useAllowKeychain } from "./useAllowKeychain";

const lineStyle: React.CSSProperties = { fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.45 };

type RowWords = { line: string; tone: "muted" | "warn"; retry: boolean };

/** What the row says, from the page machine's read. Pure. */
export function gitHubCliWords(input: {
  row: ProviderLoginProviderStatus;
  status: ProviderLoginStatus;
  isThisMachine: boolean;
  machineName: string;
  running: boolean;
}): RowWords {
  const { row, status, isThisMachine, machineName, running } = input;
  const gh = row.ghCli!;
  const where = isThisMachine ? "this computer" : machineName;
  if (running) return { line: "Reading the GitHub CLI login. Your computer may ask you to unlock its keychain.", tone: "muted", retry: false };
  if (!gh.allowed) {
    if (!isThisMachine) return { line: `Off. Turn this on at ${machineName}.`, tone: "muted", retry: false };
    if (!gh.present) return { line: "The GitHub CLI here is not signed in to github.com. Run gh auth login, then turn this on.", tone: "muted", retry: false };
    if (!gh.canAllow) return { line: status.thisComputer.message ?? row.message, tone: "muted", retry: false };
    const as = gh.user ? `Signed in as ${gh.user}. ` : "";
    return { line: `${as}Copy it to your ADE account so Copilot on ADE Cloud can use it. ${COPILOT_REPO_LINE}`, tone: "muted", retry: false };
  }
  if (gh.unsupported === "classic_token") {
    return { line: "It uses a classic token (ghp_), which Copilot does not take. ADE did not copy it.", tone: "warn", retry: isThisMachine };
  }
  if (gh.lastError) return { line: gh.lastError, tone: "warn", retry: isThisMachine };
  if (status.thisComputer.reason === "all_off") {
    return { line: `On. Nothing leaves ${where} while sign-ins for ADE Cloud are off.`, tone: "muted", retry: false };
  }
  if (row.local.state === "captured") {
    const signIn = status.signIns.find((entry) => entry.key === row.local.key) ?? null;
    const inAccount = "In your ADE account.";
    if (signIn?.inUseOnCloud) return { line: `${inAccount} ADE Cloud uses it for Copilot.`, tone: "muted", retry: false };
    if (signIn && !signIn.onForCloud) return { line: `${inAccount} It is off for ADE Cloud.`, tone: "muted", retry: false };
    // No Copilot sign-in in use: the saved Copilot key stands in until one is picked.
    const anyInUse = status.signIns.some((entry) => entry.provider === "copilot" && entry.inUseOnCloud);
    if (!anyInUse) return { line: `${inAccount} ADE Cloud uses your saved Copilot key; pick this login to use it instead.`, tone: "muted", retry: false };
    return { line: `${inAccount} ADE Cloud uses another Copilot sign-in now.`, tone: "muted", retry: false };
  }
  return { line: "On. ADE copies the login when it changes.", tone: "muted", retry: false };
}

export function GitHubCliLoginRow({
  row,
  status,
  pin,
  pageKey,
  isThisMachine,
  machineName,
  onStatus,
}: {
  row: ProviderLoginProviderStatus;
  status: ProviderLoginStatus;
  /** The page machine's pin (`useSettingsMachineScope().pin`): Off goes there. */
  pin: OpenProjectBinding | null;
  pageKey: string | null;
  isThisMachine: boolean;
  machineName: string;
  /** Applies a write's answer when the page still shows the machine it was for. */
  onStatus: (key: string | null, next: ProviderLoginStatus) => void;
}) {
  const bridge = typeof window === "undefined" ? undefined : window.ade?.providerLogins;
  const gh = row.ghCli!;

  // On: never pinned; it can wait for the keychain prompt (up to 2 min).
  const turnOn = useCallback(async () => {
    const key = pageKey;
    try {
      const next = await bridge?.allowGitHubCli?.({ on: true });
      if (next) onStatus(key, next);
    } catch (error) {
      showToast({ tone: "error", title: "ADE couldn't turn on the GitHub CLI login", message: ipcErrorMessage(error) || "Try again." });
    }
  }, [bridge, onStatus, pageKey]);
  const { allowing: running, allow: runOn } = useAllowKeychain(turnOn, "github-cli");

  const turnOff = useCallback(async () => {
    const ok = await confirmDialog({
      title: "Turn off the GitHub CLI login?",
      message: "ADE removes it from your ADE account, and cloud computers stop using it. To stop the token itself, run gh auth logout or revoke it in GitHub settings.",
      confirmLabel: "Turn off",
    });
    if (!ok) return;
    const key = pageKey;
    try {
      const next = await bridge?.allowGitHubCli?.({ on: false }, pin);
      if (next) onStatus(key, next);
    } catch (error) {
      showToast({ tone: "error", title: "ADE couldn't turn off the GitHub CLI login", message: ipcErrorMessage(error) || "Try again." });
    }
  }, [bridge, onStatus, pageKey, pin]);

  const words = gitHubCliWords({ row, status, isThisMachine, machineName, running });
  // On is offered only here and only when it can work; Off wherever it is on.
  const canTurnOn = isThisMachine && gh.present && gh.canAllow;
  const toggleShown = gh.allowed || canTurnOn || running;

  return (
    <div
      data-testid="github-cli-login"
      style={{ display: "flex", alignItems: "center", gap: 12, borderTop: `1px solid ${COLORS.borderMuted}`, paddingTop: 12 }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: "1 1 240px", minWidth: 0 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
          GitHub CLI login on {isThisMachine ? "this computer" : machineName}
        </span>
        <span role={words.tone === "warn" ? "status" : undefined} style={{ ...lineStyle, color: words.tone === "warn" ? COLORS.warning : COLORS.textMuted }}>
          {words.line}
        </span>
      </div>
      {words.retry ? (
        <button
          type="button"
          disabled={running}
          onClick={runOn}
          style={{ ...outlineButton({ height: 28, padding: "0 11px", fontSize: 12 }), flexShrink: 0, whiteSpace: "nowrap" }}
        >
          Try again
        </button>
      ) : null}
      {toggleShown ? (
        <span aria-busy={running || undefined} style={{ flexShrink: 0 }}>
          <SettingsToggle
            checked={gh.allowed || running}
            disabled={running}
            label={`Copy the GitHub CLI login${gh.user ? ` (${gh.user})` : ""} for ADE Cloud`}
            onChange={(on) => {
              if (on) runOn();
              else void turnOff();
            }}
          />
        </span>
      ) : null}
    </div>
  );
}
