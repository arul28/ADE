import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  DesktopTower,
  DeviceMobile,
  Globe,
  UserCircle,
  X,
} from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import type {
  AdeAccountMachine,
  AdeAccountMachinesResult,
  MachineConnectionRoutes,
  GitHubStatus,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeTarget,
} from "../../../shared/types";
import { RemoteTargetList } from "../remoteTargets/RemoteTargetList";
import { ThisComputerStatus } from "../remoteTargets/ThisComputerStatus";
import { HostReachabilityCheck } from "../remoteTargets/HostReachabilityCheck";
import {
  PhoneConnectionsTab,
  ThisComputerPairingCode,
  ThisMacCard,
  canShowPairingCode,
  WebConnectionsTab,
  useSyncConnections,
  type RevokeConfirm,
} from "../settings/SyncDevicesSection";
import { confirmDialog } from "../ui/dialog";
import {
  accountAvatarImage,
  accountInitials,
  accountSessionConnectionsAction,
  accountSessionConnectionsActionAria,
  accountSessionConnectionsSubtitle,
  accountSessionState,
  accountSessionTitle,
  fetchAccountMachines,
  invalidateAccountMachines,
  providerTint,
  useAccountStatus,
} from "../../lib/account";
import type { ConnectionsPanelTab } from "../../lib/connectionsPanel";
import { flashRowHighlight } from "../../lib/flashRowHighlight";
import { RoutePills } from "../account/MachineRoutes";
import { machineReachHeadline, machineRouteItems } from "../account/machineRouteModel";
import { routesAvailable } from "../account/useMachineRoutes";
import { rgbCss, useProfilePalette } from "../account/useProfilePalette";
import "../remoteTargets/connections.css";

type ConnectionsPanelProps = {
  initialTab?: ConnectionsPanelTab;
  machineId?: string | null;
  onClose: () => void;
  onDisconnectRequested?: (target: RemoteRuntimeTarget) => boolean | Promise<boolean>;
  onRemoveRequested?: (target: RemoteRuntimeTarget) => boolean | Promise<boolean>;
};

const TABS: Array<{ key: ConnectionsPanelTab; label: string; icon: typeof DesktopTower }> = [
  { key: "machines", label: "Machines", icon: DesktopTower },
  { key: "mobile", label: "Phone", icon: DeviceMobile },
  { key: "web", label: "Web", icon: Globe },
];

/** The header: who is signed in, on a strip painted from their profile picture. */
function AccountHeader({
  githubStatus,
  onNavigate,
  onClose,
}: {
  githubStatus?: GitHubStatus | null;
  onNavigate: () => void;
  onClose: () => void;
}) {
  const { status } = useAccountStatus();
  const githubConnected = Boolean(githubStatus?.connected);
  const avatarImage = accountAvatarImage(status, githubStatus?.userLogin ?? null);
  const ringTint = providerTint(status, githubConnected);
  const [imgBroken, setImgBroken] = useState(false);
  const palette = useProfilePalette(imgBroken ? null : avatarImage, ringTint);
  const [base, deep, , bright, light] = palette.ramp;

  // State-first title so the panel reads honestly at a glance. A session that
  // could not be READ is not a sign-out, and must not be summarized as one.
  const sessionState = accountSessionState(status);
  const active = sessionState === "active";
  const title = active ? status.name || status.email || accountSessionTitle(sessionState) : accountSessionTitle(sessionState);
  const subtitle = active
    ? status.name && status.email ? status.email : accountSessionConnectionsSubtitle(sessionState)
    : accountSessionConnectionsSubtitle(sessionState);

  return (
    <div
      className="ade-cx-head"
      style={{
        "--cx-base": rgbCss(base!),
        "--cx-deep": rgbCss(deep!),
        "--cx-bright": rgbCss(bright!, 0.85),
        "--cx-light": rgbCss(light!, 0.55),
      } as CSSProperties}
    >
      {/* Close is rendered first so it remains the panel's leading focus stop,
          then ordered to the right for layout. */}
      <button
        type="button"
        className="ade-cx-head-btn ade-cx-head-close"
        onClick={onClose}
        title="Close connections"
        aria-label="Close connections"
        style={{ order: 3 }}
      >
        <X size={13} weight="bold" />
      </button>
      <button
        type="button"
        onClick={onNavigate}
        className="ade-cx-head-who"
        style={{ order: 1 }}
        aria-label={accountSessionConnectionsActionAria(sessionState)}
      >
        {avatarImage && !imgBroken ? (
          <img
            src={avatarImage}
            alt=""
            width={36}
            height={36}
            draggable={false}
            onError={() => setImgBroken(true)}
            className="ade-cx-head-avatar"
          />
        ) : status.signedIn ? (
          <span className="ade-cx-head-avatar ade-cx-head-monogram">{accountInitials(status)}</span>
        ) : (
          <UserCircle size={36} weight="regular" />
        )}
        <span style={{ minWidth: 0, flex: 1 }}>
          <span className="ade-cx-head-name">{title}</span>
          {subtitle ? <span className="ade-cx-head-email">{subtitle}</span> : null}
        </span>
      </button>
      <button type="button" onClick={onNavigate} className="ade-cx-head-btn" style={{ order: 2 }}>
        {active ? <UserCircle size={13} weight="bold" /> : null}
        {active ? "Account" : accountSessionConnectionsAction(sessionState)}
      </button>
    </div>
  );
}

