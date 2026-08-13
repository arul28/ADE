import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildPluginSlashCommands,
  namespacedSlashCommand,
  pluginSlashCommandDeclarations,
  readPluginSlashCommandDeclarations,
  type PluginSlashCommandCollision,
  type PluginSlashCommandDeclaration,
} from "./pluginSlashCommands";
import { parsePluginManifest } from "../../../shared/plugins/manifest";
import type { AgentChatSlashCommand } from "../../../shared/types";

function core(...names: string[]): AgentChatSlashCommand[] {
  return names.map((name) => ({ name, description: `core ${name}`, source: "sdk" as const }));
}

function declaration(
  overrides: Partial<PluginSlashCommandDeclaration> & Pick<PluginSlashCommandDeclaration, "pluginId" | "command">,
): PluginSlashCommandDeclaration {
  return {
    displayName: overrides.pluginId,
    socketId: overrides.command,
    description: `run ${overrides.command}`,
    actionId: "run",
    ...overrides,
  };
}

/** A manifest with one `slash-command` socket, as a plugin author would write it. */
function manifestWithCommand(fields: Record<string, unknown>) {
  return parsePluginManifest({
    name: "acme",
    version: "1.0.0",
    displayName: "Acme",
    description: "Acme tools",
    vocabVersion: 1,
    entry: "index.js",
    sockets: [{ socket: "slash-command", surface: "work", id: "fix", actionId: "runFix", ...fields }],
  });
}

describe("plugin slash command declarations", () => {
  it("reads the command word off a manifest socket", () => {
    const parsed = manifestWithCommand({ command: "fix", label: "Fix the build" });
    expect(parsed.errors).toEqual([]);
    expect(parsed.manifest?.sockets[0]?.command).toBe("fix");

    expect(pluginSlashCommandDeclarations([
      { pluginId: "acme", enabled: true, manifest: parsed.manifest },
    ])).toEqual([
      expect.objectContaining({
        pluginId: "acme",
        displayName: "Acme",
        command: "fix",
        description: "Fix the build",
        actionId: "runFix",
      }),
    ]);
  });

  it.each([
    ["/fix", "a leading slash"],
    ["Fix", "uppercase"],
    ["  fix  ", "surrounding space"],
  ])("normalizes %j — %s — rather than refusing it", (command) => {
    expect(manifestWithCommand({ command }).manifest?.sockets[0]?.command).toBe("fix");
  });

  it("prefers an explicit description over the label, and carries the argument hint", () => {
    const parsed = manifestWithCommand({
      command: "fix",
      label: "Fix",
      description: "Repair the failing build",
      argumentHint: "<issue-id>",
    });

    expect(pluginSlashCommandDeclarations([
      { pluginId: "acme", enabled: true, manifest: parsed.manifest },
    ])).toEqual([
      expect.objectContaining({
        description: "Repair the failing build",
        argumentHint: "<issue-id>",
      }),
    ]);
  });

  it("falls back to the socket label when no description is declared", () => {
    const parsed = manifestWithCommand({ command: "fix", label: "Fix the build" });
    expect(pluginSlashCommandDeclarations([
      { pluginId: "acme", enabled: true, manifest: parsed.manifest },
    ])).toEqual([expect.objectContaining({ description: "Fix the build" })]);
  });

  it("names the plugin when a command declares neither description nor label", () => {
    const parsed = manifestWithCommand({ command: "fix" });
    expect(pluginSlashCommandDeclarations([
      { pluginId: "acme", enabled: true, manifest: parsed.manifest },
    ])).toEqual([expect.objectContaining({ description: "Run Acme" })]);
  });

  it("does not reach past an over-long description for the label", () => {
    // Ratified behaviour, pinned so it cannot drift back: the `?? label`
    // fallback is ABSENCE-only. A description the gate refuses for length
    // leaves the subtitle unset rather than silently substituting the label,
    // which keeps this mapping identical to the renderer's arm in
    // `contributionModel.ts`. The author shortening the description heals it.
    const parsed = manifestWithCommand({
      command: "fix",
      label: "Fix the build",
      description: "d".repeat(400),
    });

    expect(pluginSlashCommandDeclarations([
      { pluginId: "acme", enabled: true, manifest: parsed.manifest },
    ])).toEqual([expect.objectContaining({ description: "Run Acme" })]);
  });

  it("refuses over-long menu text rather than letting it into the menu", () => {
    // This path reads the manifest in the host rather than going through the
    // renderer's contribution model, so the ceilings have to be applied here or
    // they hold for every socket kind EXCEPT the one whose text the user reads.
    // `bounded` refuses rather than truncates, so an over-long description
    // falls back and an over-long hint is simply absent — the command still
    // works, which is the right trade for a cosmetic field.
    const parsed = manifestWithCommand({
      command: "fix",
      description: "d".repeat(400),
      argumentHint: "h".repeat(200),
    });

    const [declaration] = pluginSlashCommandDeclarations([
      { pluginId: "acme", enabled: true, manifest: parsed.manifest },
    ]);
    expect(declaration).toEqual(expect.objectContaining({ command: "fix", description: "Run Acme" }));
    expect(declaration).not.toHaveProperty("argumentHint");
  });

  it("drops a socket whose action id is missing rather than offering a dead command", () => {
    const parsed = parsePluginManifest({
      name: "acme",
      version: "1.0.0",
      displayName: "Acme",
      description: "Acme tools",
      vocabVersion: 1,
      entry: "index.js",
      sockets: [{ socket: "slash-command", surface: "work", id: "fix", command: "fix" }],
    });
    expect(parsed.manifest?.sockets).toEqual([]);
    expect(pluginSlashCommandDeclarations([
      { pluginId: "acme", enabled: true, manifest: parsed.manifest },
    ])).toEqual([]);
  });

  it.each([
    ["f", "one character"],
    ["fix build", "an inner space"],
    ["fix!", "punctuation"],
    ["9fix", "a leading digit"],
    ["-fix", "a leading hyphen"],
    ["a".repeat(32), "over 31 characters"],
  ])("refuses %j — %s", (command) => {
    const parsed = manifestWithCommand({ command });
    expect(parsed.manifest?.sockets).toEqual([]);
    // A bad entry is dropped with a named reason, not a manifest-level error:
    // one malformed socket must not take the whole plugin down with it.
    expect(parsed.warnings.join(" ")).toMatch(/command must be a lowercase word/);
  });

  it("refuses a slash-command socket that declares no command at all", () => {
    const parsed = parsePluginManifest({
      name: "acme",
      version: "1.0.0",
      displayName: "Acme",
      description: "Acme tools",
      vocabVersion: 1,
      entry: "index.js",
      sockets: [{ socket: "slash-command", surface: "work", id: "fix", actionId: "runFix" }],
    });
    // The whole point of `manifestExtra`: this used to parse clean and then
    // contribute nothing, with nothing anywhere telling the author why.
    expect(parsed.manifest?.sockets).toEqual([]);
    expect(parsed.warnings.join(" ")).toMatch(/requires command for socket "slash-command"/);
  });

  it("drops a disabled plugin's commands", () => {
    const parsed = manifestWithCommand({ command: "fix" });
    expect(pluginSlashCommandDeclarations([
      { pluginId: "acme", enabled: false, manifest: parsed.manifest },
    ])).toEqual([]);
  });

  it("drops a contribution the user switched off", () => {
    const parsed = manifestWithCommand({ command: "fix" });
    expect(pluginSlashCommandDeclarations([
      { pluginId: "acme", enabled: true, manifest: parsed.manifest, disabledContributions: ["fix"] },
    ])).toEqual([]);
  });
});

