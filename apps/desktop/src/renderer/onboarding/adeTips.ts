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
  FilmStrip,
  GitBranch,
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
import { settingsRouteFor } from "../components/settings/settingsManifest";

/**
 * ADE Tips: the things worth knowing about ADE, browsable from the help menu
 * and the home screen, never pushed. Tier 2 of onboarding (tier 1 is the
 * first-run flow, tier 3 the situational suggestions in
 * `adeTipsSuggestions.ts`, which land here when the user says "Not now").
 *
 * Each tip is one plain sentence: what it is and why you would want it. An
 * action opens the real surface; a tip whose surface lives inside a chat (the
 * @ menu, rewind) has none rather than a guess.
 */

export type AdeTipGroupId = "agents" | "brain" | "machines" | "integrations" | "git" | "yours" | "safety";

export type AdeTipGroup = { id: AdeTipGroupId; label: string; icon: Icon };

export const ADE_TIP_GROUPS: readonly AdeTipGroup[] = [
  { id: "agents", label: "Agents", icon: Robot },
  { id: "brain", label: "Project brain", icon: Brain },
  { id: "machines", label: "Machines", icon: Laptop },
  { id: "integrations", label: "Integrations", icon: PlugsConnected },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "yours", label: "Make it yours", icon: PaintBrush },
  { id: "safety", label: "Safety", icon: ShieldCheck },
];

export type AdeTipAction =
  /** A route in the open project (a page, or a Settings anchor). */
  | { kind: "route"; to: string }
  /** The top bar's Connections panel, on one of its tabs. Desktop only. */
  | { kind: "connections"; tab: ConnectionsPanelTab };

export type AdeTip = {
  id: string;
  group: AdeTipGroupId;
  title: string;
  /** One sentence: what it is and why you would want it. */
  sentence: string;
  icon: Icon;
  action?: AdeTipAction;
};

const route = (to: string): AdeTipAction => ({ kind: "route", to });
const setting = (entryId: string): AdeTipAction => route(settingsRouteFor(entryId));
const connections = (tab: ConnectionsPanelTab): AdeTipAction => ({ kind: "connections", tab });

