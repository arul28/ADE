import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CTO_ACCOUNT_COPY_VAULT_KIND, CTO_ACCOUNT_COPY_VAULT_KEY } from "../../../shared/ctoAccountCopy";
import { CTO_HOME_SETTING_KEY, type CtoHomeMachineRecord } from "../../../shared/ctoHomeMachine";
import { ACCOUNT_VAULT_NO_REVISION } from "../../../shared/types/accountVault";
import type { CtoIdentity } from "../../../shared/types/cto";
import {
  createCtoAccountCopyService,
  decodeCtoAccountCopy,
  type CtoAccountCopySettings,
  type CtoAccountCopyVault,
} from "./ctoAccountCopyService";
import { createCtoMemoryService } from "./ctoMemoryService";

const SCOPE = "repo:github.com/acme/app";
const silent = { info: () => {}, warn: () => {} };

/** The account's vault as the relay keeps it: one row, refused when the writer names a stale revision. */
function createAccount() {
  let row: { value: string; revision: string } | null = null;
  let seq = 0;
  const settings = new Map<string, unknown>();
  const vaultFor = (reach: { synced: "ready" | "unavailable" }): CtoAccountCopyVault => ({
    get: () => row?.value ?? null,
    list: () => (row ? [{ kind: CTO_ACCOUNT_COPY_VAULT_KIND, key: CTO_ACCOUNT_COPY_VAULT_KEY, revision: row.revision }] : []),
    trySet: (_scope, _kind, _key, value, options) => {
      if ((options?.expectedRevision ?? null) !== (row?.revision ?? ACCOUNT_VAULT_NO_REVISION)) return "stale";
      seq += 1;
      row = { value, revision: `r${seq}` };
      return "queued";
    },
    sync: async () => reach.synced,
  });
  const settingsView = (): CtoAccountCopySettings => ({
    get: (_scope, key) => settings.get(key) ?? null,
    set: (_scope, key, value) => settings.set(key, value),
  });
  return { vaultFor, settingsView, copy: () => decodeCtoAccountCopy(row?.value ?? null) };
}

let clock = Date.parse("2026-11-01T09:00:00.000Z");
const tick = () => (clock += 60_000);

