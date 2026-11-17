import { cloudCatalogOf, isCloudInstanceId } from "../../../shared/adeCloud";
import { cloudMachineOfInstance } from "../../../shared/cloudMachineOfInstance";
import { cloudMachineRefusal, runCloudMachineLifecycleAction } from "../../../shared/cloudMachineActions";
import { CloudApiError, type CloudApiClient } from "../../../shared/cloudApiClient";
import type {
  CloudAgentLimits,
  CloudMachineActionArgs,
  CloudMachineActionResult,
  CloudMachinesResult,
  CloudStatus,
} from "../../../shared/adeCloud";
import type { CloudSignInStatus } from "../../../shared/cloudSignIns";
import { createWebCloudBilling, type CloudBillingAccountClient } from "./cloudBilling";
import type { CloudSavedChatList, CloudSavedChatPage } from "../../../shared/cloudSavedChats";
import type { AdapterInfra } from "./types";
import { forwardSignalToSentry } from "../../../shared/sentry/logBridge";
import { UnsupportedRemoteCommandError } from "./infra/commandCaller";
import type { AccountCloudLaunchesBridge } from "../../../shared/accountCloudLaunches";
import type { BrowserAccountClient } from "../account/client";

/**
 * `window.ade.cloud` for the web app: enough for Settings › ADE Cloud (the
 * dashboard) and the machine lists to read the account and its computers,
 * and to pick and pay for a plan.
 *
 * The browser never holds the cloud provider's key. Every ADE brain of the
 * account can read the account's ADE Cloud (the phone's cloud page uses the
 * same `cloud.read` / `cloud.write` commands), so the web asks a connected
 * machine for the computers. Account level: no project pin.
 *
 * ADE Cloud is the account's, so it never waits for a computer: whether it is
 * on comes from the account server itself (`GET /cloud/access`), and with
 * none of the account's computers online the plan, hours and disk do too
 * (`GET /cloud/account`), with the computers left unread (`computersUnread`).
 *
 * The plan and billing calls (checkout, the billing portal, the free plan's
 * card, extra hours and disk, a plan's cleanup pick) go to the account
 * server itself with this browser's own account token, as the desktop's main
 * process sends its own (`cloudBilling.ts`): no computer has to be connected.
 *
 * A computer's sleep, wake, resize, backup and update go to the account
 * server too (`/cloud/instances/:id/...`), as the desktop's main process
 * sends them (`cloudMachines.ts`), so they need no computer of the person's.
 * A chat on a new computer starts there as well (`POST /cloud/launches`,
 * `accountCloudLaunches.ts`).
 *
 * What only the desktop app can do stays out, so each caller's own guard
 * hides it: the life of a lane's computer (`laneLife`, `onLaneJob`), saving a
 * key or a Claude pass. A delete refuses with a plain sentence: the desktop
 * first checks the lane's work for changes not on GitHub. The account's cloud
 * sign-ins (saved keys, passes) are read, never written.
 */

const DELETE_ON_DESKTOP = "Delete computers in the ADE desktop app. It first checks each lane for work that isn't on GitHub yet.";

function isMachinesResult(value: unknown): value is CloudMachinesResult {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CloudMachinesResult>;
  return typeof record.state === "string" && Array.isArray(record.machines);
}

/**
 * The brain's answer to `cloud.list` with `detail: "full"`: the account's
 * own read. An older brain ignores `detail` and sends its summary list,
 * whose rows are not full computers: then only the account shows.
 */
function machinesResultOf(value: unknown): CloudMachinesResult | null {
  if (isMachinesResult(value)) return value;
  if (!value || typeof value !== "object") return null;
  const legacy = value as { machines?: unknown[]; runningCount?: unknown; account?: unknown };
  if (!Array.isArray(legacy.machines)) return null;
  return {
    state: "ok",
    machines: [],
    instanceCount: legacy.machines.length,
    runningCount: typeof legacy.runningCount === "number" ? legacy.runningCount : null,
    account: (legacy.account ?? null) as CloudMachinesResult["account"],
    message: null,
  };
}

/**
 * Whether ADE Cloud lets the account in: the account server's answer, or,
 * when the server can't be reached, the connected computer's.
 */
