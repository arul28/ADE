/**
 * What a reader is told before a plugin install happens — derived from the
 * manifest, in one place, for every surface that asks.
 *
 * The Marketplace modal has always built this list. It is now shared because a
 * second surface needs the identical sentences: an agent that calls
 * `plugin.install` no longer gets a flat refusal, it raises an approval card in
 * the chat, and that card is the only thing standing between a sentence an
 * agent wrote and third-party code on the machine.
 *
 * ## The copy is derived, never quoted
 *
 * Every string here comes from the manifest the HOST parsed off the source, or
 * from a fact the host resolved itself (which source kind, whether the bundled
 * catalogue vouches for it). Nothing an agent typed into the action arguments
 * reaches the card as prose. The one exception is the source string itself,
 * which is shown verbatim precisely BECAUSE it is the thing being approved —
 * the same way the install modal shows it.
 *
 * ## A source that cannot be read says so
 *
 * A git URL has no manifest until something clones it, and inspecting must
 * never be the step that puts code on the machine. Such a source produces an
 * honest low-information disclosure ("ADE can't read this without downloading
 * it") rather than an invented feature list — the install modal already
 * behaves this way, and the two must not drift.
 */

import { builtinSurfaceOwner } from "./builtinSurfaces";
import { PLUGIN_SKILL_NEXT_TURN_NOTE } from "./clientRendering";
import { PLUGIN_PROVIDER_KEY_LABELS, type PluginManifest } from "./manifest";
import { PLUGIN_SURFACE_IDS, type PluginSocketKind, type PluginSurfaceId } from "./sockets";

/** The surface names a reader sees, canonical across the modal and the card. */
export const PLUGIN_SURFACE_LABELS: Record<PluginSurfaceId, string> = {
  work: "Work",
  lanes: "Lanes",
  files: "Files",
  prs: "PRs",
  automations: "Automations",
  cto: "CTO",
  app: "App",
  settings: "Settings",
};

/**
 * What each socket kind IS, in the words of someone who has never read the
 * taxonomy.
 *
 * The Marketplace's per-contribution switches printed only the plugin author's
 * own label and the surface, so HN's two additions — a button in the chat header
 * and a pane in the Work tools rail — both read "HN in Work". Two identical rows
 * with two different effects, and the only way to tell which switch did what was
 * to flip one and go looking.
 *
 * These are nouns for a THING ON SCREEN, not the kind's identifier prettified.
 * `work-rail-pane` is "Work tools pane" because that is the rail it appears in;
 * nobody has to learn what a rail pane is to recognize one. The one place the
 * kind's own word survives is where the product uses it too — a slash command
 * is called a slash command everywhere.
 */
export const PLUGIN_SOCKET_KIND_LABELS: Record<PluginSocketKind, string> = {
  "toolbar-action": "Toolbar button",
  "row-badge": "Row badge",
  "row-menu-item": "Row menu item",
  "detail-section": "Detail section",
  "empty-state": "Empty-state button",
  "filter-chip": "Filter chip",
  "file-viewer": "File viewer",
  "composer-action": "Composer button",
  "chat-header-action": "Chat header button",
  "chat-card": "Chat card",
  "slash-command": "Slash command",
  "command-palette-action": "Command palette action",
  "settings-section": "Settings section",
  "work-rail-pane": "Work tools pane",
  "drawer-tab": "Chat drawer tab",
  "activity-entry": "Activity entry",
  // "Graph node", not "Graph shape" or "Canvas node": the Graph tab calls the
  // things on it nodes in its own empty state and its own tooltips, so a reader
  // who has opened that tab already has the word.
  "graph-node": "Graph node",
  "dialog-section": "Dialog section",
  // Nouns for the thing on screen, as the rule above says. "Composer menu row"
  // rather than "Composer menu item": the reader is being told a row appears in
  // a menu they already open, and "item" is the taxonomy's word, not theirs.
  "composer-menu-item": "Composer menu row",
  "chat-menu-item": "Chat menu row",
  // "Machine picker row", not "Machine entry": the picker is what the reader
  // opens to choose where a chat runs, and the sentence has to say that a new
  // place to run things is being added.
  "machine-entry": "Machine picker row",
  "automation-trigger-tile": "Automation trigger",
  "automation-template": "Automation template",
};

