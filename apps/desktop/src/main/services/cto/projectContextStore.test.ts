import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createProjectContextStore,
  projectContextAccountPort,
  type ProjectContextAccountPort,
  type ProjectContextItem,
} from "./projectContextStore";

function tempAdeDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cto-context-"));
  const adeDir = path.join(root, ".ade");
  fs.mkdirSync(adeDir, { recursive: true });
  return adeDir;
}

function fakeAccount(initial: Array<{ key: string; value: unknown; updatedAt: string }> = []): {
  port: ProjectContextAccountPort;
  rows: Map<string, { value: unknown; updatedAt: string }>;
  status: { current: "ready" | "unavailable" | "failed" };
} {
  const rows = new Map(initial.map((row) => [row.key, { value: row.value, updatedAt: row.updatedAt }]));
  const status: { current: "ready" | "unavailable" | "failed" } = { current: "ready" };
  const port: ProjectContextAccountPort = {
    scope: "repo:github.com/acme/ade",
    list: () => [...rows.entries()].map(([key, row]) => ({ key, value: row.value, updatedAt: row.updatedAt })),
    set: (key, value) => {
      rows.set(key, { value, updatedAt: "2026-09-21T00:00:00.000Z" });
      return true;
    },
    remove: (key) => rows.delete(key),
    sync: async () => status.current,
  };
  return { port, rows, status };
}

