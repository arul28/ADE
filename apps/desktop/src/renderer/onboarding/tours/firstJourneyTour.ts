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
import { runTour } from "./runTour";
import { laneWorkPaneTour } from "./laneWorkPaneTour";
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

// Wraps a per-tab walkthrough's steps for inclusion in the tutorial. Injects:
//   - A stable id per step (sectionId.index) so progress tracking works.
//   - A `requires` gate (default: project open) — overridable per-call.
//   - A `waitForSelector` derived from `target` so the engine waits for the
//     anchor before rendering — the underlying timeout is 10s in
//     `waitForSelector.ts`, so a missing anchor never permanently hangs.
//   - A `fallbackAfterMs` + skip label whenever the step has a `requires` gate
//     and the source walkthrough didn't already provide a fallback. This means
//     a user can never get stuck on a tutorial step waiting for state that
//     never arrives — they always have a "Continue" / "Skip" path within
//     `OPTIONAL_ACTION_FALLBACK_MS`.
function tutorialSection(
  sectionId: string,
  steps: readonly TourStep[],
  requires: readonly string[] = PROJECT_OPEN_REQUIRES,
): TourStep[] {
  return steps.map((step, index) => {
    const effectiveRequires = step.requires ?? requires;
    const needsFallback =
      effectiveRequires.length > 0 && typeof step.fallbackAfterMs !== "number";
    return {
      ...step,
      id: step.id ?? `${sectionId}.${index}`,
      requires: effectiveRequires,
      waitForSelector: step.waitForSelector ?? (step.target ? step.target : undefined),
      ...(needsFallback
        ? {
            fallbackAfterMs: OPTIONAL_ACTION_FALLBACK_MS,
            fallbackNextLabel: step.fallbackNextLabel ?? "Skip",
            fallbackNotice:
              step.fallbackNotice ??
              "This step is waiting on a state that hasn't appeared — you can skip it without affecting the tutorial.",
          }
        : {}),
    };
  });
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

// --- Act 0: Welcome + project picker ---------------------------------------
const act0Welcome: TourStep = {
  id: "act0.welcome",
  target: "",
  title: "Welcome to ADE",
  body: "Imagine being able to try several different ideas on your project **at the same time** without any of them messing each other up. That's what ADE does. Each idea gets its own safe sandbox copy of your code — we call those **lanes**. This tutorial will create one test lane, show you around, then clean it up.",
  actIntro: { title: "Welcome to ADE", subtitle: "Try several ideas in parallel — each in its own safe copy.", variant: "drift" },
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
  body: "A **project** is just a folder of code on your computer (technically a Git repo). You already have one open. Click **Use this project** to keep going with it. You can swap to a different folder later from the project switcher.",
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
  body: "Pick a folder of code to work on. ADE works with any Git repository — that just means a folder you've put under version control. Open a recent one, or click **Open Project** to browse to a different folder.",
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
  title: "Pick your folder",
  body: "Browse to the project folder you want to work on, then click **Open**. Close this picker if you'd rather pick from your recent projects instead.",
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
  body: "A **lane** is a safe sandbox copy of your project for one task — like *\"try a new login screen\"* or *\"fix the broken search\"*. It has its own copy of the files, its own conversations with AI helpers, and its own changes. Your real project (we call it **primary**) stays untouched until you decide the work is good enough to keep.",
  actIntro: { title: "Make a lane", variant: "orbit" },
  requires: PROJECT_OPEN_REQUIRES,
  beforeEnter: async () => [{ type: "navigate", to: "/lanes" }],
  docUrl: docs.lanesOverview,
};

const act1SidebarSweep: TourStep = {
  id: "act1.sidebarSweep",
  target: '[data-tour="app.sidebar"]',
  title: "Your tabs",
  body: "These icons on the left are how you move around ADE — like tabs in a browser. You're on **Lanes** right now (where you manage your sandbox copies). We'll visit each of the others as we go.",
  placement: "right",
  requires: PROJECT_OPEN_REQUIRES,
  waitForSelector: '[data-tour="app.sidebar"]',
  docUrl: docs.welcome,
};

// Lanes basics steps used inline by act1 (instead of spreading the full
// lanesTour, which would re-introduce New Lane and lane tabs the user just
// learned about via the interactive create-lane builder + lane spotlight).
const act1BranchSelector: TourStep = {
  id: "act1.branchSelector",
  target: '[data-tour="lanes.branchSelector"]',
  title: "The clean starting point",
  body: "Every sandbox copy needs a starting point. ADE uses your project's main branch (usually called `main`) as that. Each new lane copies from here, and ADE always compares the lane's changes back to this so you can see exactly what's different.",
  placement: "bottom",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="lanes.branchSelector"]',
  docUrl: docs.lanesOverview,
};

