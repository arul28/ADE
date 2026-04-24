import { registerTour, type Tour, type TourCtx, type TourStep } from "../registry";
import { docs } from "../docsLinks";
import { requestProjectBrowserClose } from "../../lib/projectBrowserEvents";
import { useAppStore } from "../../state/appStore";
import {
  buildCreateLaneDialogWalkthrough,
  buildGitActionsPaneWalkthrough,
  buildManageLaneDialogWalkthrough,
  buildPrCreateModalWalkthrough,
} from "../stepBuilders";
import { graphTour } from "./graphTour";
import { filesTour } from "./filesTour";
import { workTour } from "./workTour";
import { runTour } from "./runTour";
import { lanesTour } from "./lanesTour";
import { laneWorkPaneTour } from "./laneWorkPaneTour";
import { prsTour } from "./prsTour";
import { historyTour } from "./historyTour";
import { automationsTour } from "./automationsTour";
import { ctoTour } from "./ctoTour";
import { settingsTour } from "./settingsTour";

/**
 * Flagship first-run Tutorial. Acts 0–12 described in
 * `docs/plans/ok-so-i-wanna-luminous-cocoa.md` → "The Flagship First-Run
 * Journey". Crosses every in-scope tab via the new `navigate` StepAction,
 * writes/reads `laneName` via adaptive `TourCtx`, and ends by cleaning up
 * the sample lane it created.
 *
 * Act 0 runs before a project exists. The project picker step blocks until
 * a repo is open, then Act 1 navigates to Lanes.
 */
const SAMPLE_LANE_NAME = "tour-sample";
const PROJECT_OPEN_REQUIRES = ["projectOpen"] as const;
const LANE_EXISTS_REQUIRES = ["projectOpen", "laneExists"] as const;
const OPTIONAL_ACTION_FALLBACK_MS = 30_000;

type Ctx = TourCtx;

function tutorialSection(
  sectionId: string,
  steps: readonly TourStep[],
  requires: readonly string[] = PROJECT_OPEN_REQUIRES,
): TourStep[] {
  return steps.map((step, index) => ({
    ...step,
    id: step.id ?? `${sectionId}.${index}`,
    requires: step.requires ?? requires,
    waitForSelector: step.waitForSelector ?? (step.target ? step.target : undefined),
  }));
}

function laneName(ctx: Ctx): string {
  return ctx.get<string>("laneName") ?? SAMPLE_LANE_NAME;
}

function isProjectOpenSync(): boolean {
  const { project, projectHydrated, showWelcome, isNewTabOpen } = useAppStore.getState();
  const rootPath = project?.rootPath;
  return (
    projectHydrated === true &&
    showWelcome !== true &&
    isNewTabOpen !== true &&
    typeof rootPath === "string" &&
    rootPath.trim().length > 0
  );
}

function isProjectBrowserOpenSync(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector('[data-tour="project.browser"]') != null;
}

function isWelcomeProjectScreenVisible(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector('[data-tour="project.welcomeOpenButton"]') != null;
}

function requestFocusedLaneLayout(): void {
  if (typeof window === "undefined") return;
  const { selectedLaneId, lanes } = useAppStore.getState();
  const selectedLane = selectedLaneId ? lanes.find((lane) => lane.id === selectedLaneId) ?? null : null;
  const targetLane = selectedLane?.laneType !== "primary"
    ? selectedLane
    : lanes.find((lane) => lane.laneType !== "primary") ?? null;
  if (!targetLane) return;
  window.dispatchEvent(new CustomEvent("ade:tour-focus-lane", { detail: { laneId: targetLane.id } }));
}

function waitForProjectBrowserClosed(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  return new Promise((resolve) => {
    if (!isProjectBrowserOpenSync()) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      observer?.disconnect();
      resolve();
    };
    const observer =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            if (!isProjectBrowserOpenSync()) finish();
          })
        : null;
    observer?.observe(document.body, { childList: true, subtree: true });
    const timeout = window.setTimeout(finish, 5_000);
    window.setTimeout(() => {
      if (!isProjectBrowserOpenSync()) finish();
    }, 0);
  });
}

function buildTabHandoffStep(
  id: string,
  currentTab: string,
  nextTab: string,
  docUrl: string,
): TourStep {
  return {
    id,
    target: '[data-tour="app.helpMenu"]',
    title: "Replay this section later",
    body: `You just walked the main **${currentTab}** controls. The ? menu can replay this same section by itself later, without the action steps. Next: **${nextTab}**.`,
    placement: "left",
    requires: LANE_EXISTS_REQUIRES,
    waitForSelector: '[data-tour="app.helpMenu"]',
    docUrl,
  };
}

