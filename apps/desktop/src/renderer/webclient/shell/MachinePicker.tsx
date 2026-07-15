import React from "react";
import type { BrowserAccountSnapshot } from "../account/client";
import { accountMachineConnectionState } from "../../../shared/accountDirectory";
import type { AdeAccountMachine } from "../../../shared/types/account";
import type { WebClientEnvironmentRecord } from "../sync";
import { ScreenShell } from "./ScreenShell";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton, recessedStyle } from "./shellTokens";

function lastConnectedLabel(value: string | null | undefined): string {
  if (!value) return "Never connected";
  try {
    return `Last connected ${new Date(value).toLocaleString()}`;
  } catch {
    return "Previously connected";
  }
}

function lastSeenLabel(value: number | null): string {
  if (value == null) return "Last seen unavailable";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `Last seen ${date.toLocaleString()}`
    : "Last seen unavailable";
}

function accountIdentity(account: BrowserAccountSnapshot): string {
  return account.email ?? account.name ?? account.userId ?? "ADE account";
}

/** Full-screen chooser when several machines are paired and none is selected. */
export function MachinePicker({
  environments,
  account,
  connectingMachineKey,
  onSelect,
  onSelectAccountMachine,
  onPair,
  onSignIn,
  onSignOut,
  onRetryDirectory,
}: {
  environments: WebClientEnvironmentRecord[];
  account: BrowserAccountSnapshot;
  connectingMachineKey: string | null;
  onSelect: (environment: WebClientEnvironmentRecord) => void;
  onSelectAccountMachine: (machine: AdeAccountMachine) => void;
  onPair: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onRetryDirectory: () => void;
}) {
  return (
    <ScreenShell title="Choose a machine" subtitle="Pair directly, or sign in to use your ADE account machine directory.">
      {environments.length > 0 ? (
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase" }}>
            Paired machines
          </div>
          {environments.map((environment) => (
            <button
              key={environment.envId}
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
          ))}
        </div>
      ) : null}

      <div style={{ height: 1, background: COLORS.border }} />
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600 }}>
              Account machines
            </div>
            <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 11, marginTop: 2 }}>
              {account.state === "signed_in" || account.state === "directory_unavailable"
                ? `Signed in as ${accountIdentity(account)}`
                : "Optional — pairing works without an account"}
            </div>
          </div>
          {account.state === "signed_in" || account.state === "directory_unavailable" ? (
            <button type="button" style={outlineButton()} onClick={onSignOut}>Sign out</button>
          ) : account.state !== "unconfigured" && account.state !== "loading" ? (
            <button type="button" style={outlineButton()} onClick={onSignIn}>
              {account.state === "auth_expired" ? "Sign in again" : "Sign in"}
            </button>
          ) : null}
        </div>

        {account.state === "loading" ? (
          <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12 }}>Loading account machines…</div>
        ) : account.state === "unconfigured" || account.state === "auth_expired" ? (
          <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12 }}>{account.message}</div>
        ) : account.state === "directory_unavailable" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12 }}>
              {account.message ?? "Machine directory is unavailable."}
            </span>
            <button type="button" style={outlineButton()} onClick={onRetryDirectory}>Retry</button>
          </div>
        ) : account.state === "signed_in" ? (
          account.machines.length === 0 ? (
            <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12 }}>No machines are registered to this account.</div>
          ) : account.machines.map((machine) => {
            const connectionState = accountMachineConnectionState(machine, account.relayBaseUrls);
            const available = connectionState === "available";
            const connecting = connectingMachineKey === machine.machineKey;
            return (
              <button
                key={machine.machineKey}
                type="button"
                disabled={!available || connecting}
                onClick={() => onSelectAccountMachine(machine)}
                title={connectionState === "offline" ? "This machine is offline." : !available ? "No secure relay route is available." : undefined}
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
                    {connecting ? "connecting" : connectionState}
                  </span>
                </span>
                <span style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 11 }}>
                  {lastSeenLabel(machine.lastSeenAt)} · {machine.machineKey}
                </span>
              </button>
            );
          })
        ) : null}
      </div>
      <button type="button" style={outlineButton({ justifySelf: "start" })} onClick={onPair}>
        Pair a new machine
      </button>
    </ScreenShell>
  );
}
