import { CLOUD_WAKE_WAIT_MS } from "../../../shared/adeCloud";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { remoteProjectBindingKey } from "../../../shared/projectIdentity";
import type { OpenProjectBinding } from "../../../shared/types/core";
import type { RemoteRuntimeConnectionStatus, RemoteRuntimeProjectRecord } from "../../../shared/types/remoteRuntime";
import { ipcErrorMessage } from "../../lib/format";
import type { AdeCloudLaneComputer } from "../../state/adeCloudLaneIndex";
import { connectWithRetry } from "./connectWithRetry";
import { connectMachine } from "../../lib/machineConnect";

type RemoteBinding = OpenProjectBinding & { kind: "remote" };

const CONNECT_RETRY_MS = 2_000;

function bindingFor(
  target: { id: string; name: string; hostname?: string | null },
  project: RemoteRuntimeProjectRecord,
): RemoteBinding {
  return {
    kind: "remote",
    key: remoteProjectBindingKey(target.id, project.projectId),
    targetId: target.id,
    runtimeName: target.name,
    transport: "paired",
    ...(target.hostname ? { hostname: target.hostname } : {}),
    projectId: project.projectId,
    rootPath: project.rootPath,
    displayName: project.displayName,
    gitOriginUrl: project.gitOriginUrl,
  };
}

function projectByOrigin(
  projects: readonly RemoteRuntimeProjectRecord[] | null | undefined,
  origin: string | null,
): RemoteRuntimeProjectRecord | null {
  if (!origin) return null;
  return (projects ?? []).find((project) => project.exists !== false && normalizeGitRemoteIdentity(project.gitOriginUrl) === origin) ?? null;
}

/**
 * The project binding of an ADE Cloud lane's computer, so a send to that lane
 * goes to that computer (every call of the chat keeps this pin).
 *
 * In order, cheapest first:
 * 1. A paired computer whose connection lists the project: its binding. The
 *    send wakes an asleep computer by itself (a person's write wakes it).
 * 2. A paired computer the Work list already holds a binding for.
 * 3. Else ADE pairs this computer with it if needed, connects (which wakes
 *    it), and finds the project there. `onWaking` fires first so the person
 *    sees why the send waits.
 */
export async function resolveAdeCloudLaneBinding(args: {
  lane: AdeCloudLaneComputer;
  originUrl: string | null;
  connections: readonly RemoteRuntimeConnectionStatus[];
  /** A binding the Work list holds for this remote target, if any. */
  knownBindingFor: (targetId: string) => OpenProjectBinding | null;
  stillWanted: () => boolean;
  onWaking: () => void;
}): Promise<RemoteBinding> {
  const { lane } = args;
  const origin = normalizeGitRemoteIdentity(args.originUrl);
  const connection = args.connections.find((candidate) => lane.machineKey && candidate.target.pairedMachine?.machineKey === lane.machineKey)
    ?? args.connections.find((candidate) => candidate.target.hostname?.trim().toLowerCase() === lane.instanceId.toLowerCase())
    ?? null;
  if (connection) {
    const project = projectByOrigin(connection.projects, origin);
    if (project) return bindingFor(connection.target, project);
    const known = args.knownBindingFor(connection.target.id);
    if (known?.kind === "remote" && known.targetId === connection.target.id) return known;
  }

  let target: { id: string; name: string; hostname?: string | null } | null = connection?.target ?? null;
  if (!target) {
    if (!lane.machineKey) throw new Error(`ADE can't reach the computer of ${lane.laneName} yet. Try again in a minute.`);
    // Never connected from here: contract C2 wakes a sleeping computer, pairs
    // this one with it through the account, and connects.
    args.onWaking();
    const address = await connectMachine(lane.machineKey);
    if (address.kind !== "remote") throw new Error(`The computer of ${lane.laneName} is this computer.`);
    target = { id: address.targetId, name: address.name || lane.laneName, hostname: lane.instanceId };
  } else {
    args.onWaking();
  }
  if (!args.stillWanted()) throw new Error("Send cancelled.");
  const targetId = target.id;
  const { value: connected, lastError } = await connectWithRetry({
    connect: () => window.ade.remoteRuntime.connect(targetId),
    stillWanted: args.stillWanted,
    waitMs: CLOUD_WAKE_WAIT_MS,
    retryMs: CONNECT_RETRY_MS,
  });
  if (!connected) {
    const reason = lastError ? ipcErrorMessage(lastError) : "";
    throw new Error(`ADE couldn't wake ${lane.laneName}${reason ? `: ${reason}` : "."}`);
  }
  const project = projectByOrigin(await window.ade.remoteRuntime.listProjects(targetId), origin);
  if (!project) throw new Error(`The computer of ${lane.laneName} doesn't have this project.`);
  return bindingFor(connected.target ?? target, project);
}
