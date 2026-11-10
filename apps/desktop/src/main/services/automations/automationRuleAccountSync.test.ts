import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { createAccountSettingsStore } from "../../../../../ade-cli/src/services/account/accountSettingsStore";
import { createProjectConfigService } from "../config/projectConfigService";
import { openKvDb } from "../state/kvDb";
import { createAutomationRuleAccountStore } from "./automationRuleAccountStore";

/**
 * Rules that follow the account, across two computers that share one account.
 * Everything is real (config service, rule store, account settings store with
 * its cache and queue) except the relay, the network boundary, which keeps
 * the later write per key as the Worker does.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
const SCOPE = "repo:github.com/acme/widgets";

function createRelay() {
  let clock = Date.parse("2026-11-09T10:00:00Z");
  const rows = new Map<string, Record<string, unknown>>();
  const stamp = () => new Date((clock += 1000)).toISOString();
  return {
    baseUrl: "test-relay",
    async getAccountSettings(options?: { since?: string | null }) {
      const since = options?.since ?? "";
      const settings = [...rows.values()]
        .filter((row) => String(row.updatedAt) > since)
        .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
      return { settings: settings as never, cursor: (settings.at(-1)?.updatedAt as string | undefined) ?? since, truncated: false };
    },
    async putAccountSettings(settings: Array<{ scope: string; key: string; value: unknown; changedAt: string }>, deviceId: string | null) {
      let updatedAt: string | null = null;
      for (const setting of settings) {
        updatedAt = stamp();
        rows.set(`${setting.scope}|${setting.key}`, { ...setting, updatedAt, writerDeviceId: deviceId });
      }
      return { updatedAt };
    },
    async deleteAccountSetting(scope: string, key: string) {
      rows.set(`${scope}|${key}`, { scope, key, value: null, updatedAt: stamp(), changedAt: null, writerDeviceId: null, deleted: true });
      return true;
    },
  };
}

const rule = (id: string, prompt: string) => ({
  id,
  name: id,
  enabled: true,
  mode: "review",
  triggers: [{ type: "schedule", cron: "0 9 * * *" }],
  execution: { kind: "agent-session", session: {} },
  prompt,
});

async function createComputer(args: {
  name: string;
  relay: ReturnType<typeof createRelay>;
  rules?: unknown[];
  user?: { id: string | null };
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ade-rules-${args.name}-`));
  roots.push(root);
  const projectRoot = path.join(root, "repo");
  const adeDir = path.join(projectRoot, ".ade");
  fs.mkdirSync(adeDir, { recursive: true });
  fs.writeFileSync(
    path.join(adeDir, "local.yaml"),
    YAML.stringify({ version: 1, testSuites: [], laneOverlayPolicies: [], automations: args.rules ?? [] }),
  );
  const user = args.user ?? { id: "user-1" };
  const account = createAccountSettingsStore({
    adeDir: path.join(root, "machine"),
    relay: args.relay as never,
    getAccountUserId: () => user.id,
    getDeviceId: () => args.name,
  });
  const db = await openKvDb(path.join(adeDir, "ade.db"), silent);
  const config = createProjectConfigService({ projectRoot, adeDir, projectId: args.name, db, logger: silent });
  const store = createAutomationRuleAccountStore({
    backend: account,
    readOriginUrl: () => "git@github.com:acme/widgets.git",
    thisComputer: () => ({ deviceId: args.name, name: args.name }),
    projectRoot,
    accountUserId: () => user.id,
    statePath: path.join(adeDir, "automation-rules.state.json"),
    logger: silent,
  });
  config.setAutomationRuleStore(store);
  /** What the brain does after each sync: move, then claim and confirm. */
  const settle = async () => {
    const confirmed = await store.syncedEverything();
    const moved = config.migrateAutomationRulesToAccount();
    config.reconcileAutomationRules({ confirmed: confirmed && moved.moved === 0 });
  };
  const rules = () => Object.fromEntries(config.get().effective.automations.map((entry) => [entry.id, entry]));
  const fileRuleIds = () =>
    ((YAML.parse(fs.readFileSync(path.join(adeDir, "local.yaml"), "utf8"))?.automations ?? []) as Array<{ id: string }>).map((entry) => entry.id);
  const stored = (id: string) => config.get().local.automations?.find((entry) => entry.id === id);
  return { config, account, settle, rules, fileRuleIds, stored, user };
}

async function settleAll(...computers: Array<{ settle: () => Promise<void> }>) {
  for (let round = 0; round < 3; round += 1) {
    for (const computer of computers) await computer.settle();
  }
}

