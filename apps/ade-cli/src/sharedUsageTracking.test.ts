/**
 * The brain hosts several project scopes in one process and each of them used
 * to build its own usage tracker: two 120s poll timers on different phases, two
 * `lastSnapshot`s, two demand leases. Two ADE windows on one machine then
 * showed two different Claude/Codex meters, and one of them was always behind.
 *
 * `bootstrap.ts` now attaches every scope to one machine-level tracker. These
 * tests hold that wiring — the same call shape `createAdeRuntime` uses, without
 * booting two full runtimes for it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UsageSnapshot } from "../../desktop/src/shared/types/usage";
import {
  attachSharedUsageTrackingScope,
  clearSharedUsageTrackingServicesForTesting,
  createUsageTrackingService,
  peekSharedUsageTrackingService,
} from "../../desktop/src/main/services/usage/usageTrackingService";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function fastDependencies() {
  return {
    pollClaudeUsage: vi.fn(async () => ({ windows: [] as never[], extraUsage: null, errors: [] as never[] })),
    pollCodexUsage: vi.fn(async () => ({ windows: [] as never[], errors: [] as never[] })),
    scanClaudeLogs: vi.fn(async () => [] as never[]),
    scanCodexLogs: vi.fn(async () => [] as never[]),
    scanCursorLogs: vi.fn(async () => [] as never[]),
    scanCursorAgentLogs: vi.fn(async () => [] as never[]),
    scanOpenClawLogs: vi.fn(async () => [] as never[]),
    scanOpenCodeLogs: vi.fn(async () => [] as never[]),
    scanDroidLogs: vi.fn(async () => [] as never[]),
    scanCopilotLogs: vi.fn(async () => [] as never[]),
    scanGeminiLogs: vi.fn(async () => [] as never[]),
  };
}

type RuntimeEvent = { type: string; snapshot: UsageSnapshot };

/** Mirrors bootstrap: one scope per project, pushing into that scope's buffer. */
function attachScope(
  adeDir: string,
  make: () => ReturnType<typeof createUsageTrackingService>,
  project: { projectId: string; projectRoot: string },
) {
  const events: RuntimeEvent[] = [];
  const scope = attachSharedUsageTrackingScope(adeDir, make, {
    key: `${project.projectId}:${project.projectRoot}`,
    projectRoot: project.projectRoot,
    logger,
    onUpdate: (snapshot) => events.push({ type: "usage", snapshot }),
  });
  return { scope, events };
}

describe("shared usage tracking across project scopes", () => {
  afterEach(() => {
    clearSharedUsageTrackingServicesForTesting();
  });

  it("gives two project scopes in one process one tracker and one snapshot", async () => {
    const adeDir = "/tmp/ade-shared-usage-one";
    const dependencies = fastDependencies();
    const make = vi.fn(() => createUsageTrackingService({ logger, dependencies }));

    const first = attachScope(adeDir, make, { projectId: "p1", projectRoot: "/repo-one" });
    const second = attachScope(adeDir, make, { projectId: "p2", projectRoot: "/repo-two" });

    expect(make).toHaveBeenCalledTimes(1);
    expect(peekSharedUsageTrackingService(adeDir)).toBeDefined();

    await first.scope.poll();

    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);
    const a = first.events[0]!.snapshot;
    const b = second.events[0]!.snapshot;
    expect(a.revision?.producerId).toBeTruthy();
    expect(b.revision?.producerId).toBe(a.revision?.producerId);
    expect(b.revision?.seq).toBe(a.revision?.seq);
    expect(b.lastPolledAt).toBe(a.lastPolledAt);
    // The provider was polled once for the machine, not once per project.
    expect(dependencies.pollClaudeUsage).toHaveBeenCalledTimes(1);

    first.scope.dispose();
    second.scope.dispose();
  });

  it("keeps delivering to the remaining scope when one project closes", async () => {
    const adeDir = "/tmp/ade-shared-usage-close";
    const dependencies = fastDependencies();
    const make = vi.fn(() => createUsageTrackingService({ logger, dependencies }));

    const first = attachScope(adeDir, make, { projectId: "p1", projectRoot: "/repo-one" });
    const second = attachScope(adeDir, make, { projectId: "p2", projectRoot: "/repo-two" });

    first.scope.start();
    second.scope.start();
    await first.scope.poll();
    const beforeClose = second.events.length;

    first.scope.dispose();
    await second.scope.poll();

    expect(second.events.length).toBeGreaterThan(beforeClose);
    expect(first.events).toHaveLength(beforeClose);
    expect(second.events.at(-1)!.snapshot.revision!.producerId)
      .toBe(second.events[0]!.snapshot.revision!.producerId);
    // The last scope takes the tracker with it.
    second.scope.dispose();
    expect(peekSharedUsageTrackingService(adeDir)).toBeUndefined();
  });
});
