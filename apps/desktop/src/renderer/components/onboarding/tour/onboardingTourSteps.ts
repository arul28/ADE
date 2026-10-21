import { ONBOARDING_ANCHOR_ATTR } from "../../../onboarding/onboardingProgress";

/**
 * The guided tour, in order. Each step points at a real control, marked with
 * `data-onboarding-anchor="<anchor>"` where it renders; the host finds the
 * first one on screen.
 *
 * - `advance: "click"`: the step asks the user to click the control, and the
 *   click moves the tour on (the card still has Next, so nobody is stuck).
 * - `advance: "next"`: the card's Next moves on.
 * - `place`: where the card sits around the control, first fit wins.
 * - `goTo`: what "Show me" on the paused pill does when the control is not on
 *   screen (the user went elsewhere). Steps without one wait for the user.
 * - `skipIf`: checked while the control is missing; true moves past the step
 *   (no chats to open, the pane is already open, already on a new chat).
 */

export type TourPlace = "above" | "below" | "right" | "left";
export type TourDestination = "draft" | "work" | "home";

export type TourStepDef = {
  id: string;
  anchors: readonly string[];
  title: string;
  line: string;
  advance: "click" | "next";
  /** For click steps: what the card asks for ("Click New chat"). */
  clickLabel?: string;
  place: readonly TourPlace[];
  /** Where the control lives, for "Show me". */
  goTo?: TourDestination;
  /** Where to send the user, said on the paused pill ("Back to Work"). */
  where: string;
  skipIf?: () => boolean;
};

const anchorPresent = (id: string) => document.querySelector(`[${ONBOARDING_ANCHOR_ATTR}="${id}"]`) != null;
const onDraftPage = () => document.querySelector("[data-work-draft-surface]") != null;
const toolsPaneOpen = () => document.querySelector("[data-work-tools-pane]") != null;
/** The sessions list is up and empty: nothing to open. */
const noChatsToOpen = () => anchorPresent("session-list") && !anchorPresent("session-row");

export const TOUR_STEPS: readonly TourStepDef[] = [
  {
    id: "lanes",
    anchors: ["lane-picker"],
    title: "ADE works in lanes",
    line: "This chat runs in your primary lane: the checkout you already have. New work can get its own lane, a git worktree on its own branch, so agents never step on each other.",
    advance: "next",
    place: ["below", "right", "above"],
    goTo: "draft",
    where: "a new chat",
  },
  {
    id: "composer",
    anchors: ["composer"],
    title: "Tell an agent what to do",
    line: "Type @ to bring in files, other chats, a subagent or another machine. Type / for commands.",
    advance: "next",
    place: ["above", "below"],
    goTo: "draft",
    where: "a new chat",
  },
  {
    id: "composer-controls",
    anchors: ["composer-controls"],
    title: "Permissions, model and effort",
    line: "Choose how much the agent may do before it asks you, which model runs, and how hard it thinks.",
    advance: "next",
    place: ["below", "above", "right"],
    goTo: "draft",
    where: "a new chat",
  },
  {
    id: "lane-menu-open",
    anchors: ["lane-picker"],
    title: "Start work in a new lane",
    line: "Open the lane menu to pick where this chat runs.",
    advance: "click",
    clickLabel: "Click the lane",
    place: ["below", "right", "above"],
    goTo: "draft",
    where: "a new chat",
  },
  {
    id: "lane-menu",
    anchors: ["lane-picker-menu"],
    title: "Pick or create a lane",
    line: "Every lane on this project, on every machine. + creates a new one; Auto-create lane makes one for the chat when you send it.",
    advance: "next",
    place: ["right", "left", "above", "below"],
    where: "the lane menu",
    // The menu closed (the user picked a lane or clicked away): carry on.
    skipIf: () => !anchorPresent("lane-picker-menu"),
  },
  {
    id: "import-chats",
    anchors: ["import-pill", "import-button"],
    title: "Bring your other chats",
    line: "Continue chats from Claude Code, Codex, Cursor and more in ADE, each in the lane it ran in.",
    advance: "next",
    place: ["above", "below", "right"],
    goTo: "draft",
    where: "a new chat",
  },
  {
    id: "sidebar",
    anchors: ["session-list"],
    title: "Every chat, every lane",
    line: "Chats, CLIs and terminals from all your lanes and machines live here, newest first.",
    advance: "next",
    place: ["right", "below"],
    goTo: "work",
    where: "Work",
  },
  {
    id: "open-chat",
    anchors: ["session-row"],
    title: "Open a chat",
    line: "Click a chat to pick it up where it left off.",
    advance: "click",
    clickLabel: "Click a chat",
    place: ["right", "below"],
    goTo: "work",
    where: "Work",
    skipIf: noChatsToOpen,
  },
  {
    id: "tools-toggle",
    anchors: ["tools-toggle"],
    title: "Open the Tools pane",
    line: "Every chat has tools beside it, for the same lane the agent works in.",
    advance: "click",
    clickLabel: "Click to open it",
    place: ["below", "left"],
    goTo: "work",
    where: "a chat",
    skipIf: () => toolsPaneOpen() || onDraftPage(),
  },
  {
    id: "tools-pane",
    anchors: ["tools-pane"],
    title: "Tools for this lane",
    line: "Terminal, Git, files, a browser, simulators and more. Agents use the same ones, and you can watch them work.",
    advance: "next",
    place: ["left", "below"],
    goTo: "work",
    where: "a chat",
    skipIf: () => !toolsPaneOpen(),
  },
  {
    id: "back-to-new-chat",
    anchors: ["new-chat"],
    title: "Back to a new chat",
    line: "Start the next piece of work from here, in a new lane or this one.",
    advance: "click",
    clickLabel: "Click New chat",
    place: ["right", "below"],
    goTo: "work",
    where: "Work",
    skipIf: onDraftPage,
  },
  {
    id: "new-tab",
    anchors: ["new-tab"],
    title: "Open another project",
    line: "Each project gets its own tab, including projects on your other machines.",
    advance: "click",
    clickLabel: "Click + for a new tab",
    place: ["below", "left"],
    where: "the top bar",
  },
  {
    id: "home-customize",
    anchors: ["home-customize"],
    title: "Your home page",
    line: "Widgets for what's going on everywhere: chats that need you, usage, PRs and tips. Make the page yours from here.",
    advance: "click",
    clickLabel: "Click to customize",
    place: ["below", "left"],
    goTo: "home",
    where: "Home",
    // Already editing: the tools step covers it.
    skipIf: () => anchorPresent("home-edit-tools"),
  },
  {
    id: "home-edit-tools",
    anchors: ["home-edit-tools"],
    title: "Add, move and resize",
    line: "Add widgets, pick a card look, save layouts. Drag a widget to move it and pull its corner to resize.",
    advance: "next",
    place: ["below", "left"],
    goTo: "home",
    where: "Home",
    // Editing ended (Done): carry on.
    skipIf: () => anchorPresent("home-customize"),
  },
  {
    id: "connections",
    anchors: ["connections"],
    title: "Work from every computer",
    line: "Connect your other machines and your phone here. Their lanes and chats show up right beside these.",
    advance: "click",
    clickLabel: "Click Connections",
    place: ["below", "left"],
    where: "the top bar",
  },
];
