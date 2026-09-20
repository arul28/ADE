import { describe, expect, it } from "vitest";
import {
  assertMergedLaunchArgs,
  collectLaunchArgs,
  normalizeLaunchArgs,
} from "./launchArgs";

// The rules read a plain object, so they can be exercised without building a
// command line around them.
describe("assertMergedLaunchArgs", () => {
  it("rejects an account id on a provider with a single identity per machine", () => {
    expect(() =>
      assertMergedLaunchArgs({ provider: "cursor", instanceId: "work" }, { allowShell: false }),
    ).toThrow(/--instance names a Claude or Codex account/);
    expect(() =>
      assertMergedLaunchArgs({ provider: "claude", instanceId: "work" }, { allowShell: false }),
    ).not.toThrow();
  });

  it("refuses to orphan an agent spawn whose lineage the shell flag dropped", () => {
    expect(() =>
      assertMergedLaunchArgs(
        { provider: "codex" },
        { allowShell: true, droppedAmbientParentSessionId: "parent-session-1" },
      ),
    ).toThrow(/Name the agent provider with --provider codex/);
    // The lineage survived the merge, so nothing was orphaned.
    expect(() =>
      assertMergedLaunchArgs(
        {
          provider: "codex",
          orchestrationParentSessionId: "parent-session-1",
          spawnKind: "subagent",
        },
        { allowShell: true, droppedAmbientParentSessionId: "parent-session-1" },
      ),
    ).not.toThrow();
  });

  // Ordering, not just presence: a bag that lost its ambient parent to
  // `--provider shell` AND carries a spawn kind satisfies the "kind with no
  // parent" rule too, and that rule's advice ("remove --no-parent") names a
  // flag this caller never wrote. The dropped-ambient diagnosis has to win.
  it("names the flag that dropped the lineage before the pairing rules", () => {
    expect(() =>
      assertMergedLaunchArgs(
        { provider: "codex", spawnKind: "subagent" },
        { allowShell: true, droppedAmbientParentSessionId: "parent-session-1" },
      ),
    ).toThrow(/Name the agent provider with --provider codex/);
  });

  // The pairing the flag reader enforces, on the merged bag: `--arg` writes
  // the same two wire fields, so a parent with no spawn kind (or a kind with
  // no parent) has to be refused here too, and read identically.
  it("rejects a merged parent with no spawn kind", () => {
    expect(() =>
      assertMergedLaunchArgs(
        { provider: "codex", orchestrationParentSessionId: "parent-session-1" },
        { allowShell: false },
      ),
    ).toThrow(/--type is required for a parented agent spawn/);
  });

  it("rejects a merged spawn kind with no parent", () => {
    expect(() =>
      assertMergedLaunchArgs(
        { provider: "codex", spawnKind: "subagent" },
        { allowShell: false },
      ),
    ).toThrow(/--type requires a parent session/);
  });
});

// Restoring a blanked provider belongs to `collectLaunchArgs` alone — the
// bag is the only place the caller's own provider lives, so by the time
// `normalizeLaunchArgs` sees a blank there is nothing to fall back to. It
// used to read the un-normalised bag into a `fallbackProvider` before the
// blank pre-pass ran, which made the restore branch unreachable: a blank had
// already been deleted, so `provider === undefined` was only ever true for a
// bag that never carried one.
describe("normalizeLaunchArgs", () => {
  it("drops a blanked provider instead of re-installing one", () => {
    expect(normalizeLaunchArgs({ provider: "" }, { allowShell: false })).not.toHaveProperty(
      "provider",
    );
    expect(normalizeLaunchArgs({ provider: null }, { allowShell: false })).not.toHaveProperty(
      "provider",
    );
    expect(
      normalizeLaunchArgs({ provider: "   " }, { allowShell: false }),
    ).not.toHaveProperty("provider");
  });

  it("still canonicalises a provider the bag really supplied", () => {
    expect(normalizeLaunchArgs({ provider: "Claude" }, { allowShell: false })).toMatchObject({
      provider: "claude",
    });
  });
});

describe("collectLaunchArgs", () => {
  it("restores the caller's provider behind --arg provider=", () => {
    expect(
      collectLaunchArgs(["--arg", "provider="], { provider: "codex" }, { allowShell: false }),
    ).toMatchObject({ provider: "codex" });
  });

  // A base that carries no provider at all must not gain an OWN key spelled
  // `undefined`: `Object.keys` and the JSON that reaches the runtime both
  // treat an own `provider: undefined` differently from an absent one.
  it("never installs an own undefined provider key from a base without one", () => {
    const collected = collectLaunchArgs(["--arg", "provider="], {}, { allowShell: false });
    expect(collected).not.toHaveProperty("provider");
    expect(Object.keys(collected)).not.toContain("provider");
  });
});

