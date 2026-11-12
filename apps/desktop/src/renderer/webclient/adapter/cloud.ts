import type {
  CloudAgentLimits,
  CloudMachineActionArgs,
  CloudMachineActionResult,
  CloudMachinesResult,
  CloudStatus,
} from "../../../shared/adeCloud";
import type { CloudSignInStatus } from "../../../shared/cloudSignIns";
import type { AdapterInfra } from "./types";

/**
 * `window.ade.cloud` for the web app: enough for Settings › ADE Cloud (the
 * dashboard) and the machine lists to read the account and its computers.
 *
 * The browser never holds the cloud credential. Every ADE brain of the
 * account can read the account's ADE Cloud (the phone's cloud page uses the
 * same `cloud.read` / `cloud.write` commands), so the web asks the machine
 * this tab is connected to. Account level: no project pin.
 *
 * What only the desktop app can do stays out, so each caller's own guard
 * hides it: the life of a lane's computer (`laneLife`, `onLaneJob`), saving a
 * key or a Claude pass, plans and billing pages. Making a computer and the
 * machine actions that delete or resize refuse with a plain sentence. The
 * account's cloud sign-ins (saved keys, passes) are read, never written.
 */

const DESKTOP_ONLY = "Do this in the ADE desktop app. The web app reads ADE Cloud but can't change computers.";

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

export function createWebCloudNamespace(infra: Pick<AdapterInfra, "client" | "commands">): NonNullable<Window["ade"]["cloud"]> {
  const { client, commands } = infra;

  const access = async (): Promise<boolean> => {
    const answer = await commands.call<{ enabled: boolean }>("cloud.read", { action: "access" }, { fallback: { enabled: false }, retainLastRead: false });
    return answer?.enabled === true;
  };

  const listMachines = async (): Promise<CloudMachinesResult | null> => {
    if (!(await access())) return null;
    const answer = await commands.call<unknown>(
      "cloud.read",
      { action: "list", args: { detail: "full" } },
      { idempotent: false, authoritative: true },
    );
    return machinesResultOf(answer);
  };

  const getStatus = async (): Promise<CloudStatus | null> => {
    if (!(await access())) {
      return { connected: false, signedOut: false, instanceCount: null, runningCount: null, error: null };
    }
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

  /** Sleep and wake only: a delete or resize of a lane's computer needs the desktop app's lane steps. */
  const machineAction = async (args: CloudMachineActionArgs): Promise<CloudMachineActionResult | null> => {
    if (args.action !== "sleep" && args.action !== "wake") return { ok: false, message: DESKTOP_ONLY } as CloudMachineActionResult;
    return await commands.call<CloudMachineActionResult>(
      "cloud.write",
      { action: args.action, args: { machine: args.instanceId } },
      { idempotent: false },
    );
  };

  return {
    getStatus,
    listMachines,
    machineAction,
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
  };
}
