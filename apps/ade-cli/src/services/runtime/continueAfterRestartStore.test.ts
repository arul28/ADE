import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAdeLayout } from "../../../../desktop/src/shared/adeLayout";
import { resolveMachineAdeLayout } from "../projects/machineLayout";
import { ProjectRegistry } from "../projects/projectRegistry";
import { removeTestTree } from "../../test/filesystem";
import {
  continueAfterRestartFilePath,
  resolveContinueAfterRestart,
  writeSavedContinueAfterRestart,
} from "./continueAfterRestartStore";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeTestTree(root);
});

/** A machine home with projects registered; `off` projects turned the old setting off. */
function machineWithProjects(projects: Array<{ name: string; off?: boolean }>): NodeJS.ProcessEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-continue-after-restart-"));
  roots.push(root);
  const env = { ADE_HOME: path.join(root, "home") };
  const registry = new ProjectRegistry(resolveMachineAdeLayout(env));
  for (const project of projects) {
    const projectRoot = path.join(root, project.name);
    fs.mkdirSync(projectRoot, { recursive: true });
    if (project.off) {
      const config = resolveAdeLayout(projectRoot).localConfigPath;
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, "ai:\n  chat:\n    continueAfterRestart: false\n");
    }
    registry.add(projectRoot);
  }
  return env;
}

describe("resolveContinueAfterRestart", () => {
  it("migrates once from the projects, keeps an explicit off, and then follows the machine's own value", () => {
    const env = machineWithProjects([{ name: "web" }, { name: "api", off: true }]);

    // One project had turned it off on purpose: the machine starts off, and
    // the answer is saved so it is decided once.
    expect(resolveContinueAfterRestart(env)).toBe(false);
    expect(JSON.parse(fs.readFileSync(continueAfterRestartFilePath(env), "utf8")).continueAfterRestart).toBe(false);

    // The project's old value no longer decides: the migration does not run again.
    fs.rmSync(resolveAdeLayout(path.join(path.dirname(env.ADE_HOME!), "api")).localConfigPath);
    expect(resolveContinueAfterRestart(env)).toBe(false);

    // A change on this machine (Settings › Chat, or a pinned set from another one) wins.
    writeSavedContinueAfterRestart(true, env);
    expect(resolveContinueAfterRestart(env)).toBe(true);

    // A machine where no project turned it off starts on.
    const fresh = machineWithProjects([{ name: "web" }]);
    expect(resolveContinueAfterRestart(fresh)).toBe(true);
    expect(fs.existsSync(continueAfterRestartFilePath(fresh))).toBe(true);
  });
});
