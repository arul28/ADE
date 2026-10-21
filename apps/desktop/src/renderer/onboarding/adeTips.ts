import {
  AppWindow,
  ArrowsLeftRight,
  At,
  Bell,
  Brain,
  CalendarCheck,
  ChatCenteredText,
  ClockCounterClockwise,
  Cloud,
  Crown,
  DesktopTower,
  DeviceMobile,
  DownloadSimple,
  Eye,
  FileCode,
  FilmStrip,
  GitBranch,
  GitFork,
  GitPullRequest,
  Globe,
  GridFour,
  HardDrives,
  Laptop,
  Lightning,
  LinkSimple,
  ListChecks,
  LockKey,
  Microphone,
  Moon,
  MusicNotes,
  PaintBrush,
  Palette,
  Plug,
  Plugs,
  PlugsConnected,
  PresentationChart,
  Robot,
  ShieldCheck,
  SquaresFour,
  StackSimple,
  TerminalWindow,
  Toolbox,
  type Icon,
} from "@phosphor-icons/react";
import type { ConnectionsPanelTab } from "../lib/connectionsPanel";
import { openConnectionsPanel } from "../lib/connectionsPanel";
import { isWebClientMode } from "../lib/webClientMode";
import { isSettingAvailable, settingsEntryById, settingsRouteFor } from "../components/settings/settingsManifest";
import { musicActions } from "../components/music/musicStore";
import { musicTabAvailable } from "../components/music/musicTab";
import { onDraftPage } from "../components/onboarding/tour/onboardingTourSteps";
import type { GoToDestination } from "../components/onboarding/spotlight/useGoTo";
import {
  anchorSelector,
  settingsCardSelector,
  showSpotlight,
  type SpotlightSpot,
} from "../components/onboarding/spotlight/spotlight";

/**
 * ADE Tips: the things worth knowing about ADE, browsable from the help menu
 * and the home screen, never pushed. Tier 2 of onboarding (tier 1 is the
 * first-run flow, tier 3 the situational suggestions in
 * `adeTipsSuggestions.ts`, which land here when the user says "Not now").
 *
 * Each tip is one plain sentence: what it is and why you would want it. Its
 * "Try it" takes the user to the place it lives (a page of the open project,
 * a Settings card, a new chat, Home, the Connections panel) and rings the
 * control there with one line on what to do (`spotlight/`). A tip whose
 * surface lives inside a chat (rewind, comments) rings the chats list and
 * says how to get there; nothing guesses at a chat for them.
 */

export type AdeTipGroupId = "agents" | "brain" | "machines" | "integrations" | "git" | "yours" | "safety";

export type AdeTipGroup = {
  id: AdeTipGroupId;
  label: string;
  /** One line under the group's name. */
  blurb: string;
  icon: Icon;
  /** The group's colour: its chip and its tips' glyphs. Read on dark and light pages. */
  hue: string;
};

export const ADE_TIP_GROUPS: readonly AdeTipGroup[] = [
  { id: "agents", label: "Agents", blurb: "What your agents can do, and how to steer them.", icon: Robot, hue: "#8b5cf6" },
  { id: "brain", label: "Project brain", blurb: "A lead for each project, and work that runs while you're away.", icon: Brain, hue: "#f59e0b" },
  { id: "machines", label: "Machines", blurb: "Every computer you own, and your phone, from one window.", icon: Laptop, hue: "#0ea5e9" },
  { id: "integrations", label: "Integrations", blurb: "Your tracker, other agents and other AI apps.", icon: PlugsConnected, hue: "#22c55e" },
  { id: "git", label: "Git", blurb: "Lanes, files, pull requests and history, without leaving ADE.", icon: GitBranch, hue: "#f0643c" },
  { id: "yours", label: "Make it yours", blurb: "Home, themes, music and how Work is laid out.", icon: PaintBrush, hue: "#ec4899" },
  { id: "safety", label: "Safety", blurb: "Keys kept out of chats, proof of the work, and a screen of their own.", icon: ShieldCheck, hue: "#14b8a6" },
];