async function readCloudAccess(
  infra: Pick<AdapterInfra, "client" | "commands">,
  billing: ReturnType<typeof createWebCloudBilling>,
): Promise<{ enabled: boolean }> {
  const direct = await billing.accessEnabledCached().catch(() => null);
  if (infra.client.getStatus().readiness !== "ready") return { enabled: direct === true };
  // The computer's answer also carries its sign-in end warning; the server decides `enabled`.
  // A computer that drops mid-read leaves the server's answer standing.
  try {
    const answer = await infra.commands.call<{ enabled: boolean }>("cloud.read", { action: "access" }, { fallback: { enabled: false }, retainLastRead: false });
    return { ...answer, enabled: direct ?? answer?.enabled === true };
  } catch (error) {
    // Nothing learned from either side: let the page say it couldn't check.
    if (direct == null) throw error;
    forwardSignalToSentry("web.cloud_access_read_failed", {}, "cloud_access_read_failed", "info");
    return { enabled: direct };
  }
}

/** `window.ade.cloudAccess` for the web app: the account server's yes or no, no computer needed. */
export function createWebCloudAccessNamespace(
  infra: Pick<AdapterInfra, "client" | "commands">,
  accountClient: CloudBillingAccountClient,
): NonNullable<Window["ade"]["cloudAccess"]> {
  const billing = createWebCloudBilling(accountClient);
  return {
    read: () => readCloudAccess(infra, billing),
    // Read again when this tab's connection changes: a computer that comes online adds its sign-in warning.
    onChanged: (cb) => {
      let readiness = infra.client.getStatus().readiness;
      return infra.client.subscribe((status) => {
        if (status.readiness === readiness) return;
        readiness = status.readiness;
        cb();
      });
    },
  };
}