const act1StatusChips: TourStep = {
  id: "act1.statusChips",
  target: '[data-tour="lanes.statusChips"]',
  title: "What's going on with each lane",
  body: "These little badges tell you the status of every lane at a glance. **Running** = something is actively working in it. **Waiting** = it needs you (or an AI) to make a call. **Ended** = the work there is done or put away.",
  placement: "bottom",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="lanes.statusChips"]',
  docUrl: docs.lanesOverview,
};

const act1LaneTabSpotlight: TourStep = {
  id: "act1.laneTabSpotlight",
  target: '[data-tour="lanes.laneTab"]',
  title: "Your new lane",
  body: "There it is — that's your sandbox copy. Click it any time to see this task's files, conversations, and changes. Your real project stays untouched.",
  bodyTemplate: (ctx) =>
    `**${laneName(ctx)}** is live — that's your sandbox copy. Anything that happens in it (file changes, AI chats, etc.) stays inside it. Your real project is untouched.`,
  placement: "bottom",
  requires: LANE_EXISTS_REQUIRES,
  disableBack: true,
  beforeEnter: async () => {
    requestFocusedLaneLayout();
  },
  waitForSelector: '[data-tour="lanes.laneTab"]',
  docUrl: docs.lanesOverview,
};

// Per-act handoff steps were collapsed into the single act12 finale — no need
// to remind the user 11 times that the ? menu replays sections.

// --- Act 2: Graph -----------------------------------------------------------
const act2Intro: TourStep = {
  id: "act2.intro",
  target: "",
  title: "See how everything connects",
  body: "Once you have a few lanes going, it can be hard to keep track of how they relate. **Graph** is a visual map — each lane is a circle, each connection between them is a line.",
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
  title: "Your lane on the map",
  body: "That circle is your new lane, drawn off the main project. The line between them shows it branched off from there. If you build a lane *on top of* another lane (called **stacking**), you'd see another line continuing out from it.",
  bodyTemplate: (ctx) =>
    `That circle is **${laneName(ctx)}**, your new sandbox copy. The line shows it branched off from your main project. Lines between lanes show **stacking** — when one lane builds on top of another.`,
  placement: "bottom",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="graph.node"]',
  docUrl: docs.workspaceGraph,
};

const act2Zoom: TourStep = {
  id: "act2.zoom",
  target: '[data-tour="graph.zoom"]',
  title: "Move around the map",
  body: "Scroll to zoom in and out, drag to pan around. The map updates itself live as you make new lanes or change existing ones — no refresh needed.",
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
  title: "What the colors mean",
  body: "Lanes change color and shape based on their status — like \"has changes you haven't saved\" or \"ready to ship\". This little key explains them. Peek at it whenever something looks unfamiliar.",
  placement: "left",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="graph.legend"]',
  docUrl: docs.workspaceGraph,
};

// --- Act 3: Files -----------------------------------------------------------
const act3Intro: TourStep = {
  id: "act3.intro",
  target: "",
  title: "Browse the code",
  body: "**Files** is your code browser — like Finder or Explorer, but for any of your lanes. Each lane has its own copy of the project's files (we call that a **worktree**, just a fancy word for \"this lane's folder\"). Pick which lane to look at, then explore.",
  actIntro: { title: "Browse the code", variant: "drift" },
  requires: LANE_EXISTS_REQUIRES,
  beforeEnter: async () => [{ type: "navigate", to: "/files" }],
  docUrl: docs.filesEditor,
};