export type AdeTipPlace =
  /** Home, a new chat, or a page of the open project (Settings cards included). */
  | { kind: "go"; to: GoToDestination }
  /** The top bar's Connections panel, on one of its tabs. Desktop only. */
  | { kind: "connections"; tab: ConnectionsPanelTab }
  /** The Music tab. Desktop only. */
  | { kind: "music" }
  /** Work with a chat open: the one already open, else the newest in the list. */
  | { kind: "chat" };

export type AdeTipAction = {
  place: AdeTipPlace;
  /** What to ring once there, best first; the first on screen wins. */
  spots: readonly SpotlightSpot[];
  /** Settings card the place is, for availability (`isSettingAvailable`). */
  settingId?: string;
};

export type AdeTip = {
  id: string;
  group: AdeTipGroupId;
  title: string;
  /** One sentence: what it is and why you would want it. */
  sentence: string;
  icon: Icon;
  action?: AdeTipAction;
};

const spot = (anchor: string, label: string): SpotlightSpot => ({ selector: anchorSelector(anchor), label });
const at = (selector: string, label: string): SpotlightSpot => ({ selector, label });

/** A page of the open project, ringing `spots` there. */
const page = (to: `/${string}`, ...spots: SpotlightSpot[]): AdeTipAction => ({ place: { kind: "go", to }, spots });
/** A fresh new chat, ringing `spots` on it. */
const draft = (...spots: SpotlightSpot[]): AdeTipAction => ({ place: { kind: "go", to: "draft" }, spots });
/** A Settings card, ringed with `label`. */
function setting(entryId: string, label: string): AdeTipAction {
  const anchor = settingsEntryById(entryId)?.anchor;
  return {
    place: { kind: "go", to: settingsRouteFor(entryId) as `/${string}` },
    spots: anchor ? [at(settingsCardSelector(anchor), label)] : [],
    settingId: entryId,
  };
}
const connections = (tab: ConnectionsPanelTab, label: string): AdeTipAction => ({
  place: { kind: "connections", tab },
  spots: [spot(`connections-${tab}`, label)],
});

/** For tips that live inside a chat: the open chat's control if there is one, else a chat to open. */
const inAChat = (rowLabel: string, emptyLabel: string, ...openChatSpots: SpotlightSpot[]): AdeTipAction =>
  page("/work", ...openChatSpots, spot("session-row", rowLabel), spot("session-list", emptyLabel));

const FIRST_CHAT = "Start a chat first; it shows here.";

/**
 * For tips that live on a message: open a chat, then ring `messageSpot` in
 * it, or the chat itself with `noMessageLabel` when it has no such message.
 * `runTipAction` drops the second spot when it opened a chat and the third
 * when it did not.
 */
const inOpenChat = (messageSpot: SpotlightSpot, noMessageLabel: string): AdeTipAction => ({
  place: { kind: "chat" },
  spots: [messageSpot, at("[data-chat-message-list-root]", noMessageLabel), spot("session-list", FIRST_CHAT)],
});

