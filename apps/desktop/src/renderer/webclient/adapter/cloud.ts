import { cloudCatalogOf, isCloudInstanceId, isGravityUrl } from "../../../shared/adeCloud";
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
import { createWebCloudCopies } from "./cloudCopies";
import { createWebCloudMoves } from "./cloudMoves";
import { createWebCloudLaneLife, createWebCloudResizes, createWebTierRequestTeller } from "./cloudLaneLifeWeb";
import { projectPinOnMachine } from "../../lib/machineConnect";
import { savedChatProofResultOf, type CloudSavedChatList, type CloudSavedChatPage } from "../../../shared/cloudSavedChats";
import type { AdapterInfra } from "./types";
import { runAdeCloudAccountCall } from "../../../shared/adeCloud/accountCalls";
import type { CloudAgentLimitsState } from "../../../../../account-directory/src/cloud/contract";
import { forwardSignalToSentry } from "../../../shared/sentry/logBridge";
import { UnsupportedRemoteCommandError } from "./infra/commandCaller";
import type { AccountCloudLaunchesBridge } from "../../../shared/accountCloudLaunches";
import type { BrowserAccountClient } from "../account/client";
import type { CloudAccessIpcAnswer } from "../../../shared/adeCloudMachine";
import type { CloudKeptLaneRestorePreview, CloudKeptLaneRestoreRecord } from "../../../shared/cloudKeptLaneRestore";
import { isAccountAnsweredPin } from "../../../shared/adeCloud/binding";
import { markExpected } from "../../../shared/expectedError";
import type { OpenProjectBinding } from "../../../shared/types";

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
 * The life of a lane's computer goes through the account server too
 * (`laneLife`): the work check, push all work, delete lane, free it (the
 * server runs the free), and a size change in place (run in this tab,
 * `cloudLaneLifeWeb.ts`). A move to the other kind runs on the server, so
 * the web starts and follows it (`cloudMoves.ts`). So does a copy of a
 * computer (`cloudCopies.ts`).
 *
 * What only the desktop app can do stays out, so each caller's own guard
 * hides it: saving a key or a Claude pass. The account's cloud sign-ins
 * (saved keys, passes) are read, never written.
 */

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
  accountUserId: () => string | null,
): Promise<CloudAccessIpcAnswer> {
  const serverAnswer = await billing.accessAnswerCached().catch(() => null);
  const direct = serverAnswer?.enabled ?? null;
  // A failed server read is "unknown", never "blocked": the store keeps ADE Cloud shown.
  const fromServer = (): CloudAccessIpcAnswer => ({
    enabled: direct === true,
    state: direct === true ? "on" : direct === false ? "blocked" : "unknown",
    reason: direct === false ? serverAnswer?.reason ?? null : null,
    account: accountUserId(),
  });
  if (infra.client.getStatus().readiness !== "ready") return fromServer();
  // The computer's answer also carries its sign-in end warning; the server decides `enabled`.
  // A computer that drops mid-read leaves the server's answer standing.
  try {
    const answer = await infra.commands.call<CloudAccessIpcAnswer>("cloud.read", { action: "access" }, { fallback: { enabled: false }, retainLastRead: false });
    if (direct == null) {
      return { ...answer, enabled: answer?.enabled === true, state: answer?.enabled === true ? "on" : "unknown", reason: null, account: accountUserId() };
    }
    return { ...fromServer(), ...(answer?.signInEnd !== undefined ? { signInEnd: answer.signInEnd } : {}) };
  } catch {
    if (direct == null) {
      forwardSignalToSentry("web.cloud_access_read_failed", {}, "cloud_access_read_failed", "info");
    }
    return fromServer();
  }
}

/** `window.ade.cloudAccess` for the web app: the account server's yes or no, no computer needed. */
export function createWebCloudAccessNamespace(
  infra: Pick<AdapterInfra, "client" | "commands">,
  accountClient: CloudBillingAccountClient,
): NonNullable<Window["ade"]["cloudAccess"]> {
  const billing = createWebCloudBilling(accountClient);
  return {
    read: () => readCloudAccess(infra, billing, () => accountClient.getSnapshot().userId ?? null),
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
      wake: async (id, origin) => (await api.wake(id, origin)).status,
      resize: async (id, resources, computerIdle, origin) => (await api.resize(id, { ...resources, ...(computerIdle ? { computerIdle: true } : {}), ...(origin ? { origin } : {}) })).status,
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
      detail: error instanceof CloudApiError ? error.detail : null,
    });
  }
}

