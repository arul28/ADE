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
import { formatTime } from "../../lib/format";
import { ModernRow, ModernRows, ModernSection, type SettingsTone } from "../settings/primitives";
import { TailscaleMark } from "./MachineRoutes";
import { Banner } from "../ui/notice";
import { machineRouteItems, type MachineRouteItem } from "./machineRouteModel";
import type { MachineRoutesState } from "./useMachineRoutes";

/** Settings anchor; the manifest entry `account.privateNetwork` points here. */
export const PRIVATE_NETWORK_SETTINGS_ANCHOR = "account-private-network";
const KEY_EXPIRY_WARN_DAYS = 14;

type StepState = "done" | "todo" | "blocked" | "working";

type StepAction =
  | { label: string; href: string }
  /** Runs on this computer (opening the Tailscale app). */
  | { label: string; run: () => void };

export type SetupStep = {
  id: string;
  title: string;
  hint: ReactNode;
  state: StepState;
  action?: StepAction;
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

/** Why Tailscale isn't on here, and what to do about it. */
const TAILSCALE_OFF_HINT: Record<Exclude<MachineConnectionRoutes["tailscale"]["state"], "running" | "not_installed">, string> = {
  needs_login: "Tailscale is installed but signed out. Sign in from the Tailscale app.",
  stopped: "Tailscale is installed but turned off. Turn it on from the Tailscale app.",
  starting: "Tailscale is starting. Press Check again in a moment.",
  unknown: "Tailscale didn't answer. Open the Tailscale app and make sure it's connected, then press Check again.",
};

/** Opens the Tailscale app on this computer, where the bridge can. */
function openTailscaleAction(): StepAction | undefined {
  const open = window.ade?.app?.openTailscale;
  return open ? { label: "Open Tailscale", run: () => void open().catch(() => undefined) } : undefined;
}

/**
 * Is Tailscale on this computer? An expired sign-in (Tailscale stops
 * connecting until someone signs in again) is its own answer, with the renew
 * path; a reading ADE couldn't get says why; Tailscale's own first warning is
 * quoted, since it usually names the fix.
 */
function tailscaleStep(routes: MachineConnectionRoutes): SetupStep {
  const ts = routes.tailscale;
  const running = ts.state === "running";
  const installed = ts.state !== "not_installed";
  const says = !running && ts.health?.[0] ? <> Tailscale says: <q>{ts.health[0]}</q></> : null;
  if (!running && ts.keyExpired) {
    return {
      id: "installed",
      title: "Tailscale sign-in expired",
      hint: <>This computer's Tailscale sign-in expired, so Tailscale stopped connecting. Sign in again from the Tailscale app, or renew it on Tailscale's Machines page.{says}</>,
      state: "todo",
      action: openTailscaleAction() ?? { label: "Machines", href: TAILSCALE_MACHINES_ADMIN_URL },
    };
  }
  const offHint = ts.state === "running" || ts.state === "not_installed"
    ? null
    : ts.state === "unknown" && ts.readError
      ? `ADE couldn't read Tailscale: ${ts.readError} Open the Tailscale app and make sure it's connected, then press Check again.`
      : TAILSCALE_OFF_HINT[ts.state];
  return {
    id: "installed",
    title: running ? "Tailscale is on" : installed ? "Turn Tailscale on" : "Install Tailscale",
    hint: running
      ? <>This computer is <span className="ade-net-mono">{ts.dnsName ?? "on your tailnet"}</span></>
      : !installed
        ? "Free for personal use. Install it on each computer and your phone, signed in to the same account."
        : <>{offHint}{says}</>,
    state: running ? "done" : ts.state === "starting" ? "working" : "todo",
    action: !installed
      ? { label: "Download", href: TAILSCALE_DOWNLOAD_URL }
      : running || ts.state === "starting" ? undefined : openTailscaleAction(),
  };
}

export function setupSteps(routes: MachineConnectionRoutes): SetupStep[] {
  const ts = routes.tailscale;
  const running = ts.state === "running";
  const https = routes.tailnetHttps;
  const routeStep = ROUTE_STEP[https.state];
  return [
    tailscaleStep(routes),
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
function RouteLadder({ onTailnet, total, routes, checking }: {
  onTailnet: number;
  total: number;
  routes: MachineRouteItem[];
  checking: boolean;
}) {
  const steps = [
    { key: "lan", icon: <WifiHigh size={15} weight="bold" />, name: "Local network", note: "On the same Wi-Fi, direct" },
    {
      key: "tailscale",
      icon: <TailscaleMark size={15} />,
      name: "Tailscale",
      note: total > 0 ? `Anywhere, private · ${onTailnet} of ${total} on it` : "Anywhere, private and direct",
    },
    { key: "relay", icon: <CloudArrowUp size={15} weight="bold" />, name: "ADE Relay", note: "Through ADE's servers, as a fallback" },
  ];
  return (
    <ol className="ade-net-ladder" aria-label="Route order">
      {steps.map((step, index) => {
        const result = routes.find((route) => route.kind === step.key);
        const status = checking ? "Checking…" : result?.word;
        return (
          <li key={step.key} className="ade-net-rung" data-route={step.key}>
            <span className="ade-net-rung-icon">{step.icon}</span>
            <span className="ade-net-rung-copy">
              <span className="ade-net-rung-name">
                <span className="ade-net-rung-index kit-num">{index + 1}</span>
                {step.name}
              </span>
              <span className="ade-net-rung-note">{step.note}</span>
              {status ? <span className="ade-net-rung-note" title={checking ? undefined : result?.detail ?? undefined}>{status}</span> : null}
            </span>
          </li>
        );
      })}
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

function StepActionButton({ action }: { action: StepAction }) {
  if ("href" in action) return <ExternalButton label={action.label} href={action.href} primary />;
  return (
    <button type="button" className="ade-acct-btn" data-tone="primary" onClick={action.run}>
      {action.label}
    </button>
  );
}

/** The line under the checklist: what the last check found, and when. */
function CheckResult({
  state,
  rechecking,
  lastRecheckAtMs,
  todo,
  complete,
}: {
  state: MachineRoutesState | undefined;
  rechecking: boolean;
  lastRecheckAtMs: number | null;
  todo: number;
  complete: boolean;
}) {
  if (state?.status === "error" && !rechecking) {
    // A failed re-read with an older answer on screen: say the list is the old one.
    const at = lastRecheckAtMs ? ` at ${formatTime(new Date(lastRecheckAtMs).toISOString())}` : "";
    return (
      <div className="ade-net-check-failed">
        <Banner
          layout="inline"
          model={{
            id: "private-network-check-failed",
            tone: "warning",
            title: `Couldn't check${at}`,
            detail: state.routes ? `${state.message} The steps show the last answer.` : state.message,
            report: false,
          }}
        />
      </div>
    );
  }
  let text: string | null = null;
  if (rechecking) {
    text = "Checking connection routes and Tailscale setup on this computer…";
  } else if (state?.routes) {
    const at = formatTime(state.routes.checkedAt);
    const outcome = complete
      ? "Everything is set up."
      : todo > 0
        ? `${todo} ${todo === 1 ? "step needs" : "steps need"} you.`
        : "Still setting up.";
    text = at ? `Checked at ${at}. ${outcome}` : outcome;
  }
  if (!text) return null;
  return (
    <div className="ade-net-checked" role="status" aria-live="polite">
      {rechecking
        ? <CircleNotch size={12} weight="bold" className="animate-spin" />
        : <CheckCircle size={13} weight="fill" />}
      {text}
    </div>
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
  rechecking = false,
  lastRecheckAtMs = null,
  onRecheck,
}: {
  state: MachineRoutesState | undefined;
  machines: AdeAccountMachine[];
  /** "Check again" is running: every step shows that it is being checked. */
  rechecking?: boolean;
  /** When the last "Check again" finished, for a failure the answer can't date. */
  lastRecheckAtMs?: number | null;
  onRecheck: () => void;
}) {
  const routes = state?.routes ?? null;
  const checking = rechecking || state?.status === "loading";
  const onTailnet = machines.filter((machine) =>
    machine.reachableEndpoints.some((endpoint) => endpoint.kind === "tailnet"),
  ).length;
  const localMachine = routes ? machines.find((machine) => machine.machineKey === routes.machineKey) ?? null : null;
  const routeResults = routes ? machineRouteItems(localMachine, routes) : [];
  const steps = routes ? setupSteps(routes) : [];
  const done = steps.filter((step) => step.state === "done").length;
  const todo = steps.filter((step) => step.state === "todo").length;
  const complete = steps.length > 0 && done === steps.length;
  const expiryDays = routes ? tailscaleKeyExpiryDays(routes.tailscale.keyExpiry, Date.now()) : null;
  // An expired sign-in is the first step's own answer; this row only warns before it.
  const expiringSoon = expiryDays != null && expiryDays <= KEY_EXPIRY_WARN_DAYS && routes?.tailscale.keyExpired !== true;
  // Once everything is done the checklist has nothing to ask for; it folds
  // into the header until the owner opens it.
  const [showDone, setShowDone] = useState(false);
  const showSteps = !complete || expiringSoon || showDone || rechecking;
  const adminSteps = steps.filter((step) => step.action && "href" in step.action && step.action.href === TAILSCALE_DNS_ADMIN_URL).length;

  return (
    <ModernSection
      group="Account"
      anchor={PRIVATE_NETWORK_SETTINGS_ANCHOR}
      title="Connections"
      icon={<TailscaleMark size={15} />}
      tone="teal"
      hint="How your phone, the web app and your other computers reach these computers. ADE tries each way in order and uses the first that answers."
      actions={(
        <button type="button" className="ade-acct-btn" disabled={checking} onClick={onRecheck}>
          {checking
            ? <CircleNotch size={12} weight="bold" className="animate-spin" />
            : <ArrowClockwise size={12} weight="bold" />}
          {rechecking ? "Checking…" : "Check again"}
        </button>
      )}
    >
      <div className="ade-net">
        <RouteLadder onTailnet={onTailnet} total={machines.length} routes={routeResults} checking={checking} />
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
        <CheckResult state={state} rechecking={rechecking} lastRecheckAtMs={lastRecheckAtMs} todo={todo} complete={complete} />
        {routes && showSteps ? (
          <div className="ade-net-steps">
            <ModernRows>
              {steps.map((step) => (
                <ModernRow
                  key={step.id}
                  icon={STEP_LOOK[rechecking ? "working" : step.state].icon}
                  tone={STEP_LOOK[rechecking ? "working" : step.state].tone}
                  title={step.title}
                  hint={rechecking ? "Checking…" : step.hint}
                  control={!rechecking && step.action ? <StepActionButton action={step.action} /> : undefined}
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