// --- Act 0: Welcome + project picker ---------------------------------------
const act0Welcome: TourStep = {
  id: "act0.welcome",
  target: "",
  title: "Welcome to ADE",
  body: "ADE helps you work on one project in several safe copies at the same time. This tutorial creates one test lane, shows where its files/chats/Git state live, then cleans it up.",
  actIntro: { title: "Welcome to ADE", subtitle: "Safe copies of one project, each with its own task.", variant: "drift" },
  docUrl: docs.welcome,
  branches: (_ctx: TourCtx) => {
    if (isWelcomeProjectScreenVisible()) return "act0.openProject";
    return isProjectOpenSync() ? "act0.projectChoice" : null;
  },
};

const act0ProjectChoice: TourStep = {
  id: "act0.projectChoice",
  target: '[data-tour="project.activeTab"]',
  title: "Use this project",
  body: "ADE already has a project open. Click **Use this project** to continue with this repo. If you want a different repo, use the project switcher after the tutorial.",
  placement: "bottom",
  waitForSelector: '[data-tour="project.activeTab"]',
  advanceWhenSelector: '[data-tour="project.browser"]',
  requires: PROJECT_OPEN_REQUIRES,
  nextLabel: "Use this project",
  exitOnOutsideInteraction: true,
  allowedInteractionSelectors: ['[data-tour="project.addProject"]'],
  docUrl: docs.welcome,
  afterLeave: () => {
    const { project, cancelNewTab, setShowWelcome } = useAppStore.getState();
    if (!project?.rootPath) return;
    cancelNewTab();
    setShowWelcome(false);
  },
  branches: (_ctx: TourCtx) => {
    if (isProjectBrowserOpenSync()) return "act0.projectBrowser";
    if (isWelcomeProjectScreenVisible()) return "act0.openProject";
    return isProjectOpenSync() ? "act1.intro" : "act0.openProject";
  },
};

const act0OpenProject: TourStep = {
  id: "act0.openProject",
  target: '[data-tour="project.welcomeOpenButton"]',
  title: "Open a project",
  body: "Open a recent project, or choose **Open Project** to browse for another Git repo.",
  placement: "right",
  waitForSelector: '[data-tour="project.welcomeOpenButton"]',
  advanceWhenSelector: '[data-tour="project.browser"]',
  awaitingActionLabel: "Waiting for project",
  exitOnOutsideInteraction: true,
  allowedInteractionSelectors: [
    '[data-tour="project.welcomeOpenButton"]',
    '[data-tour="project.recentProject"]',
  ],
  docUrl: docs.welcome,
  // If a project is already open, ask the user to use it or open another one.
  // If the browser is open, move into the modal guidance. Otherwise hold here.
  branches: (_ctx: TourCtx) => {
    if (isProjectOpenSync()) return "act1.intro";
    if (isProjectBrowserOpenSync()) return "act0.projectBrowser";
    return "act0.openProject";
  },
};

const act0ProjectBrowser: TourStep = {
  id: "act0.projectBrowser",
  target: '[data-tour="project.browser"]',
  title: "Pick your repo",
  body: "Select a Git repo in this picker, then click Open. Close the picker to return to recent projects.",
  placement: "top",
  waitForSelector: '[data-tour="project.browser"]',
  awaitingActionLabel: "Waiting for project to open",
  exitOnOutsideInteraction: true,
  docUrl: docs.welcome,
  beforeBack: async () => {
    requestProjectBrowserClose();
    await waitForProjectBrowserClosed();
  },
  branches: (_ctx: TourCtx) => {
    return isProjectOpenSync() ? "act1.intro" : "act0.projectBrowser";
  },
};

const act1Intro: TourStep = {
  id: "act1.intro",
  target: "",
  title: "Make a lane",
  body: "Think of a lane as one safe workspace for one task. It has its own branch, folder, file changes, and worker chats, while your primary project stays clean.",
  actIntro: { title: "Make a lane", variant: "orbit" },
  requires: PROJECT_OPEN_REQUIRES,
  beforeEnter: async () => [{ type: "navigate", to: "/lanes" }],
  docUrl: docs.lanesOverview,
};

const act1SidebarSweep: TourStep = {
  id: "act1.sidebarSweep",
  target: '[data-tour="app.sidebar"]',
  title: "Your tabs",
  body: "The left rail is ADE's map. Lanes is where work starts, Graph shows how lanes relate, Files shows the lane's code, Work shows chats and terminals, and PRs/History help you ship and audit.",
  placement: "right",
  requires: PROJECT_OPEN_REQUIRES,
  waitForSelector: '[data-tour="app.sidebar"]',
  docUrl: docs.welcome,
};