export const ADE_TIPS: readonly AdeTip[] = [
  // Agents
  {
    id: "chat-tools", group: "agents", icon: Toolbox, title: "Chat tools",
    sentence: "Agents can use the ADE browser, drive your app and run ADE itself, so they can check their own work.",
    action: inAChat(
      "Open a chat, then its Tools: the browser and app controls agents use too.",
      "Start a chat; its Tools pane holds the browser and app controls agents use.",
      spot("tools-pane", "This chat's tools. Agents use the same browser and app controls."),
      spot("tools-toggle", "Open Tools: the browser and app controls agents use too."),
    ),
  },
  {
    id: "at-menu", group: "agents", icon: At, title: "The @ menu",
    sentence: "Type @ in the composer to hand part of a task to another model as a subagent, or to another machine.",
    action: draft(spot("composer", "Type @ to hand part of the task to a subagent, or to another machine.")),
  },
  {
    id: "handoff", group: "agents", icon: ArrowsLeftRight, title: "Hand off a chat",
    sentence: "Move a chat to another model or machine and keep everything it knows.",
    action: inAChat("Right-click a chat and pick Hand off.", FIRST_CHAT),
  },
  {
    id: "rewind", group: "agents", icon: ClockCounterClockwise, title: "Rewind files",
    sentence: "Undo an agent's file edits back to any message in the chat.",
    action: inOpenChat(
      at("[data-chat-user-message-card]", "Hover your message: after a turn that changed files, the ↶ button in its corner puts them back."),
      "Hover one of your messages: after a turn that changed files, ↶ in its corner puts them back.",
    ),
  },
  {
    id: "comments", group: "agents", icon: ChatCenteredText, title: "Comments on replies",
    sentence: "Comment on any part of a reply, then send your comments to the chat.",
    action: inOpenChat(
      at("[data-thread-comment-key]", "Select a few words in this reply, then pick Comment."),
      "This chat has no reply yet. In a chat with one, select a few words of the reply and pick Comment.",
    ),
  },
  {
    id: "scenes", group: "agents", icon: PresentationChart, title: "Scenes",
    sentence: "Agents can answer with live charts, views and small forms right in the chat.",
    action: draft(spot("composer", "Ask for a chart, a table or a small form; the agent can answer with a live scene.")),
  },
  {
    id: "voice", group: "agents", icon: Microphone, title: "Voice",
    sentence: "Dictate a prompt, or talk with an agent out loud.",
    action: setting("chat.voice-conversations", "Turn voice on here, then talk from any chat's composer."),
  },
  {
    id: "cli-chats", group: "agents", icon: TerminalWindow, title: "CLI chats",
    sentence: "Run the same agents in a terminal when you prefer their own interface, with ADE's lanes around them.",
    action: draft(spot("draft-mode-switch", "Pick CLI to run an agent in its own terminal interface.")),
  },
  {
    id: "import-chats", group: "agents", icon: DownloadSimple, title: "Import your chats",
    sentence: "Bring in past chats from Claude Code, Codex, Cursor and more, and keep going in ADE.",
    action: draft(
      spot("import-pill", "Import past chats from Claude Code, Codex, Cursor and more."),
      spot("import-button", "Import past chats from Claude Code, Codex, Cursor and more."),
    ),
  },

  // Project brain
  {
    id: "cto", group: "brain", icon: Crown, title: "CTO",
    sentence: "A lead for each project that knows its lanes, PRs and history, and plans work with you.",
    action: page("/cto", spot("composer", "Ask your CTO what to work on next. It knows this project's lanes and PRs.")),
  },
  {
    id: "automations", group: "brain", icon: Lightning, title: "Automations",
    sentence: "Run an agent on a schedule, or when a PR, an issue or a webhook fires.",
    action: page("/automations", at('[data-tour="automations.createTrigger"]', "Create one: a schedule, a PR, an issue or a webhook starts an agent.")),
  },
  {
    id: "scheduled-sends", group: "brain", icon: CalendarCheck, title: "Scheduled sends",
    sentence: "Write a message now and let ADE send it later, from the composer's send menu.",
    action: draft(
      spot("composer-send-menu", "Write your message, then pick Scheduled send from this menu."),
      spot("composer", "Write your message, then open the send menu beside Send."),
    ),
  },

  // Machines
  {
    id: "connect-machine", group: "machines", icon: DesktopTower, title: "Connect another computer",
    sentence: "Drive lanes and chats that live on your other machines from this window.",
    action: connections("machines", "Your computers. Connect one to drive its lanes and chats from here."),
  },
  {
    id: "phone", group: "machines", icon: DeviceMobile, title: "ADE on your phone",
    sentence: "Check on agents and answer them from the iPhone app when you are away.",
    action: connections("mobile", "Pair the iPhone app here."),
  },
  {
    id: "web-app", group: "machines", icon: Globe, title: "The web app",
    sentence: "Control every machine and agent from a browser, the same way as here.",
    action: connections("web", "Turn on the web app here."),
  },
  {
    id: "headless", group: "machines", icon: HardDrives, title: "Headless brain",
    sentence: "Run ADE on a server with no screen; once it signs in it joins your other machines.",
    action: connections("machines", "A server running ADE headless shows up here once it signs in."),
  },
  {
    id: "keep-awake", group: "machines", icon: Moon, title: "Keep awake",
    sentence: "Keep this computer awake so agents keep working while you are away.",
    action: setting("general.keep-awake", "Keep this computer awake while agents work."),
  },
  {
    id: "notifications", group: "machines", icon: Bell, title: "Notifications",
    sentence: "Hear when an agent needs you, here or on your phone.",
    action: setting("notifications.events", "Pick what reaches you, here and on your phone."),
  },

  // Integrations
  {
    id: "issues", group: "integrations", icon: ListChecks, title: "Linear, GitHub and Jira issues",
    sentence: "Connect your tracker and start a chat straight from an issue.",
    action: setting("integrations.linear", "Connect Linear here. GitHub and Jira sit on the same page."),
  },
  {
    id: "cloud-agents", group: "integrations", icon: Cloud, title: "Cursor and Devin cloud agents",
    sentence: "Once Cursor or Devin is connected, their cloud agents show in the top bar for this project.",
    action: setting("agents.providers", "Connect Cursor or Devin here."),
  },
  {
    id: "ade-mcp", group: "integrations", icon: Plug, title: "ADE MCP",
    sentence: "Let ChatGPT, claude.ai and other AI apps use ADE on this computer.",
    action: setting("ade-mcp.server", "Let other AI apps use ADE on this computer."),
  },
  {
    id: "mcp-once", group: "integrations", icon: Plugs, title: "One MCP setup for every agent",
    sentence: "Add an MCP server once and every ADE agent gets it, on every computer.",
    action: setting("mcp.servers", "Add a server once; every agent gets it, on every computer."),
  },

  // Git
  {
    id: "lanes", group: "git", icon: GitFork, title: "Lanes",
    sentence: "Each piece of work gets its own worktree and branch, so agents never step on each other.",
    action: page("/lanes", at('[data-tour="lanes.newLane"]', "New lane: a worktree on its own branch, for one piece of work.")),
  },
  {
    id: "files", group: "git", icon: FileCode, title: "Files",
    sentence: "A full editor for every lane, with a diff for each change.",
    action: page("/files", at('[data-tour="files.fileTree"]', "This lane's files. Open one to edit it and see its diff.")),
  },
  {
    id: "prs", group: "git", icon: GitPullRequest, title: "Pull requests",
    sentence: "Checks, reviews and merges for this project, without opening GitHub.",
    action: page("/prs", at('[data-tour="prs.list"]', "Every PR in this project, with its checks and reviews.")),
  },
  {
    id: "pr-watch", group: "git", icon: Eye, title: "PR watch",
    sentence: "A chat can watch its PR and wake up on new reviews and failed checks.",
    action: inAChat("Open a chat that made a PR: Watch sits beside the PR in its header.", FIRST_CHAT),
  },
  {
    id: "stacked-prs", group: "git", icon: StackSimple, title: "Stacked PRs",
    sentence: "Build PRs on top of each other, and merge them in order.",
    action: page(
      "/prs",
      at('[data-tour="prs.createBtn"]', "Create a PR and pick another lane's branch as its base to stack it."),
      at('[data-tour="prs.list"]', "Stacked PRs show here, each on the branch below it."),
    ),
  },
  {
    id: "history", group: "git", icon: GitBranch, title: "History graph",
    sentence: "Every branch and commit in this project, drawn as one graph.",
    action: page(
      "/history",
      spot("history-graph", "Every branch and commit in this project, as one graph."),
      at('[data-tour="history.entries"]', "Everything that happened in this project, newest first."),
      spot("history-lane-picker", "Pick a lane to draw its branches and commits."),
    ),
  },
  {
    id: "deep-links", group: "git", icon: LinkSimple, title: "Deep links",
    sentence: "Share a link to a chat, file or PR that opens right there in ADE.",
    action: inAChat("Right-click a chat to copy its deep link.", FIRST_CHAT),
  },

  // Make it yours
  {
    id: "home-widgets", group: "yours", icon: SquaresFour, title: "Home screen widgets",
    sentence: "Pick the widgets on your home screen, their sizes and their order.",
    action: { place: { kind: "go", to: "home" }, spots: [spot("home-customize", "Customize: add, move and resize widgets.")] },
  },
  {
    id: "themes", group: "yours", icon: Palette, title: "Themes and backgrounds",
    sentence: "Choose a theme, your own colours and fonts, and a picture behind ADE.",
    action: setting("appearance.theme", "Pick a theme. Your own colours, fonts and backgrounds are further down."),
  },
  {
    id: "music", group: "yours", icon: MusicNotes, title: "Music",
    sentence: "Play, pause and skip what you are listening to without leaving ADE.",
    action: {
      place: { kind: "music" },
      spots: [
        spot("music-player", "Play, pause and skip here, or from the top bar."),
        spot("music-connect", "Connect your music app, then play it from here or the top bar."),
        spot("music-setup", "Set up your music app here first."),
        spot("music-page", "Connect your music app, then play it from here or the top bar."),
      ],
    },
  },
  {
    id: "grid-view", group: "yours", icon: GridFour, title: "Grid view",
    sentence: "Watch several chats work side by side in Work.",
    action: page("/work", spot("work-focus", "Turn on Focus, then its grid half shows running chats side by side.")),
  },

  // Safety
  {
    id: "secrets", group: "safety", icon: LockKey, title: "ADE secrets",
    sentence: "Keep this project's API keys encrypted, where agents can use them without pasting them into chat.",
    action: setting("secrets.secrets", "Add this project's keys here. Agents use them without seeing them in chat."),
  },
  {
    id: "proof", group: "safety", icon: FilmStrip, title: "Proof",
    sentence: "Agents file screenshots and videos of what they did, next to the chat.",
    action: inAChat(
      "Open a chat: what its agent files as proof is in the progress drawer in its header.",
      FIRST_CHAT,
      spot("chat-actions", "This chat's progress: screenshots and videos its agent filed as proof."),
    ),
  },
  {
    id: "private-desktop", group: "safety", icon: AppWindow, title: "A private desktop for agents",
    sentence: "Agents drive apps on their own Mac or Windows screen, so yours stays free.",
    action: inAChat(
      "Open a chat, then its Tools: agents get a desktop of their own there.",
      "Start a chat; its Tools pane gives agents a desktop of their own.",
      spot("tools-pane", "Agents get a desktop of their own here, so your screen stays free."),
      spot("tools-toggle", "Open Tools: agents get a desktop of their own there."),
    ),
  },
];

