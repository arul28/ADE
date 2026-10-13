import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchTree, type TreeWatcher, type TreeWatcherEvent } from "./treeWatcher";

const TREE_EVENTS: TreeWatcherEvent[] = ["add", "change", "unlink", "addDir", "unlinkDir"];

// `watchTree` selects the recursive native watcher on macOS and Windows and has
// no seam to select it elsewhere; Linux hands the tree to chokidar. The Windows
// job runs this file; no macOS CI job runs the desktop tests, so a Mac does.
// DARWIN-GATE: no macOS runner executes the desktop vitest suites
describe.skipIf(process.platform !== "darwin" && process.platform !== "win32")("watchTree on macOS and Windows", () => {
  let base: string;
  let root: string;
  let watcher: TreeWatcher | null;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ade-tree-watcher-"));
    root = path.join(base, "root");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "one.txt"), "one");
    fs.writeFileSync(path.join(root, "two.txt"), "two");
    watcher = null;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await watcher?.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  /** Starts a watcher and records `event path` (path relative to the root) for every tree event. */
  async function watchRoot(options: Parameters<typeof watchTree>[1] = {}) {
    const seen: string[] = [];
    const waiters: Array<{ wanted: string[]; resolve: () => void }> = [];
    const started = watchTree(root, options);
    watcher = started;
    for (const event of TREE_EVENTS) {
      started.on(event, (absPath) => {
        seen.push(`${event} ${path.relative(root, absPath).split(path.sep).join("/")}`);
        for (const waiter of waiters) {
          if (waiter.wanted.every((entry) => seen.includes(entry))) waiter.resolve();
        }
      });
    }
    await new Promise<void>((resolve) => started.once("ready", resolve));
    return {
      seen,
      /** Resolves when every listed event has arrived. */
      saw: (...wanted: string[]) =>
        new Promise<void>((resolve) => {
          if (wanted.every((entry) => seen.includes(entry))) resolve();
          else waiters.push({ wanted, resolve });
        }),
    };
  }

  it("reports files and directories that appear, change and go, and stays silent for ignored paths", async () => {
    fs.mkdirSync(path.join(root, "node_modules"));
    const events = await watchRoot({ ignored: [/(^|[/\\])node_modules($|[/\\])/] });
    // The tree that was there before the watch is not announced.
    expect(events.seen).toEqual([]);

    fs.writeFileSync(path.join(root, "node_modules", "ignored.js"), "x");
    fs.mkdirSync(path.join(root, "lib"));
    fs.writeFileSync(path.join(root, "lib", "new.txt"), "new");
    await events.saw("addDir lib", "add lib/new.txt");

    fs.writeFileSync(path.join(root, "two.txt"), "two, changed");
    await events.saw("change two.txt");

    fs.rmSync(path.join(root, "src"), { recursive: true });
    await events.saw("unlink src/one.txt", "unlinkDir src");

    expect(events.seen.filter((entry) => entry.includes("node_modules"))).toEqual([]);
    expect(events.seen).not.toContain("add two.txt");
  });

  it("reports the whole tree as removed when the root is moved away, and new files when it comes back", async () => {
    const events = await watchRoot();

    fs.renameSync(root, path.join(base, "elsewhere"));
    await events.saw("unlink two.txt", "unlink src/one.txt", "unlinkDir src", "unlinkDir ");

    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "fresh.txt"), "fresh");
    await events.saw("add fresh.txt");
    // The old tree is gone; nothing of it is announced again.
    expect(events.seen.filter((entry) => entry.startsWith("add "))).toEqual(["add fresh.txt"]);
  });

  it("reads the whole tree again when the OS reports that it dropped events", async () => {
    // The root's recursive watch delivers nothing of its own here; the test
    // decides when the OS "overflows" (an event with no file name).
    const realWatch = fs.watch.bind(fs) as (...args: unknown[]) => fs.FSWatcher;
    let overflow: (() => void) | null = null;
    vi.spyOn(fs, "watch").mockImplementation(((dir: string, options: unknown, listener: (event: string, name: string | null) => void) => {
      if ((options as { recursive?: boolean } | undefined)?.recursive) {
        overflow = () => listener("rename", null);
        return realWatch(dir, options, () => {});
      }
      return realWatch(dir, options, listener);
    }) as never);
    const events = await watchRoot();
    expect(overflow, "the root's watch was opened").not.toBeNull();

    fs.mkdirSync(path.join(root, "lib"));
    fs.writeFileSync(path.join(root, "lib", "new.txt"), "new");
    fs.rmSync(path.join(root, "two.txt"));
    fs.writeFileSync(path.join(root, "src", "one.txt"), "one, changed");
    for (let index = 0; index < 20; index += 1) overflow!();

    await events.saw("addDir lib", "add lib/new.txt", "unlink two.txt", "change src/one.txt");
    // However many overflows arrive, each change is reported once.
    expect(events.seen.filter((entry) => entry === "add lib/new.txt")).toEqual(["add lib/new.txt"]);
  });

  it.skipIf(process.platform !== "win32")("notices a root that is created after the watch starts (Windows)", async () => {
    fs.rmSync(root, { recursive: true, force: true });
    const events = await watchRoot();
    expect(events.seen).toEqual([]);

    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "fresh.txt"), "fresh");
    await events.saw("add fresh.txt");
    // Later changes come from the new root's own watch.
    fs.writeFileSync(path.join(root, "later.txt"), "later");
    await events.saw("add later.txt");
  });

  it("still reports ready when the root cannot be watched, so a caller that waits to close is not left waiting", async () => {
    const failure = Object.assign(new Error("too many open files"), { code: "EMFILE" });
    vi.spyOn(fs, "watch").mockImplementation(() => {
      throw failure;
    });
    const order: string[] = [];
    const errors: unknown[] = [];
    const started = watchTree(root);
    watcher = started;
    started.on("error", (error) => {
      order.push("error");
      errors.push(error);
    });
    await new Promise<void>((resolve) =>
      started.once("ready", () => {
        order.push("ready");
        resolve();
      }));

    expect(errors).toEqual([failure]);
    expect(order).toEqual(["error", "ready"]);
    await expect(started.close()).resolves.toBeUndefined();
  });
});