const act1LaneTabSpotlight: TourStep = {
  id: "act1.laneTabSpotlight",
  target: '[data-tour="lanes.laneTab"]',
  title: "Your new lane",
  body: "That tab is your new lane. Select it any time you want this task's files, chats, and Git actions.",
  bodyTemplate: (ctx) =>
    `${laneName(ctx)} is live. It has its own branch, folder, file changes, and worker chats. Primary stays separate.`,
  placement: "bottom",
  requires: LANE_EXISTS_REQUIRES,
  disableBack: true,
  beforeEnter: async () => {
    requestFocusedLaneLayout();
  },
  waitForSelector: '[data-tour="lanes.laneTab"]',
  docUrl: docs.lanesOverview,
};

const act1PerTabTours = buildTabHandoffStep("act1.perTabTours", "Lanes", "Graph", docs.lanesOverview);
const act2PerTabTours = buildTabHandoffStep("act2.perTabTours", "Graph", "Files", docs.workspaceGraph);
const act3PerTabTours = buildTabHandoffStep("act3.perTabTours", "Files", "Work", docs.filesEditor);
const act4PerTabTours = buildTabHandoffStep("act4.perTabTours", "Work", "Git actions", docs.chatOverview);
const act5PerTabTours = buildTabHandoffStep("act5.perTabTours", "Git actions", "PRs", docs.lanesOverview);
const act7PerTabTours = buildTabHandoffStep("act7.perTabTours", "PRs", "History", docs.prsOverview);
const act6PerTabTours = buildTabHandoffStep("act6.perTabTours", "History", "Run", docs.historyOverview);
const act8PerTabTours = buildTabHandoffStep("act8.perTabTours", "Run", "Automations", docs.projectHome);
const act9PerTabTours = buildTabHandoffStep("act9.perTabTours", "Automations", "CTO", docs.automationsOverview);
const act10PerTabTours = buildTabHandoffStep("act10.perTabTours", "CTO", "Settings", docs.ctoOverview);
const act11PerTabTours = buildTabHandoffStep("act11.perTabTours", "Settings", "cleanup", docs.settingsGeneral);

// --- Act 2: Graph -----------------------------------------------------------
const act2Intro: TourStep = {
  id: "act2.intro",
  target: "",
  title: "See the shape",
  body: "Graph draws every lane as a node, every relationship as an edge.",
  actIntro: { title: "See the shape", variant: "orbit" },
  requires: LANE_EXISTS_REQUIRES,
  beforeEnter: async () => {
    const { selectedLaneId, lanes } = useAppStore.getState();
    const selectedLane = selectedLaneId ? lanes.find((lane) => lane.id === selectedLaneId) ?? null : null;
    const focusLane = selectedLane?.laneType !== "primary"
      ? selectedLane
      : lanes.find((lane) => lane.laneType !== "primary") ?? null;
    const query = focusLane ? `?focusLane=${encodeURIComponent(focusLane.id)}` : "";
    return [{ type: "navigate", to: `/graph${query}` }];
  },
  docUrl: docs.workspaceGraph,
};

const act2LaneNode: TourStep = {
  id: "act2.laneNode",
  target: '[data-tour="graph.node"]',
  title: "Your lane, as a node",
  body: "That node is your lane hanging off primary. Edges show stacking — where one lane branches off another.",
  bodyTemplate: (ctx) =>
    `That node is your new lane (${laneName(ctx)}) hanging off primary. Edges show stacking — where one lane branches off another.`,
  placement: "bottom",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="graph.node"]',
  docUrl: docs.workspaceGraph,
};

const act2Zoom: TourStep = {
  id: "act2.zoom",
  target: '[data-tour="graph.zoom"]',
  title: "Zoom and pan",
  body: "Scroll to zoom, drag to pan. The graph redraws live as you create, rebase, or archive lanes.",
  placement: "left",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="graph.zoom"]',
  ghostCursor: {
    from: '[data-tour="graph.canvas"]',
    to: '[data-tour="graph.zoom"]',
  },
  docUrl: docs.workspaceGraph,
};

const act2Legend: TourStep = {
  id: "act2.legend",
  target: '[data-tour="graph.legend"]',
  title: "Read the legend",
  body: "The legend explains node colors and edge types. Glance at it when something looks unfamiliar — the shape of a node usually tells you its state.",
  placement: "left",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="graph.legend"]',
  docUrl: docs.workspaceGraph,
};

// --- Act 3: Files -----------------------------------------------------------
const act3Intro: TourStep = {
  id: "act3.intro",
  target: "",
  title: "Each lane, its own files",
  body: "Files can browse the primary project or any lane worktree. Pick the workspace first, then inspect files and changes.",
  actIntro: { title: "Each lane, its own files", variant: "drift" },
  requires: LANE_EXISTS_REQUIRES,
  beforeEnter: async () => [{ type: "navigate", to: "/files" }],
  docUrl: docs.filesEditor,
};

