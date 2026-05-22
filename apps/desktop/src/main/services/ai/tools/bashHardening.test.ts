/* @vitest-environment node */
import { describe, expect, it } from "vitest";
import { DEFAULT_WORKER_SANDBOX_CONFIG } from "../../orchestrator/orchestratorConstants";
import type { WorkerSandboxConfig } from "../../../../shared/types";
import {
  checkWorkerSandbox,
  commandUsesInterpreterPayload,
} from "./universalTools";
import { buildOrchestrationSandboxConfig } from "./orchestrationTools";

const PROJECT = "/tmp/ade-bash-hardening";
const BUNDLE = `${PROJECT}/.ade/orchestration/R-test`;

function orchestrationConfig(extra: Partial<WorkerSandboxConfig> = {}): WorkerSandboxConfig {
  return {
    ...buildOrchestrationSandboxConfig(BUNDLE),
    ...extra,
  };
}

describe("bash hardening — hardlink (ln without -s)", () => {
  it("blocks `ln <src> <dst>` (default sandbox treats it as mutating)", () => {
    const result = checkWorkerSandbox(
      `ln ${BUNDLE}/manifest.json /tmp/leak.json`,
      orchestrationConfig(),
      PROJECT,
    );
    expect(result.allowed).toBe(false);
  });

  it("blocks `ln <src> manifest.json` from writing the bundle manifest", () => {
    const result = checkWorkerSandbox(
      `ln /tmp/source.json ${BUNDLE}/manifest.json`,
      orchestrationConfig(),
      PROJECT,
    );
    expect(result.allowed).toBe(false);
  });

  it("still permits `ln -s` (symlink) read-style use inside the sandbox", () => {
    const result = checkWorkerSandbox(
      `ln -s ./a ./b`,
      orchestrationConfig({ blockByDefault: false }),
      PROJECT,
    );
    // symlink isn't a hardlink and our MUTATING_BASH_RE addition uses
    // a negative lookahead for `-s`, so the mutation flag is not set.
    expect(result.allowed).toBe(true);
  });
});

describe("bash hardening — interpreter payloads", () => {
  it("commandUsesInterpreterPayload detects python -c", () => {
    expect(commandUsesInterpreterPayload("python -c \"print(1)\"")).toBe(true);
    expect(commandUsesInterpreterPayload("python3 -c 'open(1)'")).toBe(true);
    expect(commandUsesInterpreterPayload("node -e \"fs.writeFileSync('x','y')\"")).toBe(true);
    expect(commandUsesInterpreterPayload("ruby -e 'File.open(\"x\",\"w\")'")).toBe(true);
  });

  it("does NOT match perl -i (already covered by MUTATING_BASH_RE)", () => {
    expect(commandUsesInterpreterPayload("perl -i -pe 's/a/b/' file.txt")).toBe(false);
  });

  it("blocks `python -c open(...)` against bundle manifest", () => {
    const result = checkWorkerSandbox(
      `python -c "open('${BUNDLE}/manifest.json','w').write('hax')"`,
      orchestrationConfig(),
      PROJECT,
    );
    expect(result.allowed).toBe(false);
  });

  it("blocks `node -e fs.writeFileSync(...)` against bundle plan", () => {
    const result = checkWorkerSandbox(
      `node -e "require('fs').writeFileSync('${BUNDLE}/plan.md','x')"`,
      orchestrationConfig(),
      PROJECT,
    );
    expect(result.allowed).toBe(false);
  });

  it("blocks unknown `python --version` under blockByDefault: true", () => {
    const result = checkWorkerSandbox(
      "python --version",
      orchestrationConfig(),
      PROJECT,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/blockByDefault|safe list/i);
  });

  it("blocks `python -c print(1)` under blockByDefault (not safe-listed)", () => {
    const result = checkWorkerSandbox(
      `python -c "print(1)"`,
      orchestrationConfig(),
      PROJECT,
    );
    expect(result.allowed).toBe(false);
  });
});

describe("bash hardening — artifacts/ writes succeed", () => {
  it("permits redirecting into bundle artifacts under default config", () => {
    const baseCfg: WorkerSandboxConfig = {
      ...DEFAULT_WORKER_SANDBOX_CONFIG,
      // Allow the project root + bundle artifacts subtree
      allowedPaths: [PROJECT, `${BUNDLE}/artifacts`],
      // Don't flip blockByDefault here — we want to test the path policy alone.
    };
    const result = checkWorkerSandbox(
      `echo "log" > ${BUNDLE}/artifacts/test_log.txt`,
      baseCfg,
      PROJECT,
    );
    expect(result.allowed).toBe(true);
  });

  it("permits writing artifacts even with orchestration config + safe-listed shell", () => {
    const cfg = orchestrationConfig({
      // add the bundle artifacts dir to allowedPaths
      allowedPaths: [PROJECT, `${BUNDLE}/artifacts`],
      // add a safe pattern matching `tee` so blockByDefault doesn't trip it
      safeCommands: [
        ...DEFAULT_WORKER_SANDBOX_CONFIG.safeCommands,
        "^tee\\s",
      ],
    });
    const result = checkWorkerSandbox(
      `tee ${BUNDLE}/artifacts/log.txt`,
      cfg,
      PROJECT,
    );
    // tee writes — protectedFiles regexes target only manifest/plan, not
    // artifacts. The command does not match a blocked pattern and is in the
    // safe list.
    expect(result.allowed).toBe(true);
  });

  it("denies redirecting into the bundle manifest under the orchestration config", () => {
    const cfg = orchestrationConfig({
      allowedPaths: [PROJECT, BUNDLE],
      safeCommands: [
        ...DEFAULT_WORKER_SANDBOX_CONFIG.safeCommands,
        "^echo\\s",
      ],
    });
    const result = checkWorkerSandbox(
      `echo "x" > ${BUNDLE}/manifest.json`,
      cfg,
      PROJECT,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/protected file/i);
  });
});

describe("bash hardening — blockByDefault denies novel commands", () => {
  it("blocks `cat ./README` when not in safe list and blockByDefault: true", () => {
    const result = checkWorkerSandbox(
      "cat ./README",
      orchestrationConfig(),
      PROJECT,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/blockByDefault|safe list/i);
  });

  it("still allows safe-listed git commands", () => {
    const result = checkWorkerSandbox("git status", orchestrationConfig(), PROJECT);
    expect(result.allowed).toBe(true);
  });
});