/**
 * "Chat header button in Work" — one contribution, said in full.
 *
 * Joined here rather than at each caller so the toggle row, its `aria-label` and
 * anything that comes later cannot spell the same fact two ways.
 */
export function describePluginContributionPlacement(
  socket: PluginSocketKind,
  surface: PluginSurfaceId,
): string {
  // A `row-badge` on `app` is the notification pill on the plugin's own tab,
  // not a chip on an App row — App has no rows. Said that way so the install
  // sheet and the per-contribution switch do not read as "Row badge in App".
  if (socket === "row-badge" && surface === "app") {
    return "Notification badge on its tab";
  }
  // Three kinds whose own label already names the place. "Automation trigger in
  // Automations" says the word twice and the second one carries nothing, and a
  // machine picker row is not "in Work" in any sense a reader would recognize —
  // the picker is a control inside the composer, not a region of the tab.
  if (socket === "automation-trigger-tile" || socket === "automation-template" || socket === "machine-entry") {
    return PLUGIN_SOCKET_KIND_LABELS[socket];
  }
  return `${PLUGIN_SOCKET_KIND_LABELS[socket]} in ${PLUGIN_SURFACE_LABELS[surface]}`;
}

/**
 * `a`, `a and b`, `a, b and c`. Named for its first caller and used by every
 * list on this card since — hosts and provider names included — because one
 * spelling of the Oxford-comma question is the point.
 */
export function joinSurfaceNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Are these two surfaces the same feature declared twice?
 *
 * A plugin that wants a rich desktop tab AND the cross-device panel behind it
 * declares both: a `webview` for the HTML, and a `tab` for the vocabulary panel
 * every other client renders in its place. That is the recommended shape — see
 * `PluginSurfaceKind` — and the disclosure printed it as two separate gifts,
 * "Focus tab" and "Focus tab — desktop only, custom UI", which reads as a plugin
 * taking two tabs in the rail. It takes one.
 *
 * Two signals, either of which is enough. A shared `panelId` is the strong one:
 * the webview's panel IS what the other clients draw, so a tab rendering the
 * same panel is that same surface. A shared title is the weak one, kept because
 * an author may point the two at different panel ids and the reader still sees
 * one name on the rail either way.
 */
function surfacesAreTwoHalvesOfOne(
  tab: PluginManifest["surfaces"][number],
  webview: PluginManifest["surfaces"][number],
): boolean {
  if (tab.panelId && tab.panelId === webview.panelId) return true;
  const left = tab.title.trim().toLowerCase();
  const right = webview.title.trim().toLowerCase();
  return left.length > 0 && left === right;
}

/**
 * Tab surface id → the webview surface id that is its other half.
 *
 * Greedy first-match, and derived in ONE place so the "Adds:" and "Removes:"
 * lists cannot pair differently and print different surface counts for one
 * manifest. A pair is claimed once: two tabs sharing a title with a single
 * webview leave the second tab unpaired rather than both claiming it.
 */
function pairedSurfaceHalves(manifest: PluginManifest): Map<string, string> {
  const pairs = new Map<string, string>();
  const webviews = manifest.surfaces.filter((surface) => surface.kind === "webview");
  if (webviews.length === 0) return pairs;
  const claimed = new Set<string>();
  for (const tab of manifest.surfaces.filter((surface) => surface.kind === "tab")) {
    const twin = webviews.find((webview) =>
      !claimed.has(webview.id) && surfacesAreTwoHalvesOfOne(tab, webview));
    if (!twin) continue;
    claimed.add(twin.id);
    pairs.set(tab.id, twin.id);
  }
  return pairs;
}

