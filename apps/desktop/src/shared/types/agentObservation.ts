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
