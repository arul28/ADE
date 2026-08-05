/**
 * `ade connect` — the one idempotent command that puts this machine on the
 * user's ADE account.
 *
 * The install scripts chain into it, and users run it later to (re)connect an
 * existing install. Three steps, each independently idempotent:
 *
 *   1. account  — reuse a valid session, else sign in (loopback or device flow)
 *   2. service  — register + start the per-user login service for this platform
 *   3. machine  — wait for the account-directory row this machine publishes
 *
 * Step 3 is a *wait*, not a write: the machine row is created by the brain's
 * account-machine publisher, which POSTs to the directory on sign-in and then
 * every 30s. So `ade connect` makes the preconditions true (signed in + brain
 * running) and then polls `listMachines` for this machine's own machineKey.
 *
 * This module holds no I/O of its own. Everything that touches the brain, the
 * service manager or the network arrives through `ConnectDeps` so the step
 * orchestration is unit-testable with fakes.
 */

export class ConnectUsageError extends Error {}

/** Per-platform name for the login-persistence mechanism, in user-facing copy. */
export function serviceMechanismLabel(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "launchd login service";
  if (platform === "linux") return "systemd user service";
  if (platform === "win32") return "per-user startup entry";
  return "login service";
}

/** The command that removes the service again, per platform. */
const UNINSTALL_SERVICE_COMMAND = "ade runtime uninstall-service";

const DEFAULT_WEB_CLIENT_URL = "https://app.ade-app.dev";

const DEFAULT_MACHINE_WAIT_MS = 60_000;
const MACHINE_POLL_INTERVAL_MS = 2_000;
const MIN_MACHINE_WAIT_MS = 1_000;
const MAX_MACHINE_WAIT_MS = 600_000;

export type ConnectStepId = "account" | "service" | "machine";
export type ConnectStepState = "ok" | "skipped" | "failed";

export type ConnectStep = {
  id: ConnectStepId;
  state: ConnectStepState;
  detail: string;
  nextAction?: string;
};

export type ConnectAccountStatus = {
  signedIn: boolean;
  email?: string | null;
  name?: string | null;
  userId?: string | null;
  source?: string | null;
};

export type ConnectServiceStatus = {
  installed: boolean | null;
  running: boolean | null;
  message?: string | null;
};

export type ConnectServiceInstallResult = {
  ok: boolean;
  message?: string | null;
  /** Set when the caller is running inside the very brain it tried to mutate. */
  selfMutationBlocked?: boolean;
};

export type ConnectMachine = {
  machineKey: string;
  name?: string | null;
  customName?: string | null;
  online?: boolean;
  lastSeenAt?: number | null;
};

export type ConnectMachineList = {
  /** Mirrors AdeAccountMachinesResult["state"]. */
  state: string;
  machines: ConnectMachine[];
  message?: string | null;
};

/** Last-attempt health from the brain's account-directory publisher. */
export type ConnectPublishHealth = {
  state?: string | null;
  reason?: string | null;
};

export type ConnectDeps = {
  platform?: NodeJS.Platform;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Progress checklist sink. Progress goes to stderr; the payload goes to stdout. */
  write?: (text: string) => void;
  webClientUrl?: string;

  getAccountStatus: () => Promise<ConnectAccountStatus>;
  runLogin: (args: { headless: boolean }) => Promise<ConnectAccountStatus>;
  getServiceStatus: () => ConnectServiceStatus | Promise<ConnectServiceStatus>;
  installService: () => Promise<ConnectServiceInstallResult>;
  /** This machine's directory primary key, from the sync cloud relay store. */
  getMachineKey: () => string | null;
  listMachines: () => Promise<ConnectMachineList>;
  getPublishHealth?: () => Promise<ConnectPublishHealth | null>;
};

export type ConnectOptions = {
  statusOnly: boolean;
  login: boolean;
  service: boolean;
  headless: boolean;
  machineWaitMs: number;
};

export type ConnectResult = {
  ok: boolean;
  action: "connect" | "connect-status";
  connected: boolean;
  steps: ConnectStep[];
  account: { signedIn: boolean; identity: string | null; source: string | null };
  service: {
    installed: boolean | null;
    running: boolean | null;
    mechanism: string;
    skipped: boolean;
  };
  machine: {
    machineKey: string | null;
    name: string | null;
    published: boolean;
    online: boolean;
  };
  webClientUrl: string;
  message: string;
  nextAction?: string;
};

