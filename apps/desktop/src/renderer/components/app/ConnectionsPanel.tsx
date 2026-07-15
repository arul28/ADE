import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CaretRight,
  DesktopTower,
  DeviceMobile,
  Globe,
  UserCircle,
} from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import type {
  AdeAccountMachinesResult,
  GitHubStatus,
  RemoteRuntimeTarget,
} from "../../../shared/types";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { RemoteTargetList } from "../remoteTargets/RemoteTargetList";
import { SyncDevicesSection } from "../settings/SyncDevicesSection";
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
  { key: "mobile", label: "Mobile", icon: DeviceMobile },
  { key: "web", label: "Web client", icon: Globe },
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

function AccountHeader({ githubStatus, onNavigate }: { githubStatus?: GitHubStatus | null; onNavigate: () => void }) {
  const { status } = useAccountStatus();
  const githubConnected = Boolean(githubStatus?.connected);
  const avatarImage = accountAvatarImage(status, githubStatus?.userLogin ?? null);
  const ringTint = providerTint(status, githubConnected);
  const [imgBroken, setImgBroken] = useState(false);

  const title = status.signedIn
    ? status.name ?? status.email ?? "Your ADE account"
    : "Sign in to ADE";
  const subtitle = status.signedIn
    ? status.email ?? "Manage your account"
    : "Bring your machines together under one identity";

  return (
    <button
      type="button"
      onClick={onNavigate}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        width: "100%",
        padding: "12px 16px",
        border: "none",
        borderBottom: `1px solid ${COLORS.borderMuted}`,
        background: "transparent",
        cursor: "pointer",
        textAlign: "left",
      }}
      aria-label={status.signedIn ? "Open account" : "Sign in to ADE"}
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
      <CaretRight size={15} weight="bold" color={COLORS.textDim} style={{ flexShrink: 0 }} />
    </button>
  );
}

export function ConnectionsPanel({
  initialTab = "machines",
  onClose,
  onDisconnectRequested,
  onRemoveRequested,
}: ConnectionsPanelProps) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<ConnectionsPanelTab>(initialTab);
  const [accountMachines, setAccountMachines] = useState<AdeAccountMachinesResult | null>(null);
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);

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
    navigate("/account");
  }, [navigate, onClose]);

  return (
    <div style={{ display: "flex", flexDirection: "column", maxHeight: "calc(100vh - 96px)" }}>
      <AccountHeader githubStatus={githubStatus} onNavigate={goToAccount} />

      <div
        role="tablist"
        aria-label="Connections"
        style={{ display: "flex", gap: 4, padding: "10px 12px 0" }}
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
            accountMachinesMessage={accountMachines?.message}
          />
        ) : null}
        {tab === "mobile" ? <SyncDevicesSection variant="phone" /> : null}
        {tab === "web" ? <SyncDevicesSection variant="web" /> : null}
      </div>
    </div>
  );
}
