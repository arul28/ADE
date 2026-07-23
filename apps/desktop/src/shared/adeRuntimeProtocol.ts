/**
 * Monotonically bumpable compatibility level for the local ADE runtime RPC.
 *
 * A runtime is compatible with this desktop when the desktop's level falls
 * inside the inclusive range advertised by the runtime.
 */
export const RUNTIME_COMPAT_LEVEL = 1;

export function isRuntimeProtocolCompatible(runtimeInfo: {
  minCompatibleProtocol: number | null;
  protocolVersion: number | null;
}): boolean {
  const { minCompatibleProtocol, protocolVersion } = runtimeInfo;
  return minCompatibleProtocol != null
    && protocolVersion != null
    && minCompatibleProtocol > 0
    && protocolVersion >= minCompatibleProtocol
    && minCompatibleProtocol <= RUNTIME_COMPAT_LEVEL
    && RUNTIME_COMPAT_LEVEL <= protocolVersion;
}
