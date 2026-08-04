import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import {
  invalidateWindowsDpapiMaterial,
  readOrCreateWindowsDpapiMaterialAsync,
} from "./windowsDpapiMaterial";

// The DPAPI helper is a real PowerShell child process, which no test may spawn:
// this suite runs on every platform and the module has no injection seam. Fake
// the child instead, so the cache/invalidation logic in the module's own read
// wrappers is what gets exercised.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

const POWERSHELL_PATH = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/** Minimal stand-in for the PowerShell child the module drives. */
class FakeDpapiChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = Object.assign(new EventEmitter(), { resume: () => {} });
  readonly stdin = Object.assign(new EventEmitter(), { end: () => {} });
  kill = vi.fn();

  /** Completes the unprotect with `material` as the plaintext key. */
  succeedWith(material: Buffer): void {
    this.stdout.emit("data", Buffer.from(material.toString("base64"), "utf8"));
    this.emit("close", 0);
  }
}

let tempDir = "";
let pendingChildren: FakeDpapiChild[] = [];

function writeProtectedKeyFile(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".credential-key.dpapi"),
    `ADE_WINDOWS_DPAPI_KEY_V1\n${Buffer.alloc(48, 9).toString("base64")}\n`,
  );
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-dpapi-"));
  pendingChildren = [];
  // `resolveWindowsDpapiPowerShellPath` validates a Windows system path; on any
  // host it only has to answer consistently for the fake spawn below.
  vi.spyOn(fs.realpathSync, "native").mockReturnValue(POWERSHELL_PATH);
  vi.spyOn(fs, "statSync").mockReturnValue({ isFile: () => true } as fs.Stats);
  vi.mocked(spawn).mockImplementation((() => {
    const child = new FakeDpapiChild();
    pendingChildren.push(child);
    return child;
  }) as unknown as typeof spawn);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("readOrCreateWindowsDpapiMaterialAsync", () => {
  it("does not let a read that started before an invalidation repopulate the cache", async () => {
    // Self-heal drops the cached material and retries. If a read already in
    // flight when that happened were allowed to write its result back, the
    // material the self-heal just rejected would be cached again — and the
    // credential store's 30 s self-heal throttle means nothing would clear it
    // for a full window.
    const keyDir = path.join(tempDir, "dpapi-epoch");
    writeProtectedKeyFile(keyDir);
    const stale = Buffer.alloc(32, 1);
    const fresh = Buffer.alloc(32, 2);

    const inFlight = readOrCreateWindowsDpapiMaterialAsync(keyDir);
    await vi.waitFor(() => expect(pendingChildren).toHaveLength(1));

    invalidateWindowsDpapiMaterial(keyDir);
    pendingChildren[0]!.succeedWith(stale);
    // The read still answers its own callers; only the cache write is dropped.
    expect(await inFlight).toEqual(stale);

    const next = readOrCreateWindowsDpapiMaterialAsync(keyDir);
    await vi.waitFor(() => expect(pendingChildren).toHaveLength(2));
    pendingChildren[1]!.succeedWith(fresh);

    expect(await next).toEqual(fresh);
    // And the post-invalidation read is the one that gets to stay cached.
    expect(await readOrCreateWindowsDpapiMaterialAsync(keyDir)).toEqual(fresh);
    expect(pendingChildren).toHaveLength(2);
  });

  it("coalesces concurrent reads of one key directory into a single helper spawn", async () => {
    const keyDir = path.join(tempDir, "dpapi-dedup");
    writeProtectedKeyFile(keyDir);
    const material = Buffer.alloc(32, 3);

    const first = readOrCreateWindowsDpapiMaterialAsync(keyDir);
    const second = readOrCreateWindowsDpapiMaterialAsync(keyDir);
    await vi.waitFor(() => expect(pendingChildren).toHaveLength(1));
    pendingChildren[0]!.succeedWith(material);

    expect(await first).toEqual(material);
    expect(await second).toEqual(material);
    expect(pendingChildren).toHaveLength(1);
  });
});
