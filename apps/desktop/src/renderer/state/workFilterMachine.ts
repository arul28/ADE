import type { OpenProjectBinding } from "../../shared/types/core";
import { ADE_CLOUD_MACHINE_ID, isAdeCloudBinding } from "../../shared/adeCloud/binding";
import { isAdeCloudComputer, type AdeCloudIndexState } from "./adeCloudLaneIndex";

/**
 * The machine id a Work row has in the machine filter. Every ADE Cloud
 * computer is one "ADE Cloud" choice (`ADE_CLOUD_MACHINE_ID`): the person has
 * no single cloud computers to pick from. The filter options and the filter
 * itself both use this, so a choice never hides its own rows.
 */
export function workFilterMachineId(
  machineId: string,
  binding: OpenProjectBinding | null | undefined,
  index: AdeCloudIndexState,
): string {
  const hostname = binding?.kind === "remote" ? binding.hostname ?? null : null;
  return isAdeCloudBinding(binding) || isAdeCloudComputer({ machineKey: machineId, hostname }, index)
    ? ADE_CLOUD_MACHINE_ID
    : machineId;
}