describe("reading declarations off disk", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  /** A plugins root as the install service writes it: a registry plus manifests. */
  function seedPluginsRoot(plugins: Array<{ pluginId: string; enabled: boolean; command?: string }>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-slash-"));
    roots.push(root);
    const registry = { version: 2, plugins: {} as Record<string, unknown> };
    for (const plugin of plugins) {
      registry.plugins[plugin.pluginId] = {
        pluginId: plugin.pluginId,
        version: "1.0.0",
        enabled: plugin.enabled,
        source: { kind: "builtin" },
        installedAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T00:00:00.000Z",
      };
      fs.mkdirSync(path.join(root, plugin.pluginId), { recursive: true });
      fs.writeFileSync(path.join(root, plugin.pluginId, "plugin.json"), JSON.stringify({
        name: plugin.pluginId,
        version: "1.0.0",
        displayName: plugin.pluginId.toUpperCase(),
        description: "seeded",
        vocabVersion: 1,
        entry: "index.js",
        ...(plugin.command
          ? {
              sockets: [{
                socket: "slash-command",
                surface: "work",
                id: plugin.command,
                command: plugin.command,
                actionId: "run",
                label: `Run ${plugin.command}`,
              }],
            }
          : {}),
      }));
    }
    fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(registry));
    return root;
  }

  it("reads enabled plugins' commands without a plugin host", () => {
    // The desktop main process never builds one, so this path has to work off
    // the machine install registry alone.
    const root = seedPluginsRoot([
      { pluginId: "acme", enabled: true, command: "fix" },
      { pluginId: "zeta", enabled: false, command: "ship" },
      { pluginId: "quiet", enabled: true },
    ]);

    expect(readPluginSlashCommandDeclarations({ pluginsRoot: root })).toEqual([
      expect.objectContaining({ pluginId: "acme", command: "fix", displayName: "ACME", actionId: "run" }),
    ]);
  });

  it("reads nothing, and does not throw, when no plugin has ever been installed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-slash-"));
    roots.push(root);
    expect(readPluginSlashCommandDeclarations({ pluginsRoot: root })).toEqual([]);
  });

  it("skips a plugin whose manifest is unreadable rather than losing the rest", () => {
    const root = seedPluginsRoot([
      { pluginId: "acme", enabled: true, command: "fix" },
      { pluginId: "broken", enabled: true, command: "oops" },
    ]);
    fs.writeFileSync(path.join(root, "broken", "plugin.json"), "{ not json");

    expect(readPluginSlashCommandDeclarations({ pluginsRoot: root }).map((d) => d.pluginId))
      .toEqual(["acme"]);
  });
});

