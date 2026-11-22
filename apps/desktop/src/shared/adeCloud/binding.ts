/**
 * The ADE Cloud binding: a project tab that is bound to ADE Cloud, the one
 * machine every account always has.
 *
 * A project tab binds to an own computer's copy when one is online. When none
 * is, the tab binds to ADE Cloud with this binding. The tab then renders the
 * normal project tabs. Its lanes and chats come from the account (the saved
 * copies of each cloud lane), and every action on a lane still goes to that
 * lane's own computer through the lane's own pin.
 *
 * The binding is a `remote` binding with a reserved target id, not a new
 * binding kind, so every reader of `OpenProjectBinding` keeps working.
 */

import type { OpenProjectBinding, RemoteOpenProjectBinding } from "../types/core";
import { ADE_CLOUD_MACHINE_ID, ADE_CLOUD_NAME } from "../adeCloudMachine";
import { savedChatsMachineKey } from "../cloudSavedChats";
import { remoteProjectBindingKey } from "../projectIdentity";

export { ADE_CLOUD_MACHINE_ID, ADE_CLOUD_NAME };

/** What the tab knows about the account project it shows. */
export type AdeCloudBindingProject = {
  /** The account project id (`ap_…`), or the repository's address before the account knows it. */
  accountProjectId: string;
  displayName: string;
  gitOriginUrl?: string | null;
  iconDataUrl?: string | null;
};

/** A remote binding whose machine is ADE Cloud itself. */
export type AdeCloudOpenProjectBinding = RemoteOpenProjectBinding & { targetId: typeof ADE_CLOUD_MACHINE_ID };

/** The folder value of an ADE Cloud binding. It names no folder on any machine. */
export function adeCloudBindingRoot(accountProjectId: string): string {
  return `remote:${accountProjectId}`;
}

/** The binding of a project tab that is bound to ADE Cloud. */
export function adeCloudBinding(project: AdeCloudBindingProject): AdeCloudOpenProjectBinding {
  const id = project.accountProjectId.trim();
  return {
    kind: "remote",
    key: remoteProjectBindingKey(ADE_CLOUD_MACHINE_ID, id),
    targetId: ADE_CLOUD_MACHINE_ID,
    runtimeName: ADE_CLOUD_NAME,
    transport: "paired",
    projectId: id,
    rootPath: adeCloudBindingRoot(id),
    displayName: project.displayName.trim() || id,
    gitOriginUrl: project.gitOriginUrl?.trim() || null,
    iconDataUrl: project.iconDataUrl ?? null,
  };
}

/** Whether this binding is a project tab bound to ADE Cloud (not a lane's own computer). */
export function isAdeCloudBinding(binding: OpenProjectBinding | null | undefined): binding is AdeCloudOpenProjectBinding {
  return binding?.kind === "remote" && binding.targetId === ADE_CLOUD_MACHINE_ID;
}

/** Whether a target id names ADE Cloud as a machine. */
export function isAdeCloudTargetId(targetId: string | null | undefined): boolean {
  return targetId === ADE_CLOUD_MACHINE_ID;
}

/**
 * Whether this pin is answered by the account and not by a computer: the ADE
 * Cloud tab binding, or a lane pin of a cloud computer this window has no
 * connection to (`cloud-saved:<machineKey>`). Reads of such a pin never wake
 * a computer.
 */
export function isAccountAnsweredPin(pin: OpenProjectBinding | null | undefined): boolean {
  return pin?.kind === "remote" && (pin.targetId === ADE_CLOUD_MACHINE_ID || savedChatsMachineKey(pin.targetId) != null);
}
