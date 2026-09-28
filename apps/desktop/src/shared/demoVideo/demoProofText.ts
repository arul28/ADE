/**
 * The sentences a filed recording's proof description says about how it was
 * made and why it stopped. One wording for every surface.
 */

import { formatProofDuration } from "../proofProvenance";
import type { DemoArtifactMetadata } from "./demoContract";

/** Why a recording stopped, as every surface's stop reason spells the shared ones. */
export type DemoStopReasonText = "cap" | "idle" | "disk";

/** "A 0:24 demo of 3:10 of real time: still stretches are cut and waits play faster." */
export function demoProofSentence(meta: DemoArtifactMetadata | null | undefined): string | null {
  if (!meta) return null;
  if (meta.fallbackReason) return `Filed as recorded: ${meta.fallbackReason}.`;
  if (meta.plain) return null;
  const shortened = meta.sourceSeconds - meta.outputSeconds >= 0.5;
  if (!shortened) return null;
  const what = [
    meta.cutSeconds >= 0.5 ? "still stretches are cut" : null,
    meta.spedUpSourceSeconds >= 0.5 ? "waits play faster" : null,
  ].filter(Boolean).join(" and ");
  return `A ${formatProofDuration(meta.outputSeconds * 1000)} demo of ${formatProofDuration(meta.sourceSeconds * 1000)} of real time${what ? `: ${what}` : ""}.`;
}

/** The stop sentence for a recording a limit ended, or null for a requested stop. */
export function recordingStopSentence(reason: string | null | undefined, maxDurationMs?: number | null): string | null {
  switch (reason) {
    case "cap":
      return typeof maxDurationMs === "number" ? `Stopped at its ${formatProofDuration(maxDurationMs)} limit.` : "Stopped at its time limit.";
    case "idle":
      return "Stopped after two minutes with nothing happening.";
    case "disk":
      return "Stopped because the disk is almost full.";
    default:
      return null;
  }
}

/** True for a stop that files the recording on its own, the way the cap always has. */
export function isLimitStop(reason: string | null | undefined): reason is DemoStopReasonText {
  return reason === "cap" || reason === "idle" || reason === "disk";
}

/**
 * The chapters a filed demo lists (`metadata.demo.steps`), or none. Reads
 * defensively: metadata crosses processes and versions as plain JSON.
 */
export function readDemoChapters(metadata: unknown): Array<{ t: number; text: string }> {
  if (!metadata || typeof metadata !== "object") return [];
  const demo = (metadata as { demo?: unknown }).demo;
  if (!demo || typeof demo !== "object") return [];
  const steps = (demo as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((step) => {
    if (!step || typeof step !== "object") return [];
    const { t, text } = step as { t?: unknown; text?: unknown };
    return typeof t === "number" && Number.isFinite(t) && t >= 0 && typeof text === "string" && text.trim()
      ? [{ t, text: text.trim() }]
      : [];
  });
}
