/**
 * One wire shape for the agent-observation contract.
 *
 * The built-in browser and App Control drive the *same* in-page collector
 * (`AGENT_DOM_COLLECTOR_FUNCTION` in `shared/agentObservation.ts`), so the
 * element/DOM snapshots they produce are one shape with two historical names.
 * Declaring it once here — next to the collector that produces it — keeps the
 * two surfaces from drifting field by field, and lets shared readers (trace
 * renderers, normalizers) be written against the base type instead of being
 * accidentally locked to one surface.
 *
 * The surface-specific aliases live in `./appControl` and `./builtInBrowser`
 * so every existing import keeps working.
 */

export type AgentFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AgentElementSnapshot = {
  index: number;
  handle?: string | null;
  framePath?: number[];
  shadowPath?: string[];
  tagName: string | null;
  role: string | null;
  label: string | null;
  text: string | null;
  value: string | null;
  placeholder: string | null;
  selector: string | null;
  testId: string | null;
  href: string | null;
  disabled: boolean | null;
  frame: AgentFrame;
  center: { x: number; y: number };
};

export type AgentDomSnapshot = {
  url: string | null;
  title: string | null;
  capturedAt: string;
  viewport: AgentFrame;
  scroll: { x: number; y: number };
  elementCount: number;
  elements: AgentElementSnapshot[];
  /**
   * A short key for the element that had keyboard focus when the snapshot was
   * taken (tag, role, id, name, label), or null when nothing did. Absent from
   * a snapshot an older collector wrote. Read only by the action-effect check.
   */
  focusKey?: string | null;
  /** A hash of the page's visible text; the action-effect check compares it. */
  textKey?: string;
};

/**
 * Did an acting command visibly change anything?
 *
 * Every computer-use surface (browser, App Control, Mac Desktop, Apple
 * device) answers with this, so an agent learns the same two facts from every
 * action: which element it hit, and whether the screen changed after it.
 */
export type ComputerUseActionEffect = {
  /** "observed": the screen/DOM visibly changed after the action. "unconfirmed": the input was sent, but nothing ADE can see changed. "not_checked": this action/surface did not compare (say why in `reason`). */
  status: "observed" | "unconfirmed" | "not_checked";
  /** One short plain-English sentence, e.g. "the focused element changed", "the URL changed", "3 elements changed", "nothing on screen changed". */
  reason: string;
};

/**
 * Common half of an action-trace entry. Each surface adds its own target
 * identity — a tab id for the browser, a CDP target id for App Control — and
 * nothing else.
 */
export type AgentActionTraceEntry = {
  id: string;
  sessionId: string | null;
  action: string;
  status: "ok" | "error";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  before: { url: string | null; title: string | null };
  after: { url: string | null; title: string | null };
  target: Record<string, unknown> | null;
  observationId: string | null;
  error: string | null;
};
