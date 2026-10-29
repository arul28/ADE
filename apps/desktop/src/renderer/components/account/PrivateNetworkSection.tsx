import { useState, type ReactNode } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  CheckCircle,
  CircleDashed,
  CircleNotch,
  CloudArrowUp,
  Info,
  WarningCircle,
  WifiHigh,
} from "@phosphor-icons/react";
import type { AdeAccountMachine, MachineConnectionRoutes, MachineTailnetHttpsState } from "../../../shared/types";
import {
  TAILSCALE_DNS_ADMIN_URL,
  TAILSCALE_DOWNLOAD_URL,
  TAILSCALE_MACHINES_ADMIN_URL,
  tailscaleKeyExpiryDays,
} from "../../../shared/machineConnectionRoutes";
import { openExternalUrl } from "../../lib/openExternal";
import { ModernRow, ModernRows, ModernSection, type SettingsTone } from "../settings/primitives";
import { TailscaleMark } from "./MachineRoutes";
import type { MachineRoutesState } from "./useMachineRoutes";

/** Settings anchor; the manifest entry `account.privateNetwork` points here. */
export const PRIVATE_NETWORK_SETTINGS_ANCHOR = "account-private-network";
const KEY_EXPIRY_WARN_DAYS = 14;

type StepState = "done" | "todo" | "blocked" | "working";

type SetupStep = {
  id: string;
  title: string;
  hint: ReactNode;
  state: StepState;
  action?: { label: string; href: string };
};

const STEP_LOOK: Record<StepState, { icon: ReactNode; tone: SettingsTone }> = {
  done: { icon: <CheckCircle size={15} weight="fill" />, tone: "green" },
  todo: { icon: <WarningCircle size={15} weight="fill" />, tone: "amber" },
  working: { icon: <CircleNotch size={15} weight="bold" className="animate-spin" />, tone: "slate" },
  blocked: { icon: <CircleDashed size={15} weight="bold" />, tone: "slate" },
};

const WAITING_ON_STEPS = "ADE sets this up once the steps above are done.";

/** The secure route's step, by the route's state. */
const ROUTE_STEP: Record<MachineTailnetHttpsState, { state: StepState; hint: string | null }> = {
  published: { state: "done", hint: null },
  publishing: { state: "working", hint: "Starting…" },
  failed: { state: "todo", hint: null },
  needs_https_certs: { state: "blocked", hint: WAITING_ON_STEPS },
  needs_magic_dns: { state: "blocked", hint: WAITING_ON_STEPS },
  unavailable: { state: "blocked", hint: WAITING_ON_STEPS },
};