/** A kept lane's move names the computer it goes to: one of the person's own, never ADE Cloud. */
function keptLaneDestination(pin: OpenProjectBinding | null | undefined): void {
  if (!pin) throw markExpected(new Error("Pick the computer to move the lane to."), "user");
  if (isAccountAnsweredPin(pin)) throw markExpected(new Error("A kept lane moves to one of your own computers, not to ADE Cloud."), "user");
}

const keptLaneUnsupported = (): Error =>
  markExpected(new Error("ADE on that computer can't take a kept lane yet. Update ADE there, then try again."), "user");

export function createWebCloudNamespace(
  infra: Pick<AdapterInfra, "client" | "commands">,
  accountClient: CloudBillingAccountClient & Pick<BrowserAccountClient, "cloudApi">,
): NonNullable<Window["ade"]["cloud"]> {
  const { client, commands } = infra;
  const billing = createWebCloudBilling(accountClient);
  const cloudApi = () => accountClient.cloudApi();
  // One change at a time per computer: a size change in place (this tab's) or a move (ADE's server's).
  // A delete or free waits for it; the resizes and the moves each refuse a
  // second change or a Retry, by their own state and the other's.
  const changing = (instanceId: string): boolean => resizes.isLive(instanceId) || moves.moving(instanceId);
  const life = createWebCloudLaneLife({ api: cloudApi, changing });
  // How a change this tab ran ended, to the asking chat's machine: through
  // `window.ade`, whose federated adapter sends a pinned call to the pin's
  // machine, and reaches a machine of the account by its key (C2).
  const teller = createWebTierRequestTeller({
    answer: async (pin, args) => {
      const answer = window.ade?.cloud?.answerTierRequest;
      if (!answer) throw new Error("This window can't tell the chat.");
      return await answer(pin, args);
    },
    machineKeyOf: async (targetId) => {
      const snapshot = await window.ade.remoteRuntime.getConnectionSnapshot().catch(() => null);
      return snapshot?.connections.find((entry) => entry.target.id === targetId)?.target.pairedMachine?.machineKey ?? null;
    },
    pinOnMachine: async (machineKey, ref) => {
      const { pin } = await projectPinOnMachine(machineKey, ref);
      if (!pin) throw new Error("ADE couldn't reach the chat's computer from this window.");
      return pin;
    },
  });
  const resizes = createWebCloudResizes({
    api: cloudApi,
    agentWork: (instanceId) => life.agentWork(instanceId),
    moving: (instanceId) => moves.moving(instanceId),
    teller,
  });
  const copies = createWebCloudCopies(cloudApi);
  const moves = createWebCloudMoves(cloudApi, { resizeInPlace: (args) => resizes.start(args), resizing: (instanceId) => resizes.isLive(instanceId), teller });
  /** A computer of the account answers on this connection. */
  const computerOnline = () => client.getStatus().readiness === "ready";

  const access = async (): Promise<boolean> => (await readCloudAccess(infra, billing, () => accountClient.getSnapshot().userId ?? null)).enabled;

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

  /**
   * Sponsored cards follow where this browser is (its country, its Global
   * Privacy Control), so the page reads them itself: a computer's answer
   * says where that computer is, and would tell a person cards are on (or
   * ask) by the wrong country. A failed read shows none.
   */
  const withOwnSponsored = async (result: CloudMachinesResult): Promise<CloudMachinesResult> => {
    if (!result.account?.sponsored) return result;
    const own = await billing.readAccount().catch(() => null);
    return { ...result, account: { ...result.account, sponsored: own?.sponsored } };
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
    const fromComputer = machinesResultOf(answer);
    return fromComputer ? await withOwnSponsored(fromComputer) : await accountOnly();
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
   * sleep and wake still go through a connected computer. A delete is the
   * desktop's too: no work check here (a lane's delete checks first, `laneLife`).
   */
  const machineAction = async (args: CloudMachineActionArgs): Promise<CloudMachineActionResult | null> => {
    const api = accountClient.cloudApi();
    if (args.action === "delete") {
      const instanceId = typeof args?.instanceId === "string" ? args.instanceId.trim() : "";
      if (!api) return { ok: false, blocker: null, message: "Sign in to your ADE account here to change this computer." };
      if (!isCloudInstanceId(instanceId)) return { ok: false, blocker: null, message: "ADE doesn't know that computer." };
      return await life.deleteComputer(instanceId);
    }
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
    // A lane computer's status menu: the account server reads it (never a wake), no computer of the person's needed.
    computerStatus: async (instanceId: string) => {
      const api = accountClient.cloudApi();
      if (!api || !isCloudInstanceId(instanceId)) return null;
      try {
        return await api.computerStatus(instanceId);
      } catch (error) {
        forwardSignalToSentry("web.cloud_computer_status_failed", { code: error instanceof CloudApiError ? error.code : null }, "cloud_computer_status_failed", "info");
        return null;
      }
    },
    // The account server runs the code on that computer; no machine connection needed.
    sendLaunchSignInCode: async ({ instanceId, jobId, code }) => {
      const api = accountClient.cloudApi();
      if (!api) throw new Error("Account sign-in isn't configured for this web client.");
      return await api.sendSignInCode(instanceId, jobId, code);
    },
    // A lane's computer, all through the account server (no computer of the person's needed).
    laneLife: (async ({ method, args }: { method: string; args?: unknown }) => {
      const api = accountClient.cloudApi();
      if (!api) throw new Error("Sign in to ADE to see your ADE Cloud lanes.");
      const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
      const instanceId = typeof record.instanceId === "string" ? record.instanceId.trim() : "";
      const jobId = typeof record.jobId === "string" ? record.jobId : "";
      const needInstance = () => {
        if (!isCloudInstanceId(instanceId)) throw new Error("ADE doesn't know that computer.");
        return instanceId;
      };
      switch (method) {
        case "workState":
          return await life.workState(needInstance());
        case "deleteLane":
          return await life.deleteLane({ instanceId: needInstance(), skipCheck: record.skipCheck === true, keepChats: record.keepChats === true });
        case "freeLane":
          return await life.freeLane({ instanceId: needInstance() });
        case "lanesWithoutComputer":
          return await api.lanesWithoutComputer();
        case "forgetLaneWithoutComputer": {
          const laneId = args && typeof args === "object" ? (args as { laneId?: unknown }).laneId : null;
          if (typeof laneId !== "string" || !laneId.trim()) throw new Error("ADE doesn't know that lane.");
          return { forgotten: (await api.forgetLaneWithoutComputer(laneId.trim())).forgotten === true };
        }
        // A move to the other kind runs on ADE's server (`cloudMoves.ts`); one of the same kind runs here.
        case "changeTier":
          return await moves.changeTier(args);
        case "listJobs":
          return [...resizes.list(), ...await moves.listJobs()];
        case "cancelJob":
          return resizes.has(jobId) ? resizes.cancel(jobId) : await moves.cancelJob(args);
        case "retryJob":
          return resizes.has(jobId) ? resizes.retry(jobId) : await moves.retryJob(args);
        case "dismissJob":
          return resizes.has(jobId) ? resizes.dismiss(jobId) : await moves.dismissJob(args);
        default:
          // The same sentence as `CLOUD_LANE_LIFE_UNAVAILABLE` (cloudLaneActions.ts).
          throw new Error("Do this in the ADE desktop app. This window can't change ADE Cloud lanes.");
      }
    }) as NonNullable<Window["ade"]["cloud"]>["laneLife"],
    // A server move's progress, read while one runs, and a resize's from this tab.
    onLaneJob: (cb) => {
      const offMoves = moves.onLaneJob(cb);
      const offResizes = resizes.onLaneJob(cb);
      return () => {
        offMoves();
        offResizes();
      };
    },
    // Every lane's work on the computer, pushed (`ade cloud push-work`); it wakes a resting computer.
    pushAllWork: async (instanceId: string) => {
      const id = typeof instanceId === "string" ? instanceId.trim() : "";
      if (!isCloudInstanceId(id)) return { ok: false, blocker: null, message: "ADE doesn't know that computer." };
      if (!accountClient.cloudApi()) return { ok: false, blocker: null, message: "Sign in to your ADE account here to change this computer." };
      return await life.pushAllWork(id);
    },
    // A lane's saved work at rest (`laneBackups.ts`): the list and its patch only; the bundle stays native.
    laneBackups: async (laneId?: string | null) => (await accountClient.cloudApi()?.laneBackups(laneId ?? null)) ?? [],
    saveLaneBackupPatch: async (machineKey: string, laneId: string) => {
      const api = accountClient.cloudApi();
      if (!api) throw new Error("Sign in to ADE to download your lane's work.");
      const backup = await api.laneBackup(machineKey, laneId);
      if (!backup || !backup.patchParts) throw new Error("ADE Cloud has no saved work for that lane to download.");
      const parts: ArrayBuffer[] = [];
      for (let part = 1; part <= backup.patchParts; part += 1) parts.push(await api.readLaneBackupPart(machineKey, laneId, "patch", part));
      const blob = new Blob(parts, { type: "text/x-patch" });
      if (blob.size !== backup.patchBytes) throw new Error("This lane's saved work arrived damaged. Try again.");
      const name = `${(backup.laneName ?? backup.branchRef ?? "lane").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60)}-saved-work.patch`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return { savedTo: name };
    },
    forgetLaneBackup: async (machineKey: string, laneId: string) => {
      const api = accountClient.cloudApi();
      if (!api) throw new Error("Sign in to ADE to delete your lane's work.");
      return await api.forgetLaneBackup(machineKey, laneId);
    },
    // The person's answer to an agent's size request, on the chat's own machine: the
    // federated adapter sends the pinned call to the pin's machine, so it runs here.
    // An account-answered pin (a saved chat read from the account) has no machine to tell.
    answerTierRequest: async (pin, args) => {
      if (isAccountAnsweredPin(pin)) throw markExpected(new Error("This chat's computer isn't connected, so ADE can't tell its agent. Open the chat once its computer is awake."), "environment");
      if (!commands.hasAction("cloud.write")) throw markExpected(new Error("ADE on that computer can't take this answer yet. Update ADE there, then try again."), "user");
      return await commands.call<{ answered: boolean; toldAgent: boolean }>("cloud.write", { action: "tier_request_answer", args }, { idempotent: false });
    },
    // A kept lane moved to one of the person's computers, run by that computer's brain in the
    // pinned project. The federated adapter sends a pinned call to the pin's machine (connecting
    // it first), so each runs on this adapter's machine; with no pin there is no destination.
    previewKeptLaneRestore: async (args, pin) => {
      keptLaneDestination(pin);
      return await commands.call<CloudKeptLaneRestorePreview>("cloud.previewKeptLaneRestore", { laneId: args.laneId, ...(args.fromComputer ? { fromComputer: args.fromComputer } : {}) }, {
        fallback: () => { throw keptLaneUnsupported(); },
        authoritative: true,
        requireProject: true,
        retainLastRead: false,
      });
    },
    restoreKeptLane: async (args, pin) => {
      keptLaneDestination(pin);
      if (!commands.hasAction("cloud.restoreKeptLane")) throw keptLaneUnsupported();
      return await commands.call<CloudKeptLaneRestoreRecord>("cloud.restoreKeptLane", { laneId: args.laneId, ...(args.fromComputer ? { fromComputer: args.fromComputer } : {}) }, { idempotent: false });
    },
    getKeptLaneRestore: async (args, pin) => {
      keptLaneDestination(pin);
      return await commands.call<CloudKeptLaneRestoreRecord | null>("cloud.getKeptLaneRestore", { restoreId: args.restoreId }, {
        fallback: null,
        authoritative: true,
        requireProject: true,
        retainLastRead: false,
      });
    },
    carriedSignIns: async () => {
      const answer = await accountClient.cloudApi()?.accountSignIns().catch(() => null);
      return answer?.carried ?? null;
    },
    savedChats: {
      // No computer to ask (ADE Web with none connected): the account server
      // answers the list itself.
      list: async (args) => await savedChatRead<CloudSavedChatList>("saved_chats_list", { ...args })
        ?? await accountClient.cloudApi()?.savedChats(args).catch(() => null)
        ?? null,
      read: async (args) => await savedChatRead<CloudSavedChatPage>("saved_chats_read", { ...args })
        ?? await accountClient.cloudApi()?.savedChat(args).catch(() => null)
        ?? null,
      delete: async ({ machineKey, chatId }) => {
        const api = accountClient.cloudApi();
        if (!api) throw new Error("Sign in to ADE to delete a saved chat.");
        await api.deleteSavedChat(machineKey, chatId);
      },
      // Straight from the account with the person's token: a picture is no read for a connected machine to relay.
      readProof: async ({ machineKey, chatId, artifactId }) => {
        const proof = await accountClient.cloudApi()?.savedChatProof(machineKey, chatId, artifactId).catch(() => null);
        return proof ? savedChatProofResultOf(proof) : null;
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
    // A connected computer answers for the account. With none, the account
    // server does (`GET/PUT /cloud/limits`). The Settings card sends
    // `ifRevision` itself (`CloudAgentLimitsCard`); this path is last-writer-wins.
    getAgentLimits: async () => {
      if (commands.hasAction("cloud.read")) {
        return await commands.call<CloudAgentLimits | null>("cloud.read", { action: "limits" }, { fallback: null, retainLastRead: false });
      }
      const answer = await runAdeCloudAccountCall(accountClient.cloudApi(), { call: "limits" });
      if (!answer.ok) throw new Error(answer.message);
      return (answer.result as CloudAgentLimitsState | null)?.limits ?? null;
    },
    setAgentLimits: async (limits) => {
      if (commands.hasAction("cloud.write")) {
        return await commands.call<CloudAgentLimits | null>("cloud.write", { action: "set_limits", args: limits }, { idempotent: false });
      }
      const { fallback: _fallback, ...value } = limits;
      const answer = await runAdeCloudAccountCall(accountClient.cloudApi(), { call: "saveLimits", update: { limits: value } });
      if (!answer.ok) throw new Error(answer.message);
      return (answer.result as CloudAgentLimitsState | null)?.limits ?? null;
    },
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
    // A copy runs on ADE's server (`cloudCopies.ts`) and reports as the desktop's does.
    copyMachine: copies.copyMachine,
    onCreateProgress: copies.onCreateProgress,
    cancelCreate: copies.cancelCreate,
    // The plan and Stripe's pages, from this browser (`cloudBilling.ts`). The page reads the account again after each.
    openCheckout: (plan, cleanup) => billing.openCheckout(plan, cleanup),
    openBillingPortal: () => billing.openBillingPortal(),
    openFreeUnlock: () => billing.openFreeUnlock(),
    setExtraHours: (enabled) => billing.setExtraHours(enabled),
    // Sponsored cards: straight from this browser to the account server, which
    // reads the browser's own address and user agent. Account level, no pin.
    setSponsoredConsent: async (consent, confirmed) => (await accountClient.cloudApi()?.setSponsoredConsent(consent, confirmed === true)) ?? null,
    sponsoredSeen: async (input) => {
      await accountClient.cloudApi()?.sponsoredSeen(input).catch(() => undefined);
    },
    sponsoredHide: async (input) => {
      await accountClient.cloudApi()?.sponsoredHide(input).catch(() => undefined);
    },
    sponsoredAd: async (input) => {
      const api = accountClient.cloudApi();
      if (!api) return { ad: null, reason: "unavailable" };
      // This browser is the web surface: its own Gravity placements.
      return api.sponsoredAd({ ...input, surface: "web" }).catch(() => ({ ad: null, reason: "unavailable" as const }));
    },
    // This page may reach Gravity itself (`_headers`: `connect-src https:`).
    sponsoredViewed: async (impUrl) => {
      if (!isGravityUrl(impUrl)) return false;
      // An opaque answer is all a page gets; only a network failure is worth sending again.
      return fetch(impUrl, { mode: "no-cors", credentials: "omit", keepalive: true }).then(() => true, () => false);
    },
    setPhoneProvider: (provider) => billing.setPhoneProvider(provider),
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
    uploadFile: (launchId, fileId, bytes, contentType) => api().uploadLaunchFile(launchId, fileId, bytes, contentType),
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
