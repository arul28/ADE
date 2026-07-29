import React, { useCallback, useEffect, useRef, useState } from "react";
import { buildDeeplink } from "../../../shared/deeplinks";
import {
  accountMachineConnectionState,
  accountMachineDisplayName,
} from "../../../shared/accountDirectory";
import type { AdeAccountMachine } from "../../../shared/types/account";
import type { SyncMobileProjectSummary } from "../../../shared/types/sync";
import { browserAccountIsSignedIn, type BrowserAccountSnapshot } from "../account/client";
import type { AdeSyncClientStatus, WebClientEnvironmentRecord } from "../sync";
import { parseWebPath } from "./webRoutes";
import { AccountIdentity } from "./AccountIdentity";
import { COLORS, MONO_FONT, SANS_FONT, connectionTone } from "./shellTokens";

const STRIP_HEIGHT = 30;

const menuStyle: React.CSSProperties = {
  position: "absolute",
  top: STRIP_HEIGHT + 2,
  minWidth: 240,
  maxWidth: 320,
  background: "var(--color-popup-bg)",
  border: `1px solid ${COLORS.border}`,
  borderRadius: 10,
  boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
  padding: 6,
  zIndex: 50,
  display: "grid",
  gap: 2,
};

const triggerStyle = (open: boolean): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 22,
  padding: "0 8px",
  borderRadius: 6,
  border: "1px solid transparent",
  background: open ? "color-mix(in srgb, var(--color-fg) 8%, transparent)" : "transparent",
  color: COLORS.textSecondary,
  fontFamily: SANS_FONT,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  maxWidth: 260,
});

const menuItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  width: "100%",
  height: 30,
  padding: "0 8px",
  borderRadius: 6,
  border: "none",
  background: "transparent",
  color: COLORS.textPrimary,
  fontFamily: SANS_FONT,
  fontSize: 12,
  cursor: "pointer",
  textAlign: "left",
};

function Caret() {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden style={{ opacity: 0.7, flexShrink: 0 }}>
      <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

const AccountMachineMenu = React.memo(function AccountMachineMenu({
  account,
  connectingMachineKey,
  onSelect,
  onSignIn,
  onSignOut,
  onRetry,
}: {
  account: BrowserAccountSnapshot;
  connectingMachineKey: string | null;
  onSelect: (machine: AdeAccountMachine) => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onRetry: () => void;
}) {
  return (
    <>
      <div style={{ height: 1, background: COLORS.border, margin: "4px 0" }} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 8px 6px", gap: 10 }}>
        <span style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 10, letterSpacing: "0.04em", textTransform: "uppercase" }}>
          Your machines
        </span>
        {browserAccountIsSignedIn(account.state) ? (
          <button type="button" onClick={onSignOut} style={{ border: "none", background: "transparent", color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 10, cursor: "pointer" }}>
            Sign out
          </button>
        ) : account.state !== "unconfigured" && account.state !== "loading" ? (
          <button type="button" onClick={onSignIn} style={{ border: "none", background: "transparent", color: COLORS.textSecondary, fontFamily: SANS_FONT, fontSize: 10, cursor: "pointer" }}>
            {account.state === "auth_expired" ? "Sign in again" : "Sign in"}
          </button>
        ) : null}
      </div>
      {account.state === "signed_in" ? (
        <div style={{ display: "grid", gap: 2, maxHeight: 220, overflow: "auto" }}>
          <div style={{ padding: "0 8px 4px" }}>
            <AccountIdentity account={account} size={20} />
          </div>
          {account.machines.length === 0 ? (
            <div style={{ padding: "4px 8px 7px", color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 11 }}>
              No machines found
            </div>
          ) : account.machines.map((machine) => {
            const connectionState = accountMachineConnectionState(machine, account.relayBaseUrls);
            const available = connectionState === "available";
            const connecting = connectingMachineKey === machine.machineKey;
            return (
              <button
                key={machine.machineKey}
                type="button"
                disabled={!available || connecting}
                onClick={() => onSelect(machine)}
                title={!available ? "Can't reach this Mac right now" : undefined}
                style={{
                  ...menuItemStyle,
                  height: 36,
                  opacity: available ? 1 : 0.5,
                  cursor: available && !connecting ? "pointer" : "not-allowed",
                }}
              >
                <span style={{ display: "grid", minWidth: 0 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: COLORS.textSecondary }}>
                    {accountMachineDisplayName(machine) ?? "Unnamed machine"}
                  </span>
                  <span style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 9 }}>
                    {machine.lastSeenAt == null ? "Last seen unknown" : `Last seen ${new Date(machine.lastSeenAt).toLocaleString()}`}
                  </span>
                </span>
                <span style={{ color: available ? COLORS.success : COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 9 }}>
                  {connecting ? "Reconnecting" : available ? "Connect" : "Can't reach this Mac"}
                </span>
              </button>
            );
          })}
        </div>
      ) : account.state === "directory_unavailable" ? (
        <button type="button" style={menuItemStyle} onClick={onRetry}>
          <span style={{ color: COLORS.textMuted }}>Couldn't load your machines</span>
          <span style={{ color: COLORS.textSecondary }}>Retry</span>
        </button>
      ) : account.state === "auth_expired" ? (
        <div style={{ padding: "4px 8px 7px", color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 11 }}>Account session expired</div>
      ) : account.state === "unconfigured" ? (
        <div style={{ padding: "4px 8px 7px", color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 11 }}>Sign-in is unavailable in this build</div>
      ) : account.state === "loading" ? (
        <div style={{ padding: "4px 8px 7px", color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 11 }}>Loading account machines…</div>
      ) : (
        <button type="button" style={menuItemStyle} onClick={onSignIn}>Sign in to ADE…</button>
      )}
    </>
  );
});

