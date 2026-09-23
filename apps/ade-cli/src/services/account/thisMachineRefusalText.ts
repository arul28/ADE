import {
  readThisMachineRefusal,
  type ThisMachineRefusal,
} from "../../../../desktop/src/shared/accountMachineRefusal";
import type { SyncAccountDirectoryHealth } from "../../../../desktop/src/shared/types/sync";

/**
 * The CLI's words for an account-directory refusal of THIS computer.
 *
 * The desktop says the same facts in its banner (`describeThisComputerRefusal`
 * in the renderer): the removal date, whether the automatic repair stopped,
 * and the one action that fixes it. Here the action is `ade machines
 * reconnect`, and dates are ISO days, because agents read this output too.
 */

/** The refusal on a publisher health record from the wire, or null. */
export function readThisMachineRefusalFromWire(raw: unknown): ThisMachineRefusal | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  // Every field the reader looks at is optional on the wire, so a partial
  // record from an older brain reads as "no refusal", not as a crash.
  return readThisMachineRefusal(raw as SyncAccountDirectoryHealth);
}

/** A `ThisMachineRefusal` read back from command output, or null. */
export function parseThisMachineRefusal(value: unknown): ThisMachineRefusal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.code !== "machine_revoked" && record.code !== "pairing_authentication_required") return null;
  return {
    code: record.code,
    revokedAt: typeof record.revokedAt === "string" ? record.revokedAt : null,
    recoveryGaveUpAt: typeof record.recoveryGaveUpAt === "number" && Number.isFinite(record.recoveryGaveUpAt)
      ? record.recoveryGaveUpAt
      : null,
  };
}

/** "2026-09-14" for an ISO time or epoch ms, or null when it is not a date. */
export function isoDay(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

/** The state in a few words, for a key-value row: "removed on 2026-09-14". */
export function thisMachineRefusalState(refusal: ThisMachineRefusal): string {
  const removedOn = isoDay(refusal.revokedAt);
  if (refusal.code === "pairing_authentication_required") {
    return `must confirm it's you to rejoin${removedOn ? ` (removed on ${removedOn})` : ""}`;
  }
  return removedOn ? `removed from your ADE account on ${removedOn}` : "removed from your ADE account";
}

/** One sentence with the date, the give-up, and the command that fixes it. */
export function describeThisMachineRefusal(refusal: ThisMachineRefusal): string {
  const removedOn = isoDay(refusal.revokedAt);
  const lead = refusal.code === "pairing_authentication_required"
    ? `This computer must confirm it's you before it can rejoin your ADE account${removedOn ? ` (removed on ${removedOn})` : ""}.`
    : `This computer was removed from your ADE account${removedOn ? ` on ${removedOn}` : ""}.`;
  const gaveUp = refusal.recoveryGaveUpAt != null
    ? " ADE stopped trying to reconnect it on its own."
    : "";
  return `${lead}${gaveUp} Run \`ade machines reconnect\` to rejoin.`;
}
