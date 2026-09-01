/**
 * Refusing an action domain whose plugin is not on this machine.
 *
 * An `"enables"` plugin is a whole vertical: its pane, its agent tooling and its
 * skills arrive and leave together. Round 2 hid the UI; hiding the UI alone
 * would only have moved the confusion into the agent, which would keep calling
 * `ios_simulator.tap` against a machine that has no simulator pane.
 *
 * A `"supersedes"` surface is refused by NOTHING here. ADE compiled those verbs
 * and still answers them, because the plugin replacing the UI is not a reason to
 * fail a call an existing chat or automation is part-way through. Those verbs
 * stop being ADVERTISED instead — see {@link resolveHiddenActionNames}.
 *
 * ## The refusal is policy, never a missing method
 *
 * `methodNotFound` reads as "this ADE is too old" and sends a client down its
 * legacy-host fallback — a bug class this repo has already paid for once. A
 * gated domain exists, is spelled correctly, and is refused, so it answers
 * `policyDenied` with a message that names the fix.
 *
 * ## The copy comes from the catalog, not from here
 *
 * This module knows only the JOIN KEY: which plugin id owns which domain, from
 * the shared surface table. The human name comes from the bundled package
 * manifests and the cached registry index — the same two sources the
 * Marketplace renders from. When neither knows the plugin, there is NO invented
 * hint: the caller falls back to its plain unknown-domain error rather than
 * telling a user to install something ADE cannot name.
 */

import fs from "node:fs";
import path from "node:path";

import {
  BUILTIN_SURFACE_OWNERS,
  builtinSurfaceDrawn,
  builtinSurfaceInstalled,
  builtinSurfaceOwnerForActionDomain,
  builtinSurfacePresence,
  gatedBuiltinActionDomains,
  gatedBuiltinActionNames,
  hiddenBuiltinActionNames,
  type BuiltinSurfaceOwner,
} from "../../../shared/plugins/builtinSurfaces";
import { isRecord } from "../../../shared/plugins/parse";
import { parsePluginRegistryIndex } from "../../../shared/plugins/registryIndex";
import { resolveBuiltinPluginsRoot } from "./pluginInstallService";
import { readPluginInstallRecords, resolvePluginsRoot } from "./pluginRegistryFile";

export type GatedDomainDenial = {
  domain: string;
  pluginId: string;
  message: string;
  data: { kind: "plugin_not_installed"; domain: string; pluginId: string };
};

/** Every domain any plugin gates, whether or not that plugin is installed. */
export function allGatedActionDomains(): ReadonlySet<string> {
  return new Set(gatedBuiltinActionDomains());
}

/**
 * The domains to refuse right now: owned by a plugin that is not installed and
 * enabled on this machine.
 *
 * Reads the registry leniently, so a `state.json` this build cannot parse gates
 * everything rather than opening every plugin domain on a corrupt file.
 */
export function resolveDisabledActionDomains(
  pluginsRoot: string = resolvePluginsRoot(),
): Set<string> {
  const records = [...readPluginInstallRecords(pluginsRoot).values()];
  const disabled = new Set<string>();
  for (const domain of gatedBuiltinActionDomains()) {
    const owner = builtinSurfaceOwnerForActionDomain(domain);
    if (!owner) continue;
    if (!builtinSurfaceInstalled(owner.builtinId, records)) disabled.add(domain);
  }
  return disabled;
}

/** Every `"<domain>.<action>"` any surface gates, whether or not it is drawn. */
export function allGatedActionNames(): ReadonlySet<string> {
  return new Set(gatedBuiltinActionNames());
}

/**
 * The `"<domain>.<action>"` names to leave out of an action catalog right now.
 *
 * The name-level twin of {@link resolveDisabledActionDomains}, and it covers the
 * two surfaces that must not refuse: Cursor Cloud, whose verbs share the `ai`
 * domain ADE keeps, and Linear, which supersedes an integration ADE compiled
 * and still serves. It is a WITHHOLDING, not a refusal: the verbs still
 * dispatch, so a chat already bound to a cloud agent or a Linear issue keeps
 * working while the built-in UI is hidden. What stops is ADE listing a
 * surface's verbs to an agent when the user cannot see that surface.
 *
 * Reads the registry through the same lenient path the domain gate uses, so an
 * unparseable `state.json` withholds rather than advertises.
 */
export function resolveHiddenActionNames(
  pluginsRoot: string = resolvePluginsRoot(),
): ReadonlySet<string> {
  return hiddenBuiltinActionNames([...readPluginInstallRecords(pluginsRoot).values()]);
}

/** How a plugin id becomes a name a user recognizes. Injectable for tests. */
export type PluginDisplayNameLookup = (pluginId: string) => string | null;