describe("buildPluginSlashCommands", () => {
  it("offers a free word bare, attributed to its plugin", () => {
    expect(buildPluginSlashCommands(
      [declaration({ pluginId: "acme", command: "fix", displayName: "Acme", actionId: "runFix" })],
      core("/clear", "/review"),
    )).toEqual([
      {
        name: "/fix",
        description: "run fix",
        source: "plugin",
        plugin: { pluginId: "acme", displayName: "Acme", actionId: "runFix" },
      },
    ]);
  });

  it("never displaces a core command, and namespaces the plugin's instead", () => {
    const collisions: PluginSlashCommandCollision[] = [];
    const commands = buildPluginSlashCommands(
      [declaration({ pluginId: "acme", command: "review" })],
      core("/review"),
      { onCollision: (info) => collisions.push(info) },
    );

    expect(commands).toEqual([expect.objectContaining({ name: "/acme:review", source: "plugin" })]);
    expect(commands.some((command) => command.name === "/review")).toBe(false);
    expect(collisions).toEqual([
      { pluginId: "acme", command: "review", reason: "core", offeredAs: "/acme:review" },
    ]);
  });

  it("matches a core command case-insensitively", () => {
    expect(buildPluginSlashCommands(
      [declaration({ pluginId: "acme", command: "review" })],
      [{ name: "/Review", description: "core", source: "sdk" }],
    )).toEqual([expect.objectContaining({ name: "/acme:review" })]);
  });

  it("namespaces BOTH plugins when two want the same word", () => {
    const collisions: PluginSlashCommandCollision[] = [];
    const commands = buildPluginSlashCommands(
      [
        declaration({ pluginId: "acme", command: "todo" }),
        declaration({ pluginId: "zeta", command: "todo" }),
      ],
      core("/clear"),
      { onCollision: (info) => collisions.push(info) },
    );

    // Picking a winner would silently rename one of them the next time the
    // user installed something unrelated.
    expect(commands.map((command) => command.name)).toEqual(["/acme:todo", "/zeta:todo"]);
    expect(collisions.map((info) => info.reason)).toEqual(["plugin", "plugin"]);
  });

  it("namespaces only the contested word, not the rest of that plugin's commands", () => {
    const commands = buildPluginSlashCommands(
      [
        declaration({ pluginId: "acme", command: "todo" }),
        declaration({ pluginId: "acme", command: "ship" }),
        declaration({ pluginId: "zeta", command: "todo" }),
      ],
      core(),
    );
    expect(commands.map((command) => command.name).sort())
      .toEqual(["/acme:todo", "/ship", "/zeta:todo"]);
  });

  it("drops a command whose namespaced form collides too, rather than shadowing core", () => {
    const collisions: PluginSlashCommandCollision[] = [];
    const commands = buildPluginSlashCommands(
      [declaration({ pluginId: "acme", command: "review" })],
      core("/review", "/acme:review"),
      { onCollision: (info) => collisions.push(info) },
    );

    expect(commands).toEqual([]);
    expect(collisions.at(-1)).toEqual({
      pluginId: "acme",
      command: "review",
      reason: "unresolvable",
      offeredAs: null,
    });
  });

  it("keeps the first of a manifest's duplicate declarations", () => {
    const commands = buildPluginSlashCommands(
      [
        declaration({ pluginId: "acme", command: "fix", actionId: "first" }),
        declaration({ pluginId: "acme", command: "fix", actionId: "second" }),
      ],
      core(),
    );
    // A repeat is a typo, not a second claimant — so it must not make the
    // plugin collide with ITSELF and namespace a word nothing else wanted.
    expect(commands).toEqual([
      expect.objectContaining({ name: "/fix", plugin: expect.objectContaining({ actionId: "first" }) }),
    ]);
  });

  it("reports no collision when nothing collides", () => {
    const onCollision = vi.fn();
    buildPluginSlashCommands([declaration({ pluginId: "acme", command: "fix" })], core("/clear"), { onCollision });
    expect(onCollision).not.toHaveBeenCalled();
  });

  it("builds a namespaced word the leading-command grammar accepts", () => {
    // `extractLeadingSlashCommand` in shared/chatSlashCommands.ts already
    // parses colon segments, because nested command files produce `/dir:name`.
    expect(namespacedSlashCommand("acme", "review")).toBe("/acme:review");
    expect(/^\/[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(
      namespacedSlashCommand("acme-tools", "run-tests"),
    )).toBe(true);
  });
});
