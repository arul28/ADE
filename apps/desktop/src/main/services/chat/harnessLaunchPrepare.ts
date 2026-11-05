/**
 * The async half of a routed launch.
 *
 * Resolving a launch is synchronous on purpose — it runs inside the PTY
 * materializer, the resume path and the chat env builder, none of which can
 * await. The one thing a route needs that is inherently async is ADE's local
 * proxy: a translated route (Claude Code on an OpenAI-chat-only model) cannot
 * resolve until the proxy is running. So every async launch entry calls
 * {@link prepareHarnessLaunch} first; it dry-resolves the launch and, when the
 * only thing missing is the proxy, starts it. The real resolve that follows
 * then writes the proxy upstream and points the harness at it.
 *
 * The proxy starter is registered by whichever process owns the proxy service
 * (the brain, or the desktop main process in local mode). A process with no
 * starter simply skips the step; the resolver then returns its reason.
 */

import { captureError } from "../../../shared/sentry/capture";
import { resolveLaunchBrain } from "./harnessPresetLaunch";

type ProxyStarter = () => Promise<unknown>;

// Registered once per process by whichever process owns the proxy service:
// desktop main (`main.ts`) and every project runtime in the brain
// (`bootstrap.ts`). They all point at the same machine-level proxy.
const proxyStarters = new Set<ProxyStarter>();
let processProxyStarter: ProxyStarter | null = null;

/** Register one runtime-owned starter and remove only that starter on teardown. */
export function registerHarnessProxyStarter(starter: ProxyStarter): () => void {
  proxyStarters.add(starter);
  return () => proxyStarters.delete(starter);
}

/** Register a process-owned starter (used by desktop main). */
export function setHarnessProxyStarter(starter: ProxyStarter | null): void {
  processProxyStarter = starter;
}

/**
 * Start ADE's proxy, which lends this machine's logins to it, through this
 * process's registered starter. False when no starter is registered or it
 * failed; never throws.
 */
export async function startHarnessProxy(): Promise<boolean> {
  const proxyStarter = [...proxyStarters].at(-1) ?? processProxyStarter;
  if (!proxyStarter) return false;
  try {
    await proxyStarter();
    return true;
  } catch (error) {
    // The launch then reports the resolver's own reason; record why it failed.
    captureError(error, { tags: { feature: "proxy", stage: "launch_start" }, fingerprint: ["proxy.launch_start"] });
    return false;
  }
}

/**
 * Start ADE's proxy when this launch needs it. Returns true when it started it
 * (the caller should drop any launch plan it cached while the proxy was down).
 * Never throws: a proxy that fails to start leaves the resolver's reason for
 * the user, which is more useful than a thrown launch.
 */
export async function prepareHarnessLaunch(args: {
  provider: string;
  presetId?: string | null;
  credentialId?: string | null;
}): Promise<boolean> {
  const presetId = args.presetId?.trim() || null;
  const credentialId = args.credentialId?.trim() || null;
  if (!presetId && !credentialId) return false;
  if (proxyStarters.size === 0 && !processProxyStarter) return false;
  let needsProxy = false;
  try {
    const dry = resolveLaunchBrain({ provider: args.provider, presetId, credentialId }, { writeConfig: false });
    needsProxy = dry?.status === "unsupported" && dry.reasonCode === "proxy-not-ready";
  } catch {
    return false;
  }
  const started = needsProxy ? await startHarnessProxy() : false;
  // A translated route names the model through ADE's proxy, which reloads its
  // config from disk a moment after the upstream is written. A harness that
  // asks in that moment got "unknown provider for model ade-…/<model>", so
  // write the upstream now and wait until the proxy lists the model.
  try {
    const plan = resolveLaunchBrain({ provider: args.provider, presetId, credentialId });
    if (plan?.status === "ready") await waitForProxyModel(plan.env, plan.env.ANTHROPIC_MODEL ?? plan.model);
  } catch (error) {
    captureError(error, { tags: { feature: "proxy", stage: "launch_model_wait" }, fingerprint: ["proxy.launch_model_wait"] });
  }
  return started;
}

/** How long a launch waits for the proxy to pick up a just-written upstream. Its file watcher reloads within a second. */
const PROXY_MODEL_WAIT_MS = 5_000;
const PROXY_MODEL_POLL_MS = 200;

/**
 * Waits until ADE's local proxy lists `model` (a prefixed `ade-…/<id>`), when
 * the launch points the harness at the proxy. Anything else returns at once.
 */
async function waitForProxyModel(env: Record<string, string>, model: string | undefined): Promise<void> {
  const base = (env.ANTHROPIC_BASE_URL ?? env.OPENAI_BASE_URL ?? "").replace(/\/v1\/?$/, "").replace(/\/$/, "");
  const token = env.ANTHROPIC_AUTH_TOKEN ?? env.OPENAI_API_KEY ?? "";
  if (!model || !model.startsWith("ade-") || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || !token) return;
  const deadline = Date.now() + PROXY_MODEL_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/v1/models`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const body = await response.json() as { data?: Array<{ id?: unknown }> };
        if (Array.isArray(body.data) && body.data.some((entry) => entry?.id === model)) return;
      }
    } catch {
      // The proxy is still starting; ask again.
    }
    await new Promise((resolve) => setTimeout(resolve, PROXY_MODEL_POLL_MS));
  }
}