function accountIdentity(status: ConnectAccountStatus): string | null {
  const candidates = [status.email, status.name, status.userId];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

export function machineDisplayName(machine: ConnectMachine): string {
  const custom = typeof machine.customName === "string" ? machine.customName.trim() : "";
  if (custom) return custom;
  const name = typeof machine.name === "string" ? machine.name.trim() : "";
  if (name) return name;
  return machine.machineKey;
}

function findMachine(list: ConnectMachineList, machineKey: string): ConnectMachine | null {
  for (const machine of list.machines) {
    if (machine?.machineKey === machineKey) return machine;
  }
  return null;
}

/**
 * Turn a non-`ok` directory list state into copy the user can act on. The
 * directory reports these verbatim, so never let a raw state string reach the
 * terminal on its own.
 */
function machineListStateMessage(list: ConnectMachineList): string {
  switch (list.state) {
    case "signed_out":
      return "the ADE brain is not signed in";
    case "auth_expired":
      return "the account session expired";
    case "not_configured":
      return "this build has no account directory configured";
    case "cancelled":
      return "the directory request was cancelled";
    default:
      return list.message?.trim() || `the account directory is unavailable (${list.state})`;
  }
}

function publishHealthDetail(health: ConnectPublishHealth | null): string | null {
  if (!health) return null;
  const reason = typeof health.reason === "string" ? health.reason.trim() : "";
  const state = typeof health.state === "string" ? health.state.trim() : "";
  if (reason) return reason;
  if (state && state !== "published") return state;
  return null;
}

export function parseConnectArgs(rest: readonly string[]): ConnectOptions {
  const options: ConnectOptions = {
    statusOnly: false,
    login: true,
    service: true,
    headless: false,
    machineWaitMs: DEFAULT_MACHINE_WAIT_MS,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--") continue;
    let name = token;
    let inlineValue: string | null = null;
    const equals = token.indexOf("=");
    if (token.startsWith("--") && equals > 2) {
      name = token.slice(0, equals);
      inlineValue = token.slice(equals + 1);
    }
    switch (name) {
      case "--status":
        options.statusOnly = true;
        break;
      case "--no-login":
        options.login = false;
        break;
      case "--no-service":
        options.service = false;
        break;
      case "--headless":
        options.headless = true;
        break;
      case "--timeout":
      case "--max-wait": {
        const raw = inlineValue ?? rest[++index];
        if (raw === undefined) {
          throw new ConnectUsageError(`ade connect ${name} requires a value in seconds.`);
        }
        const seconds = Number(raw);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw new ConnectUsageError(
            `ade connect ${name} expects a positive number of seconds; got "${raw}".`,
          );
        }
        const ms = Math.round(seconds * 1000);
        if (ms < MIN_MACHINE_WAIT_MS || ms > MAX_MACHINE_WAIT_MS) {
          throw new ConnectUsageError(
            `ade connect ${name} must be between ${MIN_MACHINE_WAIT_MS / 1000} and ${
              MAX_MACHINE_WAIT_MS / 1000
            } seconds.`,
          );
        }
        options.machineWaitMs = ms;
        break;
      }
      default:
        if (name.startsWith("-")) {
          throw new ConnectUsageError(`ade connect does not support ${name}.`);
        }
        throw new ConnectUsageError(
          `ade connect takes no positional arguments; got "${token}".`,
        );
    }
  }
  return options;
}

function formatStepLine(id: string, state: string, detail: string): string {
  return `  ${id.padEnd(8)} ${state.padEnd(9)} ${detail}`;
}

/**
 * The closing guidance. This goes to **stderr** alongside the checklist rather
 * than to stdout, because JSON is this CLI's default output mode — a user who
 * lands here straight from `curl | sh` must see prose, not a JSON blob. It
 * mirrors how `ade login` reports "Signed in as ..." on stderr.
 */
