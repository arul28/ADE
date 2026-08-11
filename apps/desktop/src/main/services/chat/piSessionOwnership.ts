import fs from "node:fs";
import path from "node:path";
import type { PiSessionLeaseOwner } from "./piSessionLease";
import { readPiSessionHeader } from "./piSessionStore";

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export type PiSessionOwnerRecord = {
  owner: PiSessionLeaseOwner;
  /**
   * ADE chat session id, or tracked terminal session id. Deliberately NOT the
   * lease's `ownerId`, which is a live PTY handle: this one has to survive
   * relaunches, and the two sit on adjacent lines at the call sites.
   */
  ownerSessionId: string;
};

function ownerPathFor(sessionFile: string): string {
  return `${path.resolve(sessionFile)}.ade-owner`;
}

/**
 * Record which ADE surface a native Pi session belongs to, durably.
 *
 * The `.ade-lease` sidecar answers "is someone writing this right now" and is
 * removed on release. This answers "whose session is this" and is never
 * removed, because chat and the tracked CLI share one native store: without it
 * a terminal adopts a chat's session as soon as the two were created minutes
 * apart, and time proximity cannot tell them apart.
 */
export function recordPiSessionOwner(args: {
  sessionFile: string;
  owner: PiSessionLeaseOwner;
  ownerSessionId: string;
}): void {
  const ownerSessionId = nonEmpty(args.ownerSessionId);
  if (!ownerSessionId) return;
  try {
    const record: PiSessionOwnerRecord = { owner: args.owner, ownerSessionId };
    fs.writeFileSync(ownerPathFor(args.sessionFile), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Ownership is an optimization for candidate selection, never a gate on
    // running the session the user asked for.
  }
}

export function readPiSessionOwner(sessionFile: string): PiSessionOwnerRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerPathFor(sessionFile), "utf8")) as Partial<PiSessionOwnerRecord>;
    const ownerSessionId = nonEmpty(parsed.ownerSessionId);
    return (parsed.owner === "sdk" || parsed.owner === "cli") && ownerSessionId
      ? { owner: parsed.owner, ownerSessionId }
      : null;
  } catch {
    return null;
  }
}

/**
 * Whether a tracked terminal may adopt this session as its own.
 *
 * Unowned sessions stay adoptable so a `pi` run started outside ADE can still
 * be picked up; anything already claimed by an ADE chat, or by a different
 * terminal, is not this terminal's to reopen.
 */
export function piSessionIsAdoptableByTerminal(sessionFile: string, terminalSessionId: string): boolean {
  const owner = readPiSessionOwner(sessionFile);
  if (!owner) return true;
  return owner.owner === "cli" && owner.ownerSessionId === terminalSessionId.trim();
}

/**
 * Whether a native Pi session could plausibly belong to a terminal that
 * started at `terminalStartedAt`.
 *
 * A tracked terminal's session is created by that terminal, so one created
 * before it existed is somebody else's — another terminal's, or an ADE chat's,
 * now that both write into a single native store. ADE stored such a pointer
 * once and then resumed it on every relaunch, so the check runs at resume time
 * and repairs the stored target rather than trusting it.
 */
export function piSessionCouldBelongToTerminal(args: {
  sessionFile: string;
  terminalStartedAt: string | null | undefined;
  /** Clock skew and the gap between ADE's row and Pi's first write. */
  graceMs?: number;
}): boolean {
  const startedAt = Date.parse(args.terminalStartedAt?.trim() || "");
  if (!Number.isFinite(startedAt)) return true;
  const createdAt = readPiSessionHeader(args.sessionFile)?.createdAt;
  if (createdAt == null) return true;
  return createdAt >= startedAt - (args.graceMs ?? 60_000);
}
