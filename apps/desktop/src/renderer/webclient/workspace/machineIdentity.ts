// A leaf module on purpose: the shared desktop components that render ADE Web's
// pre-project surfaces need this identity, and importing it must never drag the
// sync client into the desktop bundle.

/**
 * Stable identity for a machine across reloads and re-pairings.
 *
 * The host device id is the durable one — an environment record is this
 * browser's pairing and can be forgotten and recreated for the same Mac.
 */
export function machineCatalogKey(
  machine: { hostDeviceId?: string | null; envId?: string | null },
): string {
  const hostDeviceId = machine.hostDeviceId?.trim();
  if (hostDeviceId) return `device:${hostDeviceId}`;
  return `environment:${machine.envId ?? "unknown"}`;
}
