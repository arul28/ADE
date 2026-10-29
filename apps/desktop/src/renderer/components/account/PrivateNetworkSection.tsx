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
import type { AdeAccountMachine, MachineConnectionRoutes } from "../../../shared/types";
import {
  TAILSCALE_DNS_ADMIN_URL,
  TAILSCALE_DOWNLOAD_URL,
  tailscaleKeyExpiryDays,
} from "../../../shared/machineConnectionRoutes";
import { openExternalUrl } from "../../lib/openExternal";
import { ModernSection } from "../settings/primitives";
import { TailscaleMark } from "./MachineRoutes";
import type { MachineRoutesState } from "./useMachineRoutes";

/** Settings anchor; the manifest entry `account.privateNetwork` points here. */
export const PRIVATE_NETWORK_SETTINGS_ANCHOR = "account-private-network";
const TAILSCALE_MACHINES_ADMIN_URL = "https://login.tailscale.com/admin/machines";
const KEY_EXPIRY_WARN_DAYS = 14;

type StepState = "done" | "todo" | "blocked" | "working";

type SetupStep = {
  id: string;
  title: string;
  hint: ReactNode;
  state: StepState;
  action?: { label: string; href: string };
};

function setupSteps(routes: MachineConnectionRoutes): SetupStep[] {
  const ts = routes.tailscale;
  const running = ts.state === "running";
  const installed = ts.state !== "not_installed";
  const steps: SetupStep[] = [];
  steps.push({
    id: "installed",
    title: running ? "Tailscale is on" : installed ? "Turn Tailscale on" : "Install Tailscale",
    hint: running
      ? <>This computer is <span className="ade-net-mono">{ts.dnsName ?? "on your tailnet"}</span></>
      : ts.state === "needs_login"
        ? "Tailscale is installed but signed out. Sign in from its menu bar icon."
        : installed
          ? "Tailscale is installed but not connected. Turn it on from its menu bar icon."
          : "Free for personal use. Install it on each computer and your phone, signed in to the same account.",
    state: running ? "done" : "todo",
    action: installed ? undefined : { label: "Download", href: TAILSCALE_DOWNLOAD_URL },
  });
  steps.push({
    id: "magicdns",
    title: "MagicDNS",
    hint: "Gives every computer a stable name on your tailnet.",
    state: !running ? "blocked" : ts.magicDnsEnabled ? "done" : "todo",
    action: running && !ts.magicDnsEnabled ? { label: "Turn on", href: TAILSCALE_DNS_ADMIN_URL } : undefined,
  });
  steps.push({
    id: "https",
    title: "HTTPS certificates",
    hint: "Lets the ADE web app use Tailscale. Computer names show up in public certificate logs.",
    state: !running || !ts.magicDnsEnabled ? "blocked" : ts.httpsCertsEnabled ? "done" : "todo",
    action: running && ts.magicDnsEnabled && !ts.httpsCertsEnabled
      ? { label: "Turn on", href: TAILSCALE_DNS_ADMIN_URL }
      : undefined,
  });
  const https = routes.tailnetHttps;
  steps.push({
    id: "route",
    title: "Secure route for this computer",
    hint: https.state === "published" && https.url
      ? <span className="ade-net-mono">{https.url.replace(/^wss:\/\//, "")}</span>
      : https.state === "failed"
        ? https.error ?? "Tailscale didn't start the HTTPS route."
        : https.state === "publishing"
          ? "Starting…"
          : "ADE sets this up once the steps above are done.",
    state: https.state === "published"
      ? "done"
      : https.state === "publishing"
        ? "working"
        : https.state === "failed"
          ? "todo"
          : "blocked",
  });
  return steps;
}

function StepGlyph({ state }: { state: StepState }) {
  if (state === "done") return <CheckCircle size={18} weight="fill" className="ade-net-glyph" data-state="done" />;
  if (state === "working") return <CircleNotch size={18} weight="bold" className="ade-net-glyph animate-spin" data-state="working" />;
  if (state === "todo") return <WarningCircle size={18} weight="fill" className="ade-net-glyph" data-state="todo" />;
  return <CircleDashed size={18} weight="bold" className="ade-net-glyph" data-state="blocked" />;
}

/** The order clients try routes in, as three steps. */
function RouteLadder({
  onTailnet,
  total,
}: {
  onTailnet: number;
  total: number;
}) {
  const steps = [
    { key: "lan", icon: <WifiHigh size={15} weight="bold" />, name: "Local network", note: "Same Wi-Fi, direct" },
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

        <div className="ade-net-setup">
          <header className="ade-net-setup-head">
            <span className="ade-net-brand">
              <TailscaleMark size={16} />
            </span>
            <div className="ade-net-setup-title">
              <div className="ade-ap-rowtitle">
                {complete ? "Tailscale is ready" : "Set up Tailscale"}
              </div>
              <div className="ade-ap-rowhint">
                {complete
                  ? "Phones, computers and the web app on your tailnet connect without ADE Relay."
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
              {state?.status === "error"
                ? state.message
                : "Checking Tailscale on this computer…"}
            </div>
          ) : !showSteps ? null : (
            <ol className="ade-net-steps">
              {steps.map((step) => (
                <li key={step.id} className="ade-net-step" data-state={step.state}>
                  <StepGlyph state={step.state} />
                  <div className="ade-net-step-copy">
                    <div className="ade-net-step-title">{step.title}</div>
                    <div className="ade-net-step-hint">{step.hint}</div>
                  </div>
                  {step.action ? (
                    <button
                      type="button"
                      className="ade-acct-btn"
                      data-tone="primary"
                      onClick={() => openExternalUrl(step.action!.href)}
                    >
                      {step.action.label}
                      <ArrowSquareOut size={12} weight="bold" />
                    </button>
                  ) : null}
                </li>
              ))}
              {expiringSoon && expiryDays != null ? (
                <li className="ade-net-step" data-state="todo">
                  <WarningCircle size={18} weight="fill" className="ade-net-glyph" data-state="todo" />
                  <div className="ade-net-step-copy">
                    <div className="ade-net-step-title">
                      {expiryDays <= 0 ? "Tailscale sign-in expired" : `Tailscale sign-in expires in ${expiryDays} ${expiryDays === 1 ? "day" : "days"}`}
                    </div>
                    <div className="ade-net-step-hint">Renew it, or turn off key expiry for this computer.</div>
                  </div>
                  <button type="button" className="ade-acct-btn" onClick={() => openExternalUrl(TAILSCALE_MACHINES_ADMIN_URL)}>
                    Machines
                    <ArrowSquareOut size={12} weight="bold" />
                  </button>
                </li>
              ) : null}
            </ol>
          )}
          {routes && !complete && steps.some((step) => step.action?.href === TAILSCALE_DNS_ADMIN_URL) ? (
            <div className="ade-net-foot">
              <Info size={13} weight="bold" />
              {steps.filter((step) => step.action?.href === TAILSCALE_DNS_ADMIN_URL).length > 1
                ? "Both switches are on Tailscale's DNS page. Turn them on, then press Check again."
                : "The switch is on Tailscale's DNS page. Turn it on, then press Check again."}
            </div>
          ) : null}
        </div>
      </div>
    </ModernSection>
  );
}
