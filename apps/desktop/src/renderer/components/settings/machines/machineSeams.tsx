/**
 * Where a machine's page will show what the personal-mesh work adds about a
 * machine (lane `8fbb5263`): what it can do, how often work should go to it,
 * and the copies of other machines' work it holds. Each one renders nothing
 * until a real source hands it data — no placeholders, no invented values.
 *
 * Shapes mirror that lane's names where it has them (`RemoteWorkCopy` in
 * `main/services/remoteWork/remoteWorkCopyService.ts`); the rest are the
 * smallest shape the page needs and are expected to be replaced by theirs.
 */
import type { ReactNode } from "react";

/** What a machine can run, as its brain reports it. */
export type MachineCapabilities = {
  /** CLIs signed in there, by provider id. */
  signedInClis?: readonly string[];
  /** Xcode and simulators, on a Mac. */
  xcode?: { version: string | null; simulators: number } | null;
  os?: string | null;
  disk?: { freeBytes: number; totalBytes: number } | null;
  runningBuilds?: number;
  warmCaches?: readonly string[];
  /** 1-minute load average over core count, 0–1+. */
  load?: number | null;
};

/** How often other machines should send work here. */
export type MachinePreference = "prefer" | "normal" | "less-often" | "manual";

/** A copy of another machine's work kept here (their `RemoteWorkCopy`, plus its size). */
export type MachineWorkCopy = {
  owner: string;
  path: string;
  branch: string | null;
  machineName: string | null;
  lastUsedAt: string;
  sizeBytes?: number | null;
};

/** The capability map, once a machine reports one. */
export function MachineCapabilitiesArea({ capabilities }: { capabilities: MachineCapabilities | null }): ReactNode {
  if (!capabilities) return null;
  return null;
}

/** The "Prefer / Normal / Less often / Manual" row, once it can be read and set. */
export function MachinePreferenceRow({ preference }: { preference: MachinePreference | null }): ReactNode {
  if (!preference) return null;
  return null;
}

/** "Work from other machines": the copies here, with sizes and Delete. */
export function MachineWorkCopies({ copies }: { copies: readonly MachineWorkCopy[] | null }): ReactNode {
  if (!copies || copies.length === 0) return null;
  return null;
}