describe("projectContextStore", () => {
  it("survives a new instance, which is what a restart or a crash comes back as", () => {
    const adeDir = tempAdeDir();
    const first = createProjectContextStore({ adeDir, now: () => "2026-09-21T12:00:00.000Z" });
    first.setBrief({
      goal: "Ship the coordinator",
      success: "One CTO directs every thread",
      constraints: "No repository writes",
      conventions: "",
      openLoops: "",
    });
    first.remember({ text: "The installer needs a GUI prompt.", tags: { topic: "installer" } });
    first.recordThread({
      title: "Installer",
      sessionId: "chat-child",
      laneId: "lane-installer",
      objective: "Fix the prompt",
    });

    const second = createProjectContextStore({ adeDir });
    expect(second.briefText()).toContain("Ship the coordinator");
    expect(second.search("installer").map((item) => item.text)).toEqual(["The installer needs a GUI prompt."]);
    expect(second.threadsText()).toContain("chat-child");

    const onDisk = JSON.parse(fs.readFileSync(second.filePath, "utf8")) as Record<string, unknown>;
    expect(onDisk).not.toHaveProperty("ownerSessionId");
    expect(onDisk).not.toHaveProperty("sessionId");
    expect((fs.statSync(second.filePath).mode & 0o777)).toBe(0o600);
  });

  it("quarantines a corrupt file instead of throwing", () => {
    const adeDir = tempAdeDir();
    const store = createProjectContextStore({ adeDir });
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    fs.writeFileSync(store.filePath, "{not json", "utf8");

    expect(store.read().items).toEqual([]);
    expect(store.briefText()).toBeNull();
    const names = fs.readdirSync(path.dirname(store.filePath));
    expect(names.some((name) => name.includes(".corrupt-"))).toBe(true);
  });

  it("imports MEMORY.md bullets once", () => {
    const adeDir = tempAdeDir();
    const store = createProjectContextStore({ adeDir, now: () => "2026-09-21T12:00:00.000Z" });
    store.migrateFromMemory("# CTO Durable Memory\n\n- Alpha fact\n- Alpha fact\n- Beta fact\nnot a bullet\n");
    expect(store.read().items.map((item) => item.text)).toEqual(["Alpha fact", "Beta fact"]);
    store.migrateFromMemory("- Gamma fact\n");
    expect(store.read().items.map((item) => item.text)).toEqual(["Alpha fact", "Beta fact"]);
    expect(store.read().migratedFromMemoryAt).toBe("2026-09-21T12:00:00.000Z");
  });

  it("ranks a pinned fact ahead of a newer active one, and skips archived facts on an empty query", () => {
    const adeDir = tempAdeDir();
    let tick = 0;
    const store = createProjectContextStore({
      adeDir,
      now: () => `2026-09-21T12:00:0${tick++}.000Z`,
    });
    store.remember({ text: "active sync note", status: "active" });
    store.remember({ text: "pinned sync note", status: "pinned" });
    store.remember({ text: "archived sync note", status: "archived" });

    expect(store.search("sync", 5).map((item) => item.text)[0]).toBe("pinned sync note");
    expect(store.search("", 5).map((item) => item.status)).not.toContain("archived");
  });

  it("stays local when the account mirror is unavailable", async () => {
    const adeDir = tempAdeDir();
    const account = fakeAccount();
    account.status.current = "unavailable";
    const store = createProjectContextStore({ adeDir, account: account.port });
    store.remember({ text: "Local only until the account answers." });
    await store.reconcile();
    expect(account.rows.size).toBe(0);
    expect(store.search("local", 5)).toHaveLength(1);
  });

  it("merges a newer remote fact and drops a mirrored fact the account deleted", async () => {
    const adeDir = tempAdeDir();
    const remoteItem: ProjectContextItem = {
      id: "remote-1",
      text: "The relay signs every batch.",
      kind: "decision",
      status: "active",
      trust: "cto",
      tags: { topic: "sync" },
      createdAt: "2026-09-21T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
    };
    const account = fakeAccount([{
      key: "ctx.item.remote-1",
      value: remoteItem,
      updatedAt: "2026-09-21T00:00:00.000Z",
    }]);
    const store = createProjectContextStore({ adeDir, account: account.port });
    await store.reconcile();
    expect(store.read().items.map((item) => item.text)).toContain("The relay signs every batch.");

    store.remember({ text: "Keep the local pin." });
    await store.reconcile();
    const local = store.read().items.find((item) => item.text === "Keep the local pin.");
    expect(local?.accountSyncedAt).toBeTruthy();

    account.rows.delete(`ctx.item.${local?.id}`);
    await store.reconcile();
    expect(store.read().items.map((item) => item.text)).not.toContain("Keep the local pin.");
    expect(store.read().items.map((item) => item.text)).toContain("The relay signs every batch.");
  });

  it("does not invent an account scope for a checkout with no remote", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cto-noremote-"));
    const port = projectContextAccountPort({
      projectRoot,
      store: {
        list: () => [],
        set: () => true,
        remove: () => true,
        sync: async () => "ready",
      },
    });
    expect(port).toBeNull();
  });

  it("reclaims a stale migration lock and still imports once", () => {
    const adeDir = tempAdeDir();
    const store = createProjectContextStore({ adeDir, now: () => "2026-09-21T12:00:00.000Z" });
    const lockDir = `${store.filePath}.migrate.lock`;
    fs.mkdirSync(lockDir, { recursive: true });
    const stale = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir, stale, stale);
    store.migrateFromMemory("- Alpha fact\n");
    expect(store.read().items.map((item) => item.text)).toEqual(["Alpha fact"]);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("leaves a live migration lock for the other process", () => {
    const adeDir = tempAdeDir();
    const store = createProjectContextStore({ adeDir });
    const lockDir = `${store.filePath}.migrate.lock`;
    fs.mkdirSync(lockDir, { recursive: true });
    store.migrateFromMemory("- Beta fact\n");
    expect(store.read().items).toEqual([]);
    expect(store.read().migratedFromMemoryAt).toBeNull();
  });

  it("does not pull a capped thread back from the account", async () => {
    const adeDir = tempAdeDir();
    let tick = 0;
    const account = fakeAccount();
    const store = createProjectContextStore({
      adeDir,
      account: account.port,
      now: () => {
        const minute = String(Math.floor(tick / 60)).padStart(2, "0");
        const second = String(tick % 60).padStart(2, "0");
        tick += 1;
        return `2026-09-21T12:${minute}:${second}.000Z`;
      },
    });
    const threads = [];
    for (let index = 0; index < 40; index += 1) {
      threads.push(store.recordThread({
        title: `Thread ${index}`,
        sessionId: `chat-${index}`,
        laneId: "lane-1",
        objective: "work",
      }));
    }
    await store.reconcile();
    const oldest = threads[0];
    store.recordThread({
      title: "Thread 40",
      sessionId: "chat-40",
      laneId: "lane-1",
      objective: "work",
    });
    await store.reconcile();
    await store.reconcile();
    const ids = store.read().threads.map((thread) => thread.sessionId);
    expect(ids).toHaveLength(40);
    expect(ids).not.toContain(oldest.sessionId);
    expect(account.rows.has(`ctx.thread.${oldest.id}`)).toBe(false);
    expect(ids).toContain("chat-40");
  });

  it("syncs archived facts to the account copy", async () => {
    const adeDir = tempAdeDir();
    let tick = 0;
    const account = fakeAccount();
    const store = createProjectContextStore({
      adeDir,
      account: account.port,
      now: () => {
        tick += 1;
        return `2026-09-21T12:00:${String(tick).padStart(2, "0")}.000Z`;
      },
    });
    const first = store.remember({ text: "fact-0" });
    for (let index = 1; index < 121; index += 1) {
      store.remember({ text: `fact-${index}` });
    }
    await store.reconcile();
    const remote = account.rows.get(`ctx.item.${first.item?.id}`);
    expect((remote?.value as ProjectContextItem).status).toBe("archived");
    expect(store.read().items.find((item) => item.id === first.item?.id)?.status).toBe("archived");
  });
});
