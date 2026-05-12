import { registerScenario } from "./index";
import type { RemoteRuntimeTarget } from "../../../shared/types";

/**
 * Boot-tab scenarios. These exercise the "main ADE screen" — cold launch,
 * project picker, opening projects, remote runtime status, iOS pairing.
 * Most of these prefer direct IPC calls over DOM clicks so they are fast
 * and reproducible. Scenarios that need a no-project state should be launched
 * with `--no-project` on the runner so the welcome screen renders.
 */

registerScenario({
  id: "boot.cold-paint",
  description: "Cold launch — measures time-to-first-paint and to-interactive without driving any UI.",
  run: async (ctx) => {
    ctx.mark("boot.cold-paint.tick");
    await ctx.idle(8_000);
    // FCP/LCP/INP samples accumulate in webVitals during this idle window.
    ctx.assert(document.body.children.length > 0, "no body content after cold launch");
  },
});

registerScenario({
  id: "boot.recent-projects",
  description: "Measures recent-projects IPC + welcome list render.",
  run: async (ctx) => {
    ctx.mark("recent.fetch.start");
    const recent = await window.ade?.project?.listRecent();
    ctx.mark("recent.fetch.done");
    ctx.measure("recent.fetch", "recent.fetch.start", "recent.fetch.done");
    ctx.assert(Array.isArray(recent), "project.listRecent did not return an array");
    await ctx.idle(1_500);
  },
});

registerScenario({
  id: "boot.open-project",
  description: "Times opening the perf-pass project via IPC openRepo.",
  run: async (ctx) => {
    const cfg = await window.ade?.perf?.getConfig?.();
    const perfPass = cfg?.projectRoot?.trim();
    if (!perfPass) {
      window.ade?.perf?.recordEvent({
        kind: "note",
        ts: Date.now(),
        note: "boot.open-project skipped: no ADE_PERF_PASS_DIR configured",
      });
      return;
    }
    ctx.mark("openRepo.start");
    try {
      const result = await window.ade?.project?.openRepo?.({ rootPath: perfPass });
      ctx.mark("openRepo.done");
      ctx.measure("openRepo", "openRepo.start", "openRepo.done");
      ctx.assert(result !== undefined, "openRepo returned undefined");
    } catch (err) {
      ctx.mark("openRepo.done");
      ctx.measure("openRepo", "openRepo.start", "openRepo.done");
      ctx.assert(false, `openRepo threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    await ctx.idle(3_000);
  },
});

registerScenario({
  id: "boot.remote-runtime",
  description: "Times the remote runtime list-targets + snapshot path.",
  run: async (ctx) => {
    ctx.mark("remote.list.start");
    try {
      const targets = await (window.ade as unknown as {
        remoteRuntime?: { listTargets?: () => Promise<RemoteRuntimeTarget[]> };
      }).remoteRuntime?.listTargets?.();
      ctx.mark("remote.list.done");
      ctx.measure("remote.list", "remote.list.start", "remote.list.done");
      ctx.assert(targets === undefined || Array.isArray(targets), "remote.listTargets returned a non-array");
    } catch (err) {
      ctx.mark("remote.list.done");
      ctx.measure("remote.list", "remote.list.start", "remote.list.done");
      ctx.assert(false, `remote.listTargets threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    await ctx.idle(1_500);
  },
});

registerScenario({
  id: "boot.idle-welcome",
  description: "Sit on the welcome screen for 20s — measures at-rest CPU and background pollers when no project is loaded.",
  run: async (ctx) => {
    // The harness skips ADE_PERF_INITIAL_ROUTE for this scenario by not setting it.
    await ctx.idle(20_000);
    ctx.assert(document.body.children.length > 0, "body emptied during idle");
  },
});

registerScenario({
  id: "boot.stress-launch",
  description: "Long-tail at boot — 2 minutes of cold-launched idle to catch leaks in startup pollers.",
  run: async (ctx) => {
    for (let i = 0; i < 6; i++) {
      await ctx.idle(20_000);
      ctx.mark(`boot.stress.tick.${i}`);
    }
    ctx.assert(document.body.children.length > 0, "body emptied during boot stress");
  },
});