/**
 * Webviews that are not rail tabs: popovers, settings hosts, dialogs, cards.
 *
 * Listing each as "X tab — desktop only, custom UI" is how Linear's install
 * card printed six tabs including two identical "Linear issue" lines. Those
 * pages are already counted as sockets ("One addition to Settings"). The
 * remaining popovers/dialogs collapse to one sentence.
 */
const EMBEDDED_WEBVIEW_SOCKETS = new Set<PluginSocketKind>([
  "settings-section",
  "dialog-section",
  "chat-card",
]);

function webviewIsEmbeddedChrome(manifest: PluginManifest, webviewId: string): boolean {
  const surface = manifest.surfaces.find((entry) => entry.kind === "webview" && entry.id === webviewId);
  if (surface?.kind === "webview" && surface.popover) return true;
  return manifest.sockets.some((socket) =>
    socket.webviewSurfaceId === webviewId && EMBEDDED_WEBVIEW_SOCKETS.has(socket.socket),
  );
}

function unpairedTabWebviews(manifest: PluginManifest): {
  tabs: Array<{ id: string; title: string }>;
  extraPickers: boolean;
} {
  const pairs = pairedSurfaceHalves(manifest);
  const pairedWebviewIds = new Set(pairs.values());
  const tabs: Array<{ id: string; title: string }> = [];
  const seenTitles = new Set<string>();
  let extraPickers = false;
  for (const surface of manifest.surfaces) {
    if (surface.kind !== "webview") continue;
    if (pairedWebviewIds.has(surface.id)) continue;
    if (webviewIsEmbeddedChrome(manifest, surface.id)) {
      extraPickers = extraPickers
        || Boolean(surface.popover)
        || manifest.sockets.some((socket) =>
          socket.webviewSurfaceId === surface.id && socket.socket !== "settings-section");
      continue;
    }
    if (seenTitles.has(surface.title)) continue;
    seenTitles.add(surface.title);
    tabs.push({ id: surface.id, title: surface.title });
  }
  return { tabs, extraPickers };
}

/**
 * The "Adds:" lines for a manifest — what the plugin itself declared.
 *
 * Counts declarations rather than repeating a summary, so the list cannot
 * flatter the plugin: a package that claims to add nothing and declares six
 * sockets produces six lines.
 */