function createMachine(deviceId: string, account: ReturnType<typeof createAccount>, settings?: CtoAccountCopySettings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ade-cto-copy-${deviceId}-`));
  const adeDir = path.join(root, ".ade");
  fs.mkdirSync(adeDir, { recursive: true });
  const memory = createCtoMemoryService({ adeDir, userNotesDir: path.join(root, "home-cto") });
  let identity = { version: 1, updatedAt: new Date(clock).toISOString(), name: "Atlas" } as unknown as CtoIdentity;
  const reach = { synced: "ready" as "ready" | "unavailable" };
  const service = createCtoAccountCopyService({
    adeDir,
    repoScope: () => SCOPE,
    vault: account.vaultFor(reach),
    settings: settings ?? account.settingsView(),
    deviceId: () => deviceId,
    deviceName: () => `${deviceId} laptop`,
    ctoState: {
      getIdentity: () => identity,
      updateIdentity: (patch) => { identity = { ...identity, ...patch } as CtoIdentity; },
    },
    ctoMemory: memory,
    readSources: async () => ({ tail: "", routines: [] }),
    replaceRoutines: async () => true,
    threadIsBusy: async () => false,
    logger: silent,
    now: () => clock,
  });
  return { deviceId, adeDir, memory, service, reach };
}

const homeOn = (deviceId: string): CtoHomeMachineRecord => ({
  version: 1,
  deviceId,
  name: `${deviceId} laptop`,
  hostname: null,
  chosenAt: new Date(tick()).toISOString(),
});

describe("ctoAccountCopyService across machines", () => {
  it("hands the CTO to a new home, and no other machine writes over it", async () => {
    const account = createAccount();
    const a = createMachine("device-a", account);
    const b = createMachine("device-b", account);
    b.memory.writeNotes("project", "- Deploys go out on Thursdays");
    a.memory.writeNotes("project", "- Stale note from an old stay");

    // No home yet: the first machine writes the copy, the other never writes over it.
    tick();
    await b.service.save("turn_ended");
    tick();
    await a.service.save("turn_ended");
    expect(account.copy()?.ownerDeviceId).toBe("device-b");
    expect(account.copy()?.projectNotes).toContain("Deploys go out on Thursdays");

    // A becomes the home: it takes B's CTO, then writes the copy as its own.
    const home = homeOn("device-a");
    account.settingsView().set(SCOPE, CTO_HOME_SETTING_KEY, home);
    const adopted = await a.service.adopt({ home });
    expect(adopted.restored).toBe(true);
    expect(a.memory.readNotes("project")).toContain("Deploys go out on Thursdays");
    expect(a.memory.readNotes("project")).not.toContain("Stale note");
    expect(account.copy()?.ownerDeviceId).toBe("device-a");

    // B is not the home any more: its saves leave the copy alone.
    b.memory.writeNotes("project", "- Written on the old home after the move");
    tick();
    await b.service.save("turn_ended");
    expect(account.copy()?.ownerDeviceId).toBe("device-a");
    expect(account.copy()?.projectNotes).not.toContain("Written on the old home");
    await expect(b.service.homeGate("Atlas")).resolves.toMatchObject({ ok: false });
  });

  it("a move-in that couldn't read the account takes the old home's latest copy instead of overwriting it", async () => {
    const account = createAccount();
    const a = createMachine("device-a", account);
    // B hasn't heard of the move yet: its own view of the account still names B.
    const bSettings = new Map<string, unknown>([[CTO_HOME_SETTING_KEY, homeOn("device-b")]]);
    const b = createMachine("device-b", account, {
      get: (_scope, key) => bSettings.get(key) ?? null,
      set: (_scope, key, value) => bSettings.set(key, value),
    });
    b.memory.writeNotes("project", "- Release train is weekly");
    tick();
    await b.service.save("turn_ended");
    a.memory.writeNotes("project", "- A's notes from months ago");

    // The move to A happens while A can't reach the account.
    const home = homeOn("device-a");
    account.settingsView().set(SCOPE, CTO_HOME_SETTING_KEY, home);
    a.reach.synced = "unavailable";
    expect((await a.service.adopt({ home })).restored).toBe(false);
    expect(account.copy()?.ownerDeviceId).toBe("device-b");
    // Until B's CTO has landed, A runs no CTO turn or routine that it would replace.
    await expect(a.service.homeGate("Atlas")).resolves.toMatchObject({ ok: false });
    expect(a.service.routineHoldReason()).not.toBeNull();

    // B keeps working and saves after the move.
    b.memory.writeNotes("project", "- Release train is weekly\n- Freeze starts Friday");
    tick();
    await b.service.save("turn_ended");

    // Once the account answers, the next turn first takes B's latest CTO.
    a.reach.synced = "ready";
    tick();
    await expect(a.service.homeGate("Atlas")).resolves.toEqual({ ok: true });
    expect(a.service.routineHoldReason()).toBeNull();
    expect(a.memory.readNotes("project")).toContain("Freeze starts Friday");
    expect(a.memory.readNotes("project")).not.toContain("months ago");
    expect(account.copy()?.ownerDeviceId).toBe("device-a");
    expect(account.copy()?.projectNotes).toContain("Freeze starts Friday");
  });

  it("carries rules, skills and what the person undid, and leaves skills out whole when they don't fit", async () => {
    const account = createAccount();
    const b = createMachine("device-b", account);
    b.memory.saveSkill({ name: "triage", description: "Triage a bug", body: "1. Reproduce" });
    b.memory.addRule({ rule: "Keep PRs small", why: "reviews stay fast" });
    b.memory.beginLearningTurn();
    b.memory.addRule({ rule: "Merge without review", why: "it is faster" });
    const learned = b.memory.finishLearningTurn({})!;
    expect(b.memory.undoLearned({ learnId: learned.learnId, changeId: learned.changes[0]!.id }).ok).toBe(true);
    tick();
    await b.service.save("turn_ended");

    // A takes the CTO: B's skills replace A's, and B's Undo still holds on A.
    const a = createMachine("device-a", account);
    a.memory.saveSkill({ name: "a-only", description: "From an earlier stay", body: "1. Old" });
    const homeA = homeOn("device-a");
    account.settingsView().set(SCOPE, CTO_HOME_SETTING_KEY, homeA);
    expect((await a.service.adopt({ home: homeA })).restored).toBe(true);
    expect(a.memory.listSkills().map((skill) => skill.name)).toEqual(["triage"]);
    expect(a.memory.readRules()).toContain("Keep PRs small");
    expect(a.memory.addRule({ rule: "Merge without review", why: "it is faster" })).toMatchObject({ ok: false });

    // Skills too big for the account's copy are left out whole, never in part.
    for (let i = 0; i < 14; i += 1) {
      a.memory.writeSkillText({ name: `big-${i}`, text: crypto.randomBytes(3500).toString("hex") });
    }
    tick();
    await a.service.save("turn_ended");
    expect(account.copy()?.ownerDeviceId).toBe("device-a");
    expect(account.copy()?.skills).toBeUndefined();
    expect(account.copy()?.undone?.map((item) => item.text)).toEqual(["Merge without review — it is faster."]);

    // So the next home keeps its own skills instead of losing them to a partial list.
    const c = createMachine("device-c", account);
    c.memory.saveSkill({ name: "c-keep", description: "Local", body: "1. Keep" });
    const homeC = homeOn("device-c");
    account.settingsView().set(SCOPE, CTO_HOME_SETTING_KEY, homeC);
    expect((await c.service.adopt({ home: homeC })).restored).toBe(true);
    expect(c.memory.listSkills().map((skill) => skill.name)).toEqual(["c-keep"]);
    expect(c.memory.readRules()).toContain("Keep PRs small");

    // A skill that can't be read leaves the whole set out too: a copy missing
    // it would delete it from the next home.
    fs.mkdirSync(path.join(c.adeDir, "cto", "skills", "broken", "SKILL.md"), { recursive: true });
    tick();
    await c.service.save("turn_ended");
    expect(account.copy()?.ownerDeviceId).toBe("device-c");
    expect(account.copy()?.skills).toBeUndefined();
  });
});
