/**
 * Contract C2: an address for one machine of the person's ADE account.
 *
 * A caller turns a machine key into a `MachineAddress` once
 * (`window.ade.machines.connect`) and passes the address, or a project pin
 * built from it (`projectPinOn`), with each call it makes to that machine.
 *
 * What the contract never does:
 * - read or change the machine of a tab or a window;
 * - add a default route: an address names exactly one machine, and nothing
 *   falls back to "the tab's machine" when it is missing.
 */

import { remoteProjectBindingKey } from "./projectIdentity";
import type { OpenProjectBinding } from "./types/core";
import type { RemoteRuntimeProjectRecord } from "./types/remoteRuntime";

/**
 * One machine. `this` is the computer ADE runs on: its calls take no pin (the
 * unpinned route already reaches it). `remote` is any other machine of the
 * account, reached through the saved connection `targetId`.
 */
export type MachineAddress =
  | { kind: "this"; machineKey: string | null }
  | {
      kind: "remote";
      machineKey: string;
      /** This computer's saved connection to that machine. */
      targetId: string;
      /** The machine's display name, for copy. Never an instance id. */
      name: string;
    };

/**
 * Why no address could be made:
 * - `not_in_account`: the key names no machine on the signed-in account (a
 *   deleted computer, or another account's).
 * - `unreachable`: the machine is on the account but did not answer (off,
 *   asleep and could not be woken, no route).
 * - `signed_out`: this computer is not signed in to an ADE account.
 * - `invalid`: no key was given.
 */
export type MachineConnectFailureReason = "not_in_account" | "unreachable" | "signed_out" | "invalid";

export type MachineConnectResult =
  | { ok: true; address: MachineAddress }
  | { ok: false; reason: MachineConnectFailureReason; machineKey: string; message: string };

export type MachineConnectOptions = {
  /**
   * False: only make sure this computer has a saved connection (pairing
   * through the account when it has none) and do not open it. A sleeping
   * cloud computer is then left asleep. Default true: open the connection,
   * which wakes a sleeping cloud computer.
   */
  connect?: boolean;
};

/** Machine keys compare without case or surrounding space. */
export function sameMachineKey(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = a?.trim().toLowerCase() ?? "";
  return left.length > 0 && left === (b?.trim().toLowerCase() ?? "");
}

/**
 * The pin for one project on an addressed machine. Null for `this`: calls to
 * this computer go unpinned (CLAUDE.md, "Built for remote machines").
 */
export function projectPinOn(
  address: MachineAddress,
  project: Pick<RemoteRuntimeProjectRecord, "projectId" | "rootPath" | "displayName" | "gitOriginUrl">,
): (OpenProjectBinding & { kind: "remote" }) | null {
  if (address.kind === "this") return null;
  return {
    kind: "remote",
    key: remoteProjectBindingKey(address.targetId, project.projectId),
    targetId: address.targetId,
    runtimeName: address.name,
    transport: "paired",
    projectId: project.projectId,
    rootPath: project.rootPath,
    displayName: project.displayName,
    gitOriginUrl: project.gitOriginUrl,
  };
}

/** The error a renderer helper throws for a failed result: the plain sentence only. */
export class MachineConnectError extends Error {
  constructor(readonly failure: Extract<MachineConnectResult, { ok: false }>) {
    super(failure.message);
    this.name = "MachineConnectError";
  }
}
