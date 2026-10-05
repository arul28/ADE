/**
 * Which desktop sent a session its last message.
 *
 * Several desktops can show the same chat: the Mac Studio that runs it and a
 * MacBook connected to it. When the agent asks to show something (`ade browser
 * open`, `ade ui show`, an Apple drawer), it should open on the screen of the
 * person who is talking to it. So every message a desktop sends carries this
 * stamp, and requests to show something name the desktop it came from. A
 * request with no target goes to every desktop, which is what happens when
 * nobody can tell: a message sent from the CLI or the phone, or a runtime
 * that restarted since the last message.
 */
export type SessionInputOrigin = {
  /** Stable per desktop install; every window of one desktop shares it. */
  clientId: string;
  /**
   * The desktop runs on the same machine as the runtime (it reached the
   * runtime without going through a paired connection). Only such a desktop
   * can be reached through the runtime's local desktop bridge.
   */
  local: boolean;
};

const MAX_ID_CHARS = 128;

/** Validates a stamp from the wire; anything malformed reads as "unknown". */
export function parseSessionInputOrigin(value: unknown): SessionInputOrigin | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const clientId = typeof record.clientId === "string" ? record.clientId.trim() : "";
  if (!clientId || clientId.length > MAX_ID_CHARS) return null;
  return { clientId, local: record.local === true };
}

/** A request with no target is for every desktop; one with a target only for that desktop. */
export function isAddressedToClient(
  targetClientId: string | null | undefined,
  clientId: string | null | undefined,
): boolean {
  if (!targetClientId) return true;
  return Boolean(clientId) && targetClientId === clientId;
}