export const ADE_TIPS: readonly AdeTip[] = [
  // Agents
  { id: "chat-tools", group: "agents", icon: Toolbox, title: "Chat tools", sentence: "Agents can use the ADE browser, drive your app and run ADE itself, so they can check their own work." },
  { id: "at-menu", group: "agents", icon: At, title: "The @ menu", sentence: "Type @ in the composer to hand part of a task to another model as a subagent, or to another machine." },
  { id: "handoff", group: "agents", icon: ArrowsLeftRight, title: "Hand off a chat", sentence: "Move a chat to another model or machine and keep everything it knows." },
  { id: "rewind", group: "agents", icon: ClockCounterClockwise, title: "Rewind files", sentence: "Undo an agent's file edits back to any message in the chat." },
  { id: "comments", group: "agents", icon: ChatCenteredText, title: "Comments on replies", sentence: "Comment on any part of a reply, then send your comments to the chat." },
  { id: "scenes", group: "agents", icon: PresentationChart, title: "Scenes", sentence: "Agents can answer with live charts, views and small forms right in the chat." },
  { id: "voice", group: "agents", icon: Microphone, title: "Voice", sentence: "Dictate a prompt, or talk with an agent out loud.", action: setting("chat.voice-conversations") },
  { id: "cli-chats", group: "agents", icon: TerminalWindow, title: "CLI chats", sentence: "Run the same agents in a terminal when you prefer their own interface, with ADE's lanes around them." },
  { id: "import-chats", group: "agents", icon: DownloadSimple, title: "Import your chats", sentence: "Bring in past chats from Claude Code, Codex, Cursor and more, and keep going in ADE." },

  // Project brain
  { id: "cto", group: "brain", icon: Crown, title: "CTO", sentence: "A lead for each project that knows its lanes, PRs and history, and plans work with you.", action: route("/cto") },
  { id: "automations", group: "brain", icon: Lightning, title: "Automations", sentence: "Run an agent on a schedule, or when a PR, an issue or a webhook fires.", action: route("/automations") },
  { id: "scheduled-sends", group: "brain", icon: CalendarCheck, title: "Scheduled sends", sentence: "Write a message now and let ADE send it later, from the composer's send menu." },

  // Machines
  { id: "connect-machine", group: "machines", icon: DesktopTower, title: "Connect another computer", sentence: "Drive lanes and chats that live on your other machines from this window.", action: connections("machines") },
  { id: "phone", group: "machines", icon: DeviceMobile, title: "ADE on your phone", sentence: "Check on agents and answer them from the iPhone app when you are away.", action: connections("mobile") },
  { id: "web-app", group: "machines", icon: Globe, title: "The web app", sentence: "Control every machine and agent from a browser, the same way as here.", action: connections("web") },
  { id: "headless", group: "machines", icon: HardDrives, title: "Headless brain", sentence: "Run ADE on a server with no screen; once it signs in it joins your other machines." },
  { id: "keep-awake", group: "machines", icon: Moon, title: "Keep awake", sentence: "Keep this computer awake so agents keep working while you are away.", action: setting("general.keep-awake") },
  { id: "notifications", group: "machines", icon: Bell, title: "Notifications", sentence: "Hear when an agent needs you, here or on your phone.", action: setting("notifications.events") },

  // Integrations
  { id: "issues", group: "integrations", icon: ListChecks, title: "Linear, GitHub and Jira issues", sentence: "Connect your tracker and start a chat straight from an issue.", action: setting("integrations.linear") },
  { id: "cloud-agents", group: "integrations", icon: Cloud, title: "Cursor and Devin cloud agents", sentence: "Once Cursor or Devin is connected, their cloud agents show in the top bar for this project.", action: setting("agents.providers") },
  { id: "ade-mcp", group: "integrations", icon: Plug, title: "ADE MCP", sentence: "Let ChatGPT, claude.ai and other AI apps use ADE on this computer.", action: setting("ade-mcp.server") },
  { id: "mcp-once", group: "integrations", icon: Plugs, title: "One MCP setup for every agent", sentence: "Add an MCP server once and every ADE agent gets it, on every computer.", action: setting("mcp.servers") },

  // Git
  { id: "prs", group: "git", icon: GitPullRequest, title: "Pull requests", sentence: "Checks, reviews and merges for this project, without opening GitHub.", action: route("/prs") },
  { id: "pr-watch", group: "git", icon: Eye, title: "PR watch", sentence: "A chat can watch its PR and wake up on new reviews and failed checks." },
  { id: "stacked-prs", group: "git", icon: StackSimple, title: "Stacked PRs", sentence: "Build PRs on top of each other, and merge them in order.", action: route("/prs") },
  { id: "history", group: "git", icon: GitBranch, title: "History graph", sentence: "Every branch and commit in this project, drawn as one graph.", action: route("/history") },
  { id: "deep-links", group: "git", icon: LinkSimple, title: "Deep links", sentence: "Share a link to a chat, file or PR that opens right there in ADE." },

  // Make it yours
  { id: "home-widgets", group: "yours", icon: SquaresFour, title: "Home screen widgets", sentence: "Pick the widgets on your home screen, their sizes and their order." },
  { id: "themes", group: "yours", icon: Palette, title: "Themes and backgrounds", sentence: "Choose a theme, your own colours and fonts, and a picture behind ADE.", action: setting("appearance.theme") },
  { id: "music", group: "yours", icon: MusicNotes, title: "Music", sentence: "Play, pause and skip what you are listening to without leaving ADE." },
  { id: "grid-view", group: "yours", icon: GridFour, title: "Grid view", sentence: "Watch several chats work side by side in Work." },

  // Safety
  { id: "secrets", group: "safety", icon: LockKey, title: "ADE secrets", sentence: "Keep this project's API keys encrypted, where agents can use them without pasting them into chat.", action: setting("secrets.secrets") },
  { id: "proof", group: "safety", icon: FilmStrip, title: "Proof", sentence: "Agents file screenshots and videos of what they did, next to the chat." },
  { id: "private-desktop", group: "safety", icon: AppWindow, title: "A private desktop for agents", sentence: "Agents drive apps on their own Mac or Windows screen, so yours stays free." },
];

export function tipsInGroup(group: AdeTipGroupId): AdeTip[] {
  return ADE_TIPS.filter((tip) => tip.group === group);
}

export function adeTipGroup(id: AdeTipGroupId): AdeTipGroup {
  return ADE_TIP_GROUPS.find((group) => group.id === id) ?? ADE_TIP_GROUPS[0]!;
}

/**
 * Whether a tip's action can run here: routes need an open project (every
 * page they name is a project page), and the Connections panel lives in the
 * desktop top bar.
 */
export function tipActionAvailable(action: AdeTipAction | undefined, context: { hasProject: boolean }): boolean {
  if (!action) return false;
  if (action.kind === "route") return context.hasProject;
  return !isWebClientMode();
}

/** Opens the surface a tip names. */
export function runTipAction(action: AdeTipAction, navigate: (to: string) => void): void {
  if (action.kind === "route") navigate(action.to);
  else openConnectionsPanel(action.tab);
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
