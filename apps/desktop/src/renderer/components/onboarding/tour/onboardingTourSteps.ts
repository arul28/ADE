import { useAppStore } from "../../../state/appStore";
import { anchorShown, findVisibleAnchor, isAnchorVisible } from "./anchorGeometry";

/**
 * The guided tour, in order. Each step points at a real control, marked with
 * `data-onboarding-anchor="<anchor>"` where it renders; the host finds the
 * first one on screen.
 *
 * Two kinds of step, and the card makes the difference plain:
 * - A read step (`advance: "next"`) explains the control. Its card's primary
 *   button is Next.
 * - A do-it step asks for something done with the control: an instruction line
 *   with an icon (`ask`), a ring that pulses, a cursor that clicks, and Next
 *   demoted to "Skip this step". `advance: "click"` moves on when the control
 *   is clicked; `advance: "action"` moves on when its `skipIf` turns true (the
 *   chat was sent, the project opened).
 *
 * - `place`: where the card sits around the control, first fit wins.
 * - `byAnchor`: a different title, line or ask when a step's other anchor is
 *   the one on screen (no projects yet: "Add project" instead of a row).
 * - `goTo`: what "Show me" on the pill does when the control is not on screen
 *   (the user went elsewhere). Steps without one wait for the user. The tour
 *   never moves the user anywhere on its own; "Show me" is the only way.
 * - `skipIf`: checked whenever the page changes; true moves past the step in
 *   the direction the user was going (no chats to open, the pane is already
 *   open, already on a new chat, the first chat was sent).
 */

export type TourPlace = "above" | "below" | "right" | "left";
export type TourDestination = "draft" | "work" | "home";
export type TourAskIcon = "click" | "send";

export type TourAsk = { label: string; icon: TourAskIcon };

type TourCopy = { title: string; line: string; ask?: TourAsk };

export type TourStepDef = TourCopy & {
  id: string;
  anchors: readonly string[];
  advance: "click" | "action" | "next";
  byAnchor?: Readonly<Record<string, Partial<TourCopy & { place: readonly TourPlace[] }>>>;
  place: readonly TourPlace[];
  /** Where the control lives, for "Show me". */
  goTo?: TourDestination;
  /** Where the control lives, said on the pill ("on a new chat"). */
  where: string;
  skipIf?: () => boolean;
};

/** The id the tour's progress holds while the closing "You're all set" card is up. */
export const TOUR_FINISH_ID = "finish";

/**
 * Whether the user is looking at something: laid out, in the window, and on
 * top. Mounted is not enough: a project tab in the background keeps its pages
 * at zero size, and Work keeps the new chat page mounted under an open chat.
 */
const anchorOnScreen = (id: string) => findVisibleAnchor(id) != null;
const onScreen = (selector: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(selector)).some(isAnchorVisible);
export const onDraftPage = () => onScreen("[data-work-draft-surface]");
const toolsPaneOpen = () => onScreen("[data-work-tools-pane]");
/** The sessions list is up and empty: nothing to open. Rows scrolled out of view still count. */
export const noChatsToOpen = () => anchorShown("session-list") && !anchorShown("session-row");
/** A chat is open (its header has the Tools toggle). */
const inOpenChat = () => anchorOnScreen("tools-toggle");
/** A project is open and on screen (not Home). */
const inProject = () => {
  const state = useAppStore.getState();
  return state.project != null && !state.showWelcome;
};

export function isDoStep(step: TourStepDef): boolean {
  return step.advance !== "next";
}

/** The step's words, and where its card sits, for the anchor on screen. */
export function stepCopy(step: TourStepDef, anchorId: string | null): TourCopy & { place: readonly TourPlace[] } {
  const override = anchorId ? step.byAnchor?.[anchorId] : undefined;
  return {
    title: override?.title ?? step.title,
    line: override?.line ?? step.line,
    ask: override?.ask ?? step.ask,
    place: override?.place ?? step.place,
  };
}

export const TOUR_STEPS: readonly TourStepDef[] = [
  {
    // Setup lands on Home; everything else lives inside a project.
    id: "open-project",
    anchors: ["project-row", "add-project"],
    title: "Open a project",
    line: "Chats, lanes and tools all live inside a project. Pick one to start.",
    ask: { label: "Click a project", icon: "click" },
    byAnchor: {
      "add-project": {
        title: "Add a project",
        line: "Point ADE at a folder with a git repo. It opens in its own tab, ready for chats.",
        ask: { label: "Click Add project", icon: "click" },
        place: ["below", "left"],
      },
    },
    advance: "action",
    place: ["right", "below", "left"],
    goTo: "home",
    where: "Home",
    skipIf: inProject,
  },
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
    line: "The lane menu picks where this chat runs.",
    ask: { label: "Click the lane", icon: "click" },
    advance: "click",
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
    skipIf: () => !anchorOnScreen("lane-picker-menu"),
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
    // Only for someone with no chats yet; the host fills the composer in.
    id: "first-chat",
    anchors: ["composer"],
    title: "Send your first chat",
    line: "We filled in a first question. Pick a model, then press Send. Nothing runs until you do.",
    ask: { label: "Press Send", icon: "send" },
    advance: "action",
    place: ["above", "below"],
    goTo: "draft",
    where: "a new chat",
    // A chat exists: either there were some already, or this one was sent.
    skipIf: () => anchorShown("session-row"),
  },
  {
    id: "open-chat",
    anchors: ["session-row"],
    title: "Open a chat",
    line: "A chat picks up where it left off.",
    ask: { label: "Click a chat", icon: "click" },
    advance: "click",
    place: ["right", "below"],
    goTo: "work",
    where: "Work",
    skipIf: () => noChatsToOpen() || inOpenChat(),
  },
  {
    id: "tools-toggle",
    anchors: ["tools-toggle"],
    title: "Open the Tools pane",
    line: "Every chat has tools beside it, for the same lane the agent works in.",
    ask: { label: "Click the Tools button", icon: "click" },
    advance: "click",
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
    ask: { label: "Click New chat", icon: "click" },
    advance: "click",
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
    ask: { label: "Click + for a new tab", icon: "click" },
    advance: "click",
    place: ["below", "left"],
    where: "the top bar",
  },
  {
    id: "home-customize",
    anchors: ["home-customize"],
    title: "Your home page",
    line: "Widgets for what's going on everywhere: chats that need you, usage, PRs and tips. Make the page yours from here.",
    ask: { label: "Click to customize", icon: "click" },
    advance: "click",
    place: ["below", "left"],
    goTo: "home",
    where: "Home",
    // Already editing: the tools step covers it.
    skipIf: () => anchorOnScreen("home-edit-tools"),
  },
  {
    id: "home-edit-tools",
    anchors: ["home-edit-tools"],
    title: "Add, move and resize",
    line: "Add widgets, pick a card look, save layouts. Drag a widget to move it and pull its corner to resize.",
    // Asks for Done, so the tour never leaves Home stuck in edit mode.
    ask: { label: "Press Done when you're finished", icon: "click" },
    advance: "action",
    place: ["below", "left"],
    goTo: "home",
    where: "Home",
    // Editing ended (Done): carry on.
    skipIf: () => anchorOnScreen("home-customize"),
  },
  {
    id: "connections",
    anchors: ["connections"],
    title: "Work from every computer",
    line: "Connect your other machines and your phone here. Their lanes and chats show up right beside these.",
    ask: { label: "Click Connections", icon: "click" },
    advance: "click",
    place: ["below", "left"],
    where: "the top bar",
  },
];
