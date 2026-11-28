import { anchorShown, findVisibleAnchor, isAnchorVisible } from "./anchorGeometry";
import { BRAND } from "../../../../shared/brand";

/**
 * The guided tour, in order. It runs inside a project, the first time one is
 * open (the screens before that explain themselves), on the desktop and in
 * ADE Web alike, once per account. Six cards at most: what to type, how the
 * agent runs, where it runs, where chats live, the first send (or opening a
 * chat, for someone who has some), and the tools.
 * Everything else is in ADE Tips.
 *
 * Each step points at a real control, marked with
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
  /** The number the card shows ("3 of 6"). Two steps that stand in for each other (send a first chat, or open one) share it. */
  number: number;
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

/** How many cards one person sees: "Send your first chat" and "Open a chat" never both apply. */
export const TOUR_CARD_COUNT = 6;

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
    id: "composer",
    number: 1,
    anchors: ["composer"],
    title: "Tell an agent what to do",
    line: "Describe the change you want. Type @ to bring in files, other chats, or a subagent on any model, and / for commands.",
    advance: "next",
    place: ["above", "below"],
    goTo: "draft",
    where: "a new chat",
  },
  {
    id: "composer-controls",
    number: 2,
    anchors: ["composer-controls"],
    title: "Model, permissions and effort",
    line: "Pick which model runs, how much it may do before it asks you, and how hard it thinks.",
    advance: "next",
    place: ["below", "above", "right"],
    goTo: "draft",
    where: "a new chat",
  },
  {
    id: "where-it-runs",
    number: 3,
    anchors: ["run-on", "lane-picker"],
    title: "Where it runs",
    line: `Run here, on another computer of yours, or on ${BRAND.CLOUD_NAME}, which keeps going while your laptop sleeps. Beside it: your main checkout, or a new lane on its own branch.`,
    byAnchor: {
      "lane-picker": {
        line: "Your main checkout, or a new lane on its own branch, so agents never step on each other.",
      },
    },
    advance: "next",
    place: ["below", "above", "right"],
    goTo: "draft",
    where: "a new chat",
  },
  {
    id: "sidebar",
    number: 4,
    anchors: ["session-list"],
    title: "Every chat, in one list",
    line: `Chats, CLIs and terminals from every lane and machine, ${BRAND.CLOUD_NAME} included. A dot means one needs you.`,
    advance: "next",
    place: ["right", "below"],
    goTo: "work",
    where: "Work",
  },
  {
    // Only for someone with no chats yet; the host fills the composer in when it can.
    id: "first-chat",
    number: 5,
    anchors: ["composer"],
    title: "Send your first chat",
    line: "Pick a model and press Send. Nothing runs until you do.",
    ask: { label: "Press Send", icon: "send" },
    advance: "action",
    place: ["above", "below"],
    goTo: "draft",
    where: "a new chat",
    // A chat exists: either there were some already, or this one was sent.
    skipIf: () => anchorShown("session-row"),
  },
  {
    // People who had chats before the tour land on a new chat: open one first.
    id: "open-chat",
    number: 5,
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
    id: "tools",
    number: 6,
    anchors: ["tools-toggle"],
    title: "Tools beside every chat",
    line: "Terminal, Git, files, a browser and simulators, for the lane the agent works in. Agents use the same ones, so you can watch them work.",
    ask: { label: "Click Tools", icon: "click" },
    advance: "click",
    place: ["below", "left"],
    goTo: "work",
    where: "a chat",
    // Already open, or no chat to open it on.
    skipIf: () => toolsPaneOpen() || (onDraftPage() && noChatsToOpen()),
  },
];
