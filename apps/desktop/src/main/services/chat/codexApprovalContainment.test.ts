import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  codexApprovalAutoAccepts,
  codexApprovalDeniesByPolicy,
  codexApprovalPathStaysWithinRoot,
  codexCommandApprovalStaysWithinRoot,
  codexPermissionsStayWithinRoot,
  resolveCodexContainmentRoot,
} from "./codexApprovalContainment";

// Real directories, canonicalized. `resolvePathWithinRoot` walks the actual
// filesystem — it realpaths the root and every existing ancestor of the
// candidate — so a made-up path under `/tmp` fails on macOS for the wrong
// reason: `/tmp` is itself a symlink to `/private/tmp`.
const TEMP_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-codex-containment-")));
const LANE = path.join(TEMP_ROOT, "lane");
const SANDBOX = path.join(TEMP_ROOT, "sandbox");
const OUTSIDE = path.join(TEMP_ROOT, "elsewhere");
for (const dir of [LANE, SANDBOX, OUTSIDE, path.join(SANDBOX, "app"), path.join(SANDBOX, "src")]) {
  fs.mkdirSync(dir, { recursive: true });
}

afterAll(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

describe("resolveCodexContainmentRoot", () => {
  it("uses the policy's sandboxRoot when it names one", () => {
    expect(resolveCodexContainmentRoot({ permissionPolicy: { fallback: "ask", sandboxRoot: SANDBOX } }, LANE))
      .toBe(SANDBOX);
  });

  it("falls back to the session's own worktree", () => {
    expect(resolveCodexContainmentRoot({ permissionPolicy: { fallback: "ask" } }, LANE)).toBe(LANE);
    expect(resolveCodexContainmentRoot({}, LANE)).toBe(LANE);
  });

  it("treats a blank sandboxRoot as absent", () => {
    expect(resolveCodexContainmentRoot(
      { permissionPolicy: { fallback: "ask", sandboxRoot: "   " } },
      LANE,
    )).toBe(LANE);
  });
});

describe("codexApprovalAutoAccepts", () => {
  it("accepts under full auto, whatever the policy says", () => {
    expect(codexApprovalAutoAccepts({}, true)).toBe(true);
    expect(codexApprovalAutoAccepts({ permissionPolicy: { fallback: "ask" } }, true)).toBe(true);
  });

  // The behavior fix: a policy object is not a containment root. A host that
  // sends `{ fallback: "ask" }` is asking to be asked, and auto-accepting every
  // command in the session's own working directory is the opposite of that.
  it("accepts only when the policy named a sandboxRoot", () => {
    expect(codexApprovalAutoAccepts(
      { permissionPolicy: { fallback: "ask", sandboxRoot: SANDBOX } },
      false,
    )).toBe(true);
    expect(codexApprovalAutoAccepts({ permissionPolicy: { fallback: "ask" } }, false)).toBe(false);
    expect(codexApprovalAutoAccepts({ permissionPolicy: { fallback: "deny" } }, false)).toBe(false);
    expect(codexApprovalAutoAccepts({ permissionPolicy: { fallback: "ask", sandboxRoot: "  " } }, false))
      .toBe(false);
  });

  it("accepts nothing with no policy and no full auto", () => {
    expect(codexApprovalAutoAccepts({}, false)).toBe(false);
  });
});

describe("codexApprovalDeniesByPolicy", () => {
  it("is true only for a deny fallback", () => {
    expect(codexApprovalDeniesByPolicy({ permissionPolicy: { fallback: "deny" } })).toBe(true);
    expect(codexApprovalDeniesByPolicy({ permissionPolicy: { fallback: "ask" } })).toBe(false);
    expect(codexApprovalDeniesByPolicy({})).toBe(false);
  });
});

describe("codexApprovalPathStaysWithinRoot", () => {
  it("accepts the root and anything under it", () => {
    expect(codexApprovalPathStaysWithinRoot(SANDBOX, SANDBOX)).toBe(true);
    expect(codexApprovalPathStaysWithinRoot(SANDBOX, path.join(SANDBOX, "src", "a.ts"))).toBe(true);
  });

  it("refuses a path outside it, and a missing candidate", () => {
    expect(codexApprovalPathStaysWithinRoot(SANDBOX, OUTSIDE)).toBe(false);
    expect(codexApprovalPathStaysWithinRoot(SANDBOX, null)).toBe(false);
    expect(codexApprovalPathStaysWithinRoot(SANDBOX, "   ")).toBe(false);
  });

  it("refuses a path that climbs out", () => {
    expect(codexApprovalPathStaysWithinRoot(SANDBOX, path.join(SANDBOX, "..", "elsewhere"))).toBe(false);
  });

  // Codex records cwd as `\\?\C:\...`. Node treats that as UNC, so
  // path.relative against a plain `C:\...` sandbox is absolute and every
  // contained path looks like an escape. The strip is a no-op off win32, so
  // this runs only where the prefix is real.
  it.skipIf(process.platform !== "win32")(
    "accepts a Windows extended-length spelling of a contained path",
    () => {
      expect(codexApprovalPathStaysWithinRoot(SANDBOX, `\\\\?\\${SANDBOX}`)).toBe(true);
      expect(codexApprovalPathStaysWithinRoot(
        SANDBOX,
        `\\\\?\\${path.join(SANDBOX, "src", "a.ts")}`,
      )).toBe(true);
    },
  );
});

describe("codexCommandApprovalStaysWithinRoot", () => {
  it("checks the working directory and any escalation together", () => {
    expect(codexCommandApprovalStaysWithinRoot(SANDBOX, SANDBOX, null)).toBe(true);
    expect(codexCommandApprovalStaysWithinRoot(SANDBOX, OUTSIDE, null)).toBe(false);
    // Inside cwd, escalation reaching outside: refused.
    expect(codexCommandApprovalStaysWithinRoot(SANDBOX, SANDBOX, {
      fileSystem: { write: [path.join(OUTSIDE, "x.txt")] },
    })).toBe(false);
    expect(codexCommandApprovalStaysWithinRoot(SANDBOX, SANDBOX, {
      fileSystem: { write: [path.join(SANDBOX, "x.txt")] },
    })).toBe(true);
  });
});

describe("codexPermissionsStayWithinRoot", () => {
  it("resolves a relative grant against the request's own cwd", () => {
    const cwd = path.join(SANDBOX, "app");
    expect(codexPermissionsStayWithinRoot(SANDBOX, cwd, {
      fileSystem: { write: ["notes.txt"] },
    })).toBe(true);
    expect(codexPermissionsStayWithinRoot(SANDBOX, cwd, {
      fileSystem: { write: [path.join("..", "..", "escape.txt")] },
    })).toBe(false);
  });

  it("skips a deny entry, which grants nothing", () => {
    expect(codexPermissionsStayWithinRoot(SANDBOX, SANDBOX, {
      fileSystem: { entries: [{ access: "deny", path: { type: "path", path: OUTSIDE } }] },
    })).toBe(true);
  });

  it("refuses a shape it does not recognize rather than guessing", () => {
    expect(codexPermissionsStayWithinRoot(SANDBOX, SANDBOX, {
      fileSystem: { entries: "not-an-array" },
    })).toBe(false);
    expect(codexPermissionsStayWithinRoot(SANDBOX, SANDBOX, {
      fileSystem: { entries: [{ access: "allow", path: { type: "unheard-of" } }] },
    })).toBe(false);
    expect(codexPermissionsStayWithinRoot(SANDBOX, SANDBOX, {
      fileSystem: { entries: [{ access: "allow", path: { type: "special", value: { kind: "home" } } }] },
    })).toBe(false);
  });

  it("resolves a project_roots subpath against the containment root itself", () => {
    expect(codexPermissionsStayWithinRoot(SANDBOX, SANDBOX, {
      fileSystem: {
        entries: [{
          access: "allow",
          path: { type: "special", value: { kind: "project_roots", subpath: "src" } },
        }],
      },
    })).toBe(true);
    expect(codexPermissionsStayWithinRoot(SANDBOX, SANDBOX, {
      fileSystem: {
        entries: [{
          access: "allow",
          path: { type: "special", value: { kind: "project_roots", subpath: "../escape" } },
        }],
      },
    })).toBe(false);
  });

  it("accepts an absent permissions payload and refuses a malformed one", () => {
    expect(codexPermissionsStayWithinRoot(SANDBOX, SANDBOX, null)).toBe(true);
    expect(codexPermissionsStayWithinRoot(SANDBOX, SANDBOX, "nonsense")).toBe(false);
  });
});