export function tipsInGroup(group: AdeTipGroupId): AdeTip[] {
  return ADE_TIPS.filter((tip) => tip.group === group);
}

export function adeTipGroup(id: AdeTipGroupId): AdeTipGroup {
  return ADE_TIP_GROUPS.find((group) => group.id === id) ?? ADE_TIP_GROUPS[0]!;
}

/**
 * Whether a tip's "Try it" can run in this window. Pages of a project work
 * with none open too: they go Home and point at the projects first. The
 * Connections panel and Music live only in the desktop app.
 */
export function tipActionAvailable(action: AdeTipAction | undefined): boolean {
  if (!action) return false;
  if (action.place.kind === "connections") return !isWebClientMode();
  if (action.place.kind === "music") return !isWebClientMode() && musicTabAvailable();
  if (action.settingId) {
    const entry = settingsEntryById(action.settingId);
    return entry != null && isSettingAvailable(entry);
  }
  return true;
}

/** Where a page-of-a-project tip sends someone with no project open. */
const OPEN_PROJECT_SPOTS: readonly SpotlightSpot[] = [
  spot("project-row", "Open a project first, then try it again from ADE Tips."),
  spot("add-project", "Add a project first, then try it again from ADE Tips."),
];

/** How long Try it waits for Work's chat list before giving up on opening a chat. */
const CHAT_LIST_WAIT_MS = 4_000;

