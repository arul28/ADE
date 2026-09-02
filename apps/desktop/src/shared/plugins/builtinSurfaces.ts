/**
 * Everything ADE knows about a compiled surface beyond its bare identity — the
 * route it sits at, what to call it, the action domains and action names its
 * owner gates — and the one pure question "is that owner installed and enabled
 * here?".
 *
 * The id list, the polarity, the mobile ceiling and the bare
 * builtin-id → owner-plugin-id map live one module down, in
 * `builtinSurfaceRegistry.ts`, which imports nothing. This file is the rich
 * table hung off those ids; it does not spell an owner name of its own.
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

import {
  PLUGIN_BUILTIN_SURFACE_OWNER_IDS,
  PLUGIN_BUILTIN_SURFACE_PRESENCE,
  type PluginBuiltinSurfaceId,
} from "./builtinSurfaceRegistry";

export type BuiltinSurfaceOwner = {
  builtinId: PluginBuiltinSurfaceId;
  /** Null for compiled panes that live inside Work rather than at a route. */
  route: string | null;
  /**
   * The official plugin that owns it, read from
   * {@link PLUGIN_BUILTIN_SURFACE_OWNER_IDS} rather than spelled again here.
   *
   * That map is the registration, and it lives one module down in
   * `builtinSurfaceRegistry.ts` because `urlMatchers.ts` needs the same answer
   * and cannot import this file. Ownership is held in a table at all — rather
   * than discovered from whichever installed plugin happens to declare
   * `builtin` — so a plugin cannot take over a core surface by naming it: the
   * manifest field says "I gate the surface I am registered for", and the
   * registry is where it is registered.
   */
  ownerPluginId: string;
  /** What to call it when ADE has to explain that it is not here. */
  title: string;
  /**
   * ADE action domains this plugin owns, refused at dispatch when it is not
   * installed. An `"enables"` plugin is a whole vertical — its UI, its agent
   * tooling and its skills arrive and leave together — so hiding the pane while
   * `ios_simulator.tap` still answered would just move the confusion into the
   * agent.
   *
   * Only ever populated for an `"enables"` surface. A `"supersedes"` surface
   * must leave dispatch alone — ADE compiled those verbs and still serves them
   * — so it names its verbs in `actionNames` instead.
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
   * Individual ADE actions this surface owns, as `"<domain>.<action>"`, withheld
   * from every catalog while the surface is not drawn — but still dispatched.
   *
   * The domain-level list above REFUSES a call; this one only stops ADE from
   * advertising it. Two different surfaces need the softer form, for two
   * different reasons:
   *
   * - Cursor Cloud has no domain of its own. Every one of its verbs lives in
   *   `ai`, next to `getStatus`, the API-key verbs and the Cursor CLI login —
   *   refusing that whole domain would take the model picker down with it.
   * - Linear has three domains of its own and still may not refuse them,
   *   because it SUPERSEDES. Its verbs are ADE's own compiled Linear
   *   integration, which every chat, automation and paired phone on a machine
   *   without the plugin still runs. Refusing `linear_issue_tracker.listIssues`
   *   because `ade-linear` is installed would break the calls the plugin exists
   *   to take over, in the window before the agent has been told about the
   *   plugin's own tools. So the advertisement moves and the dispatch stays.
   *
   * Empty for every other surface. An `"enables"` vertical with a domain of its
   * own should use `actionDomains` and refuse outright: nothing was ever there
   * to keep serving.
   */
  actionNames: readonly string[];
};

/**
 * ADE's own compiled Linear verbs, across the three `linear_*` domains.
 *
 * The whole of `ADE_ACTION_ALLOWLIST`'s `linear_credentials`, `linear_oauth`
 * and `linear_issue_tracker` entries, written out rather than derived, for the
 * same reason Cursor Cloud's list is: this module is shared and the allowlist
 * lives in the main process, and a list a reader can check by eye is worth more
 * here than one that cannot drift. A verb added to a `linear_*` domain without
 * being added here keeps being advertised on a machine that has the plugin —
 * which the closed-list test in `builtinSurfaces.test.ts` catches.
 *
 * Note that the CONNECTION verbs are here, unlike Cursor Cloud's `cursorAuth*`.
 * `ade-linear` declares `credentialHandoff: ["linear"]`, so on a machine that
 * has the plugin the Linear token belongs to the plugin: an agent told to call
 * `linear_credentials.setToken` would be writing into a store nothing reads.
 */