const act3Workspace: TourStep = {
  id: "act3.workspace",
  target: '[data-tour="files.workspaceSelector"]',
  title: "Pick which copy to look at",
  body: "Each lane has its own files, so you have to tell ADE which one you want to see. Use this dropdown to switch between your main project and any lane.",
  bodyTemplate: (ctx) =>
    `Each lane has its own copy of the files. Pick **${laneName(ctx)}** here to see *that* lane's version — anything you do in there only affects that sandbox.`,
  placement: "bottom",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="files.workspaceSelector"]',
  docUrl: docs.filesEditor,
};

const act3Tree: TourStep = {
  id: "act3.tree",
  target: '[data-tour="files.fileTree"]',
  title: "Spot what's changed",
  body: "When a file's been touched in this lane, it gets a colored letter next to it: **M** = you edited it, **A** = you made it new, **D** = you deleted it. So you can glance and see exactly what this sandbox has changed.",
  placement: "right",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="files.fileTree"]',
  docUrl: docs.filesEditor,
};

const act3Search: TourStep = {
  id: "act3.search",
  target: '[data-tour="files.searchBar"]',
  title: "Search every file",
  body: "Type anything — a function name, a piece of text, a typo you remember — and ADE searches every file in this lane. Click a result to jump straight to that line.",
  placement: "bottom",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="files.searchBar"]',
  docUrl: docs.filesEditor,
};

const act3OpenIn: TourStep = {
  id: "act3.openIn",
  target: '[data-tour="files.openIn"]',
  title: "Open in your favorite editor",
  body: "Already use VS Code, Cursor, or another code editor? This button hands the file (or the whole lane folder) over to it in one click. Keep using ADE as your home base while editing wherever you like.",
  placement: "bottom",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="files.openIn"]',
  docUrl: docs.filesEditor,
};

// --- Act 4: Work ------------------------------------------------------------
const act4Intro: TourStep = {
  id: "act4.intro",
  target: "",
  title: "Get help from AI",
  body: "ADE can ask AI to read your files, run commands, and write code for you — we call those AI helpers **workers**. The **Work** tab shows every conversation you have with them, plus any terminal windows you've opened, all in one place.",
  actIntro: { title: "Get help from AI", variant: "particles" },
  requires: LANE_EXISTS_REQUIRES,
  beforeEnter: async () => [{ type: "navigate", to: "/work" }],
  docUrl: docs.chatOverview,
};

const act4Sessions: TourStep = {
  id: "act4.sessions",
  target: '[data-tour="work.sessionsPane"]',
  title: "Every conversation in one list",
  body: "All your AI chats and terminal windows show up here, no matter which lane they're in. Each one is called a **session** — just one open conversation or one open terminal.",
  placement: "right",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="work.sessionsPane"]',
  docUrl: docs.chatOverview,
};

const act4LaneFilter: TourStep = {
  id: "act4.laneFilter",
  target: '[data-tour="work.laneFilter"]',
  title: "Narrow the list",
  body: "Got a lot going on? Filter the list down to just one lane's conversations. Useful once you have AI working in several lanes at once.",
  bodyTemplate: (ctx) =>
    `Click here to see only **${laneName(ctx)}**'s conversations. Useful once you have AI working in several lanes at once.`,
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
  title: "Start a chat with AI",
  body: "Click **New Chat** to open a conversation. You can ask the AI to do things like *\"add a dark mode toggle\"* or *\"figure out why this test is failing\"* — it'll read your files and make changes for you. The tutorial continues the moment your chat shows up in the list.",
  placement: "bottom",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="work.newSession"]',
  awaitingActionLabel: "Waiting for a chat to start",
  advanceWhenSelector: '[data-tour="work.sessionItem"]',
  fallbackAfterMs: OPTIONAL_ACTION_FALLBACK_MS,
  fallbackNextLabel: "Skip starting a chat",
  fallbackNotice: "Don't want to start a chat right now? You can come back to this button any time.",
  exitOnOutsideInteraction: true,
  allowedInteractionSelectors: ['[data-tour="work.newSession"]'],
  docUrl: docs.chatOverview,
};

const act4ViewArea: TourStep = {
  id: "act4.viewArea",
  target: '[data-tour="work.viewArea"]',
  title: "Where the chat shows up",
  body: "Your open chat lives here. Open more than one and they appear as tabs you can drag around. Close a tab to clean up. The list on the left always shows everything — even chats you've closed but not deleted.",
  placement: "left",
  requires: LANE_EXISTS_REQUIRES,
  waitForSelector: '[data-tour="work.viewArea"]',
  docUrl: docs.chatOverview,
};