export function WebShell({
  status,
  environments,
  activeEnvId,
  catalog,
  activeProjectId,
  account,
  connectingAccountMachineKey,
  onSwitchEnv,
  onSwitchAccountMachine,
  onAccountSignIn,
  onAccountSignOut,
  onRetryAccountDirectory,
  onForgetEnv,
  onSwitchProject,
  onOpenChats,
  children,
}: {
  status: AdeSyncClientStatus;
  environments: WebClientEnvironmentRecord[];
  activeEnvId: string | null;
  catalog: SyncMobileProjectSummary[];
  activeProjectId: string | null;
  account: BrowserAccountSnapshot;
  connectingAccountMachineKey: string | null;
  onSwitchEnv: (environment: WebClientEnvironmentRecord) => void;
  onSwitchAccountMachine: (machine: AdeAccountMachine) => void;
  onAccountSignIn: () => void;
  onAccountSignOut: () => void;
  onRetryAccountDirectory: () => void;
  onForgetEnv: (environment: WebClientEnvironmentRecord) => void;
  onSwitchProject: (project: SyncMobileProjectSummary) => void;
  onOpenChats: () => void;
  children: React.ReactNode;
}) {
  const tone = connectionTone(status.state);
  const activeEnv = environments.find((environment) => environment.envId === activeEnvId) ?? null;
  const machineName = status.hostName ?? activeEnv?.machineName ?? "Machine";
  const activeProject = catalog.find((project) => project.id === activeProjectId) ?? null;

  const [machineMenu, setMachineMenu] = useState(false);
  const [projectMenu, setProjectMenu] = useState(false);
  const [confirmForget, setConfirmForget] = useState<string | null>(null);

  const machineRef = useDismiss(machineMenu, useCallback(() => { setMachineMenu(false); setConfirmForget(null); }, []));
  const projectRef = useDismiss(projectMenu, useCallback(() => setProjectMenu(false), []));
  const selectAccountMachine = useCallback((machine: AdeAccountMachine) => {
    setMachineMenu(false);
    onSwitchAccountMachine(machine);
  }, [onSwitchAccountMachine]);
  const signInToAccount = useCallback(() => {
    setMachineMenu(false);
    onAccountSignIn();
  }, [onAccountSignIn]);

  const openInDesktop = useCallback(() => {
    const path = `${window.location.pathname}${window.location.search}`;
    const target = parseWebPath(path);
    const url = target ? buildDeeplink(target, { form: "ade" }) : "ade://";
    window.location.href = url;
  }, []);

  return (
    <>
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: STRIP_HEIGHT,
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "0 8px",
          background: "var(--color-surface)",
          borderBottom: `1px solid ${COLORS.border}`,
          userSelect: "none",
          // The reused desktop App renders in its own fixed layer directly below
          // this strip; pin the machine/project chrome on top of everything the
          // App can paint (including its viewport-fixed graph/drawer layers) so
          // it is never covered regardless of the App's internal layout.
          zIndex: 2147483000,
        }}
      >
        {/* Machine switcher */}
        <div ref={machineRef} style={{ position: "relative" }}>
          <button
            type="button"
            style={triggerStyle(machineMenu)}
            onClick={() => { setMachineMenu((open) => !open); setProjectMenu(false); }}
            title={`${machineName} · ${tone.label}`}
          >
            <span
              aria-hidden
              style={{
                width: 7,
                height: 7,
                borderRadius: 999,
                background: tone.color,
                boxShadow: tone.live ? `0 0 6px ${tone.color}` : "none",
                flexShrink: 0,
              }}
            />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{machineName}</span>
            <Caret />
          </button>
          {machineMenu ? (
            <div style={menuStyle}>
              <div style={{ padding: "4px 8px 6px", color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 10, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                Machines
              </div>
              {environments.map((environment) => {
                const isActive = environment.envId === activeEnvId;
                const isConfirming = confirmForget === environment.envId;
                return (
                  <div key={environment.envId} style={{ display: "grid", gap: 2 }}>
                    <button
                      type="button"
                      style={{
                        ...menuItemStyle,
                        background: isActive ? "color-mix(in srgb, var(--color-accent) 12%, transparent)" : "transparent",
                      }}
                      onClick={() => { if (!isActive) { onSwitchEnv(environment); } setMachineMenu(false); }}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        {isActive ? (
                          <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: tone.color, flexShrink: 0 }} />
                        ) : (
                          <span aria-hidden style={{ width: 6, flexShrink: 0 }} />
                        )}
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: isActive ? COLORS.textPrimary : COLORS.textSecondary }}>
                          {environment.machineName}
                        </span>
                      </span>
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(event) => { event.stopPropagation(); setConfirmForget(isConfirming ? null : environment.envId); }}
                        onKeyDown={(event) => { if (event.key === "Enter") { event.stopPropagation(); setConfirmForget(isConfirming ? null : environment.envId); } }}
                        style={{ color: COLORS.textMuted, fontSize: 11, padding: "2px 4px", borderRadius: 4, cursor: "pointer" }}
                        title="Forget this machine"
                      >
                        Forget
                      </span>
                    </button>
                    {isConfirming ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 8px 6px" }}>
                        <span style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 11 }}>Forget {environment.machineName}?</span>
                        <button
                          type="button"
                          onClick={() => { onForgetEnv(environment); setConfirmForget(null); setMachineMenu(false); }}
                          style={{ color: COLORS.danger, background: "transparent", border: "none", fontFamily: SANS_FONT, fontSize: 11, fontWeight: 600, cursor: "pointer" }}
                        >
                          Forget
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmForget(null)}
                          style={{ color: COLORS.textMuted, background: "transparent", border: "none", fontFamily: SANS_FONT, fontSize: 11, cursor: "pointer" }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
              <AccountMachineMenu
                account={account}
                connectingMachineKey={connectingAccountMachineKey}
                onSelect={selectAccountMachine}
                onSignIn={signInToAccount}
                onSignOut={onAccountSignOut}
                onRetry={onRetryAccountDirectory}
              />
            </div>
          ) : null}
        </div>

        <span aria-hidden style={{ color: COLORS.textMuted, opacity: 0.5 }}>/</span>

        {/* Project switcher */}
        <div ref={projectRef} style={{ position: "relative" }}>
          <button
            type="button"
            style={triggerStyle(projectMenu)}
            onClick={() => { setProjectMenu((open) => !open); setMachineMenu(false); }}
            title={activeProject?.rootPath ?? "Choose a project or open a projectless chat"}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {activeProject?.displayName ?? "Select project"}
            </span>
            <Caret />
          </button>
          {projectMenu ? (
            <div style={menuStyle}>
              <button
                type="button"
                style={menuItemStyle}
                onClick={() => { onOpenChats(); setProjectMenu(false); }}
              >
                Chat without a project
              </button>
              <div style={{ height: 1, background: COLORS.border, margin: "4px 0" }} />
              <div style={{ padding: "4px 8px 6px", color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 10, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                Projects
              </div>
              {catalog.length === 0 ? (
                <div style={{ padding: "5px 8px 7px", color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 11 }}>
                  No projects available
                </div>
              ) : null}
              <div style={{ display: "grid", gap: 2, maxHeight: "60vh", overflow: "auto" }}>
                {catalog.map((project) => {
                  const isActive = project.id === activeProjectId;
                  const disabled = !project.isAvailable && !project.isOpen;
                  return (
                    <button
                      key={project.id}
                      type="button"
                      disabled={disabled}
                      onClick={() => { if (!isActive) onSwitchProject(project); setProjectMenu(false); }}
                      style={{
                        ...menuItemStyle,
                        opacity: disabled ? 0.5 : 1,
                        cursor: disabled ? "not-allowed" : "pointer",
                        background: isActive ? "color-mix(in srgb, var(--color-accent) 12%, transparent)" : "transparent",
                      }}
                      title={project.rootPath ?? undefined}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: isActive ? COLORS.textPrimary : COLORS.textSecondary }}>
                        {project.displayName}
                      </span>
                      {project.isOpen ? (
                        <span style={{ color: COLORS.success, fontSize: 10, fontFamily: MONO_FONT }}>open</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        <div style={{ flex: 1 }} />

        {/* Keep the app mounted while presenting one plain-language state. */}
        {status.state !== "connected" ? (
          <span style={{ color: tone.color, fontFamily: SANS_FONT, fontSize: 11, marginRight: 4 }}>
            {tone.label}
          </span>
        ) : null}

        <button
          type="button"
          onClick={openInDesktop}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            height: 22,
            padding: "0 8px",
            borderRadius: 6,
            border: `1px solid ${COLORS.border}`,
            background: "transparent",
            color: COLORS.textSecondary,
            fontFamily: SANS_FONT,
            fontSize: 11,
            fontWeight: 500,
            cursor: "pointer",
          }}
          title="Open the current view in the ADE desktop app"
        >
          Open in desktop
        </button>
      </div>

      <div
        style={{
          position: "fixed",
          top: STRIP_HEIGHT,
          left: 0,
          right: 0,
          bottom: 0,
          overflow: "hidden",
          background: "var(--color-bg)",
        }}
      >
        {children}
      </div>
    </>
  );
}