/**
 * With a chat already open on Work, nothing; else opens the newest chat in
 * Work's list the way a click does (its row is the control that selects).
 * Resolves true once a chat is open, false when there is none to open.
 */
function openNewestChat(): Promise<boolean> {
  // A chat with messages on screen; a new-chat draft has an empty list.
  const chatOpen = () => document.querySelector("[data-chat-user-message-card], [data-thread-comment-key]") != null;
  const firstRow = () => document.querySelector<HTMLElement>(`${anchorSelector("session-row")}:not([aria-disabled="true"])`);
  return new Promise((resolve) => {
    let done = false;
    let timer = 0;
    const observer = new MutationObserver(() => check());
    const finish = (opened: boolean) => {
      if (done) return;
      done = true;
      observer.disconnect();
      window.clearTimeout(timer);
      resolve(opened);
    };
    const check = () => {
      if (done) return;
      if (chatOpen()) return finish(true);
      const row = firstRow();
      if (!row) return;
      row.click();
      finish(true);
    };
    observer.observe(document.body, { childList: true, subtree: true });
    timer = window.setTimeout(() => finish(false), CHAT_LIST_WAIT_MS);
    // Work may still be routing in: look once it has had a frame.
    window.requestAnimationFrame(check);
  });
}

/**
 * "Try it": go where the tip lives, then ring the control there. `goTo` is
 * `useGoTo()` from the calling component. Front-window navigation only; no
 * call reaches a machine.
 */