function bundledPackageDisplayName(pluginId: string, builtinRoot: string | null): string | null {
  if (!builtinRoot) return null;
  // Bundled packages sit one category deep at most, same as the install path's
  // own walk. Reading the manifest directly keeps this a cold-path fs read with
  // no service to construct.
  const candidates = [path.join(builtinRoot, pluginId)];
  try {
    for (const entry of fs.readdirSync(builtinRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(builtinRoot, entry.name, pluginId));
    }
  } catch {
    // An unreadable bundled root is one missing source, not a failure.
  }
  for (const candidate of candidates) {
    try {
      const decoded: unknown = JSON.parse(fs.readFileSync(path.join(candidate, "plugin.json"), "utf8"));
      if (isRecord(decoded) && typeof decoded.displayName === "string" && decoded.displayName.trim()) {
        return decoded.displayName.trim();
      }
    } catch {
      // Not this candidate.
    }
  }
  return null;
}

function cachedRegistryDisplayName(pluginId: string, pluginsRoot: string): string | null {
  // The registry service owns fetching and TTLs; the denial path only wants
  // whatever already landed on disk, so it reads the cache file itself rather
  // than constructing a service (and a logger) to answer one string.
  try {
    const decoded: unknown = JSON.parse(
      fs.readFileSync(path.join(pluginsRoot, ".index-cache.json"), "utf8"),
    );
    if (!isRecord(decoded)) return null;
    const parsed = parsePluginRegistryIndex(decoded.index);
    const entry = parsed.index?.entries.find((candidate) => candidate.pluginId === pluginId);
    // `displayName` falls back to the id inside the parser, which is not a name
    // a user recognizes — treat that as "the catalog does not know it".
    const name = entry?.displayName?.trim();
    return name && name !== pluginId ? name : null;
  } catch {
    return null;
  }
}

/**
 * The default lookup: bundled manifests first, then the cached registry index.
 *
 * Bundled first because it ships with the app and answers on a fresh, offline
 * machine — exactly the machine most likely to be missing a plugin.
 */
export function pluginDisplayNameFromCatalog(
  pluginId: string,
  options: { builtinPluginsRoot?: string | null; pluginsRoot?: string } = {},
): string | null {
  const builtinRoot = options.builtinPluginsRoot !== undefined
    ? options.builtinPluginsRoot
    : resolveBuiltinPluginsRoot();
  return bundledPackageDisplayName(pluginId, builtinRoot)
    ?? cachedRegistryDisplayName(pluginId, options.pluginsRoot ?? resolvePluginsRoot());
}

const defaultLookup: PluginDisplayNameLookup = (pluginId) => pluginDisplayNameFromCatalog(pluginId);

/**
 * The one sentence every refusal uses, or null when no catalog can name the
 * plugin — in which case the caller keeps its own generic error rather than
 * telling a user to install something ADE cannot name.
 */
export function pluginNotInstalledMessage(
  pluginId: string,
  lookupDisplayName: PluginDisplayNameLookup = defaultLookup,
): string | null {
  const displayName = lookupDisplayName(pluginId)?.trim();
  if (!displayName) return null;
  return `This machine doesn't have ${displayName}. It's provided by the ${pluginId} plugin — available in the Marketplace.`;
}

/**
 * The same refusal for a plugin named DIRECTLY rather than through a domain —
 * an automation step that points at `{ pluginId, action }`.
 *
 * Always a sentence, never null, and that is the difference from
 * `pluginNotInstalledMessage`. The domain path can afford silence because it
 * has its own generic unknown-domain error to fall back to; an automation step
 * has none — the sentence IS the run's `errorMessage`, and an empty one would
 * leave a failed run with nothing on it. So a cold catalog degrades the copy
 * instead of withholding it, exactly as `buildMissingSurfaceDenial` does: name
 * the plugin id, which is a registered fact, and stop short of pointing anyone
 * at a Marketplace listing for a package ADE cannot describe.
 */
export function pluginStepUnavailableMessage(
  pluginId: string,
  lookupDisplayName: PluginDisplayNameLookup = defaultLookup,
): string {
  return pluginNotInstalledMessage(pluginId, lookupDisplayName)
    ?? `This machine doesn't have the ${pluginId} plugin.`;
}

/**
 * Why an automation's plugin step cannot run right now, or null when it can.
 *
 * The whole `pluginAvailability` dependency `automationService` takes, in one
 * function. It lives here rather than in the automation service because the
 * decision is the same decision the gated-domain path makes — is this plugin on
 * this machine? — and the copy has to be the same sentence either way.
 *
 * Reads the install registry file directly rather than asking a plugin service,
 * for the same reason the rest of this module does: the host is a daemon-side
 * singleton that the Electron main process never builds, and both processes
 * construct automation services.
 */