describe("automation rules that follow the account", () => {
  it("keeps both rules when two computers move different rules with one id before seeing each other", async () => {
    const relay = createRelay();
    const a = await createComputer({ name: "mac-a", relay, rules: [rule("nightly", "A's review")] });
    const b = await createComputer({ name: "mac-b", relay, rules: [rule("nightly", "B's review")] });

    // Both move their local rule before either has pulled the other's.
    a.config.migrateAutomationRulesToAccount();
    b.config.migrateAutomationRulesToAccount();
    await a.account.sync();
    await b.account.sync(); // B's write lands last and the account keeps it under "nightly".
    await settleAll(a, b);

    const onA = a.rules();
    const ids = Object.keys(onA).sort();
    expect(ids).toHaveLength(2);
    const readded = ids.find((id) => id !== "nightly")!;
    expect(onA.nightly.prompt).toBe("B's review");
    expect(onA[readded].prompt).toBe("A's review");
    // Each runs only on the computer that made it, and both left local.yaml.
    expect(onA.nightly.runsHere).toBe(false);
    expect(onA[readded].runsHere).toBe(true);
    expect(b.rules().nightly.runsHere).toBe(true);
    expect(a.fileRuleIds()).toEqual([]);
  });

  it("keeps an edit on one computer and a change of home on another made at the same time", async () => {
    const relay = createRelay();
    const a = await createComputer({ name: "mac-a", relay });
    const b = await createComputer({ name: "mac-b", relay });
    b.config.saveAutomationRule(rule("triage", "first") as never);
    await settleAll(b, a);
    expect(a.rules().triage.runsHere).toBe(false);

    // B's edit reaches the account; then A, which has not pulled it, takes the
    // rule over from its older view. A's later write must not undo B's edit.
    b.config.saveAutomationRule({ ...b.stored("triage")!, prompt: "edited on B" });
    await b.account.sync();
    a.config.saveAutomationRule(a.stored("triage")!, { home: "this-computer", runCount: 0 });
    await settleAll(a, b);

    const onA = a.rules().triage;
    expect(onA.prompt).toBe("edited on B");
    expect(onA.home?.deviceId).toBe("mac-a");
    expect(onA.runsHere).toBe(true);
    expect(b.rules().triage.runsHere).toBe(false);
    // The new home waits for the old one to stop before triggered runs.
    expect(Date.parse(onA.homeStartsAt!)).toBeGreaterThan(Date.now());
  });

  it("does not let a stale config save delete, undo or bring back a rule", async () => {
    const relay = createRelay();
    const a = await createComputer({ name: "mac-a", relay });
    const b = await createComputer({ name: "mac-b", relay });
    a.config.saveAutomationRule(rule("doomed", "x") as never);
    a.config.saveAutomationRule(rule("kept", "old") as never);
    await settleAll(a, b);
    const stale = b.config.get();

    a.config.deleteAutomationRule("doomed");
    a.config.saveAutomationRule({ ...a.stored("kept")!, prompt: "new" });
    a.config.saveAutomationRule(rule("added", "y") as never);
    await settleAll(a, b);
    // An unrelated settings save on B carries B's stale copy of every rule.
    b.config.save({ shared: stale.shared, local: { ...stale.local, ai: {} } });
    await settleAll(b, a);

    for (const computer of [a, b]) {
      const rules = computer.rules();
      expect(rules.doomed).toBeUndefined();
      expect(rules.kept.prompt).toBe("new");
      expect(rules.added).toBeDefined();
    }
    expect(b.fileRuleIds()).toEqual([]);
  });

  it("shows a rule a newer ADE wrote but never runs or rewrites it here", async () => {
    const relay = createRelay();
    const a = await createComputer({ name: "mac-a", relay });
    const future = { ...rule("future", "x"), triggers: [{ type: "made.up.trigger" }], newField: { kept: true } };
    a.account.set(SCOPE, "automations.rule.future", future);
    a.account.set(SCOPE, "automations.home.future", { deviceId: "mac-a", name: "mac-a", chosenAt: new Date().toISOString() });
    await settleAll(a);

    const snapshot = a.config.get();
    const shown = snapshot.effective.automations.find((entry) => entry.id === "future");
    expect(snapshot.validation.ok).toBe(true);
    expect(shown?.needsNewerAde).toBe(true);
    expect(shown?.runsHere).toBe(false);
    expect(() => a.config.saveAutomationRule({ ...a.stored("future")!, prompt: "y" })).toThrow(/newer ADE/);
    expect(a.account.get(SCOPE, "automations.rule.future")).toEqual(future);
  });

  it("keeps running rules while signed out and moves an edit only into its own account", async () => {
    const relay = createRelay();
    const user = { id: "user-1" as string | null };
    const a = await createComputer({ name: "mac-a", relay, user });
    a.config.saveAutomationRule(rule("nightly", "first") as never);
    await settleAll(a);
    a.rules(); // A signed-in read leaves this computer's copy.

    user.id = null;
    expect(a.rules().nightly.runsHere).toBe(true);
    a.config.saveAutomationRule({ ...a.stored("nightly")!, prompt: "offline edit" });
    expect(a.rules().nightly.localReason).toBe("signed-out");
    expect(() => a.config.deleteAutomationRule("nightly")).toThrow(/Sign in/);

    user.id = "user-2";
    await settleAll(a);
    expect(a.fileRuleIds()).toEqual(["nightly"]);
    expect(a.rules().nightly.localReason).toBe("other-account");

    user.id = "user-1";
    await settleAll(a);
    expect(a.fileRuleIds()).toEqual([]);
    expect(a.rules().nightly.prompt).toBe("offline edit");
  });
});
