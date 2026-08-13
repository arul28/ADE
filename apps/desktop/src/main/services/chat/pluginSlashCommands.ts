/**
 * Plugin-contributed slash commands, and how they join the runtime's own.
 *
 * Every runtime derives its command list differently — Claude from the SDK plus
 * a built-in table, Codex from an RPC, the rest from the filesystem — and each
 * of those paths ends at the same `mergeSlashCommands` call in
 * `agentChatService.getSlashCommands`. Folding plugins in THERE rather than in
 * any one runtime's branch is what makes a plugin's command work on all six
 * providers instead of the two whose skill directories happen to surface it.
 *
 * Two rules the rest of this file implements:
 *
 * 1. **Core wins a name.** A plugin never displaces a command the runtime or
 *    ADE already ships, because a user typing `/review` means the one they have
 *    always meant. The plugin's command is not dropped for it, though — it is
 *    re-offered namespaced (see {@link namespacedSlashCommand}), which is the
 *    same `dir:name` grammar the filesystem command discovery already produces
 *    and `extractLeadingSlashCommand` already parses.
 * 2. **Dispatch identity is never parsed back out of the name.** A command
 *    carries its plugin id and action id, so namespacing is free: it changes
 *    what the user types and nothing about what runs.
 *
 * The declaration read is daemon-free on purpose. `getSlashCommands` runs in
 * both the desktop main process and the daemon, and only the daemon builds a
 * plugin host — the same asymmetry `createInstalledPluginRootResolver` names.
 * So this reads the machine install registry, exactly as
 * `listPluginAgentSkillRoots` does for skill roots.
 */

import type { AgentChatSlashCommand } from "../../../shared/types";
import type { PluginManifest } from "../../../shared/plugins/manifest";
import { parsePluginManifestJson } from "../../../shared/plugins/manifest";
import { parsePluginContributionPayload } from "../../../shared/plugins/sockets";
import { readPluginInstallRecords, resolvePluginsRoot } from "../plugins/pluginRegistryFile";
import { subscribeToPluginChanges } from "../plugins/pluginEvents";
import fs from "node:fs";
import path from "node:path";

/** What one plugin declared, resolved against its install record. */
export type PluginSlashCommandDeclaration = {
  pluginId: string;
  /** From the manifest, for the menu row's attribution. */
  displayName: string;
  /** The manifest socket's id — identity for ordering and the per-socket toggle. */
  socketId: string;
  /** Canonical word, no leading slash. */
  command: string;
  description: string;
  /** What the command takes, drawn beside it. A hint, never parsed. */
  argumentHint?: string;
  /** The plugin action a selection invokes. */
  actionId: string;
};

/**
 * How a plugin's command is re-offered when its bare name is already taken.
 *
 * `dir:name` is not invented here: `discoverMarkdownCommandFiles` already turns
 * a nested command file into `/dir:name`, and the leading-command grammar in
 * `shared/chatSlashCommands.ts` already accepts colon segments. A plugin id is
 * a lowercase identifier, so the result is always a legal command word.
 */
export function namespacedSlashCommand(pluginId: string, command: string): string {
  return `/${pluginId}:${command}`;
}

function slashKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Fold plugin declarations into a runtime's already-merged command list.
 *
 * `coreCommands` is the merged product list for this provider — the runtime's
 * own commands plus ADE's. It is read, never modified: this function only
 * decides what NAME each plugin command gets, and the caller does the merge.
 *
 * A plugin command is namespaced when its bare word is taken by core, or when
 * two plugins want the same word. The two-plugin case namespaces BOTH rather
 * than picking a winner: whichever tiebreak we chose would reorder itself the
 * next time the user installed something, and a command that silently changes
 * name across an unrelated install is worse than one that never had the short
 * name to begin with.
 */