const act3Workspace: TourStep = {
  id: "act3.workspace",
  target: '[data-tour="files.workspaceSelector"]',
  title: "Pick a workspace",
  body: "Use this selector to choose the primary project or a lane worktree before browsing files.",
  bodyTemplate: (ctx) =>
    `Choose your new lane (${laneName(ctx)}) here to scope the tree and editor to that lane's worktree.`,
  placement: "bottom",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="files.workspaceSelector"]',
  docUrl: docs.filesEditor,
};

const act3Tree: TourStep = {
  id: "act3.tree",
  target: '[data-tour="files.fileTree"]',
  title: "Change badges",
  body: "Modified, added, and deleted files get colored badges. Scan the tree to spot what's changed without diving into diffs.",
  placement: "right",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="files.fileTree"]',
  docUrl: docs.filesEditor,
};

const act3Search: TourStep = {
  id: "act3.search",
  target: '[data-tour="files.searchBar"]',
  title: "Full-text search",
  body: "Search across every file in the lane's worktree. Results open in the editor with the match highlighted.",
  placement: "bottom",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="files.searchBar"]',
  docUrl: docs.filesEditor,
};

const act3Mode: TourStep = {
  id: "act3.mode",
  target: '[data-tour="files.modeToggle"]',
  title: "Code, changes, or merge",
  body: "Toggle between the editor, a per-file diff, and a three-way merge view. Same file, three lenses.",
  placement: "bottom",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="files.modeToggle"]',
  docUrl: docs.filesEditor,
};

const act3OpenIn: TourStep = {
  id: "act3.openIn",
  target: '[data-tour="files.openIn"]',
  title: "Jump to your editor",
  body: "Open the current file — or the whole worktree — in VS Code, Cursor, or your system default. ADE stays home base.",
  placement: "bottom",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="files.openIn"]',
  docUrl: docs.filesEditor,
};

// --- Act 4: Work ------------------------------------------------------------
const act4Intro: TourStep = {
  id: "act4.intro",
  target: "",
  title: "Talk to a worker",
  body: "Workers read files, run commands, and edit code. Work shows every session across every lane.",
  actIntro: { title: "Talk to a worker", variant: "particles" },
  requires: LANE_EXISTS_REQUIRES,
  beforeEnter: async () => [{ type: "navigate", to: "/work" }],
  docUrl: docs.chatOverview,
};

const act4Sessions: TourStep = {
  id: "act4.sessions",
  target: '[data-tour="work.sessionsPane"]',
  title: "Every session, one place",
  body: "Unlike the embedded Work view inside a lane, this one shows every worker across every lane at once.",
  placement: "right",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="work.sessionsPane"]',
  docUrl: docs.chatOverview,
};

const act4LaneFilter: TourStep = {
  id: "act4.laneFilter",
  target: '[data-tour="work.laneFilter"]',
  title: "Filter to your lane",
  body: "Narrow sessions to a single lane. Handy when workers are running across half a dozen worktrees at once.",
  bodyTemplate: (ctx) =>
    `Filter to ${laneName(ctx)} here. Handy when workers are running across half a dozen worktrees at once.`,
  placement: "bottom",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="work.laneFilter"]',
  ghostCursor: {
    from: '[data-tour="work.sessionsPane"]',
    to: '[data-tour="work.laneFilter"]',
  },
  docUrl: docs.chatOverview,
};

const act4NewSession: TourStep = {
  id: "act4.newSession",
  target: '[data-tour="work.newSession"]',
  title: "Start a session",
  body: "Use this button when you want a chat, CLI agent, or shell. The session picker lets you choose the lane before anything starts.",
  placement: "bottom",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="work.newSession"]',
  docUrl: docs.chatOverview,
};

const act4ViewArea: TourStep = {
  id: "act4.viewArea",
  target: '[data-tour="work.viewArea"]',
  title: "Where the conversation lives",
  body: "Open sessions appear here. If you have not started one yet, this area stays empty and the session list remains the source of truth.",
  placement: "left",
  requires: ["projectOpen", "laneExists", "chatStarted"],
  fallbackAfterMs: OPTIONAL_ACTION_FALLBACK_MS,
  fallbackNextLabel: "Continue without a session",
  fallbackNotice: "No worker session is required for the rest of the walkthrough.",
  waitForSelector: '[data-tour="work.viewArea"]',
  docUrl: docs.chatOverview,
};

// --- Act 5: Git -------------------------------------------------------------
const act5Intro: TourStep = {
  id: "act5.intro",
  target: "",
  title: "Git actions",
  body: "This pane shows dirty files, the commit box, pull and push controls, and advanced git actions. Buttons enable only when the lane has the required state.",
  actIntro: { title: "Git actions", variant: "drift" },
  requires: LANE_EXISTS_REQUIRES,
  beforeEnter: async () => [{ type: "navigate", to: "/lanes" }],
  docUrl: docs.lanesOverview,
};

