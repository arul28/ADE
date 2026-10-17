/**
 * Whether this install explicitly turned ADE's background telemetry off in an
 * earlier build: product analytics, or "send diagnostic reports
 * automatically". The switches are gone from Settings, but a choice someone
 * already made still holds, and it covers error tracking too. Read once at
 * process start, before any Sentry client exists; a missing or unreadable file
 * means no choice was recorded.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveMachineAdeLayout } from "../../../../ade-cli/src/services/projects/machineLayout";

function recordedDisabled(filePath: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { enabled?: unknown } | null;
    return parsed?.enabled === false;
  } catch {
    return false;
  }
}

export function hasPriorTelemetryOptOut(): boolean {
  try {
    const secretsDir = path.join(resolveMachineAdeLayout().adeDir, "secrets");
    const analyticsState = path.join(secretsDir, "product-analytics.json");
    return fs.existsSync(`${analyticsState}.disabled`)
      || recordedDisabled(analyticsState)
      || recordedDisabled(path.join(secretsDir, "diagnostics-autosend.json"));
  } catch {
    return false;
  }
}
