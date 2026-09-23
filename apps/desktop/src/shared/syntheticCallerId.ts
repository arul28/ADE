/**
 * `ade-cli:5504`, `ade-code:912`: a caller id a client makes from its name and
 * its own pid when its environment names no chat session and no attempt.
 *
 * It identifies a PROCESS. It is a usable caller id, but it must never become
 * an owner of anything durable, and the brain must not fill it in with its own
 * environment identity.
 */
export function syntheticCallerId(clientName: string, pid: number = process.pid): string {
  return `${clientName}:${pid}`;
}

export function isSyntheticCallerId(id: string | null | undefined): boolean {
  return Boolean(id && /^[a-z][a-z0-9-]*:\d+$/.test(id));
}

/** The client name in a synthetic caller id (`ade-cli` for `ade-cli:5504`), else null. */
export function syntheticCallerClient(id: string | null | undefined): string | null {
  return id && isSyntheticCallerId(id) ? id.slice(0, id.lastIndexOf(":")) : null;
}
