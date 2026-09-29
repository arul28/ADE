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

import { resolveLaunchBrain } from "./harnessPresetLaunch";

type ProxyStarter = () => Promise<unknown>;

let proxyStarter: ProxyStarter | null = null;

export function setHarnessProxyStarter(starter: ProxyStarter | null): void {
  proxyStarter = starter;
}

/** Reasons the resolver gives when the only missing piece is a running proxy. */
function isProxyNotReady(reason: string): boolean {
  return /ADE's proxy (is not running|has not written its config|has no connection key)|Sign-in through ADE's proxy is stopped/.test(reason);
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
  if (!proxyStarter) return false;
  let reason: string | null = null;
  try {
    const dry = resolveLaunchBrain({ provider: args.provider, presetId, credentialId }, { writeConfig: false });
    reason = dry?.status === "unsupported" ? dry.unsupported : null;
  } catch {
    return false;
  }
  if (!reason || !isProxyNotReady(reason)) return false;
  try {
    await proxyStarter();
    return true;
  } catch {
    return false;
  }
}
