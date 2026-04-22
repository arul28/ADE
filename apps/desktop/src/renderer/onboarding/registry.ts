export type TourStepPlacement = "top" | "bottom" | "left" | "right" | "auto";

export type StepAction =
  | { type: "navigate"; to: string }
  | { type: "openDialog"; id: string; props?: Record<string, unknown> }
  | { type: "closeDialog"; id: string }
  | { type: "ipc"; call: () => Promise<void> }
  | { type: "focus"; selector: string };

export type TourCtx = {
  values: Record<string, unknown>;
  set: (k: string, v: unknown) => void;
  get: <T = unknown>(k: string) => T | undefined;
};

export type TourStepIllustration =
  | { kind: "lottie"; src: string; loop?: boolean }
  | { kind: "svg"; src: string };

export type TourStepGhostCursor = { from: string; to: string; click?: boolean };

export type TourStepActIntro = {
  title: string;
  subtitle?: string;
  variant: "orbit" | "drift" | "particles";
};

// NOTE: `target` and `body` are kept as plain strings for backward compatibility
// with existing consumers (TourOverlay, TourStep, legacy tour tests). The richer
// forms specified in the engine upgrade (hero steps without anchors, ctx-aware
// body templating) are surfaced as separate optional fields so both shapes can
// coexist while the component layer migrates to the new types.
//
// Richer forms:
//   - `target` may be an empty string or omitted in spirit; to unlock hero-only
//     steps, use the `actIntro` field and leave `target: ""` — the controller
//     and overlay layer are expected to short-circuit when actIntro is set.
//   - `body` as a function lives in `bodyTemplate` (evaluated against the
//     TourCtx at render time). When both are present, `bodyTemplate` wins.
export type TourStep = {
  id?: string;
  target: string;
  title: string;
  body: string;
  bodyTemplate?: (ctx: TourCtx) => string;
  docUrl?: string;
  placement?: TourStepPlacement;
  waitForSelector?: string;
  beforeEnter?: (
    ctx?: TourCtx,
  ) => void | StepAction[] | Promise<void | StepAction[]>;
  afterLeave?: (ctx: TourCtx) => void | Promise<void>;
  illustration?: TourStepIllustration;
  ghostCursor?: TourStepGhostCursor;
  actIntro?: TourStepActIntro;
  branches?: (ctx: TourCtx) => string | null;
};

export type TourVariant = "full" | "highlights";

export type Tour = {
  id: string;
  title: string;
  route: string;
  routes?: string[];
  variant?: TourVariant;
  steps: TourStep[];
  ctxInit?: () => Record<string, unknown>;
};

// Internal storage keyed by `${id}::${variant || "full"}`. We keep insertion
// order via a parallel array of keys so listTours() can return a stable order
// matching the order tours were registered (existing test relies on this).
const tours = new Map<string, Tour>();
const insertionOrder: string[] = [];

function storageKey(id: string, variant: TourVariant | undefined): string {
  return `${id}::${variant ?? "full"}`;
}

export function registerTour(tour: Tour): void {
  const key = storageKey(tour.id, tour.variant);
  if (!tours.has(key)) {
    insertionOrder.push(key);
  }
  tours.set(key, tour);
}

export function getTour(id: string, variant?: TourVariant): Tour | undefined {
  // Prefer the exact variant match. If none provided, try "full" first, then
  // fall back to whichever variant is registered if only one exists.
  if (variant) {
    return tours.get(storageKey(id, variant));
  }
  const full = tours.get(storageKey(id, "full"));
  if (full) return full;
  // Look for any single registered variant.
  const matches = insertionOrder
    .filter((k) => k.startsWith(`${id}::`))
    .map((k) => tours.get(k))
    .filter((t): t is Tour => Boolean(t));
  if (matches.length === 1) return matches[0];
  // If multiple variants exist but "full" isn't among them, return the first by
  // registration order for a deterministic fallback.
  return matches[0];
}

export function listTours(variant?: TourVariant): Tour[] {
  const out: Tour[] = [];
  for (const key of insertionOrder) {
    const tour = tours.get(key);
    if (!tour) continue;
    if (variant === undefined) {
      out.push(tour);
    } else if ((tour.variant ?? "full") === variant) {
      out.push(tour);
    }
  }
  return out;
}

export function _resetRegistryForTests(): void {
  tours.clear();
  insertionOrder.length = 0;
}
