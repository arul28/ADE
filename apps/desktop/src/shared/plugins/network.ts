/**
 * What a plugin's own process is allowed to talk to.
 *
 * ## Why this is its own module
 *
 * Three layers need the same two rules and none of them may import the other
 * two: the manifest parser validates a declared host, the install disclosure
 * prints it, and the child bootstrap matches a live request against it. A
 * second spelling of the match would mean a host the parser accepted the child
 * refuses, which reads to the plugin author as a platform bug and to the user
 * as a plugin that does not work.
 *
 * ## What this is, and what it is not
 *
 * It is a declaration and a guard-rail. `pluginChildBootstrap.ts` already says
 * it "assumes the plugin is buggy, not malicious-proof", and this does not
 * change that: the child is an ordinary Node process, so a plugin that wants
 * to reach an undeclared host can spawn `curl` and this module will never see
 * it. What the guard buys is real anyway — an official plugin that sends the
 * user's API key somewhere must SAY so before the install, a dependency that
 * quietly gains a telemetry call is refused rather than silently allowed, and
 * every refusal is written to the plugin's log where `ade plugin logs` and
 * `ade plugin doctor` can show it.
 *
 * Do not describe it as a sandbox in user-facing copy.
 *
 * ## The matching rule
 *
 * - `api.cursor.com` matches that host and nothing else.
 * - `*.hf.co` matches any subdomain at ANY depth — `us.aws.cdn.hf.co` is a real
 *   redirect target of `huggingface.co`, so a one-label-only wildcard would
 *   have failed the first download it was asked to allow. It does NOT match the
 *   apex `hf.co`; a plugin that needs both declares both.
 * - Nothing else matches. A plugin with no `network` field reaches no host.
 */

/** The most hosts one plugin may declare. */
export const PLUGIN_NETWORK_HOSTS_MAX = 8;

/** Longest a hostname may be, per DNS. */
const PLUGIN_NETWORK_HOST_MAX_LENGTH = 253;

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

/** One optional `*.` prefix, then two or more DNS labels. */
const PLUGIN_NETWORK_HOST_PATTERN = new RegExp(
  `^(?:\\*\\.)?${HOST_LABEL}(?:\\.${HOST_LABEL})+$`,
);

const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * The one hostname allowed to stand alone.
 *
 * A plugin talking to a service on this machine is a real case (a local model
 * server, a dev server it started itself), and `localhost` is the only name for
 * it that is not an IP literal. It is still a DECLARATION: a plugin that does
 * not list it does not get loopback either.
 */
const PLUGIN_NETWORK_LOOPBACK_HOST = "localhost";

/**
 * Is this a host a manifest may declare?
 *
 * Refused on purpose: uppercase (so one host has one spelling), a scheme, a
 * port, a path, an IP literal in either family, a bare `*`, and a wildcard over
 * a single label such as `*.com` — that last one is a claim on a whole registry
 * rather than a declaration of who the plugin talks to.
 */
export function isValidPluginNetworkHost(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const host = value.trim();
  if (host.length === 0 || host.length > PLUGIN_NETWORK_HOST_MAX_LENGTH) return false;
  if (host !== host.toLowerCase()) return false;
  if (host === PLUGIN_NETWORK_LOOPBACK_HOST) return true;
  if (!PLUGIN_NETWORK_HOST_PATTERN.test(host)) return false;
  // An IPv4 literal parses as labels, so the pattern above lets it through.
  // IPv6 carries colons and never reaches here.
  return !IPV4_PATTERN.test(host.startsWith("*.") ? host.slice(2) : host);
}

/**
 * The hostname a request is really for, reduced to what the match compares.
 *
 * A trailing dot is the fully-qualified spelling of the same name, and an
 * uppercase host is the same host; neither may be the difference between
 * allowed and refused. Returns null for anything that is not a hostname at all
 * — a bracketed IPv6 literal included, which then falls through to a refusal
 * because no manifest can declare one.
 */
export function normalizePluginNetworkHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  return host.length > 0 ? host : null;
}

/** Does `host` match any declared entry? See the matching rule above. */
export function pluginNetworkHostAllowed(host: unknown, declared: readonly string[]): boolean {
  const candidate = normalizePluginNetworkHost(host);
  if (candidate === null) return false;
  for (const entry of declared) {
    if (entry.startsWith("*.")) {
      // `.hf.co` — the dot is part of the suffix, so `evilhf.co` cannot match,
      // and the length check keeps the apex out.
      const suffix = entry.slice(1);
      if (candidate.length > suffix.length && candidate.endsWith(suffix)) return true;
      continue;
    }
    if (candidate === entry) return true;
  }
  return false;
}

/**
 * The refusal a plugin reads, and the line its log keeps.
 *
 * Names the host and the fix in one sentence, because the person who sees it in
 * `ade plugin logs` is usually the plugin's author and the remedy is a manifest
 * edit, not a retry.
 */
export function pluginNetworkRefusalMessage(args: {
  pluginId: string;
  host: string;
  declared: readonly string[];
}): string {
  const { pluginId, host, declared } = args;
  const tail = declared.length === 0
    ? `${pluginId} declares no outbound network in its plugin.json.`
    : `${pluginId} declares ${declared.join(", ")}.`;
  return `Plugin "${pluginId}" tried to contact ${host}, which it does not declare. ${tail}`
    + ` Add the host to "network": { "hosts": [...] } and install it again.`;
}

/** The structured field every refusal carries, so the doctor can count them. */
export const PLUGIN_NETWORK_REFUSAL_LOG_CODE = "network_host_not_declared";