export function describeManifestAdds(manifest: PluginManifest): string[] {
  const lines: string[] = [];
  const tabs = manifest.surfaces.filter((surface) => surface.kind === "tab");
  const panes = manifest.surfaces.filter((surface) => surface.kind === "pane");
  const pairs = pairedSurfaceHalves(manifest);
  for (const tab of tabs) {
    lines.push(pairs.has(tab.id)
      // One rail item, two renderers. Said in one line because two lines read as
      // two tabs, which is what the reader was counting.
      ? `${tab.title} tab (custom UI on desktop; panel on other devices)`
      : `${tab.title} tab`);
  }
  // Honest by construction now: the manifest parser refuses a `pane` that
  // carries no honoured `builtin`, so every pane that reaches here is a
  // COMPILED ADE pane the plugin gates — one the user really does get back by
  // installing it. Before that refusal this line promised a surface no client
  // had ever drawn.
  for (const pane of panes) lines.push(`${pane.title} pane`);
  const unpaired = unpairedTabWebviews(manifest);
  for (const webview of unpaired.tabs) {
    lines.push(`${webview.title} tab — desktop only, custom UI`);
  }
  if (unpaired.extraPickers) {
    lines.push("Issue pickers and cards on desktop");
  }

  const bySurface = new Map<PluginSurfaceId, number>();
  for (const socket of manifest.sockets) {
    bySurface.set(socket.surface, (bySurface.get(socket.surface) ?? 0) + 1);
  }
  for (const surface of PLUGIN_SURFACE_IDS) {
    const total = bySurface.get(surface);
    if (!total) continue;
    lines.push(total === 1
      ? `One addition to ${PLUGIN_SURFACE_LABELS[surface]}`
      : `${total} additions to ${PLUGIN_SURFACE_LABELS[surface]}`);
  }

  if (manifest.cli.length > 0) {
    lines.push(`Terminal commands: ${manifest.cli.map((word) => `ade ${manifest.name} ${word}`).join(", ")}`);
  }
  if (manifest.skills.length > 0) {
    lines.push(manifest.skills.length === 1
      ? "One agent skill"
      : `${manifest.skills.length} agent skills`);
  }
  if (manifest.theme) lines.push("A colour theme");
  // Named by HOST, not counted. A matcher changes what the reader's own pasted
  // links look like, and "two URL matchers" is not a fact anyone can decide
  // with — "turns acme.atlassian.net links into chips" is. Deduplicated across
  // matchers because the reader is agreeing to the domains, not the rules.
  const matcherHosts = [
    ...new Set((manifest.urlMatchers ?? []).flatMap((matcher) => matcher.hosts)),
  ];
  if (matcherHosts.length > 0) {
    lines.push(`Turns ${joinSurfaceNames(matcherHosts)} links into chips`);
  }
  if (Object.keys(manifest.collections).length > 0) {
    const synced = Object.values(manifest.collections).filter((collection) => collection.sync).length;
    lines.push(synced > 0 ? "Stores data, and syncs it to your other devices" : "Stores data on this machine");
  }
  if (manifest.entry) lines.push("Runs code on this machine");
  // The three capability lines go last, together, because they are the ones
  // about credentials and reach: where the plugin's code talks to, whose API
  // key it reads, and which of this project's own secrets it opens. A reader
  // who stops early has still seen the sockets; a reader who stops before these
  // has seen everything cheaper.
  const hosts = manifest.network?.hosts ?? [];
  if (hosts.length > 0) lines.push(`Talks to ${joinSurfaceNames(hosts)}`);
  const providers = manifest.providerKeys ?? [];
  if (providers.length > 0) {
    const named = joinSurfaceNames(providers.map((provider) => PLUGIN_PROVIDER_KEY_LABELS[provider]));
    lines.push(providers.length === 1
      ? `Uses your ${named} API key`
      : `Uses your ${named} API keys`);
  }
  // Beside the other three because it is the same kind of fact: what this
  // package can reach that the package itself did not come with. Named rather
  // than counted, and by PROVIDER rather than by URL — "signs you in to Linear"
  // is a sentence a person can agree to, where "opens linear.app/oauth/authorize"
  // asks them to recognise an OAuth endpoint before they can decide.
  for (const session of manifest.authSessions ?? []) {
    // The loopback listener is on the line rather than in a footnote. It is the
    // one thing here that a reader could otherwise discover only by finding a
    // port on their machine already taken, and a port a package binds is
    // exactly the sort of thing an install card exists to say out loud.
    lines.push(session.loopback
      ? `Signs you in to ${session.provider}, and listens on port ${session.loopback.port} while you do`
      : `Signs you in to ${session.provider}`);
  }
  // Then the credential the plugin asks to INHERIT, which is a different and
  // larger fact than any of the above: everything else describes access the
  // plugin builds for itself, and this one describes a connection the user
  // already made with ADE. Said as "asks to use", never "uses", because the
  // install is not the consent — a separate card is, and this line is only the
  // warning that it is coming.
  for (const builtin of manifest.credentialHandoff ?? []) {
    lines.push(
      `Asks to use the ${builtinSurfaceOwner(builtin).title} connection you already set up in ADE`,
    );
  }
  // Last of the three, because it is the most sensitive read on the card and
  // the one a person is most likely to want to stop on. Named rather than
  // counted — "reads two of this project's secrets" tells the reader nothing
  // they can decide with, and the manifest declares the names precisely so this
  // line can print them.
  const projectSecrets = manifest.projectSecrets ?? [];
  if (projectSecrets.length > 0) {
    lines.push(`Reads this project's secrets (.env): ${joinSurfaceNames(projectSecrets)}`);
  }
  return lines;
}

