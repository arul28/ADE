/**
 * Where a machine's page will show what the personal-mesh work adds about a
 * machine: what it can do and how often work should go to it (lane `8d7f46b1`).
 * Each one renders nothing until a real source hands it data — no
 * placeholders, no invented values. The copies of other machines' work it
 * holds are `MachineWorkCopies.tsx`.
 *
 * The shapes are the smallest the page needs and are expected to be replaced
 * by that lane's.
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