export function buildPluginSlashCommands(
  declarations: readonly PluginSlashCommandDeclaration[],
  coreCommands: readonly AgentChatSlashCommand[],
  options: { onCollision?: (info: PluginSlashCommandCollision) => void } = {},
): AgentChatSlashCommand[] {
  const coreNames = new Set(coreCommands.map((command) => slashKey(command.name)));

  // One entry per (plugin, word): a manifest that declares the same word twice
  // is a typo, and the first declaration is the one the author meant.
  //
  // The key joins on a NUL, which neither a plugin id nor a command word can
  // contain, so no pair can collide into one entry. Written as the ESCAPE,
  // never as a literal NUL byte: a source file holding one is binary to git,
  // which stops diffing it and hides every later change to this function, and
  // drops the file out of `rg` silently. Same rule as `pluginHostService.ts`.
  const unique: PluginSlashCommandDeclaration[] = [];
  const seenPerPlugin = new Set<string>();
  for (const declaration of declarations) {
    const key = `${declaration.pluginId}\u0000${declaration.command}`;
    if (seenPerPlugin.has(key)) continue;
    seenPerPlugin.add(key);
    unique.push(declaration);
  }

  const claimantsByWord = new Map<string, number>();
  for (const declaration of unique) {
    claimantsByWord.set(declaration.command, (claimantsByWord.get(declaration.command) ?? 0) + 1);
  }

  const commands: AgentChatSlashCommand[] = [];
  for (const declaration of unique) {
    const bare = `/${declaration.command}`;
    const takenByCore = coreNames.has(slashKey(bare));
    const contested = (claimantsByWord.get(declaration.command) ?? 0) > 1;
    const name = takenByCore || contested
      ? namespacedSlashCommand(declaration.pluginId, declaration.command)
      : bare;

    if (takenByCore || contested) {
      options.onCollision?.({
        pluginId: declaration.pluginId,
        command: declaration.command,
        reason: takenByCore ? "core" : "plugin",
        offeredAs: name,
      });
    }

    // A namespaced form colliding with core too means the plugin id itself
    // shadows a real command word. Nothing left to fall back to, and offering
    // it would be the one thing rule 1 forbids.
    if (coreNames.has(slashKey(name))) {
      options.onCollision?.({
        pluginId: declaration.pluginId,
        command: declaration.command,
        reason: "unresolvable",
        offeredAs: null,
      });
      continue;
    }

    commands.push({
      name,
      description: declaration.description,
      ...(declaration.argumentHint ? { argumentHint: declaration.argumentHint } : {}),
      source: "plugin",
      plugin: {
        pluginId: declaration.pluginId,
        displayName: declaration.displayName,
        actionId: declaration.actionId,
      },
    });
  }
  return commands;
}

export type PluginSlashCommandCollision = {
  pluginId: string;
  command: string;
  /** Who took the bare word: core, another plugin, or nothing left to try. */
  reason: "core" | "plugin" | "unresolvable";
  /** The name it is offered under instead, or null when it was dropped. */
  offeredAs: string | null;
};

/**
 * Declarations from one already-parsed manifest, honouring the user's
 * per-contribution toggles.
 *
 * Exported for the same reason the parse lives beside the merge: a caller that
 * already holds manifests (a test, or a host that grows an install-service
 * handle later) should not have to go back to disk to use this.
 */
export function pluginSlashCommandDeclarations(
  plugins: readonly {
    pluginId: string;
    enabled: boolean;
    manifest: PluginManifest | null;
    disabledContributions?: readonly string[];
  }[],
): PluginSlashCommandDeclaration[] {
  const declarations: PluginSlashCommandDeclaration[] = [];
  for (const plugin of plugins) {
    if (!plugin.enabled || !plugin.manifest) continue;
    const off = new Set(plugin.disabledContributions ?? []);
    const displayName = plugin.manifest.displayName || plugin.pluginId;
    for (const socket of plugin.manifest.sockets) {
      if (socket.socket !== "slash-command") continue;
      if (off.has(socket.id)) continue;
      // Through the taxonomy's single gate, not around it. This path reads the
      // manifest in the host rather than going through the renderer's
      // contribution model, so without this the per-field ceilings the payload
      // parser enforces — a 120-character description, a 40-character hint —
      // would apply to every socket kind EXCEPT the one whose text lands in a
      // menu the user reads.
      /**
       * `description` falls back to `label` on ABSENCE only, for plugins
       * written before the field existed which put their menu line there.
       *
       * Deliberately not length-aware. A description the gate refuses for
       * length leaves the subtitle unset rather than reaching past it for the
       * label, so this mapping stays identical to the renderer's arm in
       * `contributionModel.ts` — the two are kept in lockstep by policy, and a
       * subtitle that is missing because the author wrote 400 characters is
       * self-healing in a way a quietly substituted one is not.
       */
      const payload = parsePluginContributionPayload("slash-command", {
        command: socket.command,
        actionId: socket.actionId,
        description: socket.description ?? socket.label,
        argumentHint: socket.argumentHint,
        icon: socket.icon,
      });
      if (!payload) continue;
      declarations.push({
        pluginId: plugin.pluginId,
        displayName,
        socketId: socket.id,
        command: payload.command,
        description: payload.description ?? `Run ${displayName}`,
        ...(payload.argumentHint ? { argumentHint: payload.argumentHint } : {}),
        actionId: payload.actionId,
      });
    }
  }
  // Deterministic across machines, which is what lets two devices agree on
  // which of two plugins is "first" before the namespacing rule makes the
  // question moot.
  return declarations.sort((left, right) => (
    left.pluginId.localeCompare(right.pluginId) || left.socketId.localeCompare(right.socketId)
  ));
}