// --- Act 6: History ---------------------------------------------------------
const act6Intro: TourStep = {
  id: "act6.intro",
  target: "",
  title: "Nothing gets lost",
  body: "Every lane, commit, push, and rebase lands in History. Scrub back whenever you need to know what happened.",
  actIntro: { title: "Nothing gets lost", variant: "orbit" },
  requires: PROJECT_OPEN_REQUIRES,
  beforeEnter: async () => [{ type: "navigate", to: "/history" }],
  docUrl: docs.welcome,
};

const act6Entries: TourStep = {
  id: "act6.entries",
  target: '[data-tour="history.entries"]',
  title: "Your trail of breadcrumbs",
  body: "Recent events sit at the top. Lane creation appears here once the lane exists; commits and pushes appear only after you perform those actions.",
  placement: "right",
  requires: PROJECT_OPEN_REQUIRES,
  waitForSelector: '[data-tour="history.entries"]',
  docUrl: docs.welcome,
};

const act6Filter: TourStep = {
  id: "act6.filter",
  target: '[data-tour="history.filter"]',
  title: "Filter by importance or kind",
  body: "Importance tiers tag the big moments — created, merged, deleted. Use filters to narrow the timeline when it gets noisy.",
  placement: "bottom",
  requires: PROJECT_OPEN_REQUIRES,
  waitForSelector: '[data-tour="history.filter"]',
  ghostCursor: {
    from: '[data-tour="history.entries"]',
    to: '[data-tour="history.filter"]',
  },
  docUrl: docs.welcome,
};

const act6ColumnSettings: TourStep = {
  id: "act6.columnSettings",
  target: '[data-tour="history.export"]',
  title: "Tune the timeline",
  body: "Use column settings to choose the timeline details that matter for review or handoff.",
  placement: "bottom",
  requires: PROJECT_OPEN_REQUIRES,
  waitForSelector: '[data-tour="history.export"]',
  docUrl: docs.welcome,
};

// --- Act 7: PRs -------------------------------------------------------------
const act7Intro: TourStep = {
  id: "act7.intro",
  target: "",
  title: "Ship a PR",
  body: "PRs starts with lane selection and a target branch, then moves into title, description, checks, and merge readiness.",
  actIntro: { title: "Ship a PR", variant: "orbit" },
  requires: LANE_EXISTS_REQUIRES,
  beforeEnter: async () => [{ type: "navigate", to: "/prs" }],
  docUrl: docs.lanesOverview,
};

const act7List: TourStep = {
  id: "act7.list",
  target: '[data-tour="prs.list"]',
  title: "Every PR, at a glance",
  body: "The list shows GitHub PRs and ADE-linked lanes. Select a row before inspecting checks, convergence, or close actions.",
  placement: "right",
  requires: ["projectOpen", "laneExists", "prCreated"],
  fallbackAfterMs: OPTIONAL_ACTION_FALLBACK_MS,
  fallbackNextLabel: "Continue without a PR",
  fallbackNotice: "No PR is required for the remaining product surfaces.",
  waitForSelector: '[data-tour="prs.list"]',
  docUrl: docs.lanesOverview,
};

const act7Checks: TourStep = {
  id: "act7.checks",
  target: '[data-tour="prs.checksPanel"]',
  title: "Checks tab",
  body: "Checks are shown inside a selected PR. Open a PR row and switch to Checks before using this panel.",
  placement: "left",
  requires: ["projectOpen", "prCreated"],
  beforeEnter: async () => [{
    type: "ipc",
    call: async () => {
      window.dispatchEvent(new CustomEvent("ade:tour-pr-detail-tab", { detail: "checks" }));
    },
  }],
  fallbackAfterMs: OPTIONAL_ACTION_FALLBACK_MS,
  fallbackNextLabel: "Skip PR checks",
  fallbackNotice: "Checks appear after a PR is selected; the walkthrough can continue without one.",
  waitForSelector: '[data-tour="prs.checksPanel"]',
  docUrl: docs.lanesOverview,
};

const act7Conflict: TourStep = {
  id: "act7.conflict",
  target: '[data-tour="prs.conflictSim"]',
  title: "Path to merge",
  body: "The convergence tab tracks checks, review comments, conflicts, and resolver runs for the selected PR.",
  placement: "left",
  requires: ["projectOpen", "prCreated"],
  beforeEnter: async () => [{
    type: "ipc",
    call: async () => {
      window.dispatchEvent(new CustomEvent("ade:tour-pr-detail-tab", { detail: "convergence" }));
    },
  }],
  fallbackAfterMs: OPTIONAL_ACTION_FALLBACK_MS,
  fallbackNextLabel: "Skip merge path",
  fallbackNotice: "Path to merge appears after a PR is selected.",
  waitForSelector: '[data-tour="prs.conflictSim"]',
  docUrl: docs.lanesOverview,
};