/* ── Install disclosure ─────────────────────────────────────────────────── */

/**
 * How the host resolved the `source` argument, mirroring the branch
 * `pluginInstallService.install` takes so the card cannot describe one install
 * while a different one runs.
 */
export type PluginInstallSourceKind =
  /** A directory on this machine. Readable now, so the manifest is real. */
  | "path"
  /** A package bundled with this ADE build. Readable now, and vouched for. */
  | "builtin"
  /** A git URL. Not readable without fetching, so no manifest. */
  | "git";

/**
 * How much the catalogue vouches for this source.
 *
 * `official` is never taken from the manifest: `official: true` in a manifest
 * is the author's claim about themselves, and only the bundled catalogue can
 * vouch for a package. Everything else is `community`, and a source no
 * catalogue has heard of is `unverified`.
 */
export type PluginInstallTrust = "official" | "community" | "unverified";

export type PluginInstallDisclosure = {
  /** Null when the source could not be read without fetching it. */
  pluginId: string | null;
  /** The manifest's display name, or the raw source when there is no manifest. */
  displayName: string;
  version: string | null;
  description: string | null;
  sourceKind: PluginInstallSourceKind;
  /** Shown verbatim: it is the thing being approved. */
  source: string;
  trust: PluginInstallTrust;
  /** Empty when the source has no readable manifest. */
  adds: string[];
  /**
   * The manifest contributes at least one agent skill.
   *
   * Carried as a fact rather than inferred from the `adds` wording, so the
   * timing note below cannot fall off the card because a line was reworded.
   */
  declaresSkills: boolean;
};

export function buildPluginInstallDisclosure(args: {
  source: string;
  sourceKind: PluginInstallSourceKind;
  manifest: PluginManifest | null;
}): PluginInstallDisclosure {
  const { source, sourceKind, manifest } = args;
  const trust: PluginInstallTrust = sourceKind === "builtin"
    ? "official"
    : manifest
      ? "community"
      : "unverified";
  if (!manifest) {
    return {
      pluginId: null,
      displayName: source,
      version: null,
      description: null,
      sourceKind,
      source,
      trust,
      adds: [],
      declaresSkills: false,
    };
  }
  return {
    pluginId: manifest.name,
    displayName: manifest.displayName || manifest.name,
    version: manifest.version || null,
    description: manifest.description || null,
    sourceKind,
    source,
    trust,
    adds: describeManifestAdds(manifest),
    declaresSkills: manifest.skills.length > 0,
  };
}

/** Where the code comes from, in one line a reader can act on. */
export function describeInstallSourceLine(disclosure: PluginInstallDisclosure): string {
  switch (disclosure.sourceKind) {
    case "path":
      return `From this computer: ${disclosure.source}`;
    case "builtin":
      return `Bundled with ADE: ${disclosure.source}`;
    case "git":
      return `From the internet: ${disclosure.source}`;
  }
}

/** Whether the reader is being asked to trust something nothing vouches for. */
export function describeInstallTrustLine(disclosure: PluginInstallDisclosure): string {
  switch (disclosure.trust) {
    case "official":
      return "Official — this package ships with ADE.";
    case "community":
      return "Community plugin. It runs with the same access as tools you install yourself.";
    case "unverified":
      return "ADE can't read this source without downloading it, so it can't show what the plugin adds. It runs with the same access as tools you install yourself.";
  }
}

/**
 * The whole card body: source, trust, and what it adds.
 *
 * Built here rather than at the call site so the chat card and any future
 * surface read the same words in the same order.
 */
