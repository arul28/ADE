import type {
  AgentChatFileRef,
  AppControlContextItem,
  OpenProjectBinding,
} from "../../../../shared/types";

/**
 * What an engine view needs, and deliberately nothing more.
 *
 * ## Why these five and no others
 *
 * An engine view is the PICTURE half of a tool whose chrome now lives in a
 * plugin page — the Electron Control screencast, the simulator mirror. The page
 * draws the launch form, the status pill, the window picker and the settings;
 * the host paints only the live view into a rect the page reserved, and keeps
 * the pointer and key events that land on it.
 *
 * So the props are exactly the inputs a live view cannot derive:
 *
 * - `laneId` and `projectRoot` scope every host call to one checkout. A live
 *   view with the wrong one drives another lane's app.
 * - `runtimePin` names the MACHINE. Every `appControl.*` and `iosSimulator.*`
 *   verb takes it, and a null pin means this tab's bound machine.
 * - `sessionId` is the chat a captured element is attached to, and null where
 *   there is no chat to attach to.
 * - `controlDisabledReason` is the host's own sentence for "this view is
 *   read-only from here". Non-null disables every input verb and is shown by
 *   the view rather than swallowed, because a click that silently does nothing
 *   is the worst of the three outcomes.
 *
 * What is NOT here is the point: no launch command, no port, no target list, no
 * mode toggle, no message banner. Those are chrome, the page owns them, and an
 * engine view that took them would be the compiled panel again.
 */
export type HostEngineViewProps = {
  laneId: string | null;
  projectRoot: string | null;
  runtimePin: OpenProjectBinding | null;
  sessionId: string | null;
  /** Non-null makes every input verb refuse, with this sentence. */
  controlDisabledReason?: string | null;
};

/**
 * The two ways a captured element leaves the picture.
 *
 * Separate from {@link HostEngineViewProps} because only the engine that
 * INSPECTS takes them. A pointer landing on the live view is the only gesture
 * that can name an element, so the attach path has to live where the pointer
 * does — the page around it has no picture to point at. Both are optional, and
 * absent means the surrounding host has no composer to insert into, which the
 * view reads as "offer no attach affordance" rather than as an error.
 */
export type HostEngineAttachProps = {
  onAddContext?: (item: AppControlContextItem) => void;
  onAddAttachment?: (attachment: AgentChatFileRef) => void;
};