const LINEAR_ACTION_NAMES: readonly string[] = [
  "linear_credentials.clearOAuthClientCredentials",
  "linear_credentials.clearToken",
  "linear_credentials.getStatus",
  "linear_credentials.setOAuthClientCredentials",
  "linear_credentials.setOAuthToken",
  "linear_credentials.setToken",
  "linear_oauth.getSession",
  "linear_oauth.startSession",
  "linear_issue_tracker.addIssueLabel",
  "linear_issue_tracker.addLabel",
  "linear_issue_tracker.createComment",
  "linear_issue_tracker.fetchIssueById",
  "linear_issue_tracker.fetchIssuesByIds",
  "linear_issue_tracker.fetchIssueComments",
  "linear_issue_tracker.graphql",
  "linear_issue_tracker.getIssuePickerData",
  "linear_issue_tracker.getConnectionStatus",
  "linear_issue_tracker.getQuickView",
  "linear_issue_tracker.getStatus",
  "linear_issue_tracker.getWorkflowCatalog",
  "linear_issue_tracker.listLabels",
  "linear_issue_tracker.listIssues",
  "linear_issue_tracker.listProjects",
  "linear_issue_tracker.listWorkflowStates",
  "linear_issue_tracker.listUsers",
  "linear_issue_tracker.removeIssueLabel",
  "linear_issue_tracker.searchIssues",
  "linear_issue_tracker.updateComment",
  "linear_issue_tracker.updateIssueAssignee",
  "linear_issue_tracker.updateIssueState",
];

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

/**
 * ADE's own compiled Review verbs.
 *
 * The `review` domain stays DISPATCHING on a machine that has `ade-review`:
 * the plugin's tools and panels call these, and an in-flight chat must not
 * fail because the catalog hid them. Advertisement is what moves.
 */
const REVIEW_ACTION_NAMES: readonly string[] = [
  "review.cancelRun",
  "review.deleteSuppression",
  "review.getRunDetail",
  "review.listLaunchContext",
  "review.listRuns",
  "review.listSuppressions",
  "review.qualityReport",
  "review.recordFeedback",
  "review.rerun",
  "review.startRun",
];

export const BUILTIN_SURFACE_OWNERS: readonly BuiltinSurfaceOwner[] = [
  {
    // Superseded: ADE shipped a compiled Graph tab, so `ade-graph` replaces
    // it rather than being the reason it exists. The React Flow engine stays
    // in core; this row gates the page, not the canvas.
    builtinId: "graph",
    route: "/graph",
    ownerPluginId: PLUGIN_BUILTIN_SURFACE_OWNER_IDS.graph,
    title: "Graph",
    actionDomains: [],
    actionNames: [],
  },
  {
    // Superseded: ADE shipped a compiled Review tab, so `ade-review` replaces
    // it rather than being the reason it exists.
    builtinId: "review",
    route: "/review",
    ownerPluginId: PLUGIN_BUILTIN_SURFACE_OWNER_IDS.review,
    title: "Review",
    actionDomains: [],
    actionNames: REVIEW_ACTION_NAMES,
  },
  {
    // Superseded: ADE shipped a compiled History tab, so `ade-history` replaces
    // it rather than being the reason it exists. Git and operation verbs stay
    // open — this row gates the page, not the engine.
    builtinId: "history",
    route: "/history",
    ownerPluginId: PLUGIN_BUILTIN_SURFACE_OWNER_IDS.history,
    title: "History",
    actionDomains: [],
    actionNames: [],
  },
  {
    // Superseded: ADE has shipped a compiled Linear integration since long
    // before the plugin platform, so `ade-linear` replaces it rather than being
    // the reason it exists. Polarity rule: `renderer/components/plugins/builtinTabs.ts`.
    builtinId: "linear",
    route: null,
    ownerPluginId: PLUGIN_BUILTIN_SURFACE_OWNER_IDS.linear,
    title: "Linear",
    // Deliberately empty, and this is the difference from an `"enables"`
    // vertical. Refusing `linear_issue_tracker.*` by domain would break every
    // machine that HAS the plugin — those verbs are what the compiled
    // integration still serves, and the plugin taking over the UI is not a
    // reason to fail a call an existing chat or automation is mid-way through.
    // The verbs stop being ADVERTISED instead; see `actionNames`.
    actionDomains: [],
    actionNames: LINEAR_ACTION_NAMES,
  },
  {
    // Superseded: ADE shipped compiled Work panes, so `ade-ios-sim` replaces
    // the Simulator pane rather than being the reason it exists. simctl/idb
    // stay in core; this row gates the Work rail entry, not the engine.
    builtinId: "ios",
    route: null,
    ownerPluginId: PLUGIN_BUILTIN_SURFACE_OWNER_IDS.ios,
    title: "iOS Simulator",
    actionDomains: [],
    actionNames: [],
  },
  {
    // Superseded: ADE shipped a compiled Electron Control pane, so
    // `ade-app-control` replaces it. CDP stays in core.
    builtinId: "app-control",
    route: null,
    ownerPluginId: PLUGIN_BUILTIN_SURFACE_OWNER_IDS["app-control"],
    title: "Electron Control",
    actionDomains: [],
    actionNames: [],
  },
  {
    // Superseded, like `linear` above: `ade-cursor-cloud` replaces ADE's
    // compiled fleet button, fleet modal, composer cloud row and `/cloud`
    // command rather than being the reason they exist. Both rows read the
    // opposite way from the `"enables"` ones — see
    // `PLUGIN_BUILTIN_SURFACE_PRESENCE`.
    builtinId: "cursor-cloud",
    route: null,
    ownerPluginId: PLUGIN_BUILTIN_SURFACE_OWNER_IDS["cursor-cloud"],
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