/**
 * The declarations installed on this machine, briefly cached.
 *
 * Cached at all because the read is a registry file plus one manifest per
 * installed plugin, and `getSlashCommands` runs on every composer reveal and
 * after every finished turn.
 *
 * Cached only BRIEFLY because the install that would invalidate it does not
 * necessarily happen here. `emitPluginChange` is in-process, and installs are
 * performed by the plugin host — which the daemon builds and the desktop main
 * process does not. So in the daemon the subscription below is what drops an
 * uninstalled plugin's command immediately, and in desktop main, where no such
 * event will ever arrive, the TTL is the only thing that does. Both are here
 * because either alone is wrong in one of the two processes.
 */
const DECLARATION_TTL_MS = 3_000;

let cachedDeclarations: PluginSlashCommandDeclaration[] | null = null;
let cachedAt = 0;
let subscribed = false;

function ensureInvalidationSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  subscribeToPluginChanges((event) => {
    // `status` is child-process health and cannot change a manifest; every
    // other kind can, including one this build has not learned about.
    if (event.kind === "status") return;
    cachedDeclarations = null;
  });
}

export function readPluginSlashCommandDeclarations(
  options: { pluginsRoot?: string; env?: NodeJS.ProcessEnv } = {},
): PluginSlashCommandDeclaration[] {
  const explicitRoot = options.pluginsRoot?.trim();
  // Only the default root is cached. A caller naming a root is a test or a
  // second machine layout, and caching that would leak across both.
  if (!explicitRoot) {
    ensureInvalidationSubscription();
    if (cachedDeclarations && Date.now() - cachedAt < DECLARATION_TTL_MS) return cachedDeclarations;
  }
  // Resolved per call, never captured: the channel defaults that decide whether
  // this machine's directory is `.ade`, `.ade-beta` or `.ade-alpha` are applied
  // to `process.env` during launch.
  const root = explicitRoot || resolvePluginsRoot(options.env ?? process.env);
  const declarations = pluginSlashCommandDeclarations(
    [...readPluginInstallRecords(root).values()].map((record) => ({
      pluginId: record.pluginId,
      enabled: record.enabled,
      manifest: readManifest(path.join(root, record.pluginId)),
      disabledContributions: record.disabledContributions ?? [],
    })),
  );
  if (!explicitRoot) {
    cachedDeclarations = declarations;
    cachedAt = Date.now();
  }
  return declarations;
}

function readManifest(pluginRoot: string): PluginManifest | null {
  try {
    return parsePluginManifestJson(fs.readFileSync(path.join(pluginRoot, "plugin.json"), "utf8")).manifest;
  } catch {
    // A plugin whose manifest is unreadable contributes nothing; the install
    // service is where that is surfaced to the operator.
    return null;
  }
}

/** Test seam: forget the cached read and the change subscription. */
export function resetPluginSlashCommandCacheForTests(): void {
  cachedDeclarations = null;
  cachedAt = 0;
  subscribed = false;
}