/**
 * This computer's routes as the Account page's badges: which ways other
 * devices can reach it. Only for this computer itself; a window bound to
 * another machine shows that machine in the card, and these would describe
 * the wrong one.
 */
function ThisComputerRouteBadges({ accountMachines }: { accountMachines: AdeAccountMachine[] | undefined }) {
  const [routes, setRoutes] = useState<MachineConnectionRoutes | null>(null);
  const [localKey, setLocalKey] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.ade?.account?.getConnectionRoutes?.({ machineKey: null })
      .then((next) => {
        if (!cancelled) setRoutes(next);
      })
      .catch(() => {});
    void window.ade?.account?.getLocalMachineIdentity?.()
      .then((identity) => {
        if (!cancelled) setLocalKey(identity.machineKey);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const machine = accountMachines?.find((entry) => entry.machineKey === localKey) ?? null;
  const items = useMemo(() => machineRouteItems(machine, routes), [machine, routes]);
  if (!routes && !machine) return <span className="ade-cx-reach-label">Can other devices reach this computer?</span>;
  return (
    <span className="ade-cx-reach">
      <RoutePills items={items} />
      <span className="ade-cx-reach-label">{machineReachHeadline(items)}</span>
    </span>
  );
}

const confirmRevoke: RevokeConfirm = ({ name, connected }) =>
  confirmDialog({
    title: "Revoke access?",
    message: connected
      ? `${name} will be disconnected and lose access to this computer until it connects again.`
      : `${name} will lose access to this computer until it connects again.`,
    confirmLabel: "Revoke",
    destructive: true,
  });

export function ConnectionsPanel({
  initialTab = "machines",
  machineId = null,
  onClose,
  onDisconnectRequested,
  onRemoveRequested,
}: ConnectionsPanelProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { status: accountStatus } = useAccountStatus();
  const [tab, setTab] = useState<ConnectionsPanelTab>(initialTab);
  const [accountMachines, setAccountMachines] = useState<AdeAccountMachinesResult | null>(null);
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [connectionSnapshot, setConnectionSnapshot] =
    useState<RemoteRuntimeConnectionSnapshot | null>(null);
  const sync = useSyncConnections();

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    let cancelled = false;
    void window.ade.github
      ?.getStatus?.()
      .then((next) => {
        if (!cancelled) setGithubStatus(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Track remote-machine connections so the Machines tab can show a live dot.
  // The Phone/Web dots reuse the sync device list already fetched above.
  const applyConnectionSnapshot = useCallback((snapshot: RemoteRuntimeConnectionSnapshot) => {
    setConnectionSnapshot((current) =>
      !current || snapshot.updatedAt >= current.updatedAt ? snapshot : current,
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    const { getConnectionSnapshot, onConnectionSnapshotChanged } = window.ade.remoteRuntime;
    if (getConnectionSnapshot) {
      void getConnectionSnapshot()
        .then((snapshot) => {
          if (!cancelled && snapshot) applyConnectionSnapshot(snapshot);
        })
        .catch(() => {});
    }
    const unsubscribe = onConnectionSnapshotChanged?.((snapshot) => {
      if (!cancelled) applyConnectionSnapshot(snapshot);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [applyConnectionSnapshot]);

  const activeTabs = useMemo<Record<ConnectionsPanelTab, boolean>>(() => {
    const machines = (connectionSnapshot?.connectedCount ?? 0) > 0;
    const mobile = sync.devices.some(
      (device) => !device.isLocal && device.deviceType === "phone" && device.connectionState === "connected",
    );
    const web = sync.devices.some(
      (device) => !device.isLocal && device.deviceType === "browser" && device.connectionState === "connected",
    );
    return { machines, mobile, web };
  }, [connectionSnapshot, sync.devices]);

  const loadAccountMachines = useCallback(async (options?: { force?: boolean }) => {
    // Shared cache: the popover unmounts on close, so a per-open fetch would
    // start cold every time and one slow call would render an empty list.
    setAccountMachines(await fetchAccountMachines(options));
  }, []);

  const reloadAccountMachines = useCallback(() => {
    invalidateAccountMachines();
    void loadAccountMachines({ force: true });
  }, [loadAccountMachines]);

  // Fetch account machines whenever the Machines tab opens (including the first
  // render) without blocking the local saved/discovered rows.
  useEffect(() => {
    if (tab !== "machines") return;
    void loadAccountMachines();
  }, [loadAccountMachines, tab]);

  const focusedMachineRequestRef = useRef<{ machineId: string; focused: boolean } | null>(null);
  useEffect(() => {
    if (focusedMachineRequestRef.current?.machineId !== machineId) {
      focusedMachineRequestRef.current = machineId ? { machineId, focused: false } : null;
    }
    const request = focusedMachineRequestRef.current;
    if (tab !== "machines" || !machineId || !accountMachines) return;
    if (!request || request.focused) return;
    const row = document.querySelector<HTMLElement>(`[data-account-machine-key="${CSS.escape(machineId)}"]`);
    if (!row) return;
    request.focused = true;
    return flashRowHighlight(row);
  }, [accountMachines, machineId, tab]);

  const goToAccount = useCallback(() => {
    onClose();
    navigate("/account", {
      state: { returnTo: `${location.pathname}${location.search}${location.hash}` },
    });
  }, [location.hash, location.pathname, location.search, navigate, onClose]);

  // Only where this ADE can read this computer's routes (not hosted web).
  const routesReadable = routesAvailable();

  return (
    <div style={{ display: "flex", flexDirection: "column", maxHeight: "calc(100vh / var(--ade-web-zoom-factor, 1) - 96px)" }}>
      <AccountHeader githubStatus={githubStatus} onNavigate={goToAccount} onClose={onClose} />

      <div style={{ padding: "12px 12px 0" }}>
        <ThisMacCard
          sync={sync}
          sessionState={accountSessionState(accountStatus)}
          hidePairing
          statusSlot={(
            <>
              <ThisComputerStatus
                accountSignedIn={accountStatus.signedIn}
                onAccountMachinesChanged={reloadAccountMachines}
                hideHealthy
              />
              <HostReachabilityCheck
                leading={sync.isRemoteBound || !routesReadable ? undefined : (
                  <ThisComputerRouteBadges accountMachines={accountMachines?.machines} />
                )}
              />
            </>
          )}
        />
      </div>

      <div style={{ padding: "12px 12px 0" }}>
        <div role="tablist" aria-label="Connections" className="ade-cx-tabs">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              aria-label={activeTabs[key] ? `${label}, active connection` : label}
              onClick={() => setTab(key)}
              className="ade-cx-tab"
            >
              <Icon size={15} weight={tab === key ? "bold" : "regular"} />
              {label}
              {activeTabs[key] ? <span aria-hidden title="Active connection" className="ade-cx-tab-dot" /> : null}
            </button>
          ))}
        </div>
      </div>

      <div style={{ overflowY: "auto", padding: 12 }} data-onboarding-anchor={`connections-${tab}`}>
        {tab === "machines" ? (
          <RemoteTargetList
            onDisconnectRequested={onDisconnectRequested}
            onRemoveRequested={onRemoveRequested}
            accountMachines={accountMachines?.machines}
            accountMachinesState={accountMachines?.state}
            accountSignedIn={accountStatus.signedIn}
            onAccountRequested={goToAccount}
            onAccountMachinesChanged={reloadAccountMachines}
            accountEmail={accountStatus.email ?? null}
            thisComputerCode={sync.isRemoteBound || !canShowPairingCode(sync) ? null : <ThisComputerPairingCode sync={sync} />}
          />
        ) : null}
        {tab === "mobile" ? (
          <PhoneConnectionsTab sync={sync} confirmRevoke={confirmRevoke} />
        ) : null}
        {tab === "web" ? (
          <WebConnectionsTab
            sync={sync}
            accountSignedIn={accountStatus.signedIn}
            confirmRevoke={confirmRevoke}
            onAccountRequested={goToAccount}
          />
        ) : null}
      </div>
    </div>
  );
}