/** Sleep, wake, resize, backup and update through the account server, with the desktop's sentences. */
async function webMachineAction(api: CloudApiClient, args: CloudMachineActionArgs): Promise<CloudMachineActionResult> {
  const instanceId = typeof args?.instanceId === "string" ? args.instanceId.trim() : "";
  if (!isCloudInstanceId(instanceId)) return { ok: false, blocker: null, message: "ADE doesn't know that computer." };
  try {
    const result = await runCloudMachineLifecycleAction({
      computer: (id) => api.computer(id),
      sleep: (id) => api.sleep(id),
      wake: async (id) => (await api.wake(id)).status,
      resize: async (id, resources, computerIdle) => (await api.resize(id, { ...resources, ...(computerIdle ? { computerIdle: true } : {}) })).status,
      backup: (id) => api.backup(id),
      update: (id) => api.update(id),
    }, instanceId, args);
    return result ?? { ok: false, blocker: null, message: "ADE can't do that to a computer." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A refusal (plans, hours, the backup window) is an answer, not a failure.
    if (!(error instanceof CloudApiError)) {
      forwardSignalToSentry("web.cloud_machine_action_failed", { action: args.action, message }, `cloud_machine_action_failed:${args.action}`);
    }
    return cloudMachineRefusal(args.action, {
      message,
      code: error instanceof CloudApiError ? error.code : null,
      reason: error instanceof CloudApiError ? error.reason : null,
    });
  }
}

export function createWebCloudNamespace(
  infra: Pick<AdapterInfra, "client" | "commands">,
  accountClient: CloudBillingAccountClient & Pick<BrowserAccountClient, "cloudApi">,
): NonNullable<Window["ade"]["cloud"]> {
  const { client, commands } = infra;
  const billing = createWebCloudBilling(accountClient);
  /** A computer of the account answers on this connection. */
  const computerOnline = () => client.getStatus().readiness === "ready";

  const access = async (): Promise<boolean> => (await readCloudAccess(infra, billing)).enabled;

  /**
   * No computer online: the plan, hours and the account's ADE Cloud computers
   * straight from the account server (`GET /cloud/instances`), so a person
   * with no computer of their own still sees their cloud lanes. A failed list
   * leaves the computers unread and the plan standing.
   */
  const accountOnly = async (): Promise<CloudMachinesResult> => {
    const account = await billing.readAccount();
    const api = accountClient.cloudApi();
    const instances = api
      ? await api.listComputers().catch((error: unknown) => {
        // The page still shows the plan and hours; the computers come on the next read.
        forwardSignalToSentry("web.cloud_computers_read_failed", { code: error instanceof CloudApiError ? error.code : null }, "cloud_computers_read_failed", "info");
        return null;
      })
      : null;
    const catalog = cloudCatalogOf(account);
    const machines = instances
      ? instances.filter((instance) => instance.status !== "deleted").map((instance) => cloudMachineOfInstance(instance, catalog))
      : [];
    return {
      state: "ok",
      machines,
      instanceCount: account.computers?.total ?? (instances ? machines.length : null),
      runningCount: account.computers?.awake ?? null,
      account,
      message: null,
      ...(instances ? {} : { computersUnread: true }),
    };
  };

  const listMachines = async (): Promise<CloudMachinesResult | null> => {
    if (!(await access())) return null;
    if (!computerOnline()) return await accountOnly();
    let answer: unknown;
    try {
      answer = await commands.call<unknown>(
        "cloud.read",
        { action: "list", args: { detail: "full" } },
        { idempotent: false, authoritative: true },
      );
    } catch (error) {
      // A brain too old to have the command leaves the plan and hours to the server.
      if (error instanceof UnsupportedRemoteCommandError) return await accountOnly();
      throw error;
    }
    // A brain too old to answer still leaves the plan and hours to the server.
    return machinesResultOf(answer) ?? await accountOnly();
  };

  const getStatus = async (): Promise<CloudStatus | null> => {
    if (!(await access())) {
      return { connected: false, signedOut: false, instanceCount: null, runningCount: null, error: null };
    }
    // The page reads the account itself (`listMachines`); with no computer there is nothing more to count.
    if (!computerOnline()) return { connected: true, signedOut: false, instanceCount: null, runningCount: null, error: null };
    try {
      const result = await listMachines();
      if (!result) return { connected: false, signedOut: false, instanceCount: null, runningCount: null, error: null };
      return {
        connected: true,
        signedOut: false,
        instanceCount: result.instanceCount ?? result.machines.length,
        runningCount: result.runningCount ?? null,
        error: result.state === "ok" ? null : result.message ?? "ADE couldn't reach ADE Cloud.",
      };
    } catch (error) {
      return { connected: true, signedOut: false, instanceCount: null, runningCount: null, error: error instanceof Error ? error.message : String(error) };
    }
  };

  /**
   * Through the account server with this browser's account token, with the
   * desktop's sentences (`cloudMachines.ts`). Without account sign-in here,
   * sleep and wake still go through a connected computer. A delete stays in
   * the desktop app (see `DELETE_ON_DESKTOP`).
   */
  const machineAction = async (args: CloudMachineActionArgs): Promise<CloudMachineActionResult | null> => {
    if (args.action === "delete") return { ok: false, blocker: null, message: DELETE_ON_DESKTOP };
    const api = accountClient.cloudApi();
    if (!api) {
      if (args.action !== "sleep" && args.action !== "wake") {
        return { ok: false, blocker: null, message: "Sign in to your ADE account here to change this computer." };
      }
      return await commands.call<CloudMachineActionResult>(
        "cloud.write",
        { action: args.action, args: { machine: args.instanceId } },
        { idempotent: false },
      );
    }
    return await webMachineAction(api, args);
  };

  /**
   * An asleep ADE Cloud computer's saved chats, read by the connected brain
   * for the account (`cloud.read saved_chats_*`). Null is "couldn't ask" (no
   * ADE Cloud, an older brain): the Work list keeps what it shows.
   */
  const savedChatRead = async <T>(action: "saved_chats_list" | "saved_chats_read", args: Record<string, unknown>): Promise<T | null> => {
    if (!(await access())) return null;
    try {
      return await commands.call<T | null>("cloud.read", { action, args }, { fallback: null, retainLastRead: false });
    } catch (error) {
      // An older brain does not serve these reads ("cloud has no … here"):
      // expected, and the list stays as it is. Anything else is worth counting.
      const message = error instanceof Error ? error.message : String(error);
      if (!/^cloud has no "/.test(message)) {
        forwardSignalToSentry("web.cloud_saved_chats_read_failed", { action }, `cloud_saved_chats_read_failed:${action}`, "info");
      }
      return null;
    }
  };

  return {
    getStatus,
    listMachines,
    machineAction,
    // The account server runs the code on that computer; no machine connection needed.
    sendLaunchSignInCode: async ({ instanceId, jobId, code }) => {
      const api = accountClient.cloudApi();
      if (!api) throw new Error("Account sign-in isn't configured for this web client.");
      return await api.sendSignInCode(instanceId, jobId, code);
    },
    savedChats: {
      // No computer to ask (ADE Web with none connected): the account server
      // answers the list itself.
      list: async (args) => await savedChatRead<CloudSavedChatList>("saved_chats_list", { ...args })
        ?? await accountClient.cloudApi()?.savedChats(args).catch(() => null)
        ?? null,
      read: async (args) => await savedChatRead<CloudSavedChatPage>("saved_chats_read", { ...args }),
      delete: async () => {
        throw new Error("Delete a saved chat in the ADE desktop app.");
      },
    },
    // The connected machine answers for the account: read again when this tab's connection changes.
    onStatusChanged: (cb) => {
      let readiness = client.getStatus().readiness;
      return client.subscribe((status) => {
        if (status.readiness === readiness) return;
        readiness = status.readiness;
        cb();
      });
    },
    getAgentLimits: async () => await commands.call<CloudAgentLimits | null>("cloud.read", { action: "limits" }, { fallback: null, retainLastRead: false }),
    setAgentLimits: async (limits) => await commands.call<CloudAgentLimits | null>("cloud.write", { action: "set_limits", args: limits }, { idempotent: false }),
    // The saved ADE Cloud keys and Claude passes, as names and states only (no key). An older brain has no
    // such read: then the sign-ins card shows the account's sign-ins without them.
    cloudSignInStatus: async () => {
      if (!(await access())) return null;
      try {
        return await commands.call<CloudSignInStatus | null>("cloud.read", { action: "cloud_sign_in_status" }, { fallback: null, retainLastRead: false });
      } catch {
        return null;
      }
    },
    // No push from the host: the page reads it again on open and after its own writes.
    onCloudSignInChanged: () => () => undefined,
    onCreateProgress: () => () => undefined,
    cancelCreate: async () => ({ cancelled: false }),
    // The plan and Stripe's pages, from this browser (`cloudBilling.ts`). The page reads the account again after each.
    openCheckout: (plan, cleanup) => billing.openCheckout(plan, cleanup),
    openBillingPortal: () => billing.openBillingPortal(),
    openFreeUnlock: () => billing.openFreeUnlock(),
    setExtraHours: (enabled) => billing.setExtraHours(enabled),
    setExtraDisk: (choice) => billing.setExtraDisk(choice),
    pickPlanCleanup: (input) => billing.pickPlanCleanup(input),
  };
}

/**
 * `window.ade.cloudLaunches` for the web app: a chat on ADE Cloud started
 * straight from the account server (`POST /cloud/launches`), with no
 * computer of the person's own. The first message is stored with the launch,
 * so the tab may close. Account-level: no pin, and never the tab's machine.
 */
export function createWebCloudLaunchesNamespace(
  accountClient: Pick<BrowserAccountClient, "cloudApi">,
): AccountCloudLaunchesBridge {
  const api = () => {
    const client = accountClient.cloudApi();
    if (!client) throw new Error("Account sign-in isn't configured for this web client.");
    return client;
  };
  return {
    start: (launch) => api().startLaunch(launch),
    status: (launchId) => api().launchStatus(launchId),
    active: () => api().activeLaunches(),
    cancel: (launchId) => api().cancelLaunch(launchId),
    messages: (launchId) => api().launchMessages(launchId),
    addMessage: (launchId, message) => api().addLaunchMessage(launchId, message),
    signIns: () => api().accountSignIns(),
    saveSignIn: (signInId, key) => api().saveAccountSignIn(signInId, key),
    removeSignIn: (signInId) => api().removeAccountSignIn(signInId),
    models: () => api().modelCatalog(),
  };
}