const act7Stacking: TourStep = {
  id: "act7.stacking",
  target: '[data-tour="prs.stackingIndicator"]',
  title: "Queue context",
  body: "When a PR belongs to a queue, this button links back to that queue. PRs without queue context skip this control.",
  placement: "left",
  requires: ["projectOpen", "prCreated"],
  fallbackAfterMs: OPTIONAL_ACTION_FALLBACK_MS,
  fallbackNextLabel: "Skip queue context",
  fallbackNotice: "Queue context only appears for queued PRs.",
  waitForSelector: '[data-tour="prs.stackingIndicator"]',
  docUrl: docs.lanesStacks,
};

const act7Close: TourStep = {
  id: "act7.close",
  target: '[data-tour="prs.detailDrawer"], [data-tour="prs.list"]',
  title: "Close actions",
  body: "Close appears only on an open selected PR. The walkthrough points out the action; you decide whether a real PR should close.",
  placement: "top",
  requires: PROJECT_OPEN_REQUIRES,
  waitForSelector: '[data-tour="prs.detailDrawer"], [data-tour="prs.list"]',
  docUrl: docs.lanesOverview,
};

// --- Bonus Act 8: Run -------------------------------------------------------
const act8Intro: TourStep = {
  id: "act8.intro",
  target: "",
  title: "Scripts and services",
  body: "Run is where dev servers, tests, and scripts live. Nothing auto-runs — you pick what starts.",
  actIntro: { title: "Scripts and services", variant: "drift" },
  requires: PROJECT_OPEN_REQUIRES,
  beforeEnter: async () => [{ type: "navigate", to: "/project" }],
  docUrl: docs.projectHome,
};

const act8LaneSelector: TourStep = {
  id: "act8.laneSelector",
  target: '[data-tour="run.laneSelector"]',
  title: "Pick a lane to run",
  body: "Commands are scoped to a lane's worktree. Switch lanes here — the command list reflects whichever lane is active.",
  placement: "bottom",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="run.laneSelector"]',
  docUrl: docs.projectHome,
};

const act8AddCommand: TourStep = {
  id: "act8.addCommand",
  target: '[data-tour="run.addCommand"]',
  title: "Add a command",
  body: "Add a dev server, test watcher, or any script. Give it a name and a command string — nothing saves during this walkthrough.",
  placement: "bottom",
  requires: PROJECT_OPEN_REQUIRES,
  waitForSelector: '[data-tour="run.addCommand"]',
  ghostCursor: {
    from: '[data-tour="run.header"]',
    to: '[data-tour="run.addCommand"]',
  },
  docUrl: docs.projectHome,
};

const act8ProcessMonitor: TourStep = {
  id: "act8.processMonitor",
  target: '[data-tour="run.processMonitor"]',
  title: "Watch what's running",
  body: "Live process monitor per lane — CPU, memory, uptime. Click to drill into logs.",
  placement: "top",
  requires: PROJECT_OPEN_REQUIRES,
  waitForSelector: '[data-tour="run.processMonitor"]',
  docUrl: docs.projectHome,
};

// --- Bonus Act 9: Automations -----------------------------------------------
const act9Intro: TourStep = {
  id: "act9.intro",
  target: "",
  title: "Fire things on events",
  body: "Automations fire when an event happens — a PR lands, a commit pushes, a test fails — and run an action in response.",
  actIntro: { title: "Fire things on events", variant: "particles" },
  requires: PROJECT_OPEN_REQUIRES,
  beforeEnter: async () => [{ type: "navigate", to: "/automations" }],
  docUrl: docs.automationsOverview,
};

const act9Triggers: TourStep = {
  id: "act9.triggers",
  target: '[data-tour="automations.createTrigger"]',
  title: "Triggers",
  body: "Pick what starts the automation — a webhook, a schedule, a git event, or a file watch. One automation can wire up several.",
  placement: "right",
  requires: PROJECT_OPEN_REQUIRES,
  waitForSelector: '[data-tour="automations.createTrigger"]',
  docUrl: docs.automationsOverview,
};

const act9Actions: TourStep = {
  id: "act9.actions",
  target: '[data-tour="automations.createTrigger"]',
  title: "Actions",
  body: "What happens when a trigger fires — run a command, dispatch a mission, ping a worker. Chain them in order.",
  placement: "right",
  requires: PROJECT_OPEN_REQUIRES,
  waitForSelector: '[data-tour="automations.createTrigger"]',
  docUrl: docs.automationsOverview,
};

const act9Guardrails: TourStep = {
  id: "act9.guardrails",
  target: '[data-tour="automations.createTrigger"]',
  title: "Guardrails",
  body: "Rate limits, concurrency caps, quiet hours. Guardrails stop an automation from going rogue — set them before you save.",
  placement: "right",
  requires: PROJECT_OPEN_REQUIRES,
  waitForSelector: '[data-tour="automations.createTrigger"]',
  docUrl: docs.automationsOverview,
};