// --- Act 5: Git -------------------------------------------------------------
const act5Intro: TourStep = {
  id: "act5.intro",
  target: "",
  title: "Save your work",
  body: "When you've made changes you want to keep, you **commit** them — that's a saved snapshot of your work. Then you **push** to upload that snapshot somewhere shareable (like GitHub). This panel handles all of that without making you remember any commands. Buttons light up only when they make sense.",
  actIntro: { title: "Save and share your work", variant: "drift" },
  requires: LANE_EXISTS_REQUIRES,
  beforeEnter: async () => [{ type: "navigate", to: "/lanes" }],
  docUrl: docs.lanesOverview,
};

// --- Act 6: History ---------------------------------------------------------
const act6Intro: TourStep = {
  id: "act6.intro",
  target: "",
  title: "Nothing gets lost",
  body: "**History** is your project's logbook. Every time you create a lane, save your work, share it, or anything else important happens — it goes here in order. Scroll back any time you want to remember what you (or your AI helpers) did.",
  actIntro: { title: "Nothing gets lost", variant: "orbit" },
  requires: PROJECT_OPEN_REQUIRES,
  beforeEnter: async () => [{ type: "navigate", to: "/history" }],
  docUrl: docs.welcome,
};

const act6Entries: TourStep = {
  id: "act6.entries",
  target: '[data-tour="history.entries"]',
  title: "What just happened",
  body: "The newest events sit at the top — making a lane, saving work, sharing changes. The list grows as you do things. If you haven't done it yet, it won't show up here.",
  placement: "right",
  requires: PROJECT_OPEN_REQUIRES,
  waitForSelector: '[data-tour="history.entries"]',
  docUrl: docs.welcome,
};

const act6Filter: TourStep = {
  id: "act6.filter",
  target: '[data-tour="history.filter"]',
  title: "Find specific moments",
  body: "When the list gets long, filter to just the big stuff — \"lane created\", \"shipped\", \"deleted\" — or just one type of event. Saves scrolling.",
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
  title: "Show what matters to you",
  body: "Choose which details show up next to each event — like timestamps, who did it, or which lane it was in. Hide the noise, keep what's useful.",
  placement: "bottom",
  requires: PROJECT_OPEN_REQUIRES,
  waitForSelector: '[data-tour="history.export"]',
  docUrl: docs.welcome,
};

// --- Act 7: PRs -------------------------------------------------------------
const act7Intro: TourStep = {
  id: "act7.intro",
  target: "",
  title: "Ship your work",
  body: "When you're happy with what's in a lane and want it to become part of the real project, you open a **PR** (short for **Pull Request** — basically: *\"please pull this lane's changes into the main project\"*). It's how teams review and combine work on GitHub. ADE handles the whole thing for you here.",
  actIntro: { title: "Ship your work", variant: "orbit" },
  requires: LANE_EXISTS_REQUIRES,
  beforeEnter: async () => [{ type: "navigate", to: "/prs" }],
  docUrl: docs.lanesOverview,
};

const act7DetailDrawer: TourStep = {
  id: "act7.detailDrawer",
  target: '[data-tour="prs.detailDrawer"]',
  title: "The PR you just shipped",
  body: "Click any PR in the list and this panel opens up to show its details. There are five tabs at the top: **Overview** (the basics), **Path to Merge** (anything stopping it from shipping), **Files** (what changed), **CI / Checks** (automated tests), and **Activity** (review comments and discussion).",
  placement: "left",
  requires: PROJECT_OPEN_REQUIRES,
  fallbackAfterMs: OPTIONAL_ACTION_FALLBACK_MS,
  fallbackNextLabel: "Skip PR detail",
  fallbackNotice: "The detail drawer appears once you select a PR row.",
  waitForSelector: '[data-tour="prs.detailDrawer"]',
  docUrl: docs.lanesOverview,
};

