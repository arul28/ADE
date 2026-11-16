/**
 * One ADE Cloud computer as the machine lists show it, from the server's
 * `CloudInstance`. Shared by the desktop's main process (`cloudMachines.ts`)
 * and the web app, which reads the account's computers from the server when
 * no computer of the person's own is online.
 */

import type { CloudInstance } from "../../../account-directory/src/cloud/contract";
import {
  cloudDiskFullMessage,
  cloudHoursRate,
  cloudMachineKindOf,
  cloudMachineState,
  cloudMachineType,
  cloudShapeFor,
  CLOUD_DISK_FULL_METADATA,
  CLOUD_DISK_FULL_REASON_METADATA,
  type CloudCatalog,
  type CloudMachineUpdate,
  type CloudResources,
  type CloudSleepPolicy,
} from "./adeCloud";
import { cloudMachineLaneFactsOf, type CloudLaneMachine } from "./cloudLaneLaunch";

/** The metadata key ADE writes once a box joins the account: its ADE machine key. */
export const CLOUD_MACHINE_KEY_METADATA = "ade_machine_key";

export function cloudResourcesOfInstance(instance: CloudInstance): CloudResources | null {
  const raw = instance.resources;
  if (!raw || !raw.cpu || !raw.memory) return null;
  return { cpu: raw.cpu, memoryGb: raw.memory, diskGb: raw.disk };
}

/**
 * One computer as the list shows it. A lane computer also carries its lane
 * facts from its metadata (`CloudLaneMachine.lane`), so the composer can list
 * a project's ADE Cloud lanes without waking any of them.
 */
export function cloudMachineOfInstance(instance: CloudInstance, catalog: CloudCatalog): CloudLaneMachine {
  const lane = cloudMachineLaneFactsOf(instance.metadata);
  const resources = cloudResourcesOfInstance(instance);
  const type = cloudMachineType(instance.type);
  const shape = cloudShapeFor(resources);
  return {
    instanceId: instance.id,
    name: instance.name,
    status: instance.status,
    state: cloudMachineState(instance.status),
    type,
    resources,
    shapeId: shape?.id ?? null,
    region: instance.region,
    hoursRate: shape ? cloudHoursRate(cloudMachineKindOf(type), shape.id, catalog) : null,
    pastDue: instance.pastDue,
    failure: instance.status === "failed" ? instance.statusReason?.message ?? null : null,
    machineKey: instance.metadata[CLOUD_MACHINE_KEY_METADATA] ?? null,
    createdAtMs: instance.created != null ? instance.created * 1000 : null,
    sleep: cloudSleepPolicyOf(instance),
    diskFull: cloudDiskFullMessage(instance.metadata[CLOUD_DISK_FULL_METADATA], catalog, instance.metadata[CLOUD_DISK_FULL_REASON_METADATA]),
    update: updateOf(instance),
    // Use facts the computer reported while awake: read with the list, no wake.
    lastActiveAtMs: instance.lastActiveAt ?? null,
    diskUsage: instance.diskUsage ?? null,
    laneWork: instance.laneWork ?? null,
    ...(lane ? { lane } : {}),
    replacesInstanceId: instance.metadata.ade_moved_from ?? instance.metadata.ade_copied_from ?? null,
  };
}

/** How a computer sleeps, read from the provider (the setting lives there, so every app agrees). */
export function cloudSleepPolicyOf(instance: Pick<CloudInstance, "autoSleep">): CloudSleepPolicy {
  return instance.autoSleep ? { state: "auto" } : { state: "pending" };
}

/** The server's update facts, or null from a server before updates. */
function updateOf(instance: CloudInstance): CloudMachineUpdate | null {
  if (!instance.channel) return null;
  return {
    channel: instance.channel === "beta" ? "beta" : "stable",
    image: instance.templateVersion ?? null,
    target: instance.targetTemplate ?? null,
    auto: instance.autoUpdate === true,
    state: instance.updateState === "updating" || instance.updateState === "failed" ? instance.updateState : "auto",
    error: instance.updateState === "failed" ? instance.updateError ?? null : null,
    updatedAtMs: instance.updatedAt ?? null,
  };
}