export function buildPluginInstallApprovalBody(disclosure: PluginInstallDisclosure): string {
  const lines: string[] = [];
  if (disclosure.description) lines.push(disclosure.description);
  lines.push(describeInstallSourceLine(disclosure));
  lines.push(describeInstallTrustLine(disclosure));
  if (disclosure.adds.length > 0) {
    lines.push("");
    lines.push("Adds:");
    for (const add of disclosure.adds) lines.push(`- ${add}`);
  }
  if (disclosure.declaresSkills) {
    // The retrospective's sharpest confusion, answered before the person
    // approves rather than after they wonder why the agent they are talking to
    // did not change. Said in the same words as the CLI, the doctor and the
    // Marketplace — one string, so the four cannot drift.
    lines.push("");
    lines.push(PLUGIN_SKILL_NEXT_TURN_NOTE);
  }
  return lines.join("\n");
}

/** The one-line question, naming the plugin and its version when known. */
export function buildPluginInstallApprovalTitle(disclosure: PluginInstallDisclosure): string {
  const versioned = disclosure.version
    ? `${disclosure.displayName} ${disclosure.version}`
    : disclosure.displayName;
  return `Install ${versioned}?`;
}

/* ── Removal disclosure ─────────────────────────────────────────────────── */

/**
 * The three lifecycle verbs an agent may ASK for, beside install.
 *
 * They share a card because they share a question: something the reader can
 * see is about to stop being there. They keep separate words because the three
 * are not equally reversible — `enable` restores what `disable` stopped, and
 * nothing restores what `uninstall` deleted.
 */
export type PluginRemovalKind = "uninstall" | "disable" | "enable";

export type PluginRemovalDisclosure = {
  kind: PluginRemovalKind;
  pluginId: string;
  displayName: string;
  version: string | null;
  /**
   * What stops (or starts) being there.
   *
   * Empty when ADE has no readable manifest for the installed plugin, which is
   * a real state — a plugin whose `plugin.json` broke since it was installed is
   * exactly the one a reader is most likely to be removing.
   */
  items: string[];
  /** The plugin stores rows an uninstall deletes. Drives the warning line. */
  storesData: boolean;
  /** Those rows also ride sync, so the deletion reaches the other devices. */
  syncsData: boolean;
};

/**
 * The "Removes:" lines — {@link describeManifestAdds} read backwards.
 *
 * Deliberately the same facts in the same order as the install card, because
 * the person answering this one very often approved that one. A list that
 * re-groups or re-words what they agreed to would make the two impossible to
 * compare, and comparing them is the whole of the decision.
 *
 * The two lines the install card ends on — where the plugin's code talks to,
 * whose API key it reads — are NOT repeated. They describe access that is going
 * away, and a card headed "Removes:" that lists "Talks to api.example.com"
 * reads as a threat rather than as a reassurance.
 */
export function describeManifestRemoves(manifest: PluginManifest): string[] {
  const lines: string[] = [];
  // Paired BEFORE the walk, not during it: a manifest may declare the webview
  // half first, and a decision made in declaration order would print the tab
  // twice — the very duplication this pairing exists to remove. The removal card
  // is read beside the install card it undoes, so it counts surfaces the same
  // way or the two cannot be compared.
  for (const surface of manifest.surfaces) {
    if (surface.kind === "pane") {
      lines.push(`${surface.title} pane`);
      continue;
    }
    if (surface.kind === "tab") {
      lines.push(`${surface.title} tab`);
    }
  }
  const unpaired = unpairedTabWebviews(manifest);
  for (const webview of unpaired.tabs) {
    lines.push(`${webview.title} tab`);
  }
  if (unpaired.extraPickers) {
    lines.push("Issue pickers and cards on desktop");
  }

  const bySurface = new Map<PluginSurfaceId, number>();
  for (const socket of manifest.sockets) {
    bySurface.set(socket.surface, (bySurface.get(socket.surface) ?? 0) + 1);
  }
  for (const surface of PLUGIN_SURFACE_IDS) {
    const total = bySurface.get(surface);
    if (!total) continue;
    lines.push(total === 1
      ? `Its addition to ${PLUGIN_SURFACE_LABELS[surface]}`
      : `Its ${total} additions to ${PLUGIN_SURFACE_LABELS[surface]}`);
  }

  // Panels are named here and not on the install card because a panel is only
  // ever reached THROUGH a surface, so adding one is not news. Losing one is:
  // it is where the reader's own rows are drawn.
  if (manifest.panels.length > 0) {
    lines.push(manifest.panels.length === 1 ? "One panel" : `${manifest.panels.length} panels`);
  }
  if (manifest.cli.length > 0) {
    lines.push(`Terminal commands: ${manifest.cli.map((word) => `ade ${manifest.name} ${word}`).join(", ")}`);
  }
  if (manifest.skills.length > 0) {
    lines.push(manifest.skills.length === 1 ? "One agent skill" : `${manifest.skills.length} agent skills`);
  }
  if (manifest.theme) lines.push("A colour theme");
  return lines;
}

