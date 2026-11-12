/**
 * Contract C2 for renderer code: connect to any machine of the account by its
 * machine key, and build the pin for one of its projects.
 *
 * The address names one machine; pass it (or the pin) with every call to that
 * machine. Nothing here reads or changes the tab's machine.
 */

import { normalizeGitRemoteIdentity } from "../../shared/crossMachineHandoff";
import { findMachineProject } from "../../shared/projectIdentity";
import {
  MachineConnectError,
  projectPinOn,
  type MachineAddress,
  type MachineConnectOptions,
} from "../../shared/machineAddress";
import type { OpenProjectBinding } from "../../shared/types/core";
import type { RemoteRuntimeProjectRecord } from "../../shared/types/remoteRuntime";

export { MachineConnectError, projectPinOn, type MachineAddress } from "../../shared/machineAddress";

/** The address of the machine; throws a `MachineConnectError` with the plain sentence when it can't. */
export async function connectMachine(machineKey: string, options?: MachineConnectOptions): Promise<MachineAddress> {
  const result = await window.ade.machines.connect(machineKey, options);
  if (!result.ok) throw new MachineConnectError(result);
  return result.address;
}

/** Which project on the machine: by id, then folder, then the repository's origin. */
export type MachineProjectRef = {
  projectId?: string | null;
  rootPath?: string | null;
  originUrl?: string | null;
};

function pickProject(projects: readonly RemoteRuntimeProjectRecord[], ref: MachineProjectRef): RemoteRuntimeProjectRecord | null {
  const present = projects.filter((project) => project.exists !== false);
  const byId = findMachineProject(present, { projectId: ref.projectId ?? null, rootPath: ref.rootPath ?? null });
  if (byId) return byId;
  const origin = normalizeGitRemoteIdentity(ref.originUrl ?? null);
  if (!origin) return null;
  return present.find((project) => normalizeGitRemoteIdentity(project.gitOriginUrl) === origin) ?? null;
}

/**
 * The pin for one project on the machine `machineKey`, connecting first.
 * Null for this computer (its calls go unpinned). Throws when the machine
 * can't be reached or doesn't have the project.
 */
export async function projectPinOnMachine(
  machineKey: string,
  ref: MachineProjectRef,
): Promise<{ address: MachineAddress; pin: (OpenProjectBinding & { kind: "remote" }) | null }> {
  const address = await connectMachine(machineKey);
  if (address.kind === "this") return { address, pin: null };
  const project = pickProject(await window.ade.remoteRuntime.listProjects(address.targetId), ref);
  if (!project) throw new Error(`${address.name} doesn't have this project.`);
  return { address, pin: projectPinOn(address, project) };
}