// --- Bonus Act 10: CTO ------------------------------------------------------
const act10Intro: TourStep = {
  id: "act10.intro",
  target: "",
  title: "Meet your CTO",
  body: "A persistent agent that runs an org of workers. It pulls tickets from Linear, dispatches missions, and reports results back.",
  actIntro: { title: "Meet your CTO", variant: "orbit" },
  requires: PROJECT_OPEN_REQUIRES,
  beforeEnter: async () => [{ type: "navigate", to: "/cto" }],
  docUrl: docs.ctoOverview,
};

const act10Sidebar: TourStep = {
  id: "act10.sidebar",
  target: '[data-tour="cto.sidebar"]',
  title: "Your agents",
  body: "The sidebar lists every agent the CTO manages. Identities persist — each one remembers who they are between sessions.",
  placement: "right",
  requires: PROJECT_OPEN_REQUIRES,
  waitForSelector: '[data-tour="cto.sidebar"]',
  docUrl: docs.ctoOverview,
};

const act10Team: TourStep = {
  id: "act10.team",
  target: '[data-tour="cto.teamPanel"]',
  title: "Team panel",
  body: "Inspect, edit, or archive agents. Budget caps and heartbeat intervals live here too — set them low while you're learning.",
  placement: "left",
  requires: PROJECT_OPEN_REQUIRES,
  waitForSelector: '[data-tour="cto.teamPanel"]',
  docUrl: docs.ctoOverview,
};

const act10Linear: TourStep = {
  id: "act10.linear",
  target: '[data-tour="cto.linearPanel"]',
  title: "Linear sync",
  body: "Hook the CTO up to Linear and it auto-dispatches missions from tickets, posting results back to the issue. Skip if you don't use Linear.",
  placement: "left",
  requires: PROJECT_OPEN_REQUIRES,
  beforeEnter: async () => [{
    type: "ipc",
    call: async () => {
      window.dispatchEvent(new CustomEvent("ade:tour-cto-tab", { detail: "workflows" }));
    },
  }],
  waitForSelector: '[data-tour="cto.linearPanel"]',
  docUrl: docs.ctoOverview,
};

// --- Bonus Act 11: Settings --------------------------------------------------
const act11Intro: TourStep = {
  id: "act11.intro",
  target: "",
  title: "Make it yours",
  body: "Settings is sectioned by concern — appearance, AI providers, mobile push, memory, and more. Only General is required to get going.",
  actIntro: { title: "Make it yours", variant: "drift" },
  requires: PROJECT_OPEN_REQUIRES,
  beforeEnter: async () => [{ type: "navigate", to: "/settings" }],
  docUrl: docs.settingsGeneral,
};

const act11Appearance: TourStep = {
  id: "act11.appearance",
  target: '[data-tour="settings.appearance"]',
  title: "Appearance",
  body: "Theme, density, accent color. Dark mode is the default — light mode and high-contrast live right here.",
  placement: "right",
  requires: PROJECT_OPEN_REQUIRES,
  waitForSelector: '[data-tour="settings.appearance"]',
  docUrl: docs.settingsGeneral,
};

const act11Ai: TourStep = {
  id: "act11.ai",
  target: '[data-tour="settings.ai"]',
  title: "AI providers",
  body: "Plug in Claude, OpenAI, local models, or point at your own endpoint. Workers pick per-session; you set defaults here.",
  placement: "right",
  requires: PROJECT_OPEN_REQUIRES,
  waitForSelector: '[data-tour="settings.ai"]',
  docUrl: docs.settingsGeneral,
};

const act11Memory: TourStep = {
  id: "act11.memory",
  target: '[data-tour="settings.memory"]',
  title: "Memory",
  body: "Inspect and prune what the CTO and its workers remember. Pin facts, consolidate episodes, set retention caps.",
  placement: "right",
  requires: PROJECT_OPEN_REQUIRES,
  waitForSelector: '[data-tour="settings.memory"]',
  docUrl: docs.settingsGeneral,
};

const act11Templates: TourStep = {
  id: "act11.templates",
  target: '[data-tour="settings.laneTemplates"]',
  title: "Lane templates",
  body: "Pre-baked lane recipes — a fixed stack of runtimes and commands that any new lane can inherit. Save a template, apply it in one click.",
  placement: "right",
  requires: PROJECT_OPEN_REQUIRES,
  waitForSelector: '[data-tour="settings.laneTemplates"]',
  docUrl: docs.settingsGeneral,
};

// --- Act 12: Cleanup --------------------------------------------------------
const act12Nav: TourStep = {
  id: "act12.nav",
  target: "",
  title: "Clean up",
  body: "Back to Lanes to tidy up the sample lane. The tutorial will show where cleanup happens before it ends.",
  requires: PROJECT_OPEN_REQUIRES,
  beforeEnter: async () => [{ type: "navigate", to: "/lanes" }],
  docUrl: docs.lanesOverview,
  branches: () =>
    useAppStore.getState().lanes.some((lane) => lane.laneType !== "primary")
      ? null
      : "act12.help",
};

