import { toPiSdkJson } from "./piSdkProtocol";

/**
 * Small value helpers the Pi chat worker's modules share. The worker loads Pi
 * dynamically, so Pi's objects arrive as plain records and functions; these
 * read them without a static type from Pi.
 */

export type PiModule = Record<string, unknown>;
export type Callable = (...args: unknown[]) => unknown;
/** `method(target, name)`: the named function on a Pi object, or a clear error. */
export type PiSdkWorkerMethod = (target: unknown, name: string) => Callable;

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A readable message for anything a Pi call throws. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message && message !== "Error" ? message : error.name || "Unknown Pi SDK error";
  }
  if (typeof error === "string" && error.trim()) return error.trim();
  try {
    return JSON.stringify(toPiSdkJson(error));
  } catch {
    return String(error);
  }
}