export function runTipAction(action: AdeTipAction, goTo: (destination: GoToDestination) => void, hasProject: boolean): void {
  const { place } = action;
  if (place.kind === "connections") {
    openConnectionsPanel(place.tab);
    showSpotlight({ spots: action.spots });
    return;
  }
  if (place.kind === "music") {
    musicActions.open();
    showSpotlight({ spots: action.spots });
    return;
  }
  if (place.kind === "chat") {
    if (!hasProject) {
      goTo("home");
      showSpotlight({ spots: OPEN_PROJECT_SPOTS });
      return;
    }
    goTo("/work");
    // With a chat open, only its message: "Start a chat first" would be wrong.
    void openNewestChat().then((opened) => showSpotlight({
      spots: opened ? action.spots.slice(0, 2) : [action.spots[0]!, ...action.spots.slice(2)],
      waitMs: 6_000,
    }));
    return;
  }
  if (place.to !== "home" && !hasProject) {
    goTo("home");
    showSpotlight({ spots: OPEN_PROJECT_SPOTS });
    return;
  }
  goTo(place.to);
  // A new chat takes a moment: Work may restore the last chat first.
  if (place.to === "draft") showSpotlight({ spots: action.spots, ready: onDraftPage, waitMs: 6_000 });
  else showSpotlight({ spots: action.spots });
}

/**
 * Today's tip: the same all day, so a home screen left open does not flicker
 * between tips, and a different one tomorrow.
 */
export function tipIndexForDay(dayStartMs: number, count: number): number {
  if (count <= 0) return 0;
  // The local calendar day, counted from the epoch (daylight saving moves
  // local midnight by an hour; the calendar date does not).
  const date = new Date(dayStartMs);
  const day = Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
  return ((day % count) + count) % count;
}

/**
 * Every tip in this computer's own random order: a seed made once per
 * computer (this renderer's storage, never synced), so two machines rotate
 * through tips differently while each keeps a stable order. The Home widget
 * steps through it by day; tip cards offer the next one not seen yet.
 */
const TIP_ORDER_SEED_KEY = "ade.tips.orderSeed.v1";
let machineOrder: readonly AdeTip[] | null = null;

function tipOrderSeed(): number {
  try {
    const stored = Number(window.localStorage.getItem(TIP_ORDER_SEED_KEY));
    if (Number.isInteger(stored) && stored > 0) return stored;
    const seed = 1 + Math.floor(Math.random() * 0x7fff_fffe);
    window.localStorage.setItem(TIP_ORDER_SEED_KEY, String(seed));
    return seed;
  } catch {
    return 1 + Math.floor(Math.random() * 0x7fff_fffe);
  }
}

export function machineTipOrder(): readonly AdeTip[] {
  if (machineOrder) return machineOrder;
  // mulberry32: a small seeded generator, so the shuffle is the same every launch.
  let state = tipOrderSeed() >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const order = [...ADE_TIPS];
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    [order[index], order[swap]] = [order[swap]!, order[index]!];
  }
  machineOrder = order;
  return order;
}
