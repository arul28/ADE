import type { PluginManifest } from "./manifest";

/**
 * The user's per-contribution off switch, resolved the same way everywhere.
 *
 * `disabledContributions` is a flat list of ids on the install record, written
 * by the contributions rail in the plugin detail view. Historically it held
 * exactly one kind of id — a manifest SOCKET id — and every reader spelled the
 * check as `new Set(record.disabledContributions).has(socket.id)`.
 *
 * That spelling does not extend to the five engine registrations
 * (`searchProviders`, `keybindings`, `automationTriggers`, `automationSteps`,
 * `urlMatchers`),
 * because their ids live in their own namespaces: a plugin may legitimately
 * declare a search provider `issues` and a lane-badge socket `issues`, and
 * folding them into one flat set would turn "hide the badge" into "stop
 * answering the palette". So registrations are keyed with their kind attached
 * — `search:issues`, `keybinding:mod+shift+i` — which no socket id can spell
 * (a socket id is a bare identifier, so it can never contain a colon).
 *
 * KNOWN GAP, deliberate: the contributions rail only renders socket rows today,
 * so nothing WRITES a registration key yet and these filters are inert in
 * practice. They are here so the enforcement is not the thing that has to be
 * remembered when the rail grows those rows — at that point the UI writes
 * `pluginRegistrationContributionKey(...)` and every consumer already honours
 * it. See `MarketplaceDetailRail.tsx`'s `ContributionsRail`.
 */

/** The registration kinds that can be turned off independently of the plugin. */
export type PluginRegistrationKind =
  | "search"
  | "keybinding"
  | "automationTrigger"
  | "automationStep"
  | "urlMatcher";

/**
 * The `disabledContributions` entry for one engine registration.
 *
 * The id term is the declaration's own identity: a provider/trigger/step id, or
 * a keybinding's `action` (the manifest gives keybindings no id of their own).
 */
export function pluginRegistrationContributionKey(
  kind: PluginRegistrationKind,
  id: string,
): string {
  return `${kind}:${id}`;
}

/** Has the user switched off this specific registration? */
export function isPluginRegistrationDisabled(
  disabledContributions: readonly string[] | null | undefined,
  kind: PluginRegistrationKind,
  id: string,
): boolean {
  if (!disabledContributions || disabledContributions.length === 0) return false;
  return disabledContributions.includes(pluginRegistrationContributionKey(kind, id));
}

/**
 * Every contribution key that would cause `actionId` to run.
 *
 * `tools` are excluded on purpose: an agent tool is not a placement the user can
 * toggle in the rail, and the tool map has its own gate (session kind + the
 * plugin's own enabled flag). Including it here would let a socket toggle
 * silently withdraw a tool the agent was told it had.
 */
function contributionKeysInvokingAction(
  manifest: PluginManifest | null | undefined,
  actionId: string,
): string[] {
  if (!manifest) return [];
  const keys: string[] = [];
  for (const socket of manifest.sockets) {
    if (socket.actionId === actionId) keys.push(socket.id);
  }
  for (const provider of manifest.searchProviders) {
    if ((provider.action || provider.id) === actionId) {
      keys.push(pluginRegistrationContributionKey("search", provider.id));
    }
  }
  for (const step of manifest.automationSteps) {
    if ((step.action || step.id) === actionId) {
      keys.push(pluginRegistrationContributionKey("automationStep", step.id));
    }
  }
  for (const binding of manifest.keybindings) {
    if (binding.action === actionId) {
      keys.push(pluginRegistrationContributionKey("keybinding", binding.action));
    }
  }
  return keys;
}

/**
 * Should `plugin.invoke` refuse this action because the user turned off every
 * contribution that offers it?
 *
 * The rule, and the reason it is not "any disabled contribution refuses": one
 * action is routinely reachable from several places — a lane row menu item and
 * a keyboard shortcut both calling `openIssue`. Turning off the row menu item
 * is a statement about that ROW, not about the action, and refusing the chord
 * as well would make one toggle silently disable a surface the user never
 * touched. So the action survives while any contribution that offers it is
 * still on, and is refused only when the user has switched off all of them.
 *
 * An action no contribution declares is never refused here. Plugins invoke
 * their own handlers from schedules, automations and CLI subcommands, and those
 * paths have their own gates; a handler nothing declares has no toggle to obey.
 */
export function pluginActionIsFullyDisabled(
  manifest: PluginManifest | null | undefined,
  disabledContributions: readonly string[] | null | undefined,
  actionId: string,
): boolean {
  if (!disabledContributions || disabledContributions.length === 0) return false;
  const keys = contributionKeysInvokingAction(manifest, actionId);
  if (keys.length === 0) return false;
  const off = new Set(disabledContributions);
  return keys.every((key) => off.has(key));
}
