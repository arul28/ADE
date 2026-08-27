/**
 * Which official plugin owns each compiled surface, and the one pure question
 * "is that owner installed and enabled here?".
 *
 * The renderer answers this from the plugin registry it already holds in the
 * root store; the main process answers it by reading `state.json` off disk. The
 * table and the predicate are the part that must not diverge between them — a
 * surface the rail hides but the CTO prompt still advertises is the same bug in
 * two directions — so they live here, in shared, with no React and no
 * filesystem. Each side brings its own records and its own caching.
 *
 * The React hooks and the "we do not know yet" rules stay in the renderer's
 * `builtinTabs.ts`, which derives from this. What moved is only the table and
 * the membership test.
 */

import { PLUGIN_BUILTIN_SURFACE_PRESENCE, type PluginBuiltinSurfaceId } from "./manifest";

export type BuiltinSurfaceOwner = {
  builtinId: PluginBuiltinSurfaceId;
  /** Null for compiled panes that live inside Work rather than at a route. */
  route: string | null;
  /**
   * The official plugin that owns it. Held in this table rather than discovered
   * from whichever installed plugin happens to declare `builtin`, so a plugin
   * cannot take over a core surface by naming it: the manifest field says "I
   * gate the surface I am registered for", and this table is the registration.
   */
  ownerPluginId: string;
  /** What to call it when ADE has to explain that it is not here. */
  title: string;
  /**
   * ADE action domains this plugin owns, refused at dispatch when it is not
   * installed. A plugin is a whole vertical — its UI, its agent tooling and its
   * skills arrive and leave together — so hiding the pane while `linear.comment`
   * still answers would just move the confusion into the agent.
   *
   * Typed as plain strings because `AdeActionDomain` lives in the main process
   * and this module is shared; main narrows on the way in, and a name that is
   * not a real domain gates nothing rather than throwing.
   *
   * Empty for the surfaces that expose no agent tooling of their own: Graph,
   * Review and History are read-only views over state other domains already
   * own, so there is nothing here to refuse.
   */
  actionDomains: readonly string[];
  /**
   * Individual ADE actions this surface owns, as `"<domain>.<action>"`, inside a
   * domain ADE keeps for itself.
   *
   * The domain-level list above is the normal way to gate agent tooling, and it
   * works because a plugin's verbs usually get a domain of their own. Cursor
   * Cloud's do not: every one of them lives in `ai`, next to `getStatus`, the
   * API-key verbs and the Cursor CLI login — refusing that whole domain would
   * take the model picker down with it. So these are named one at a time.
   *
   * Empty for every other surface, and it should stay that way: a new plugin
   * vertical should be given its own domain rather than a longer list here.
   */
  actionNames: readonly string[];
};

/**
 * Cursor Cloud's verbs inside the `ai` domain.
 *
 * Written out rather than matched by prefix or substring so that adding an
 * `ai.*` action never silently joins the gated set, and so a reader can see the
 * whole boundary in one place. Note what is deliberately NOT here: the
 * `cursorAuth*` verbs. Those are the Cursor API-key connection, which the Cursor
 * chat provider and the Cursor CLI both still need whether or not the plugin is
 * installed.
 */
const CURSOR_CLOUD_ACTION_NAMES: readonly string[] = [
  "ai.listCursorCloudRepositories",
  "ai.listCursorCloudAgents",
  "ai.listCursorCloudRuns",
  "ai.createCursorCloudRun",
  "ai.getCursorCloudLaneSecretNames",
  "ai.archiveCursorCloudAgent",
  "ai.unarchiveCursorCloudAgent",
  "ai.deleteCursorCloudAgent",
  "ai.getCursorCloudAgent",
  "ai.listCursorCloudArtifacts",
  "ai.downloadCursorCloudArtifact",
  "ai.cursorCloudStreamRun",
  "ai.cancelCursorCloudRun",
  "ai.cursorCloudFollowUp",
  "ai.openCursorCloudChat",
  "ai.watchCursorCloudMirror",
  "ai.getCursorCloudFleet",
  "ai.resolveCursorCloudAgentLane",
  "ai.pullCursorCloudAgentIntoLane",
  "ai.stopCursorCloudAgentRun",
];

export const BUILTIN_SURFACE_OWNERS: readonly BuiltinSurfaceOwner[] = [
  { builtinId: "graph", route: "/graph", ownerPluginId: "ade-graph", title: "Graph", actionDomains: [], actionNames: [] },
  { builtinId: "review", route: "/review", ownerPluginId: "ade-review", title: "Review", actionDomains: [], actionNames: [] },
  { builtinId: "history", route: "/history", ownerPluginId: "ade-history", title: "History", actionDomains: [], actionNames: [] },
  {
    builtinId: "linear",
    route: null,
    ownerPluginId: "ade-linear",
    title: "Linear",
    // The connection domains are here on purpose: uninstalling deletes the
    // stored Linear credentials, so an agent that could still call
    // `linear_oauth.startSession` would be re-connecting an integration the
    // machine no longer has a home for.
    actionDomains: ["linear_credentials", "linear_oauth", "linear_issue_tracker"],
    actionNames: [],
  },
  { builtinId: "ios", route: null, ownerPluginId: "ade-ios-sim", title: "iOS Simulator", actionDomains: ["ios_simulator"], actionNames: [] },
  { builtinId: "app-control", route: null, ownerPluginId: "ade-app-control", title: "Electron Control", actionDomains: ["app_control"], actionNames: [] },
  {
    // The one SUPERSEDED surface: `ade-cursor-cloud` replaces ADE's compiled
    // fleet button, fleet modal, composer cloud row and `/cloud` command rather
    // than being the reason they exist. Its row therefore reads the opposite way
    // from every other one here — see `PLUGIN_BUILTIN_SURFACE_PRESENCE`.
    builtinId: "cursor-cloud",
    route: null,
    ownerPluginId: "ade-cursor-cloud",
    title: "Cursor Cloud",
    // No domain of its own: ADE's Cursor Cloud verbs live in `ai`. They are
    // named individually below instead.
    actionDomains: [],
    actionNames: CURSOR_CLOUD_ACTION_NAMES,
  },
];

