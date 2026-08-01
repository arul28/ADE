/**
 * Adapter-wide runtime-pin boundary guard.
 *
 * ADE Web targets exactly one host, so an Electron-contract call that arrives
 * with a per-session runtime pin cannot be routed — silently serving it from
 * the single web host would be a wrong-machine read or write. Every
 * pin-accepting shim in this adapter (pty/terminal, sessions reads on the
 * cross-machine lane-discovery path, lanes.list, and the draft attachment
 * shim) calls this guard so the gap fails loudly instead; a cross-machine web
 * union must extend the adapter before relying on any pin.
 */
export function assertWebRuntimePinUnsupported(
  operation: string,
  pin: unknown,
): void {
  if (pin == null) return;
  const key =
    pin && typeof pin === "object" && typeof (pin as { key?: unknown }).key === "string"
      ? (pin as { key: string }).key
      : "unknown binding";
  throw new Error(
    `ADE Web cannot route ${operation} to pinned runtime ${key}; cross-machine web routing is not implemented.`,
  );
}
