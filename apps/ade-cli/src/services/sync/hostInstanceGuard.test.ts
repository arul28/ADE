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

describe("guardAgainstCopiedAdeHome", () => {
  it("keeps a copied home blocked until every project's site id is retired, and finishes on the next start", () => {
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

    // The project's site id can't be moved (a permission error, a locked file).
    const realRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from) === siteIdPath) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      return realRename(from, to);
    });
    const blocked = guardAgainstCopiedAdeHome({ adeDir, env });
    expect(blocked.action).toBe("blocked");
    expect(blocked.action === "blocked" ? blocked.failures.map((failure) => failure.path) : []).toEqual([project]);
    // Not marked as this box: the next start must run the reset again.
    expect(recordedInstance()).toBe("box-original");
    expect(fs.readFileSync(siteIdPath, "utf8")).toBe("copied-site-id");

    vi.restoreAllMocks();
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
