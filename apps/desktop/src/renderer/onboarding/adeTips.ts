import {
  AppWindow,
  AppleLogo,
  ArrowsLeftRight,
  At,
  Bell,
  Binoculars,
  Brain,
  CalendarCheck,
  ChatCenteredText,
  ChatsCircle,
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
  Screencast,
  ShieldCheck,
  SquaresFour,
  StackSimple,
  SteeringWheel,
  TerminalWindow,
  Toolbox,
  UserSwitch,
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
import automationsShot from "../components/onboarding/tips/assets/automations.webp";
import awakeShot from "../components/onboarding/tips/assets/awake.webp";
import commentsShot from "../components/onboarding/tips/assets/comments.webp";
import ctoShot from "../components/onboarding/tips/assets/cto.webp";
import filesShot from "../components/onboarding/tips/assets/files.webp";
import gridShot from "../components/onboarding/tips/assets/grid.webp";
import historyShot from "../components/onboarding/tips/assets/history.webp";
import importShot from "../components/onboarding/tips/assets/import.webp";
import integrationsShot from "../components/onboarding/tips/assets/integrations.webp";
import lanesShot from "../components/onboarding/tips/assets/lanes.webp";
import machinesShot from "../components/onboarding/tips/assets/machines.webp";
import mcpShot from "../components/onboarding/tips/assets/mcp.webp";
import proofShot from "../components/onboarding/tips/assets/proof.webp";
import prsShot from "../components/onboarding/tips/assets/prs.webp";
import secretsShot from "../components/onboarding/tips/assets/secrets.webp";
import sideChatShot from "../components/onboarding/tips/assets/side-chat.webp";
import iosSimulatorShot from "../components/onboarding/tips/assets/ios-simulator.webp";
import phoneSimulatorShot from "../components/onboarding/tips/assets/phone-simulator.webp";
import themesShot from "../components/onboarding/tips/assets/themes.webp";
import widgetsShot from "../components/onboarding/tips/assets/widgets.webp";

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
 *
 * ADE Tips lays each group out as a wall of tiles (`TipTileSize`).
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

/**
 * How a tip sits on its group's wall in ADE Tips, after the group's own tile
 * (2×1): a `screen` tile (2×2) carries a screenshot of the real app (`shot`,
 * which its tip card shows too); `wide` is 2×1, and can carry a `shot` at its
 * right edge; `small` is 1×1. `ADE_TIPS`
 * lists each group's tips in wall order.
 *
 * The sizes are chosen so every group packs with no holes in both of the
 * dialog's grids: four columns (cells add up to a multiple of four and the
 * order fills each row) and two (an even number of small tiles). Change a
 * size or the order, recount.
 *
 * Screenshots are the real app with mock data: the landing page's wall
 * (`apps/web/public/images/home/wall`) plus a few taken from the browser
 * preview. Vite hashes them; tiles load them lazily, only for the group on
 * screen.
 */
type TipTileSize = "screen" | "wide" | "small";

type TipShot = { src: string; alt: string };

type AdeTipEntry = {
  id: string;
  group: AdeTipGroupId;
  title: string;
  /** One sentence: what it is and why you would want it. */
  sentence: string;
  icon: Icon;
  action?: AdeTipAction;
} & ({ size: "screen"; shot: TipShot } | { size: Extract<TipTileSize, "wide">; shot?: TipShot } | { size: Extract<TipTileSize, "small">; shot?: undefined });

type AdeTipId = (typeof TIP_LIST)[number]["id"];

export type AdeTip = AdeTipEntry & { id: AdeTipId };

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

/** The composer of a chat that already has a conversation; a new chat's composer does not count. */
const inChatComposer = (label: string): SpotlightSpot =>
  at(`body:has([data-chat-user-message-card]) ${anchorSelector("composer")}`, label);

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

const TIP_LIST = [
  // Agents
  {
    id: "import-chats", group: "agents", icon: DownloadSimple, title: "Import your chats",
    size: "screen", shot: { src: importShot, alt: "The import window: past Claude, Codex and Cursor chats on this computer" },
    sentence: "Bring in past chats from Claude Code, Codex, Cursor and more, and keep going in ADE.",
    action: draft(
      spot("import-pill", "Import past chats from Claude Code, Codex, Cursor and more."),
      spot("import-button", "Import past chats from Claude Code, Codex, Cursor and more."),
    ),
  },
  {
    id: "at-menu", group: "agents", icon: At, title: "The @ menu", size: "wide",
    sentence: "Type @ in the composer to hand part of a task to another model as a subagent, or to another machine.",
    action: draft(spot("composer", "Type @ to hand part of the task to a subagent, or to another machine.")),
  },
  {
    id: "chat-tools", group: "agents", icon: Toolbox, title: "Chat tools", size: "wide",
    sentence: "Agents can use the ADE browser, drive your app and run ADE itself, so they can check their own work.",
    action: inAChat(
      "Open a chat, then its Tools: the browser and app controls agents use too.",
      "Start a chat; its Tools pane holds the browser and app controls agents use.",
      spot("tools-pane", "This chat's tools. Agents use the same browser and app controls."),
      spot("tools-toggle", "Open Tools: the browser and app controls agents use too."),
    ),
  },
  {
    id: "comments", group: "agents", icon: ChatCenteredText, title: "Comments on replies",
    size: "screen", shot: { src: commentsShot, alt: "A comment on a line of an agent's reply, set to send with the next message" },
    sentence: "Comment on any part of a reply, then send your comments to the chat.",
    action: inOpenChat(
      at("[data-thread-comment-key]", "Select a few words in this reply, then pick Comment."),
      "This chat has no reply yet. In a chat with one, select a few words of the reply and pick Comment.",
    ),
  },
  {
    id: "handoff", group: "agents", icon: ArrowsLeftRight, title: "Hand off a chat", size: "small",
    sentence: "Move a chat to another model or machine and keep everything it knows.",
    action: inAChat("Right-click a chat and pick Hand off.", FIRST_CHAT),
  },
  {
    id: "rewind", group: "agents", icon: ClockCounterClockwise, title: "Rewind files", size: "small",
    sentence: "Undo an agent's file edits back to any message in the chat.",
    action: inOpenChat(
      at("[data-chat-user-message-card]", "Hover your message: after a turn that changed files, the ↶ button in its corner puts them back."),
      "Hover one of your messages: after a turn that changed files, ↶ in its corner puts them back.",
    ),
  },
  {
    id: "scenes", group: "agents", icon: PresentationChart, title: "Scenes", size: "small",
    sentence: "Agents can answer with live charts, views and small forms right in the chat.",
    action: draft(spot("composer", "Ask for a chart, a table or a small form; the agent can answer with a live scene.")),
  },
  {
    id: "voice", group: "agents", icon: Microphone, title: "Voice", size: "small",
    sentence: "Dictate a prompt, or talk with an agent out loud.",
    action: setting("chat.voice-conversations", "Turn voice on here, then talk from any chat's composer."),
  },
  {
    id: "cli-chats", group: "agents", icon: TerminalWindow, title: "CLI chats", size: "wide",
    sentence: "Run the same agents in a terminal when you prefer their own interface, with ADE's lanes around them.",
    action: draft(spot("draft-mode-switch", "Pick CLI to run an agent in its own terminal interface.")),
  },
  {
    id: "side-chats", group: "agents", icon: ChatsCircle, title: "Side chats",
    size: "screen", shot: { src: sideChatShot, alt: "A read-only side chat beside the main chat, sending a note back to it" },
    sentence: "Type /side to ask a quick question in a read-only side chat that already knows the conversation.",
    action: inOpenChat(
      inChatComposer("Type /side and your question. The side chat knows this conversation and changes nothing."),
      "Once this chat has a conversation, type /side and your question here.",
    ),
  },
  {
    id: "steer", group: "agents", icon: SteeringWheel, title: "Steer a running turn", size: "small",
    sentence: "Type while an agent works to steer it, or change its effort mid-turn.",
    action: inOpenChat(
      inChatComposer("While the agent works, type here to steer it. The effort chip changes its effort mid-turn."),
      "Once this chat's agent is working, type here to steer it.",
    ),
  },
  {
    id: "terminal-watch", group: "agents", icon: Binoculars, title: "Terminal watch", size: "small",
    sentence: "An agent can watch a terminal and wake up when it prints something new.",
    action: draft(spot("composer", "Ask the agent to watch a terminal, like your dev server. It wakes up when something new prints.")),
  },
  {
    id: "another-account", group: "agents", icon: UserSwitch, title: "Continue on another account", size: "small",
    sentence: "When one account hits its limit, continue the same chat on another.",
    action: setting("agents.providers", "Open a provider and add a second account. A chat that hits its limit can continue on it."),
  },
  {
    id: "custom-provider", group: "agents", icon: ArrowsLeftRight, title: "Any harness on your plan", size: "small",
    sentence: "Run Claude Code on your ChatGPT plan, or Codex on Claude, with the sign-ins you already have.",
    action: setting("agents.harnesses", "Pick a harness and a model you already pay for. It shows up in every model picker."),
  },
  {
    id: "startup-context", group: "agents", icon: Brain, title: "Understand startup context", size: "small",
    sentence: "See what goes into your agent's context when a new chat starts, and where to change it.",
    action: setting("agents.providers", "Open a provider to see its initial context and where each item is configured."),
  },
  {
    id: "ios-simulator", group: "agents", icon: AppleLogo, title: "iOS simulator", size: "wide",
    shot: { src: iosSimulatorShot, alt: "iPhone Duo in the simulator, half open" },
    sentence: "Run your iOS app in a simulator inside ADE, including iPhone Duo with its hinge.",
    action: inAChat(
      "Open a chat, then Tools and Apple Development to run your app in the simulator.",
      "Start a chat; its Tools pane has Apple Development, with the simulator.",
      spot("tools-pane", "Open Apple Development here to run your app in the simulator."),
      spot("tools-toggle", "Open Tools, then Apple Development, to run your app in the simulator."),
    ),
  },
  {
    id: "simulator-on-phone", group: "agents", icon: Screencast, title: "Simulator on your phone", size: "wide",
    shot: { src: phoneSimulatorShot, alt: "An iPhone driving the simulator by touch" },
    sentence: "Stream the simulator to your iPhone and tap it like a real phone.",
    action: connections("mobile", "Pair your iPhone here. Then it can stream the simulator and drive it by touch."),
  },

  // Project brain
  {
    id: "cto", group: "brain", icon: Crown, title: "CTO",
    size: "screen", shot: { src: ctoShot, alt: "The CTO introducing itself in its chat" },
    sentence: "A lead for each project that knows its lanes, PRs and history, and plans work with you.",
    action: page("/cto", spot("composer", "Ask your CTO what to work on next. It knows this project's lanes and PRs.")),
  },
  {
    id: "automations", group: "brain", icon: Lightning, title: "Automations",
    size: "screen", shot: { src: automationsShot, alt: "The automation builder: an issue opens a lane and runs an agent" },
    sentence: "Run an agent on a schedule or when a PR, issue or webhook fires. Start with a template.",
    action: page("/automations", at('[data-tour="automations.createTrigger"]', "Create one: a schedule, a PR, an issue or a webhook starts an agent.")),
  },
  {
    id: "scheduled-sends", group: "brain", icon: CalendarCheck, title: "Scheduled sends", size: "wide",
    sentence: "Write a message now and let ADE send it later, from the composer's send menu.",
    action: draft(
      spot("composer-send-menu", "Write your message, then pick Scheduled send from this menu."),
      spot("composer", "Write your message, then open the send menu beside Send."),
    ),
  },

  // Machines
  {
    id: "connect-machine", group: "machines", icon: DesktopTower, title: "Connect another computer",
    size: "screen", shot: { src: machinesShot, alt: "The Connections panel listing connected, available and offline computers" },
    sentence: "Drive lanes and chats that live on your other machines from this window.",
    action: connections("machines", "Your computers. Connect one to drive its lanes and chats from here."),
  },
  {
    id: "keep-awake", group: "machines", icon: Moon, title: "Keep awake",
    size: "screen", shot: { src: awakeShot, alt: "The keep awake setting: never, while away, or with the lid closed" },
    sentence: "Keep this computer awake so agents keep working while you are away.",
    action: setting("general.keep-awake", "Keep this computer awake while agents work."),
  },
  {
    id: "phone", group: "machines", icon: DeviceMobile, title: "ADE on your phone", size: "wide",
    sentence: "Check on agents and answer them from the iPhone app when you are away.",
    action: connections("mobile", "Pair the iPhone app here."),
  },
  {
    id: "web-app", group: "machines", icon: Globe, title: "The web app", size: "wide",
    sentence: "Control every machine and agent from a browser, the same way as here.",
    action: connections("web", "Turn on the web app here."),
  },
  {
    id: "headless", group: "machines", icon: HardDrives, title: "Headless brain", size: "small",
    sentence: "Run ADE on a server with no screen; once it signs in it joins your other machines.",
    action: connections("machines", "A server running ADE headless shows up here once it signs in."),
  },
  {
    id: "notifications", group: "machines", icon: Bell, title: "Notifications", size: "small",
    sentence: "Hear when an agent needs you, here or on your phone.",
    action: setting("notifications.events", "Pick what reaches you, here and on your phone."),
  },

  // Integrations
  {
    id: "issues", group: "integrations", icon: ListChecks, title: "Linear, GitHub and Jira issues",
    size: "screen", shot: { src: integrationsShot, alt: "Settings, Integrations: GitHub connected, with Linear and Jira beside it" },
    sentence: "Connect your tracker and start a chat straight from an issue.",
    action: setting("integrations.linear", "Connect Linear here. GitHub and Jira sit on the same page."),
  },
  {
    id: "mcp-once", group: "integrations", icon: Plugs, title: "One MCP setup for every agent",
    size: "screen", shot: { src: mcpShot, alt: "Settings, MCP servers found on this computer, ready to import" },
    sentence: "Add an MCP server once and every ADE agent gets it, on every computer.",
    action: setting("mcp.servers", "Add a server once; every agent gets it, on every computer."),
  },
  {
    id: "cloud-agents", group: "integrations", icon: Cloud, title: "Cursor and Devin cloud agents", size: "small",
    sentence: "Once Cursor or Devin is connected, their cloud agents show in the top bar for this project.",
    action: setting("agents.providers", "Connect Cursor or Devin here."),
  },
  {
    id: "ade-mcp", group: "integrations", icon: Plug, title: "ADE MCP", size: "small",
    sentence: "Connect AI apps to ADE across your computers, with interactive views in supported apps.",
    action: setting("ade-mcp.server", "Let other AI apps use ADE on your computers."),
  },

  // Git
  {
    id: "lanes", group: "git", icon: GitFork, title: "Lanes",
    size: "screen", shot: { src: lanesShot, alt: "A lane: its branch, its commit ahead of main, and the chat that made it" },
    sentence: "Each piece of work gets its own worktree and branch, so agents never step on each other.",
    action: page("/lanes", at('[data-tour="lanes.newLane"]', "New lane: a worktree on its own branch, for one piece of work.")),
  },
  {
    id: "prs", group: "git", icon: GitPullRequest, title: "Pull requests",
    size: "screen", shot: { src: prsShot, alt: "A pull request with its description, branch and checks" },
    sentence: "Checks, reviews and merges for this project, without opening GitHub.",
    action: page("/prs", at('[data-tour="prs.list"]', "Every PR in this project, with its checks and reviews.")),
  },
  {
    id: "history", group: "git", icon: GitBranch, title: "History graph",
    size: "screen", shot: { src: historyShot, alt: "The history graph across lanes, with a commit selected" },
    sentence: "Every branch and commit in this project, drawn as one graph.",
    action: page(
      "/history",
      spot("history-graph", "Every branch and commit in this project, as one graph."),
      at('[data-tour="history.entries"]', "Everything that happened in this project, newest first."),
      spot("history-lane-picker", "Pick a lane to draw its branches and commits."),
    ),
  },
  {
    id: "files", group: "git", icon: FileCode, title: "Files",
    size: "screen", shot: { src: filesShot, alt: "The file editor on a lane, beside the project's files" },
    sentence: "Edit every lane's files with a diff for each change; Word, Excel, PowerPoint and diagrams open the way they look.",
    action: page("/files", at('[data-tour="files.fileTree"]', "This lane's files. Open one to edit it and see its diff.")),
  },
  {
    id: "pr-watch", group: "git", icon: Eye, title: "PR watch", size: "wide",
    sentence: "A chat can watch its PR and wake up on new reviews and failed checks.",
    action: inAChat("Open a chat that made a PR: Watch sits beside the PR in its header.", FIRST_CHAT),
  },
  {
    id: "stacked-prs", group: "git", icon: StackSimple, title: "Stacked PRs", size: "wide",
    sentence: "Build PRs on top of each other, and merge them in order.",
    action: page(
      "/prs",
      at('[data-tour="prs.createBtn"]', "Create a PR and pick another lane's branch as its base to stack it."),
      at('[data-tour="prs.list"]', "Stacked PRs show here, each on the branch below it."),
    ),
  },
  {
    id: "deep-links", group: "git", icon: LinkSimple, title: "Deep links", size: "wide",
    sentence: "Share a link to a chat, file or PR that opens right there in ADE.",
    action: inAChat("Right-click a chat to copy its deep link.", FIRST_CHAT),
  },

  // Make it yours
  {
    id: "home-widgets", group: "yours", icon: SquaresFour, title: "Home screen widgets",
    size: "screen", shot: { src: widgetsShot, alt: "The home page: projects, pull requests, weather and contributions" },
    sentence: "Pick the widgets on your home screen, their sizes and their order.",
    action: { place: { kind: "go", to: "home" }, spots: [spot("home-customize", "Customize: add, move and resize widgets.")] },
  },
  {
    id: "themes", group: "yours", icon: Palette, title: "Themes and backgrounds",
    size: "screen", shot: { src: themesShot, alt: "Appearance settings: the theme gallery and a live preview" },
    sentence: "Choose a theme, your own colours and fonts, and a picture behind ADE, or shuffle pictures sized for your screen.",
    action: setting("appearance.theme", "Pick a theme. Your own colours, fonts and backgrounds are further down."),
  },
  {
    id: "grid-view", group: "yours", icon: GridFour, title: "Grid view",
    size: "screen", shot: { src: gridShot, alt: "Two chats side by side in the grid view" },
    sentence: "Watch several chats work side by side in Work.",
    action: page("/work", spot("work-focus", "Turn on Focus, then its grid half shows running chats side by side.")),
  },
  {
    id: "music", group: "yours", icon: MusicNotes, title: "Music", size: "wide",
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

  // Safety
  {
    id: "proof", group: "safety", icon: FilmStrip, title: "Proof",
    size: "screen", shot: { src: proofShot, alt: "An agent's reply with the screenshot it filed as proof" },
    sentence: "Agents file screenshots and videos of what they did, next to the chat.",
    action: inAChat(
      "Open a chat: what its agent files as proof is in the progress drawer in its header.",
      FIRST_CHAT,
      spot("chat-actions", "This chat's progress: screenshots and videos its agent filed as proof."),
    ),
  },
  {
    id: "secrets", group: "safety", icon: LockKey, title: "ADE secrets",
    size: "screen", shot: { src: secretsShot, alt: "Settings, Secrets: three encrypted keys saved for this project" },
    sentence: "Keep this project's API keys encrypted, where agents can use them without pasting them into chat.",
    action: setting("secrets.secrets", "Add this project's keys here. Agents use them without seeing them in chat."),
  },
  {
    id: "private-desktop", group: "safety", icon: AppWindow, title: "A private desktop for agents", size: "wide",
    sentence: "Agents drive apps on their own Mac, Windows or Linux screen, so yours stays free.",
    action: inAChat(
      "Open a chat, then its Tools: agents get a desktop of their own there.",
      "Start a chat; its Tools pane gives agents a desktop of their own.",
      spot("tools-pane", "Agents get a desktop of their own here, so your screen stays free."),
      spot("tools-toggle", "Open Tools: agents get a desktop of their own there."),
    ),
  },
] as const satisfies readonly AdeTipEntry[];

/** Every tip, group by group, each group in its wall order. */
export const ADE_TIPS: readonly AdeTip[] = TIP_LIST;

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
