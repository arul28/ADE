import React from "react";
import type { BrowserAccountSnapshot } from "../account/client";
import { accountMachineConnectionState } from "../../../shared/accountDirectory";
import type { AdeAccountMachine } from "../../../shared/types/account";
import {
  canUseRelayForEnvironment,
  deriveBrowserSyncEndpoints,
  filterEnvironmentEndpoints,
  type WebClientEnvironmentRecord,
  type WebRelayAccess,
} from "../sync";
import { ScreenShell } from "./ScreenShell";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton, primaryButton, recessedStyle } from "./shellTokens";

function lastConnectedLabel(value: string | null | undefined): string {
  if (!value) return "Not connected yet";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `Last connected ${date.toLocaleString()}` : "Connected before";
}

function lastSeenLabel(value: number | null): string {
  if (value == null) return "Last seen unavailable";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `Last seen ${date.toLocaleString()}` : "Last seen unavailable";
}

function accountIdentity(account: BrowserAccountSnapshot): string {
  return account.email ?? account.name ?? account.userId ?? "ADE account";
}

function hasDirectRoute(environment: WebClientEnvironmentRecord): boolean {
  const endpoints = deriveBrowserSyncEndpoints({ environment });
  return filterEnvironmentEndpoints(environment, endpoints, { kind: "signed_out" })
    .some((candidate) => candidate.dialable);
}

function EnvironmentButton({
  environment,
  onSelect,
}: {
  environment: WebClientEnvironmentRecord;
  onSelect: (environment: WebClientEnvironmentRecord) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(environment)}
      style={recessedStyle({
        display: "grid",
        gap: 4,
        textAlign: "left",
        cursor: "pointer",
        border: `1px solid ${COLORS.border}`,
      })}
    >
      <span style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 14, fontWeight: 600 }}>
        {environment.machineName}
      </span>
      <span style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 11 }}>
        {lastConnectedLabel(environment.lastConnectedAt)}
      </span>
    </button>
  );
}

function SavedEnvironmentList({
  environments,
  onSelect,
}: {
  environments: WebClientEnvironmentRecord[];
  onSelect: (environment: WebClientEnvironmentRecord) => void;
}) {
  if (environments.length === 0) return null;
  return (
    <section style={{ display: "grid", gap: 10, borderTop: `1px solid ${COLORS.border}`, paddingTop: 14 }}>
      <div style={{ display: "grid", gap: 4 }}>
        <span style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600 }}>
          Saved on this browser
        </span>
        <span style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.55 }}>
          Existing connections saved in this browser remain available.
        </span>
      </div>
      {environments.map((environment) => (
        <EnvironmentButton key={environment.envId} environment={environment} onSelect={onSelect} />
      ))}
    </section>
  );
}

/** Account-first machine chooser that preserves already-saved browser connections. */
export function MachinePicker({
  environments,
  account,
  relayAccess,
  connectingMachineKey,
  onSelect,
  onSelectAccountMachine,
  onSignIn,
  onSignOut,
  onRetryDirectory,
}: {
  environments: WebClientEnvironmentRecord[];
  account: BrowserAccountSnapshot;
  relayAccess: WebRelayAccess;
  connectingMachineKey: string | null;
  onSelect: (environment: WebClientEnvironmentRecord) => void;
  onSelectAccountMachine: (machine: AdeAccountMachine) => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onRetryDirectory: () => void;
}) {
  const signedIn = account.state === "signed_in" || account.state === "directory_unavailable";
  const directEnvironments = environments.filter((environment) => (
    environment.accountOwnerUserId == null && hasDirectRoute(environment)
  ));
  const savedRelayEnvironments = environments.filter((environment) => (
    canUseRelayForEnvironment(environment, relayAccess)
    && !account.machines.some((machine) => machine.deviceId === environment.hostDeviceId)
  ));
  const savedEnvironments = [...new Map(
    [...directEnvironments, ...savedRelayEnvironments]
      .map((environment) => [environment.envId, environment]),
  ).values()];

  if (!signedIn) {
    const signInAvailable = account.state !== "unconfigured";
    return (
      <ScreenShell
        title="Sign in to ADE"
        subtitle="Sign in to connect this browser to your Macs, wherever they are."
      >
        {account.state === "loading" ? (
          <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 13 }}>Checking your account…</div>
        ) : signInAvailable ? (
          <button type="button" style={primaryButton({ justifySelf: "start", height: 38 })} onClick={onSignIn}>
            {account.state === "auth_expired" ? "Sign in again" : "Sign in"}
          </button>
        ) : (
          <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 13, lineHeight: 1.55 }}>
            Account sign-in is not available on this web client.
          </div>
        )}

        {account.message && account.state === "auth_expired" ? (
          <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12 }}>{account.message}</div>
        ) : null}
        <SavedEnvironmentList environments={savedEnvironments} onSelect={onSelect} />
      </ScreenShell>
    );
  }

  return (
    <ScreenShell title="Choose a Mac" subtitle="Choose a Mac on your ADE account.">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12 }}>
          Signed in as {accountIdentity(account)}
        </div>
        <button type="button" style={outlineButton()} onClick={onSignOut}>Sign out</button>
      </div>

      {account.state === "directory_unavailable" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12 }}>
            We couldn't load your Macs. Your saved connections still work.
          </span>
          <button type="button" style={outlineButton()} onClick={onRetryDirectory}>Try again</button>
        </div>
      ) : account.machines.length === 0 ? (
        <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 13, lineHeight: 1.55 }}>
          No Macs are connected to this account yet. Open ADE on your Mac and sign in with this account.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {account.machines.map((machine) => {
            const connectionState = accountMachineConnectionState(machine, account.relayBaseUrls);
            const available = connectionState === "available";
            const connecting = connectingMachineKey === machine.machineKey;
            return (
              <button
                key={machine.machineKey}
                type="button"
                disabled={!available || connecting}
                onClick={() => onSelectAccountMachine(machine)}
                title={connectionState === "offline" ? "This Mac is offline." : !available ? "Open ADE on this Mac to finish connecting it." : undefined}
                style={recessedStyle({
                  display: "grid",
                  gap: 4,
                  textAlign: "left",
                  cursor: available && !connecting ? "pointer" : "not-allowed",
                  opacity: available ? 1 : 0.58,
                  border: `1px solid ${COLORS.border}`,
                })}
              >
                <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <span style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 14, fontWeight: 600 }}>
                    {machine.name ?? machine.machineKey}
                  </span>
                  <span style={{ color: available ? COLORS.success : COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 10 }}>
                    {connecting ? "Connecting…" : available ? "Ready" : connectionState === "offline" ? "Offline" : "Open ADE on this Mac"}
                  </span>
                </span>
                <span style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 11 }}>
                  {lastSeenLabel(machine.lastSeenAt)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <SavedEnvironmentList environments={savedEnvironments} onSelect={onSelect} />
    </ScreenShell>
  );
}
