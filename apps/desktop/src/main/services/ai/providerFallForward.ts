/**
 * The shared core of provider fall-forward: the pieces Codex and Muse use the
 * same way (Claude Code's `claudeFallForward.ts` predates them and keeps its
 * own copy of the same rules, unchanged).
 *
 * Fall-forward is the one time ADE runs a build it did not pin. The vendor
 * must provably refuse the pin (an exact signal, see
 * `providerVersionRejection.ts`), the newer build must come from the vendor's
 * own integrity-carrying channel, install as its own version directory in the
 * tools cache, and pass a probe; only then does ADE record the override
 * (`tools/overrides.ts`) that the resolvers follow while the pin it replaces is
 * still the manifest's. When in doubt nothing switches and ADE says why.
 *
 * Here: one attempt per key per process, a bounded JSON fetch, a probe
 * process runner, the machine log line, and the "Running untested …" status.
 */
import { spawn } from "node:child_process";
import { resolveActiveToolVersionOverride } from "../../../../../ade-cli/src/services/tools/overrides";
import type { Logger } from "../logging/logger";
import { getMachineMainLogger } from "../logging/machineLogger";

export type FallForwardLogger = Pick<Logger, "info" | "warn">;

const DOCUMENT_TIMEOUT_MS = 15_000;
/** A vendor document is small; anything bigger is not the document. */
const DOCUMENT_MAX_BYTES = 1_000_000;

const attempts = new Map<string, Promise<unknown>>();

/**
 * Run `attempt` at most once per `key` in this process: a second refusal of the
 * same pin joins the first attempt's outcome. `log` writes the one operational
 * line per attempt (warn, local machine log; never PostHog).
 */
export function fallForwardOnce<T>(
  key: string,
  attempt: () => Promise<T>,
  log: { event: string; logger?: FallForwardLogger | null; fields: (outcome: T) => Record<string, unknown> },
): Promise<T> {
  const existing = attempts.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const running = attempt().then((outcome) => {
    (log.logger ?? getMachineMainLogger()).warn(log.event, log.fields(outcome));
    return outcome;
  });
  attempts.set(key, running);
  return running;
}

/** True when this process already tried `key`. */
export function fallForwardAttempted(key: string): boolean {
  return attempts.has(key);
}

/**
 * GET a small JSON object over HTTPS from one of `hosts`, following no
 * redirect. Throws on anything else: a non-200, a body that is not one JSON
 * object, a timeout. Callers treat every throw as "do nothing".
 */
export async function fetchVendorJson(url: string, hosts: readonly string[]): Promise<Record<string, unknown>> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !hosts.includes(parsed.hostname)) {
    throw new Error(`${parsed.hostname} is not a host ADE reads this from`);
  }
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS),
  });
  if (response.status !== 200) throw new Error(`${parsed.hostname} answered HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > DOCUMENT_MAX_BYTES) throw new Error(`${parsed.hostname} answered with an oversized document`);
  const body = JSON.parse(text) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`${parsed.hostname} answered with no JSON object`);
  return body as Record<string, unknown>;
}

export type ProbeRun = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };

/**
 * Run a probe of a downloaded build: no stdin, bounded output, killed at
 * `timeoutMs` (a timeout is a failed probe, never a pass). Never rejects for
 * the child's own failure; a spawn error is `exitCode: null`.
 */
export function runProbeProcess(
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number },
): Promise<ProbeRun> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, {
        env: options.env,
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      stderr = error instanceof Error ? error.message : String(error);
      resolve({ exitCode: null, stdout, stderr, timedOut });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      finish(null);
    }, options.timeoutMs);
    const cap = (current: string, chunk: unknown) => (current.length > 1_000_000 ? current : current + String(chunk));
    child.stdout?.on("data", (chunk) => { stdout = cap(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = cap(stderr, chunk); });
    child.on("error", (error) => {
      stderr += error.message;
      finish(null);
    });
    child.on("close", (exitCode) => finish(exitCode));
  });
}

/**
 * The status line while an override runs on this machine, or null when ADE
 * runs its pin: "Running untested <Tool> X: <vendor> stopped supporting Y[
 * for <scope>]." No spawn, no network.
 */
export function fallForwardStatusLine(tool: string, label: string, vendor: string): string | null {
  const active = resolveActiveToolVersionOverride(tool);
  if (!active) return null;
  const running = active.override.overrideToolVersion ?? active.override.overrideVersion;
  const refused = active.override.rejectedToolVersion ?? `ADE's pinned build (${active.override.pinnedVersion})`;
  const scope = active.override.scope ? ` for ${active.override.scope}` : "";
  return `Running untested ${label} ${running}: ${vendor} stopped supporting ${refused}${scope}.`;
}
