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

import { PLUGIN_SKILL_NEXT_TURN_NOTE } from "./clientRendering";
import type { PluginManifest } from "./manifest";
import { PLUGIN_SURFACE_IDS, type PluginSurfaceId } from "./sockets";

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

export function joinSurfaceNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
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
  const webviews = manifest.surfaces.filter((surface) => surface.kind === "webview");
  for (const tab of tabs) lines.push(`${tab.title} tab`);
  for (const pane of panes) lines.push(`${pane.title} pane`);
  // Said on the line itself rather than as a chip somewhere else on the page:
  // this is the reader's one preview of what installing changes, and "this tab
  // only works on my computer" is exactly the kind of thing they should not
  // have to go looking for.
  for (const webview of webviews) lines.push(`${webview.title} tab — desktop only, custom UI`);

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
  if (Object.keys(manifest.collections).length > 0) {
    const synced = Object.values(manifest.collections).filter((collection) => collection.sync).length;
    lines.push(synced > 0 ? "Stores data, and syncs it to your other devices" : "Stores data on this machine");
  }
  if (manifest.entry) lines.push("Runs code on this machine");
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