const act7Conflict: TourStep = {
  id: "act7.conflict",
  target: '[data-tour="prs.conflictSim"]',
  title: "What's blocking me?",
  body: "This is the most useful tab. It collects everything stopping your PR from shipping — automated tests that failed, comments asking for changes, code conflicts with the main project — into one ordered to-do list. Work top to bottom, and when the list is empty, you can ship.",
  placement: "left",
  requires: ["projectOpen", "prCreated"],
  beforeEnter: async () => [{
    type: "ipc",
    call: async () => {
      window.dispatchEvent(new CustomEvent("ade:tour-pr-detail-tab", { detail: "convergence" }));
    },
  }],
  fallbackAfterMs: OPTIONAL_ACTION_FALLBACK_MS,
  fallbackNextLabel: "Skip Path to Merge",
  fallbackNotice: "Path to Merge appears once a PR is selected.",
  waitForSelector: '[data-tour="prs.conflictSim"]',
  docUrl: docs.lanesOverview,
};

const act7Checks: TourStep = {
  id: "act7.checks",
  target: '[data-tour="prs.checksPanel"]',
  title: "Automated tests",
  body: "Most projects automatically run tests every time you push code (this is called **CI**, short for **Continuous Integration**). This tab shows the results live — passing, failing, still running. Click any row to read the full output without bouncing over to GitHub.",
  placement: "left",
  requires: ["projectOpen", "prCreated"],
  beforeEnter: async () => [{
    type: "ipc",
    call: async () => {
      window.dispatchEvent(new CustomEvent("ade:tour-pr-detail-tab", { detail: "checks" }));
    },
  }],
  fallbackAfterMs: OPTIONAL_ACTION_FALLBACK_MS,
  fallbackNextLabel: "Skip CI tab",
  fallbackNotice: "Checks appear once a PR is selected.",
  waitForSelector: '[data-tour="prs.checksPanel"]',
  docUrl: docs.lanesOverview,
};

const act7Stacking: TourStep = {
  id: "act7.stacking",
  target: '[data-tour="prs.stackingIndicator"], [data-tour="prs.detailDrawer"]',
  title: "Stacking PRs",
  body: "Sometimes you want to break a big change into smaller PRs that build on each other — like *\"add login API\"* → *\"add login UI\"* → *\"polish the login\"*. Each builds on the last. We call that **stacking**, and this badge shows up so you know where this PR sits in the stack. Standalone PRs don't show this.",
  placement: "left",
  requires: PROJECT_OPEN_REQUIRES,
  fallbackAfterMs: OPTIONAL_ACTION_FALLBACK_MS,
  fallbackNextLabel: "Skip stacking",
  fallbackNotice: "Stacking only shows up for PRs that belong to a stack.",
  waitForSelector: '[data-tour="prs.stackingIndicator"], [data-tour="prs.detailDrawer"]',
  docUrl: docs.lanesStacks,
};

const act7Close: TourStep = {
  id: "act7.close",
  target: '[data-tour="prs.closeBtn"], [data-tour="prs.detailDrawer"]',
  title: "Closing the PR",
  body: "When the work is shipped (or you decide to drop it), close the PR with this button. The lane stays around in case you want to keep building on top of it later.",
  placement: "top",
  requires: PROJECT_OPEN_REQUIRES,
  fallbackAfterMs: OPTIONAL_ACTION_FALLBACK_MS,
  fallbackNextLabel: "Skip close action",
  fallbackNotice: "Close is only available for open, non-merged PRs.",
  waitForSelector: '[data-tour="prs.closeBtn"], [data-tour="prs.detailDrawer"]',
  docUrl: docs.lanesOverview,
};

