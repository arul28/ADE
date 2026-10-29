import { useState, type ReactNode } from "react";
import {
  Broadcast,
  Browser,
  CloudArrowUp,
  DeviceMobile,
  LockSimple,
  Plugs,
  WifiHigh,
} from "@phosphor-icons/react";
import { ModernRow, ModernRows } from "../settings/primitives";
import { SettingsToggle } from "../settings/primitives/SettingsControls";
import { Banner } from "../ui/notice";
import { Dialog } from "../ui/dialog";
import type { MachineRouteItem, MachineRouteKind } from "./machineRouteModel";

/**
 * Tailscale's mark: a 3×3 grid of dots, the middle row and the bottom centre
 * lit. Drawn here so the brand reads at 12px without an image asset.
 */
export function TailscaleMark({ size = 14 }: { size?: number }) {
  const lit = new Set(["1-0", "1-1", "1-2", "2-1"]);
  const dots = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      dots.push(
        <circle
          key={`${row}-${col}`}
          cx={4 + col * 8}
          cy={4 + row * 8}
          r={2.6}
          fill="currentColor"
          opacity={lit.has(`${row}-${col}`) ? 1 : 0.3}
        />,
      );
    }
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false">
      {dots}
    </svg>
  );
}

export function RouteIcon({ kind, size = 14 }: { kind: MachineRouteKind; size?: number }) {
  switch (kind) {
    case "lan":
      return <WifiHigh size={size} weight="bold" />;
    case "tailscale":
      return <TailscaleMark size={size} />;
    case "https":
      return <LockSimple size={size} weight="bold" />;
    case "relay":
      return <CloudArrowUp size={size} weight="bold" />;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

const KIT_TONE: Record<MachineRouteItem["tone"], "ok" | "warn" | undefined> = {
  on: "ok",
  warn: "warn",
  off: undefined,
  idle: undefined,
};

/**
 * The collapsed row's route summary: one kit tag per route, lit when it
 * works. `dimmed` greys the lot for a machine that is asleep or offline, where
 * the routes are what it last offered rather than what answers now.
 */
export function RoutePills({ items, dimmed }: { items: MachineRouteItem[]; dimmed?: boolean }) {
  return (
    <div className="ade-route-pills" data-dimmed={dimmed ? "true" : undefined} aria-label="Connection routes">
      {items.map((item) => (
        <span
          key={item.kind}
          className="kit-tag ade-route-pill"
          data-tone={KIT_TONE[item.tone]}
          data-route-off={item.tone === "off" ? "true" : undefined}
          title={`${item.label}: ${item.word}${item.detail ? ` · ${item.detail}` : ""}`}
        >
          <RouteIcon kind={item.kind} size={10} />
          {item.short}
        </span>
      ))}
    </div>
  );
}

export type RelaySwitchModel = {
  /** "this computer", or the other computer's name. */
  machineLabel: string;
  enabled: boolean;
  /** Null when the switch can be used; otherwise why not. */
  unavailableReason: string | null;
  busy: boolean;
  onChange: (enabled: boolean) => void;
};

/**
 * The expanded row's connection detail: a tile per route in the order clients
 * try them, then the computer's ADE Relay switch.
 */
export function MachineRoutesPanel({
  items,
  relay,
  note,
}: {
  items: MachineRouteItem[];
  relay: RelaySwitchModel | null;
  /** One quiet line under the tiles: where the facts came from. */
  note?: string | null;
}) {
  return (
    <div className="ade-routes">
      <div className="ade-routes-grid">
        {items.map((item, index) => (
          <div key={item.kind} className="ade-route-tile" data-tone={item.tone}>
            <div className="ade-route-tile-head">
              <span className="ade-route-tile-icon">
                <RouteIcon kind={item.kind} size={13} />
              </span>
              <span className="ade-route-tile-name">{item.label}</span>
              <span className="ade-route-tile-order kit-num">{index + 1}</span>
            </div>
            <div className="ade-route-tile-state">
              <span className="kit-dot" data-state={KIT_TONE[item.tone]} aria-hidden />
              {item.word}
            </div>
            <div className="ade-route-tile-detail" title={item.detail ?? undefined}>
              {item.detail ?? " "}
            </div>
          </div>
        ))}
      </div>
      {note ? <div className="ade-routes-note">{note}</div> : null}
      {relay ? (
        <ModernRows>
          <ModernRow
            icon={<CloudArrowUp size={15} weight="bold" />}
            tone="slate"
            title={`ADE Relay on ${relay.machineLabel}`}
            hint={relay.unavailableReason
              ?? (relay.enabled
                ? "Your phone, the web app and AI apps can reach it from anywhere, through ADE's servers."
                : "Only your local network and Tailscale reach it. ADE's servers can't.")}
            control={(
              <SettingsToggle
                label={`ADE Relay on ${relay.machineLabel}`}
                checked={relay.enabled}
                disabled={relay.busy || relay.unavailableReason != null}
                onChange={relay.onChange}
              />
            )}
          />
        </ModernRows>
      ) : null}
    </div>
  );
}

type Effect = { icon: ReactNode; title: string; detail: string; tone: "ok" | "warn" | "crit" };

/**
 * The warning before ADE Relay goes off on one computer. Names exactly what
 * stops working, and whether Tailscale is ready to take over.
 */
export function RelayOffDialog({
  machineName,
  isThisComputer,
  connectedViaRelay,
  httpsReady,
  tailscaleReady,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  machineName: string;
  isThisComputer: boolean;
  /** This window reaches that computer through ADE Relay right now. */
  connectedViaRelay: boolean;
  httpsReady: boolean;
  tailscaleReady: boolean;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [understood, setUnderstood] = useState(false);
  const where = isThisComputer ? "this computer" : machineName;
  const effects: Effect[] = [
    {
      icon: <DeviceMobile size={15} weight="bold" />,
      tone: tailscaleReady ? "ok" : "warn",
      title: "Your phone",
      detail: tailscaleReady
        ? "Reaches it on the same Wi-Fi, or anywhere with Tailscale on the phone."
        : "Reaches it only on the same Wi-Fi.",
    },
    {
      icon: <Browser size={15} weight="bold" />,
      tone: httpsReady ? "warn" : "crit",
      title: "The ADE web app",
      detail: httpsReady
        ? "Browsers that already opened it reconnect over Tailscale HTTPS from your tailnet. A new browser can't pair with it."
        : "Can't reach it. Set up Tailscale HTTPS first to keep browsers that already opened it.",
    },
    {
      icon: <Plugs size={15} weight="bold" />,
      tone: "crit",
      title: "AI apps using your ADE MCP server",
      detail: "Can't reach it. Your other computers still answer.",
    },
    {
      icon: <Broadcast size={15} weight="bold" />,
      tone: "ok",
      title: "ADE's servers",
      detail: "Never carry its traffic. Your other computers keep their own setting.",
    },
  ];
  const warning = connectedViaRelay
    ? `This window reaches ${where} through ADE Relay, so it will lose the connection. Turn the relay back on from ${where} itself, or over your local network or Tailscale.`
    : !tailscaleReady
      ? `Tailscale isn't set up on ${where}, so away from its network nothing will reach it.`
      : null;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
      role="alertdialog"
      title={`Turn off ADE Relay on ${machineName}?`}
      description="It will only be reachable over its local network and Tailscale. You can turn it back on here any time."
      tone="warning"
      size="md"
      hideClose
      dismissible={!busy}
      onEscapeKeyDown={(event) => event.stopPropagation()}
      actions={[
        { label: "Cancel", onClick: onCancel, disabled: busy, variant: "secondary" },
        {
          label: "Turn off ADE Relay",
          onClick: onConfirm,
          busy,
          disabled: !understood,
          variant: "solid",
        },
      ]}
    >
      <div className="ade-relay-off">
        {warning ? (
          <Banner layout="inline" model={{ id: "relay-off-warning", tone: connectedViaRelay ? "error" : "warning", title: warning }} />
        ) : null}
        <ul className="ade-relay-off-list">
          {effects.map((effect) => (
            <li key={effect.title}>
              <span className="ade-route-tile-icon" data-tone={effect.tone}>{effect.icon}</span>
              <div>
                <div className="ade-relay-off-title">{effect.title}</div>
                <div className="ade-relay-off-detail">{effect.detail}</div>
              </div>
            </li>
          ))}
        </ul>
        <label className="ade-dialog-checkbox">
          <input
            type="checkbox"
            checked={understood}
            disabled={busy}
            onChange={(event) => setUnderstood(event.target.checked)}
          />
          <span>I understand what stops working</span>
        </label>
        {error ? (
          <Banner
            layout="inline"
            model={{ id: "relay-off-error", tone: "error", title: error, report: { surface: "account_relay_switch" } }}
          />
        ) : null}
      </div>
    </Dialog>
  );
}
