/**
 * Grok permission preflight.
 *
 * The log fragments below are verbatim captures from live Grok 1.0.13 on
 * 2026-08-31, taken against a fake `HOME` whose `~/.claude/settings.json`
 * contained ONLY `{"permissions":{"defaultMode":"auto"}}` — the case the old
 * `grok inspect` parser was blind to, and which drove a real ACP session to
 * zero permission requests and a completed write. Same binary, same argv, same
 * cwd; the only difference is `_GROK_CLAUDE_MARKER_OVERRIDE`.
 *
 * Every test that is not the happy path asserts `ok: false`. There is no input
 * that may turn silence into a pass.
 */

import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkGrokPermissionNeutralization,
  classifyGrokAttestLog,
  getCachedGrokPermissionPreflight,
  GROK_AUTO_SEEDED_MARKER,
  GROK_COMPAT_DISABLED_MARKER,
  resetGrokPermissionPreflightCache,
  withGrokDebugLogging,
  type RunGrokAttestProbe,
} from "./grokPermissionPreflight";
import { grokDialect } from "../chat/acpHost/acpDialects";
import { GROK_CLAUDE_MARKER_OVERRIDE_ENV } from "../../../shared/grokSupervision";
import type { AcpSpawnPlan } from "../chat/acpHost/acpHostTypes";

/** Live capture WITHOUT the kill switch: Claude's defaultMode seeded auto. */
const LOG_LEAKING = `
2026-08-31T17:55:20.101010Z  INFO xai_grok_workspace::config: loaded config
2026-08-31T17:55:26.141930Z  INFO xai_grok_workspace::permission::manager: auto permission mode seeded from Claude defaultMode / prompt_policy
2026-08-31T17:55:26.200000Z  INFO run_stdio_agent: session ready
`;

/** Live capture WITH the kill switch: the hatch fired, nothing was seeded. */
const LOG_NEUTRALIZED = `
2026-08-31T17:55:27.101010Z  INFO xai_grok_workspace::config: loaded config
2026-08-31T17:55:27.151465Z  INFO run_stdio_agent: xai_grok_workspace::permission::claude_settings: Claude compat disabled (marker set in config.toml) first_gate="load_claude_env_with_project"
2026-08-31T17:55:27.200000Z  INFO run_stdio_agent: session ready
`;

const PLAN: AcpSpawnPlan = grokDialect.buildSpawnPlan({
  binaryPath: "/bin/grok",
  cwd: "/lane/worktree",
  baseEnv: { PATH: "/bin" },
});

function runReturning(logText: string, version: string | null = "1.0.13"): RunGrokAttestProbe {
  return async () => ({ ok: true, logText, version });
}

beforeEach(() => {
  resetGrokPermissionPreflightCache();
});

describe("grok debug spawn plan", () => {
  it("puts the debug flags before the agent subcommand, where global flags go", () => {
    const plan = withGrokDebugLogging(PLAN, "/tmp/probe.log");
    expect(plan.args.indexOf("--debug")).toBeLessThan(plan.args.indexOf("agent"));
    expect(plan.args.indexOf("--debug-file")).toBeLessThan(plan.args.indexOf("agent"));
    expect(plan.args[plan.args.indexOf("--debug-file") + 1]).toBe("/tmp/probe.log");
    expect(plan.args.at(-1)).toBe("stdio");
  });

  it("copies the session's own argv and environment verbatim", () => {
    // A probe run against a different process than the session would prove
    // nothing, so everything except the debug flags must survive untouched.
    const plan = withGrokDebugLogging(PLAN, "/tmp/probe.log");
    expect(plan.env[GROK_CLAUDE_MARKER_OVERRIDE_ENV]).toBe("1");
    expect(plan.env.PATH).toBe("/bin");
    expect(plan.cwd).toBe("/lane/worktree");
    expect(plan.args).toEqual(expect.arrayContaining(["--permission-mode", "default"]));
    expect(plan.args.filter((arg) => arg === "--debug")).toHaveLength(1);
  });
});

describe("grok self-attestation", () => {
  it("passes only when the hatch fired and nothing was seeded", () => {
    expect(classifyGrokAttestLog(LOG_NEUTRALIZED, "1.0.13")).toMatchObject({
      ok: true,
      status: "neutralized",
      compatDisabledHits: 1,
      autoSeededHits: 0,
    });
  });

  it("catches the defaultMode-only leak that grok inspect cannot see", () => {
    // The regression this whole module was rewritten for: `grok inspect` printed
    // `Source: (none)` / `0 loaded` for this machine, byte-identical to a clean
    // one, while the session did zero permission requests and wrote the file.
    expect(classifyGrokAttestLog(LOG_LEAKING, "1.0.13")).toMatchObject({
      ok: false,
      status: "claude-import-active",
      autoSeededHits: 1,
    });
  });

  it("fails when the attestation line is renamed away", () => {
    // The log strings are no more contractual than the env var. If xAI renames
    // one, the positive proof disappears and ADE must degrade, not assume.
    const renamed = LOG_NEUTRALIZED.replace(
      GROK_COMPAT_DISABLED_MARKER,
      "Claude compatibility layer switched off",
    );
    expect(classifyGrokAttestLog(renamed, "1.0.13")).toMatchObject({
      ok: false,
      status: "marker-not-honored",
      compatDisabledHits: 0,
    });
  });

  it("fails when the hatch is removed entirely, which is the regression it detects", () => {
    const noHatch = LOG_NEUTRALIZED.replace(/.*Claude compat disabled.*\n/, "");
    expect(classifyGrokAttestLog(noHatch, "1.0.13").ok).toBe(false);
  });

  it("fails on an empty or missing debug log rather than assuming silence is good", () => {
    expect(classifyGrokAttestLog("", null)).toMatchObject({ ok: false, status: "unparsable" });
    expect(classifyGrokAttestLog("   \n  ", null)).toMatchObject({ ok: false, status: "unparsable" });
  });

  it("reports the leak even when both lines somehow appear", () => {
    // Contradictory evidence resolves toward the observed harm, not the claim.
    const both = `${LOG_NEUTRALIZED}\n${LOG_LEAKING}`;
    expect(classifyGrokAttestLog(both, "1.0.13")).toMatchObject({
      ok: false,
      status: "claude-import-active",
    });
  });

  it("never passes any input that lacks the attestation", () => {
    for (const sample of ["", "random noise", GROK_AUTO_SEEDED_MARKER, "INFO session ready"]) {
      expect(classifyGrokAttestLog(sample, null).ok).toBe(false);
    }
  });
});