function setupSteps(routes: MachineConnectionRoutes): SetupStep[] {
  const ts = routes.tailscale;
  const running = ts.state === "running";
  const installed = ts.state !== "not_installed";
  const https = routes.tailnetHttps;
  const routeStep = ROUTE_STEP[https.state];
  return [
    {
      id: "installed",
      title: running ? "Tailscale is on" : installed ? "Turn Tailscale on" : "Install Tailscale",
      hint: running
        ? <>This computer is <span className="ade-net-mono">{ts.dnsName ?? "on your tailnet"}</span></>
        : ts.state === "needs_login"
          ? "Tailscale is installed but signed out. Sign in from the Tailscale app."
          : installed
            ? "Tailscale is installed but not connected. Connect from the Tailscale app."
            : "Free for personal use. Install it on each computer and your phone, signed in to the same account.",
      state: running ? "done" : "todo",
      action: installed ? undefined : { label: "Download", href: TAILSCALE_DOWNLOAD_URL },
    },
    {
      id: "magicdns",
      title: "MagicDNS",
      hint: "Gives every computer a stable name on your tailnet.",
      state: !running ? "blocked" : ts.magicDnsEnabled ? "done" : "todo",
      action: running && !ts.magicDnsEnabled ? { label: "Turn on", href: TAILSCALE_DNS_ADMIN_URL } : undefined,
    },
    {
      id: "https",
      title: "HTTPS certificates",
      hint: "Lets the ADE web app reconnect over Tailscale. Computer names show up in public certificate logs.",
      state: !running || !ts.magicDnsEnabled ? "blocked" : ts.httpsCertsEnabled ? "done" : "todo",
      action: running && ts.magicDnsEnabled && !ts.httpsCertsEnabled
        ? { label: "Turn on", href: TAILSCALE_DNS_ADMIN_URL }
        : undefined,
    },
    {
      id: "route",
      title: "Secure route for this computer",
      hint: https.state === "published" && https.url
        ? <span className="ade-net-mono">{https.url.replace(/^wss:\/\//, "")}</span>
        : routeStep.hint ?? https.error ?? "Tailscale didn't start the HTTPS route.",
      state: routeStep.state,
    },
  ];
}

/** The order clients try routes in, as three steps. */
function RouteLadder({ onTailnet, total }: { onTailnet: number; total: number }) {
  const steps = [
    { key: "lan", icon: <WifiHigh size={15} weight="bold" />, name: "Local network", note: "Same network, direct" },
    {
      key: "tailscale",
      icon: <TailscaleMark size={15} />,
      name: "Tailscale",
      note: total > 0 ? `${onTailnet} of ${total} computers` : "Anywhere, direct",
    },
    { key: "relay", icon: <CloudArrowUp size={15} weight="bold" />, name: "ADE Relay", note: "When nothing else answers" },
  ];
  return (
    <ol className="ade-net-ladder" aria-label="Route order">
      {steps.map((step, index) => (
        <li key={step.key} className="ade-net-rung" data-route={step.key}>
          <span className="ade-net-rung-icon">{step.icon}</span>
          <span className="ade-net-rung-copy">
            <span className="ade-net-rung-name">
              <span className="ade-net-rung-index kit-num">{index + 1}</span>
              {step.name}
            </span>
            <span className="ade-net-rung-note">{step.note}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function ExternalButton({ label, href, primary }: { label: string; href: string; primary?: boolean }) {
  return (
    <button
      type="button"
      className="ade-acct-btn"
      data-tone={primary ? "primary" : undefined}
      onClick={() => openExternalUrl(href)}
    >
      {label}
      <ArrowSquareOut size={12} weight="bold" />
    </button>
  );
}

/**
 * Settings › Account › Private network: how the owner's computers reach each
 * other, and the Tailscale setup that keeps ADE Relay a fallback. Everything
 * here is this computer's own reading of its own Tailscale; MagicDNS and HTTPS
 * certificates are tailnet-wide, so one computer's answer holds for all.
 */
export function PrivateNetworkSection({
  state,
  machines,
  onRecheck,
}: {
  state: MachineRoutesState | undefined;
  machines: AdeAccountMachine[];
  onRecheck: () => void;
}) {
  const routes = state?.routes ?? null;
  const checking = state?.status === "loading";
  const onTailnet = machines.filter((machine) =>
    machine.reachableEndpoints.some((endpoint) => endpoint.kind === "tailnet"),
  ).length;
  const steps = routes ? setupSteps(routes) : [];
  const done = steps.filter((step) => step.state === "done").length;
  const complete = steps.length > 0 && done === steps.length;
  const expiryDays = routes ? tailscaleKeyExpiryDays(routes.tailscale.keyExpiry, Date.now()) : null;
  const expiringSoon = expiryDays != null && expiryDays <= KEY_EXPIRY_WARN_DAYS;
  // Once everything is done the checklist has nothing to ask for; it folds
  // into the header until the owner opens it.
  const [showDone, setShowDone] = useState(false);
  const showSteps = !complete || expiringSoon || showDone;
  const adminSteps = steps.filter((step) => step.action?.href === TAILSCALE_DNS_ADMIN_URL).length;

  return (
    <ModernSection
      group="Account"
      anchor={PRIVATE_NETWORK_SETTINGS_ANCHOR}
      title="Private network"
      hint="Your computers reach each other directly over Tailscale. ADE Relay only steps in when nothing else answers."
      actions={(
        <button type="button" className="ade-acct-btn" disabled={checking} onClick={onRecheck}>
          {checking
            ? <CircleNotch size={12} weight="bold" className="animate-spin" />
            : <ArrowClockwise size={12} weight="bold" />}
          Check again
        </button>
      )}
    >
      <div className="ade-net">
        <RouteLadder onTailnet={onTailnet} total={machines.length} />
        <header className="ade-net-setup-head">
          <span className="ade-net-brand">
            <TailscaleMark size={16} />
          </span>
          <div className="ade-net-setup-title">
            <div className="ade-ap-rowtitle">{complete ? "Tailscale is ready" : "Set up Tailscale"}</div>
            <div className="ade-ap-rowhint">
              {complete
                ? "Your computers and phones on your tailnet connect without ADE Relay."
                : "Faster and private, and it keeps working when ADE Relay is off."}
            </div>
          </div>
          {complete && !expiringSoon ? (
            <button
              type="button"
              className="ade-acct-btn"
              data-variant="ghost"
              aria-expanded={showDone}
              onClick={() => setShowDone((value) => !value)}
            >
              {showDone ? "Hide steps" : "Show steps"}
            </button>
          ) : steps.length > 0 ? (
            <div className="ade-net-progress" title={`${done} of ${steps.length} done`}>
              <span className="kit-num">{done}/{steps.length}</span>
              <span className="kit-meter" aria-hidden>
                <span style={{ width: `${Math.round((done / steps.length) * 100)}%` }} />
              </span>
            </div>
          ) : null}
        </header>
        {!routes ? (
          <div className="ade-net-empty">
            {state?.status === "error" ? state.message : "Checking Tailscale on this computer…"}
          </div>
        ) : showSteps ? (
          <div className="ade-net-steps">
            <ModernRows>
              {steps.map((step) => (
                <ModernRow
                  key={step.id}
                  icon={STEP_LOOK[step.state].icon}
                  tone={STEP_LOOK[step.state].tone}
                  title={step.title}
                  hint={step.hint}
                  control={step.action ? <ExternalButton label={step.action.label} href={step.action.href} primary /> : undefined}
                />
              ))}
              {expiringSoon && expiryDays != null ? (
                <ModernRow
                  icon={STEP_LOOK.todo.icon}
                  tone={STEP_LOOK.todo.tone}
                  title={expiryDays <= 0
                    ? "Tailscale sign-in expired"
                    : `Tailscale sign-in expires in ${expiryDays} ${expiryDays === 1 ? "day" : "days"}`}
                  hint="Renew it, or turn off key expiry for this computer."
                  control={<ExternalButton label="Machines" href={TAILSCALE_MACHINES_ADMIN_URL} />}
                />
              ) : null}
            </ModernRows>
            {adminSteps > 0 ? (
              <div className="ade-net-foot">
                <Info size={13} weight="bold" />
                {adminSteps > 1
                  ? "Both switches are on Tailscale's DNS page. Turn them on, then press Check again."
                  : "The switch is on Tailscale's DNS page. Turn it on, then press Check again."}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </ModernSection>
  );
}
