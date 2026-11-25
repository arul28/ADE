/**
 * Contract C2 for renderer code: connect to any machine of the account by its
 * machine key, and build the pin for one of its projects.
 *
 * The address names one machine; pass it (or the pin) with every call to that
 * machine. Nothing here reads or changes the tab's machine.
 */

import { pickMachineProject, type MachineProjectRef } from "../../shared/projectIdentity";
import {
  MachineConnectError,
  projectPinOn,
  type MachineAddress,
  type MachineConnectOptions,
} from "../../shared/machineAddress";
import type { OpenProjectBinding } from "../../shared/types/core";

/** The address of the machine; throws a `MachineConnectError` with the plain sentence when it can't. */
export async function connectMachine(machineKey: string, options?: MachineConnectOptions): Promise<MachineAddress> {
  const result = await window.ade.machines.connect(machineKey, options);
  if (!result.ok) throw new MachineConnectError(result);
  return result.address;
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
  const project = pickMachineProject(await window.ade.remoteRuntime.listProjects(address.targetId), ref);
  if (!project) throw new Error(`${address.name} doesn't have this project.`);
  return { address, pin: projectPinOn(address, project) };
}