function renderConnectEpilogue(result: ConnectResult): string {
  const lines: string[] = [""];
  if (result.connected) {
    lines.push(
      `This machine is now reachable from ADE desktop, web (${result.webClientUrl}), and iOS.`,
    );
    lines.push("");
    lines.push("To undo:");
    lines.push("  ade logout                      Sign out of this ADE account");
    lines.push(
      `  ${UNINSTALL_SERVICE_COMMAND.padEnd(32)}Remove the ${result.service.mechanism}`,
    );
  } else {
    // The failing step's detail is already the checklist line directly above,
    // so repeat only the actionable part.
    const nextAction = result.nextAction
      ?? result.steps.find((step) => step.state === "failed")?.nextAction;
    if (nextAction) lines.push(`Next: ${nextAction}`);
    else lines.push(result.message);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * The `--text` stdout renderer: one terse line. The checklist and the guidance
 * are already on stderr, so this stays short enough to pipe somewhere useful.
 */
export function renderConnectSummary(result: ConnectResult): string {
  if (result.connected) {
    const identity = result.account.identity ?? "ADE account";
    const machine = result.machine.name ?? result.machine.machineKey ?? "this machine";
    return `Connected as ${identity} · machine "${machine}"`;
  }
  return result.message;
}

export async function runConnectCommand(
  rest: readonly string[],
  deps: ConnectDeps,
): Promise<ConnectResult> {
  const options = parseConnectArgs(rest);
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const write = deps.write ?? (() => {});
  const webClientUrl = deps.webClientUrl ?? DEFAULT_WEB_CLIENT_URL;
  const mechanism = serviceMechanismLabel(platform);

  const steps: ConnectStep[] = [];
  const pushStep = (step: ConnectStep): ConnectStep => {
    steps.push(step);
    write(`${formatStepLine(step.id, step.state, step.detail)}\n`);
    return step;
  };

  write(options.statusOnly ? "\nADE connect — status\n\n" : "\nADE connect\n\n");

  const machineKey = deps.getMachineKey();

  // ---- step 1: account -----------------------------------------------------
  let account = await deps.getAccountStatus();
  let accountFailed = false;
  if (account.signedIn) {
    pushStep({
      id: "account",
      state: "ok",
      detail: `Signed in as ${accountIdentity(account) ?? "ADE account"}`,
    });
  } else if (options.statusOnly) {
    pushStep({
      id: "account",
      state: "failed",
      detail: "Not signed in",
      nextAction: "Run `ade connect` to sign in.",
    });
    accountFailed = true;
  } else if (!options.login) {
    pushStep({
      id: "account",
      state: "skipped",
      detail: "Sign-in skipped (--no-login); this machine stays local/LAN-only",
    });
  } else {
    try {
      account = await deps.runLogin({ headless: options.headless });
    } catch (error) {
      account = { signedIn: false };
      pushStep({
        id: "account",
        state: "failed",
        detail: error instanceof Error ? error.message : String(error),
        nextAction: "Retry with `ade connect`, or `ade connect --headless` without a browser.",
      });
      accountFailed = true;
    }
    if (!accountFailed) {
      if (account.signedIn) {
        pushStep({
          id: "account",
          state: "ok",
          detail: `Signed in as ${accountIdentity(account) ?? "ADE account"}`,
        });
      } else {
        pushStep({
          id: "account",
          state: "failed",
          detail: "Sign-in did not complete",
          nextAction: "Retry with `ade connect`, or `ade connect --headless` without a browser.",
        });
        accountFailed = true;
      }
    }
  }

  // ---- step 2: service -----------------------------------------------------
  // Runs even when the account step failed: a registered service is useful on
  // its own, and it is what makes a later `ade connect` succeed unattended.
  let service = await deps.getServiceStatus();
  let serviceSkipped = false;
  if (options.statusOnly) {
    if (service.installed && service.running) {
      pushStep({ id: "service", state: "ok", detail: `${mechanism} installed and running` });
    } else if (service.installed) {
      pushStep({
        id: "service",
        state: "failed",
        detail: `${mechanism} installed but not running`,
        nextAction: "Run `ade brain start`.",
      });
    } else {
      pushStep({
        id: "service",
        state: "failed",
        detail: `${mechanism} is not installed`,
        nextAction: "Run `ade connect`.",
      });
    }
  } else if (!options.service) {
    // Report the state that was read, never assert one that was not checked:
    // --no-service means "do not change it", not "it is absent".
    serviceSkipped = true;
    pushStep({
      id: "service",
      state: "skipped",
      detail: service.installed
        ? `${mechanism} left as-is (--no-service)`
        : `${mechanism} not installed, and --no-service was passed`,
    });
  } else if (service.installed && service.running) {
    pushStep({ id: "service", state: "ok", detail: `${mechanism} already installed and running` });
  } else {
    const install = await deps.installService();
    if (install.ok) {
      service = await deps.getServiceStatus();
      pushStep({ id: "service", state: "ok", detail: `${mechanism} installed and running` });
    } else if (install.selfMutationBlocked) {
      // Running inside the brain it would replace. Not a failure: the service
      // is already doing its job.
      pushStep({
        id: "service",
        state: "ok",
        detail: `${mechanism} is already running this process`,
      });
    } else {
      pushStep({
        id: "service",
        state: "failed",
        detail: install.message?.trim() || `Could not register the ${mechanism}`,
        nextAction:
          "Run `ade serve` in the foreground to keep this machine reachable while you investigate.",
      });
    }
  }

  // ---- step 3: machine -----------------------------------------------------
  let publishedMachine: ConnectMachine | null = null;
  let machineState: ConnectStepState = "failed";
  let machineDetail = "";
  let machineNextAction: string | undefined;

  if (!account.signedIn) {
    machineState = "skipped";
    machineDetail = options.login
      ? "Not published — this machine has no account session"
      : "Not published — sign-in was skipped";
    machineNextAction = options.login ? "Run `ade connect` once sign-in succeeds." : undefined;
  } else if (!machineKey) {
    machineDetail =
      "This machine has no sync identity yet, so it cannot publish to the account directory";
    machineNextAction = "Start the ADE brain with `ade brain start`, then retry `ade connect`.";
  } else {
    // The brain publishes on sign-in and then every 30s; poll for our own row.
    const deadline = now() + (options.statusOnly ? 0 : options.machineWaitMs);
    let lastList: ConnectMachineList | null = null;
    let waited = false;
    for (;;) {
      lastList = await deps.listMachines();
      if (lastList.state === "ok") {
        publishedMachine = findMachine(lastList, machineKey);
        if (publishedMachine) break;
      }
      if (now() >= deadline) break;
      if (!waited) {
        waited = true;
        write(
          `${formatStepLine(
            "machine",
            "waiting",
            "Waiting for this machine to reach the account directory",
          )}\n`,
        );
      }
      await sleep(MACHINE_POLL_INTERVAL_MS);
    }

    if (publishedMachine) {
      machineState = "ok";
      const label = machineDisplayName(publishedMachine);
      machineDetail = publishedMachine.online
        ? `Published as "${label}" and online`
        : `Published as "${label}"`;
    } else if (lastList && lastList.state !== "ok") {
      machineDetail = `Not published — ${machineListStateMessage(lastList)}`;
      machineNextAction = "Run `ade doctor --text` to inspect account-directory health.";
    } else {
      const health = publishHealthDetail(
        deps.getPublishHealth ? await deps.getPublishHealth().catch(() => null) : null,
      );
      machineDetail = health
        ? `Not published within the wait window — publisher reports ${health}`
        : "Not published within the wait window";
      machineNextAction = serviceSkipped
        ? "The brain must stay running to publish. Start it with `ade brain start`, then retry `ade connect --status`."
        : "Run `ade doctor --text` to inspect account-directory health, then retry `ade connect --status`.";
    }
  }
  pushStep({
    id: "machine",
    state: machineState,
    detail: machineDetail,
    ...(machineNextAction ? { nextAction: machineNextAction } : {}),
  });

  const connected = account.signedIn && Boolean(publishedMachine);
  const failedStep = steps.find((step) => step.state === "failed");
  const result: ConnectResult = {
    ok: !failedStep,
    action: options.statusOnly ? "connect-status" : "connect",
    connected,
    steps,
    account: {
      signedIn: Boolean(account.signedIn),
      identity: accountIdentity(account),
      source: typeof account.source === "string" ? account.source : null,
    },
    service: {
      installed: service.installed ?? null,
      running: service.running ?? null,
      mechanism,
      skipped: serviceSkipped,
    },
    machine: {
      machineKey,
      name: publishedMachine ? machineDisplayName(publishedMachine) : null,
      published: Boolean(publishedMachine),
      online: Boolean(publishedMachine?.online),
    },
    webClientUrl,
    message: connected
      ? `This machine is now reachable from ADE desktop, web (${webClientUrl}), and iOS.`
      : failedStep
        ? failedStep.detail
        : "This machine is set up for local use; it is not linked to an ADE account.",
    ...(failedStep?.nextAction ? { nextAction: failedStep.nextAction } : {}),
  };
  write(renderConnectEpilogue(result));
  return result;
}
