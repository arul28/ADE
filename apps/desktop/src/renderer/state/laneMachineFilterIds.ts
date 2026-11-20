/**
 * The Lanes sidebar's Computer filter, as values.
 *
 * `"all"` (every computer), a computer id, `ADE_CLOUD_MACHINE_ID` (every ADE
 * Cloud computer is one machine to the person), or
 * `LANES_MACHINE_FILTER_NO_COMPUTER` (the ADE Cloud lanes whose computer is
 * gone: freed, deleted, or too old).
 *
 * A computer's id is `machineIdOfSlot(machineId)`, so two checkouts of one
 * computer share one entry.
 *
 * A leaf module on purpose (no imports): the persisted view state in
 * `appStore` and the machine model in `laneMachineRouting` must name the same
 * values, and `appStore` cannot import `laneMachineRouting` (that module reads
 * the store, which would be a cycle).
 */

/** Every computer's lanes. The default, and what an entry that is gone reads as. */
export const LANES_MACHINE_FILTER_ALL = "all";

/** The ADE Cloud lanes whose computer is gone. Shown under ADE Cloud in the panel. */
export const LANES_MACHINE_FILTER_NO_COMPUTER = "__no_computer__";

/**
 * A stored filter value, cleaned: anything that is not a non-empty string (an
 * older blob, a hand-edited one) reads as `"all"`. Whether the named computer is
 * still listed is decided where the list is built, never here.
 */
export function normalizeLanesMachineFilter(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  return id.length > 0 ? id : LANES_MACHINE_FILTER_ALL;
}
