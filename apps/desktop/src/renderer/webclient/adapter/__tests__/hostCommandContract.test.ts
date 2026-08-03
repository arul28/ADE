import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The web adapter and the sync host share a vocabulary of command names with no
 * compiler binding between them: the adapter passes plain strings to
 * `commands.call`, and the host registers plain strings. When a name exists on
 * one side only, `CommandCaller` finds no descriptor and resolves the caller's
 * fallback — for a read that is a legitimate empty state, and for a write it
 * used to be a silent no-op that reported success.
 *
 * That drift is how the web client shipped with `chat.create` answering an
 * `AgentChatSessionSummary` the renderer read as a session (breaking every new
 * chat), and with AI settings writes that persisted nothing. This test is the
 * binding those two bugs were missing: any NEW action the adapter calls must
 * exist on the host, or be listed below with the reason it cannot.
 */

const ADAPTER_DIR = join(__dirname, "..");
const HOST_REGISTRY = join(
  __dirname,
  "../../../../../../ade-cli/src/services/sync/syncRemoteCommandService.ts",
);
// Lane presence is served by synthetic descriptors declared in the host service
// rather than by `register()`, so the registry file alone under-reports it.
const HOST_SERVICE = join(
  __dirname,
  "../../../../../../ade-cli/src/services/sync/syncHostService.ts",
);

/**
 * Actions the adapter calls that the host deliberately does not serve. Adding
 * to this list is a decision, not a formality: state why the host cannot or
 * should not implement it.
 */
const KNOWN_UNSUPPORTED: Record<string, string> = {
  // The adapter redacts the key before sending (a web client must not put
  // provider credentials on the wire), so a host handler would persist the
  // placeholder. Adding a key stays a desktop-only operation.
  "ai.storeApiKey": "web redacts the key; storing it remotely would persist a placeholder",
  // Conflict resolution drives local worktree state through a resolver session
  // that has no remote contract yet.
  "conflicts.applyProposal": "no remote contract for resolver sessions",
  "conflicts.listProposals": "no remote contract for resolver sessions",
  "conflicts.prepareProposal": "no remote contract for resolver sessions",
  "conflicts.requestProposal": "no remote contract for resolver sessions",
  "conflicts.simulateMerge": "no remote contract for resolver sessions",
  "conflicts.undoProposal": "no remote contract for resolver sessions",
  // Codex goal state is held by the local Codex app-server connection.
  "chat.codex.clearGoal": "codex goal state is local to the app-server connection",
  "chat.codex.getGoal": "codex goal state is local to the app-server connection",
  "chat.codex.setGoal": "codex goal state is local to the app-server connection",
  "chat.codex.setGoalStatus": "codex goal state is local to the app-server connection",
  "cto.getLinearProjects": "not exposed remotely yet",
  "attention.acknowledgeMachine": "machine-local attention state",
  "rebase.dismiss": "machine-local rebase suggestion state",
  "terminal.reattachChatCli": "machine-local pty reattach",
};

function adapterSources(): string[] {
  const files: string[] = [];
  for (const dir of [ADAPTER_DIR, join(ADAPTER_DIR, "infra")]) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      if (entry.name.includes(".test.")) continue;
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

function actionsCalledByAdapter(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of adapterSources()) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/call(?:Required\w*)?\(\s*"([\w.]+)"/g)) {
      const action = match[1];
      if (action && !found.has(action)) found.set(action, file);
    }
  }
  return found;
}

function actionsRegisteredByHost(): Set<string> {
  const registered = new Set(
    [...readFileSync(HOST_REGISTRY, "utf8").matchAll(/register\("([\w.]+)"/g)].map((match) => match[1]!),
  );
  const hostService = readFileSync(HOST_SERVICE, "utf8");
  const synthetic = hostService.slice(
    hostService.indexOf("localPresenceCommandDescriptors"),
    hostService.indexOf("readBrainMetadata"),
  );
  for (const match of synthetic.matchAll(/action:\s*"([\w.]+)"/g)) registered.add(match[1]!);
  return registered;
}

describe("web adapter ↔ sync host command contract", () => {
  it("parses both sides (guards against the regexes silently matching nothing)", () => {
    expect(actionsCalledByAdapter().size).toBeGreaterThan(100);
    expect(actionsRegisteredByHost().size).toBeGreaterThan(100);
  });

  it("every action the web adapter calls is served by the host", () => {
    const registered = actionsRegisteredByHost();
    const unserved = [...actionsCalledByAdapter().entries()]
      .filter(([action]) => !registered.has(action) && !(action in KNOWN_UNSUPPORTED))
      .map(([action, file]) => `${action} (called from ${file.split("/").pop()})`);
    expect(unserved).toEqual([]);
  });

  it("does not carry stale exemptions for actions the host now serves", () => {
    const registered = actionsRegisteredByHost();
    const called = actionsCalledByAdapter();
    const stale = Object.keys(KNOWN_UNSUPPORTED).filter(
      (action) => registered.has(action) || !called.has(action),
    );
    expect(stale).toEqual([]);
  });
});