export function buildPluginRemovalDisclosure(args: {
  kind: PluginRemovalKind;
  pluginId: string;
  displayName: string;
  version: string | null;
  manifest: PluginManifest | null;
}): PluginRemovalDisclosure {
  const collections = Object.values(args.manifest?.collections ?? {});
  return {
    kind: args.kind,
    pluginId: args.pluginId,
    displayName: args.displayName || args.pluginId,
    version: args.version,
    items: args.manifest ? describeManifestRemoves(args.manifest) : [],
    storesData: collections.length > 0,
    syncsData: collections.some((collection) => collection.sync),
  };
}

/** `Remove Tipsy 0.2.0?` · `Turn off Tipsy?` · `Turn on Tipsy?` */
export function buildPluginRemovalApprovalTitle(disclosure: PluginRemovalDisclosure): string {
  const versioned = disclosure.version
    ? `${disclosure.displayName} ${disclosure.version}`
    : disclosure.displayName;
  switch (disclosure.kind) {
    case "uninstall":
      return `Remove ${versioned}?`;
    case "disable":
      return `Turn off ${disclosure.displayName}?`;
    case "enable":
      return `Turn on ${disclosure.displayName}?`;
  }
}

/** The heading over the item list, in the verb's own words. */
function removalListHeading(kind: PluginRemovalKind): string {
  switch (kind) {
    case "uninstall":
      return "Removes:";
    case "disable":
      return "Turns off:";
    case "enable":
      return "Turns on:";
  }
}

/**
 * The card body: what stops being there, and what happens to the data.
 *
 * The data sentence is the one that decides whether a reader can say yes
 * quickly. "Turn off" keeps everything and is undone by turning it back on;
 * "Remove" deletes the plugin's stored rows and — when it synced them — the
 * copies on the other devices. Neither is inferable from the item list, and a
 * reader who guesses wrong guesses in the expensive direction.
 */
export function buildPluginRemovalApprovalBody(disclosure: PluginRemovalDisclosure): string {
  const lines: string[] = [];
  if (disclosure.items.length > 0) {
    lines.push(removalListHeading(disclosure.kind));
    for (const item of disclosure.items) lines.push(`- ${item}`);
    lines.push("");
  } else if (disclosure.kind !== "enable") {
    // No manifest to read. Said plainly rather than as an empty list, because
    // "this plugin adds nothing" and "ADE can't read what it adds" are very
    // different things to be agreeing to.
    lines.push(`ADE can't read ${disclosure.pluginId}'s plugin.json, so it can't list what this changes.`);
    lines.push("");
  }
  switch (disclosure.kind) {
    case "uninstall":
      lines.push(disclosure.storesData
        ? disclosure.syncsData
          ? "Its stored data is deleted here and on your other devices. This can't be undone."
          : "Its stored data on this machine is deleted. This can't be undone."
        : "The plugin's files are deleted from this machine.");
      lines.push("Installing it again is a separate request, and will ask you again.");
      break;
    case "disable":
      lines.push("Its stored data and settings stay. Turning it back on restores everything above.");
      break;
    case "enable":
      lines.push(`${disclosure.displayName} starts running again with the data and settings it already had.`);
      break;
  }
  return lines.join("\n");
}
