import { registerScenario, type ScenarioContext } from "./index";

const MISSION_TABS = ["overview", "chat", "plan", "history", "artifacts"] as const;

function routeTo(path: string): void {
  const target = path.startsWith("/") ? path : `/${path}`;
  if (window.location.protocol === "http:" || window.location.protocol === "https:") {
    window.history.pushState(null, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
    return;
  }
  window.location.hash = target.startsWith("#") ? target : `#${target}`;
}

async function navigateToMissions(ctx: ScenarioContext, missionId?: string): Promise<void> {
  const suffix = missionId ? `?missionId=${encodeURIComponent(missionId)}` : "";
  ctx.mark("nav.missions.start");
  routeTo(`/missions${suffix}`);
  const present = await ctx.waitFor(
    () => document.querySelector("[data-route='missions']") !== null,
    8_000,
  );
  ctx.mark("nav.missions.done");
  ctx.measure("nav.missions", "nav.missions.start", "nav.missions.done");
  ctx.assert(present, "missions route did not render main content");
}

function chooseScenarioMission(
  missions: Awaited<ReturnType<typeof window.ade.missions.list>>,
): string | null {
  const completedWithPlan = missions.find(
    (mission) => mission.status === "completed" && mission.totalSteps > 0,
  );
  const completed = missions.find((mission) => mission.status === "completed");
  const active = missions.find(
    (mission) => mission.status === "in_progress" || mission.status === "intervention_required",
  );
  return (completedWithPlan ?? completed ?? active ?? missions[0])?.id ?? null;
}

async function openTab(ctx: ScenarioContext, tab: typeof MISSION_TABS[number]): Promise<void> {
  const button = document.getElementById(`mission-tab-${tab}`) as HTMLButtonElement | null;
  if (!button) {
    ctx.assert(false, `mission tab button missing: ${tab}`);
    return;
  }
  ctx.mark(`missions.tab.${tab}.start`);
  button.click();
  const rendered = await ctx.waitFor(
    () => document.getElementById(`mission-panel-${tab}`) !== null,
    4_000,
  );
  ctx.mark(`missions.tab.${tab}.done`);
  ctx.measure(`missions.tab.${tab}`, `missions.tab.${tab}.start`, `missions.tab.${tab}.done`);
  ctx.assert(rendered, `mission tab did not render: ${tab}`);
  await ctx.idle(250);
}

registerScenario({
  id: "missions.cold-dashboard",
  description: "Cold open of /missions — measures route mount plus summary/dashboard IPC.",
  run: async (ctx) => {
    await navigateToMissions(ctx);

    ctx.mark("missions.list.start");
    const missions = await window.ade.missions.list({ limit: 300 });
    ctx.mark("missions.list.done");
    ctx.measure("missions.list", "missions.list.start", "missions.list.done");
    ctx.assert(Array.isArray(missions), "missions.list did not return an array");

    ctx.mark("missions.dashboard.start");
    const dashboard = await window.ade.missions.getDashboard();
    ctx.mark("missions.dashboard.done");
    ctx.measure("missions.dashboard", "missions.dashboard.start", "missions.dashboard.done");
    ctx.assert(dashboard !== null, "missions dashboard did not return");

    await window.ade.perf.recordEvent({
      kind: "note",
      ts: Date.now(),
      note: "missions.dashboardSummary",
      missionCount: missions.length,
      activeCount: dashboard.active.length,
      recentCount: dashboard.recent.length,
    });
    await ctx.idle(5_000);
  },
});

registerScenario({
  id: "missions.select-and-tabs",
  description: "Select a real mission and switch overview/chat/plan/timeline/artifacts tabs.",
  run: async (ctx) => {
    await navigateToMissions(ctx);

    ctx.mark("missions.select.list.start");
    const missions = await window.ade.missions.list({ limit: 300 });
    ctx.mark("missions.select.list.done");
    ctx.measure("missions.select.list", "missions.select.list.start", "missions.select.list.done");

    const missionId = chooseScenarioMission(missions);
    if (!missionId) {
      await window.ade.perf.recordEvent({
        kind: "note",
        ts: Date.now(),
        note: "missions.select skipped: no missions available",
      });
      return;
    }

    ctx.mark("missions.fullView.ipc.start");
    const fullView = await window.ade.missions.getFullMissionView({ missionId });
    ctx.mark("missions.fullView.ipc.done");
    ctx.measure("missions.fullView.ipc", "missions.fullView.ipc.start", "missions.fullView.ipc.done");
    ctx.assert(fullView.mission?.id === missionId, "getFullMissionView returned the wrong mission");

    await window.ade.perf.recordEvent({
      kind: "note",
      ts: Date.now(),
      note: "missions.selectedSummary",
      missionId,
      status: fullView.mission?.status ?? null,
      stepCount: fullView.runGraph?.steps.length ?? 0,
      timelineCount: fullView.runGraph?.timeline.length ?? 0,
      artifactCount: fullView.artifacts.length,
      checkpointCount: fullView.checkpoints.length,
    });

    await navigateToMissions(ctx, missionId);
    const tabsReady = await ctx.waitFor(
      () => document.getElementById("mission-tab-plan") !== null,
      8_000,
    );
    ctx.assert(tabsReady, "mission tabs did not render after selecting a mission");
    if (!tabsReady) return;

    for (const tab of MISSION_TABS) {
      await openTab(ctx, tab);
    }

    await ctx.idle(8_000);
  },
});

registerScenario({
  id: "missions.idle-at-rest",
  description: "Sit on /missions for 30s — measures at-rest polling and memory.",
  run: async (ctx) => {
    await navigateToMissions(ctx);
    await ctx.idle(30_000);
    ctx.assert(document.querySelector("[data-route='missions']") !== null, "missions route vanished during idle");
  },
});
