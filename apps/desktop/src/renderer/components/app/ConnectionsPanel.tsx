import { useCallback, useEffect, useState } from "react";
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
  AdeAccountMachinesResult,
  GitHubStatus,
  RemoteRuntimeTarget,
} from "../../../shared/types";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { RemoteTargetList } from "../remoteTargets/RemoteTargetList";
import {
  PhoneConnectionsTab,
  ThisMacCard,
  WebConnectionsTab,
  useSyncConnections,
  type RevokeConfirm,
} from "../settings/SyncDevicesSection";
import { ConfirmDialog, useConfirmDialog } from "../shared/InlineDialogs";
import {
  accountAvatarImage,
  accountInitials,
  providerTint,
  useAccountStatus,
} from "../../lib/account";
import type { ConnectionsPanelTab } from "../../lib/connectionsPanel";

type ConnectionsPanelProps = {
  initialTab?: ConnectionsPanelTab;
  onClose: () => void;
  onDisconnectRequested?: (target: RemoteRuntimeTarget) => boolean | Promise<boolean>;
  onRemoveRequested?: (target: RemoteRuntimeTarget) => boolean | Promise<boolean>;
};

const TABS: Array<{ key: ConnectionsPanelTab; label: string; icon: typeof DesktopTower }> = [
  { key: "machines", label: "Machines", icon: DesktopTower },
  { key: "mobile", label: "Phone", icon: DeviceMobile },
  { key: "web", label: "Web", icon: Globe },
];

function tabStyle(active: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 32,
    padding: "0 12px",
    borderRadius: 8,
    border: "none",
    cursor: "pointer",
    fontFamily: SANS_FONT,
    fontSize: 12,
    fontWeight: 600,
    color: active ? COLORS.textPrimary : COLORS.textMuted,
    background: active
      ? "color-mix(in srgb, var(--color-fg) 10%, transparent)"
      : "transparent",
    transition: "background-color 120ms, color 120ms",
  };
}

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

  // State-first title so the panel reads honestly at a glance.
  const title = status.signedIn ? "Signed in to ADE" : "Not signed in";
  const subtitle = status.signedIn
    ? status.email ?? "Manage your account"
    : "Sign in to connect your devices";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "12px 12px 12px 16px",
        borderBottom: `1px solid ${COLORS.borderMuted}`,
      }}
    >
      {/* Close is rendered first so it remains the panel's leading focus stop,
          then ordered to the right for layout. */}
      <button
        type="button"
        className="ade-shell-control inline-flex h-7 w-7 items-center justify-center rounded-md"
        data-variant="ghost"
        onClick={onClose}
        title="Close connections"
        aria-label="Close connections"
        style={{ order: 3, flexShrink: 0, border: `1px solid ${COLORS.borderMuted}` }}
      >
        <X size={13} weight="regular" />
      </button>
      <button
        type="button"
        onClick={onNavigate}
        style={{
          order: 1,
          display: "flex",
          minWidth: 0,
          flex: 1,
          alignItems: "center",
          gap: 11,
          padding: 0,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          textAlign: "left",
        }}
        aria-label={status.signedIn ? "Manage account" : "Sign in to ADE"}
      >
        <span style={{ flexShrink: 0 }}>
          {avatarImage && !imgBroken ? (
            <img
              src={avatarImage}
              alt=""
              width={30}
              height={30}
              draggable={false}
              onError={() => setImgBroken(true)}
              style={{ width: 30, height: 30, borderRadius: "50%", objectFit: "cover", boxShadow: `0 0 0 1.5px color-mix(in srgb, ${ringTint} 55%, transparent)` }}
            />
          ) : status.signedIn ? (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 30,
                height: 30,
                borderRadius: "50%",
                fontFamily: SANS_FONT,
                fontSize: 12,
                fontWeight: 700,
                color: COLORS.textPrimary,
                background: `color-mix(in srgb, ${ringTint} 20%, transparent)`,
                boxShadow: `0 0 0 1.5px color-mix(in srgb, ${ringTint} 55%, transparent)`,
              }}
            >
              {accountInitials(status)}
            </span>
          ) : (
            <UserCircle size={30} weight="regular" color={COLORS.textMuted} />
          )}
        </span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: "block", fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title}
          </span>
          <span style={{ display: "block", fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {subtitle}
          </span>
        </span>
      </button>

      <button
        type="button"
        onClick={onNavigate}
        style={{
          order: 2,
          flexShrink: 0,
          height: 28,
          padding: "0 10px",
          borderRadius: 8,
          border: `1px solid ${COLORS.borderMuted}`,
          background: "transparent",
          color: COLORS.textSecondary,
          fontFamily: SANS_FONT,
          fontSize: 11.5,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Manage account
      </button>
    </div>
  );
}

export function ConnectionsPanel({
  initialTab = "machines",
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
  const sync = useSyncConnections();
  const { state: confirmState, confirmAsync, close: closeConfirm } = useConfirmDialog();

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

  const loadAccountMachines = useCallback(async () => {
    const api = (window.ade as typeof window.ade & {
      account?: { listMachines: () => Promise<AdeAccountMachinesResult> };
    }).account;
    if (!api?.listMachines) return;
    try {
      setAccountMachines(await api.listMachines());
    } catch {
      setAccountMachines({ state: "unavailable", machines: [], message: null });
    }
  }, []);

  // Fetch account machines whenever the Machines tab opens (including the first
  // render) without blocking the local saved/discovered rows.
  useEffect(() => {
    if (tab !== "machines") return;
    void loadAccountMachines();
  }, [loadAccountMachines, tab]);

  const goToAccount = useCallback(() => {
    onClose();
    navigate("/account", {
      state: { returnTo: `${location.pathname}${location.search}${location.hash}` },
    });
  }, [location.hash, location.pathname, location.search, navigate, onClose]);

  const confirmRevoke = useCallback<RevokeConfirm>(
    ({ name, connected }) =>
      confirmAsync({
        title: "Revoke access?",
        message: connected
          ? `${name} will be disconnected and lose access to this Mac until it connects again.`
          : `${name} will lose access to this Mac until it connects again.`,
        confirmLabel: "Revoke",
        danger: true,
      }),
    [confirmAsync],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", maxHeight: "calc(100vh - 96px)" }}>
      <AccountHeader githubStatus={githubStatus} onNavigate={goToAccount} onClose={onClose} />

      <div style={{ padding: "12px 12px 0" }}>
        <ThisMacCard sync={sync} accountSignedIn={accountStatus.signedIn} />
      </div>

      <div
        role="tablist"
        aria-label="Connections"
        style={{ display: "flex", gap: 4, padding: "12px 12px 0" }}
      >
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            style={tabStyle(tab === key)}
          >
            <Icon size={15} weight="regular" />
            {label}
          </button>
        ))}
      </div>

      <div style={{ overflowY: "auto", padding: 12 }}>
        {tab === "machines" ? (
          <RemoteTargetList
            onDisconnectRequested={onDisconnectRequested}
            onRemoveRequested={onRemoveRequested}
            accountMachines={accountMachines?.machines}
            accountMachinesState={accountMachines?.state}
            accountSignedIn={accountStatus.signedIn}
            onAccountRequested={goToAccount}
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

      <ConfirmDialog state={confirmState} onClose={closeConfirm} />
    </div>
  );
}