const act12Help: TourStep = {
  id: "act12.help",
  target: '[data-tour="app.helpMenu"]',
  title: "Replay or get help",
  body: "Open Help to replay tours, jump to docs, or review the glossary.",
  placement: "left",
  requires: PROJECT_OPEN_REQUIRES,
  waitForSelector: '[data-tour="app.helpMenu"]',
  docUrl: docs.welcome,
};

const act12Finale: TourStep = {
  id: "act12.finale",
  target: "",
  title: "That's every surface of ADE",
  body: "You've seen Lanes, Graph, Files, Work, PRs, History, Run, Automations, CTO, and Settings. Replay any walkthrough from the ? menu in the top-right.",
  actIntro: { title: "Done", variant: "drift" },
  requires: PROJECT_OPEN_REQUIRES,
  docUrl: docs.welcome,
};

// ---------------------------------------------------------------------------
// Assemble the full step list. Branching: if the user flagged "noRemote"
// during setup, skip the PR act's Close step (pushing isn't possible so
// no sample PR was created). See `registry.ts` — `branches(ctx)` may
// return the next step id or null to continue linearly.
// ---------------------------------------------------------------------------

const act7CloseWithBranch: TourStep = {
  ...act7Close,
  branches: (ctx: TourCtx) => {
    if (ctx.get<boolean>("noRemote")) return "act7.perTabTours";
    return null;
  },
};

const act5IntroWithBranch: TourStep = {
  ...act5Intro,
  branches: (ctx: TourCtx) => {
    // Dirty-repo dry-run mode: skip straight past the git actions beats
    // to the History act — the user didn't actually let us stage anything.
    if (ctx.get<boolean>("dryRun")) return "act6.intro";
    return null;
  },
};

const firstJourneyTour: Tour = {
  id: "first-journey",
  title: "Your first lane",
  variant: "full",
  route: "/lanes",
  ctxInit: () => ({ laneName: SAMPLE_LANE_NAME }),
  steps: [
    // Act 0 — Welcome + project picker
    act0Welcome,
    act0ProjectChoice,
    act0OpenProject,
    act0ProjectBrowser,

    // Act 1 — Lanes basics
    act1Intro,
    act1SidebarSweep,
    ...buildCreateLaneDialogWalkthrough(),
    act1LaneTabSpotlight,
    ...tutorialSection("act1.lanes", lanesTour.steps, LANE_EXISTS_REQUIRES),
    ...tutorialSection("act1.laneWorkPane", laneWorkPaneTour.steps, LANE_EXISTS_REQUIRES),
    act1PerTabTours,

    // Act 2 — Graph
    act2Intro,
    ...tutorialSection("act2.graph", graphTour.steps, LANE_EXISTS_REQUIRES),
    act2PerTabTours,

    // Act 3 — Files
    act3Intro,
    ...tutorialSection("act3.files", filesTour.steps, LANE_EXISTS_REQUIRES),
    act3PerTabTours,

    // Act 4 — Work
    act4Intro,
    ...tutorialSection("act4.work", workTour.steps, LANE_EXISTS_REQUIRES),
    act4ViewArea,
    act4PerTabTours,

    // Act 5 — Git
    act5IntroWithBranch,
    ...buildGitActionsPaneWalkthrough(),
    act5PerTabTours,

    // Act 6 — PRs
    act7Intro,
    ...buildPrCreateModalWalkthrough(),
    ...tutorialSection("act7.prs", prsTour.steps, LANE_EXISTS_REQUIRES),
    act7CloseWithBranch,
    act7PerTabTours,

    // Act 7 — History
    act6Intro,
    ...tutorialSection("act6.history", historyTour.steps),
    act6PerTabTours,

    // Act 8 — Run (bonus)
    act8Intro,
    ...tutorialSection("act8.run", runTour.steps),
    act8PerTabTours,

    // Act 9 — Automations (bonus)
    act9Intro,
    ...tutorialSection("act9.automations", automationsTour.steps),
    act9PerTabTours,

    // Act 10 — CTO (bonus)
    act10Intro,
    ...tutorialSection("act10.cto", ctoTour.steps),
    act10PerTabTours,

    // Act 11 — Settings (bonus)
    act11Intro,
    ...tutorialSection("act11.settings", settingsTour.steps),
    act11PerTabTours,

    // Act 12 — Cleanup (mandatory)
    act12Nav,
    ...buildManageLaneDialogWalkthrough(),
    act12Help,
    act12Finale,
  ],
};

registerTour(firstJourneyTour);

export default firstJourneyTour;
export { firstJourneyTour };
