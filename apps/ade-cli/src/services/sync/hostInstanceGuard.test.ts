import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guardAgainstCopiedAdeHome, HOST_INSTANCE_ENV, HOST_INSTANCE_RECORD_FILE } from "./hostInstanceGuard";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Unretirable = { why: string; block: (siteIdPath: string) => () => void };

const UNRETIRABLE: Unretirable[] = [
  {
    // The project's site id can't be moved (a permission error, a locked file).
    why: "it cannot be moved",
    block: (siteIdPath) => {
      const realRename = fs.renameSync;
      vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (String(from) === siteIdPath) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
        return realRename(from, to);
      });
      return () => vi.restoreAllMocks();
    },
  },
  {
    // Its folder can't even be looked in: "can't tell" must not read as "absent".
    why: "its folder cannot be read",
    block: (siteIdPath) => {
      const folder = path.dirname(siteIdPath);
      fs.chmodSync(folder, 0o000);
      return () => fs.chmodSync(folder, 0o700);
    },
  },
];
// A permission bit does not stop root, and Windows has no POSIX modes.
const canDenyReads = process.platform !== "win32" && process.getuid?.() !== 0;

describe("guardAgainstCopiedAdeHome", () => {
  it.each(UNRETIRABLE.filter((row) => row.why !== "its folder cannot be read" || canDenyReads))("keeps a copied home blocked while a project's site id cannot be retired ($why), and finishes on the next start", ({ block }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-host-guard-"));
    dirs.push(root);
    const adeDir = path.join(root, "home");
    const project = path.join(root, "project");
    const siteIdPath = path.join(project, ".ade", "secrets", "sync-site-id");
    fs.mkdirSync(path.join(adeDir, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(adeDir, "secrets", "machine.json"), "{}");
    fs.writeFileSync(path.join(adeDir, HOST_INSTANCE_RECORD_FILE), JSON.stringify({ instanceId: "box-original" }));
    fs.writeFileSync(path.join(adeDir, "projects.json"), JSON.stringify({ projects: [{ rootPath: project }] }));
    fs.mkdirSync(path.dirname(siteIdPath), { recursive: true });
    fs.writeFileSync(siteIdPath, "copied-site-id");
    const env = { [HOST_INSTANCE_ENV]: "box-fork" };
    const recordedInstance = () =>
      (JSON.parse(fs.readFileSync(path.join(adeDir, HOST_INSTANCE_RECORD_FILE), "utf8")) as { instanceId: string }).instanceId;

    const unblock = block(siteIdPath);
    const blocked = guardAgainstCopiedAdeHome({ adeDir, env });
    expect(blocked.action).toBe("blocked");
    expect(blocked.action === "blocked" ? blocked.failures.map((failure) => failure.path) : []).toEqual([project]);
    // Not marked as this box: the next start must run the reset again.
    expect(recordedInstance()).toBe("box-original");
    unblock();
    expect(fs.readFileSync(siteIdPath, "utf8")).toBe("copied-site-id");

    const reset = guardAgainstCopiedAdeHome({ adeDir, env });
    expect(reset.action).toBe("reset");
    expect(recordedInstance()).toBe("box-fork");
    expect(fs.existsSync(siteIdPath)).toBe(false);
    // The identity moved once, on the first pass, and kept its files.
    const moved = fs.readdirSync(path.join(adeDir, "copied-identities"));
    expect(moved).toHaveLength(1);
    expect(fs.existsSync(path.join(adeDir, "copied-identities", moved[0]!, "machine.json"))).toBe(true);
  });
});