export function pluginStepUnavailableReason(
  pluginId: string,
  options: { pluginsRoot?: string; lookupDisplayName?: PluginDisplayNameLookup } = {},
): string | null {
  const record = readPluginInstallRecords(options.pluginsRoot ?? resolvePluginsRoot()).get(pluginId);
  // Disabled counts as unavailable: a disabled plugin's child does not start,
  // so the invoke would fail anyway — with the host's internal wording rather
  // than a sentence naming what to switch back on.
  if (record?.enabled) return null;
  return pluginStepUnavailableMessage(pluginId, options.lookupDisplayName ?? defaultLookup);
}

/**
 * The refusal for a gated domain, or null when there is nothing honest to say.
 *
 * Null has two causes and the caller treats them the same way — fall through to
 * the ordinary unknown-domain error: the domain is not gated at all (an ADE
 * domain, or a typo), or it is gated but no catalog can name its owner.
 */
export function buildGatedDomainDenial(
  domain: string,
  lookupDisplayName: PluginDisplayNameLookup = defaultLookup,
): GatedDomainDenial | null {
  const owner: BuiltinSurfaceOwner | null = builtinSurfaceOwnerForActionDomain(domain);
  if (!owner) return null;
  const message = pluginNotInstalledMessage(owner.ownerPluginId, lookupDisplayName);
  if (!message) return null;
  return {
    domain,
    pluginId: owner.ownerPluginId,
    message,
    data: { kind: "plugin_not_installed", domain, pluginId: owner.ownerPluginId },
  };
}

/**
 * Why an automation's ADE-action step cannot run right now, or null when it can.
 *
 * The domain-shaped twin of {@link pluginStepUnavailableReason}, and it exists
 * because the two halves are easy to get wrong apart.
 * {@link buildGatedDomainDenial} only WRITES the sentence — it resolves the
 * owner from the table and never asks whether that owner is installed — so a
 * caller that treats it as the whole answer refuses every gated domain,
 * including the ones this machine has. Both automation registries did exactly
 * that. Keeping the pair in one exported function is what stops the next one.
 */
export function gatedDomainUnavailableReason(
  domain: string,
  options: { pluginsRoot?: string; lookupDisplayName?: PluginDisplayNameLookup } = {},
): string | null {
  const pluginsRoot = options.pluginsRoot ?? resolvePluginsRoot();
  if (!resolveDisabledActionDomains(pluginsRoot).has(domain)) return null;
  return buildGatedDomainDenial(domain, options.lookupDisplayName ?? defaultLookup)?.message ?? null;
}

/**
 * The same refusal for a whole compiled surface, for transports that expose a
 * plugin's capability as named methods rather than as an action domain — the
 * sync command surface phones and the web client call.
 *
 * Null means ONLY "ADE still draws this surface here". Unlike the action-domain
 * helper,
 * a cold catalog must not turn into a pass here: the domain path still refuses
 * with its own generic error when this returns null, but a sync command has no
 * such fallback, so failing open would leave every paired phone reading and
 * writing through a plugin the machine no longer has. The catalog decides how
 * much ADVICE the message carries, never whether the call is allowed.
 */
export function buildMissingSurfaceDenial(
  builtinId: string,
  options: { pluginsRoot?: string; lookupDisplayName?: PluginDisplayNameLookup } = {},
): { pluginId: string; message: string } | null {
  const owner = BUILTIN_SURFACE_OWNERS.find((candidate) => candidate.builtinId === builtinId);
  if (!owner) return null;
  const pluginsRoot = options.pluginsRoot ?? resolvePluginsRoot();
  const records = [...readPluginInstallRecords(pluginsRoot).values()];
  // `Drawn`, not `Installed`: the question a sync command has is whether ADE's
  // own compiled handler is still part of this machine, and for a superseded
  // surface that is the opposite of "is the plugin here". A phone attached to a
  // machine with no `ade-linear` must reach ADE's compiled Linear commands, the
  // way it always did.
  if (builtinSurfaceDrawn(owner.builtinId, records)) return null;
  if (builtinSurfacePresence(owner.builtinId) === "supersedes") {
    // The refusal reads the other way round too. Nothing is missing here — the
    // plugin arrived and took the surface over — so telling the user to install
    // it would be the opposite of the truth. The phone reads this as "stop
    // calling the compiled command" and draws the plugin's panels instead.
    return {
      pluginId: owner.ownerPluginId,
      message: `The ${owner.ownerPluginId} plugin provides ${owner.title} on this computer. Open it from the plugin's own screen.`,
    };
  }
  const message = pluginNotInstalledMessage(owner.ownerPluginId, options.lookupDisplayName ?? defaultLookup);
  return {
    pluginId: owner.ownerPluginId,
    // No catalog reachable: name the plugin id, which is a registered fact, and
    // stop there. Pointing someone at the Marketplace for a package ADE cannot
    // describe would be advice invented to fill the gap.
    message: message ?? `This machine doesn't have the ${owner.ownerPluginId} plugin.`,
  };
}