// --- Bonus Act 8: Run -------------------------------------------------------
const act8Intro: TourStep = {
  id: "act8.intro",
  target: "",
  title: "Run your project",
  body: "Most projects need to *run* something — a dev server while you code, a test suite, a script. Normally you'd type these into a terminal. **Run** lets you save them as buttons you can click. Nothing starts automatically — you decide what runs and when.",
  actIntro: { title: "Run your project", variant: "drift" },
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
  title: "Make things happen automatically",
  body: "**Automations** are little \"if this happens, do that\" rules. *\"When a PR ships, ping me on Slack.\"* *\"When a test fails, ask AI to look at it.\"* Set them up once and they run themselves in the background.",
  actIntro: { title: "Make things happen automatically", variant: "particles" },
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
  title: "Your AI lead",
  body: "**CTO** is an AI that acts like a tech lead on your team. You can give it a list of things to do (or hook up a project manager tool like Linear) and it'll assign work to other AI helpers, check in on their progress, and report back to you. Think of it as a manager for your AI workers.",
  actIntro: { title: "Your AI lead", variant: "orbit" },
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
  body: "Tweak how ADE looks and behaves — themes, which AI services to use (Claude, OpenAI, etc.), notifications, and more. The defaults are fine to start; come back here when you want to customize.",
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
  title: "Clean up the test lane",
  body: "Time to delete the sandbox we made for the tutorial. Heading back to **Lanes** so you can see where lane cleanup lives.",
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
  title: "Where to get help",
  body: "Click the **?** any time to replay any part of this tour, jump into the docs, or look up a word you don't recognize.",
  placement: "left",
  requires: PROJECT_OPEN_REQUIRES,
  waitForSelector: '[data-tour="app.helpMenu"]',
  docUrl: docs.welcome,
};

const act12Finale: TourStep = {
  id: "act12.finale",
  target: "",
  title: "You've seen the whole app",
  body: "Lanes for sandboxes, Graph for the map, Files for the code, Work for AI chats, Git Actions for saving, PRs for shipping, History for the logbook, plus Run, Automations, CTO, and Settings. If you ever forget what something does, hit the **?** in the top-right to replay the bit you need.",
  actIntro: { title: "You're set", variant: "drift" },
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
    // Dry-run / noRemote setup: pushing isn't possible, so we never opened a
    // sample PR — skip the close beat and jump straight to History.
    if (ctx.get<boolean>("noRemote")) return "act6.intro";
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
    // We don't spread the full lanesTour here: the user has already created
    // a lane interactively (so New Lane and lane tabs are already covered).
    // We only need the two pieces the spotlight didn't cover — base branch
    // and the status filter chips — plus the Lane Work Pane intro.
    act1Intro,
    act1SidebarSweep,
    ...buildCreateLaneDialogWalkthrough(),
    act1LaneTabSpotlight,
    act1BranchSelector,
    act1StatusChips,
    ...tutorialSection("act1.laneWorkPane", laneWorkPaneTour.steps, LANE_EXISTS_REQUIRES),

    // Act 2 — Graph
    // act2LaneNode / Zoom / Legend have ctx-aware copy that names the user's
    // lane — better than the generic graphTour spread used elsewhere.
    act2Intro,
    act2LaneNode,
    act2Zoom,
    act2Legend,

    // Act 3 — Files
    act3Intro,
    act3Workspace,
    act3Tree,
    act3Search,
    act3OpenIn,

    // Act 4 — Work
    act4Intro,
    act4Sessions,
    act4LaneFilter,
    act4NewSession,
    act4ViewArea,

    // Act 5 — Git
    act5IntroWithBranch,
    ...buildGitActionsPaneWalkthrough(),

    // Act 6 — PRs
    // The interactive builder ships a real PR. After it lands, we walk the
    // user through the detail drawer's tabs by dispatching the
    // `ade:tour-pr-detail-tab` event before each step (handler in
    // PrDetailPane.tsx). Order: drawer overview → Path to Merge (the most
    // load-bearing tab) → CI / Checks → stacking → close.
    act7Intro,
    ...buildPrCreateModalWalkthrough(),
    act7DetailDrawer,
    act7Conflict,
    act7Checks,
    act7Stacking,
    act7CloseWithBranch,

    // Act 7 — History
    act6Intro,
    ...tutorialSection("act6.history", historyTour.steps),

    // Act 8 — Run (bonus)
    act8Intro,
    ...tutorialSection("act8.run", runTour.steps),

    // Act 9 — Automations (bonus)
    act9Intro,
    ...tutorialSection("act9.automations", automationsTour.steps),

    // Act 10 — CTO (bonus)
    act10Intro,
    ...tutorialSection("act10.cto", ctoTour.steps),

    // Act 11 — Settings (bonus)
    act11Intro,
    ...tutorialSection("act11.settings", settingsTour.steps),

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