/** The presence rule for a surface: does its plugin enable it or replace it? */
export function builtinSurfacePresence(
  builtinId: PluginBuiltinSurfaceId,
): "enables" | "supersedes" {
  return PLUGIN_BUILTIN_SURFACE_PRESENCE[builtinId];
}

/** The surface that owns an action domain, or null for ADE's own domains. */
export function builtinSurfaceOwnerForActionDomain(domain: string): BuiltinSurfaceOwner | null {
  return BUILTIN_SURFACE_OWNERS.find((owner) => owner.actionDomains.includes(domain)) ?? null;
}

/** Every action domain that any plugin gates, in table order. */
export function gatedBuiltinActionDomains(): string[] {
  return BUILTIN_SURFACE_OWNERS.flatMap((owner) => [...owner.actionDomains]);
}

export function builtinSurfaceOwnerForRoute(route: string): BuiltinSurfaceOwner | null {
  return BUILTIN_SURFACE_OWNERS.find((owner) => owner.route === route) ?? null;
}

export function builtinSurfaceOwnerForPlugin(pluginId: string): BuiltinSurfaceOwner | null {
  return BUILTIN_SURFACE_OWNERS.find((owner) => owner.ownerPluginId === pluginId) ?? null;
}

export function builtinSurfaceOwner(builtinId: PluginBuiltinSurfaceId): BuiltinSurfaceOwner {
  const owner = BUILTIN_SURFACE_OWNERS.find((candidate) => candidate.builtinId === builtinId);
  if (!owner) throw new Error(`No owner registered for builtin surface ${builtinId}`);
  return owner;
}

/**
 * The shape both sides already have: the renderer's `InstalledPlugin` and the
 * main process's `PluginInstallRecord` both carry these two fields, and nothing
 * else about either is needed to answer the question.
 */
export type BuiltinSurfaceInstallRecord = {
  pluginId: string;
  enabled: boolean;
};

/**
 * The pure half of the gate: the registry says this surface's owner is here and
 * switched on.
 *
 * Deliberately NOT the whole renderer predicate. It knows nothing about whether
 * the registry has loaded or whether this host publishes plugins at all, and a
 * caller that cannot establish those has to treat a false-y registry as "not
 * installed" itself — which is what `isBuiltinSurfaceVisible` does.
 */
export function builtinSurfaceInstalled(
  builtinId: PluginBuiltinSurfaceId,
  installedRecords: Iterable<BuiltinSurfaceInstallRecord>,
): boolean {
  const ownerId = builtinSurfaceOwner(builtinId).ownerPluginId;
  for (const record of installedRecords) {
    if (record.pluginId === ownerId && record.enabled) return true;
  }
  return false;
}

/**
 * Whether ADE's own compiled page for this surface is part of the product,
 * given a registry that has already resolved.
 *
 * This is the polarity-aware twin of {@link builtinSurfaceInstalled}, and it is
 * what every caller that draws or advertises a compiled surface should ask.
 * `builtinSurfaceInstalled` answers a question about the PLUGIN; this one
 * answers the question about the PIXELS, and for a superseded surface those are
 * opposites.
 *
 * It still knows nothing about "we have not asked yet" — a caller that cannot
 * establish a resolved registry has to decide that itself, and the two polarities
 * decide it differently. See `isBuiltinSurfaceVisible` in the renderer.
 */
export function builtinSurfaceDrawn(
  builtinId: PluginBuiltinSurfaceId,
  installedRecords: Iterable<BuiltinSurfaceInstallRecord>,
): boolean {
  const installed = builtinSurfaceInstalled(builtinId, installedRecords);
  return builtinSurfacePresence(builtinId) === "supersedes" ? !installed : installed;
}

/** Every `"<domain>.<action>"` any surface gates one name at a time. */
export function gatedBuiltinActionNames(): string[] {
  return BUILTIN_SURFACE_OWNERS.flatMap((owner) => [...owner.actionNames]);
}

/**
 * The `"<domain>.<action>"` names to leave out of an action catalog right now,
 * because the surface that owns them is not drawn on this machine.
 *
 * Withholding a name is not the same as refusing the call. ADE still compiles
 * every one of these verbs and still serves the chats that already depend on
 * them; what stops is ADE telling an agent to go and use a surface the user
 * cannot see. The plugin advertises its own tools in their place.
 */
export function hiddenBuiltinActionNames(
  installedRecords: Iterable<BuiltinSurfaceInstallRecord>,
): Set<string> {
  const records = [...installedRecords];
  const hidden = new Set<string>();
  for (const owner of BUILTIN_SURFACE_OWNERS) {
    if (owner.actionNames.length === 0) continue;
    if (builtinSurfaceDrawn(owner.builtinId, records)) continue;
    for (const name of owner.actionNames) hidden.add(name);
  }
  return hidden;
}