describe("grok permission preflight", () => {
  it("verifies with the probe and passes a neutralized machine", async () => {
    const result = await checkGrokPermissionNeutralization({
      spawnPlan: PLAN,
      run: runReturning(LOG_NEUTRALIZED),
    });
    expect(result).toMatchObject({ ok: true, status: "neutralized", version: "1.0.13" });
  });

  it("treats a probe that cannot run as unverified rather than as a pass", async () => {
    const result = await checkGrokPermissionNeutralization({
      spawnPlan: PLAN,
      run: async () => ({ ok: false, error: "spawn ENOENT" }),
    });
    expect(result).toMatchObject({ ok: false, status: "probe-failed", detail: "spawn ENOENT" });
  });

  it("treats a probe timeout as unverified rather than as a pass", async () => {
    const result = await checkGrokPermissionNeutralization({
      spawnPlan: PLAN,
      run: async ({ timeoutMs }) => ({ ok: false, error: `handshake exceeded ${timeoutMs}ms` }),
      timeoutMs: 25,
    });
    expect(result).toMatchObject({ ok: false, status: "probe-failed" });
    expect(result.detail).toContain("25ms");
  });

  it("survives a runner that throws instead of returning a failure", async () => {
    const result = await checkGrokPermissionNeutralization({
      spawnPlan: PLAN,
      run: async () => {
        throw new Error("boom");
      },
    });
    expect(result).toMatchObject({ ok: false, status: "probe-failed", detail: "boom" });
  });

  it("deletes the debug log once it has the verdict", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-grok-preflight-test-"));
    try {
      let seenPath = "";
      await checkGrokPermissionNeutralization({
        spawnPlan: PLAN,
        debugDir: dir,
        run: async ({ debugFilePath }) => {
          seenPath = debugFilePath;
          // Stand in for the agent writing its log.
          fs.writeFileSync(debugFilePath, LOG_NEUTRALIZED, "utf8");
          return { ok: true, logText: LOG_NEUTRALIZED, version: "1.0.13" };
        },
      });
      expect(seenPath.startsWith(dir)).toBe(true);
      expect(fs.existsSync(seenPath)).toBe(false);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes the debug log even when the probe fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-grok-preflight-test-"));
    try {
      await checkGrokPermissionNeutralization({
        spawnPlan: PLAN,
        debugDir: dir,
        run: async ({ debugFilePath }) => {
          fs.writeFileSync(debugFilePath, "partial", "utf8");
          return { ok: false, error: "crashed" };
        },
      });
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("probes once per binary, cwd and argv, then answers from cache", async () => {
    let calls = 0;
    const run: RunGrokAttestProbe = async () => {
      calls += 1;
      return { ok: true, logText: LOG_NEUTRALIZED, version: "1.0.13" };
    };
    await checkGrokPermissionNeutralization({ spawnPlan: PLAN, run });
    await checkGrokPermissionNeutralization({ spawnPlan: PLAN, run });
    expect(calls).toBe(1);
    expect(getCachedGrokPermissionPreflight(PLAN)?.ok).toBe(true);

    // A different lane is a different answer: Grok resolves project-scoped
    // rules against the cwd.
    await checkGrokPermissionNeutralization({ spawnPlan: { ...PLAN, cwd: "/other/lane" }, run });
    expect(calls).toBe(2);

    // A different permission mode rides argv, so it earns its own verdict.
    const yoloPlan = grokDialect.buildSpawnPlan({
      binaryPath: "/bin/grok",
      cwd: "/lane/worktree",
      baseEnv: { PATH: "/bin" },
      permissionMode: "yolo",
    });
    await checkGrokPermissionNeutralization({ spawnPlan: yoloPlan, run });
    expect(calls).toBe(3);
  });

  it("re-probes when the caller forces it", async () => {
    let calls = 0;
    const run: RunGrokAttestProbe = async () => {
      calls += 1;
      return { ok: true, logText: LOG_NEUTRALIZED, version: "1.0.13" };
    };
    await checkGrokPermissionNeutralization({ spawnPlan: PLAN, run });
    await checkGrokPermissionNeutralization({ spawnPlan: PLAN, run, force: true });
    expect(calls).toBe(2);
  });

  it("shares one in-flight probe between concurrent opens", async () => {
    let calls = 0;
    const run: RunGrokAttestProbe = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true, logText: LOG_NEUTRALIZED, version: "1.0.13" };
    };
    const [a, b] = await Promise.all([
      checkGrokPermissionNeutralization({ spawnPlan: PLAN, run }),
      checkGrokPermissionNeutralization({ spawnPlan: PLAN, run }),
    ]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });
});
