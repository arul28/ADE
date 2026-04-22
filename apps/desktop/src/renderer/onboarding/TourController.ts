// Central state machine for the tour engine. Loads a `Tour` from the registry,
// walks its steps, executes `beforeEnter` StepAction sequences against injected
// dependencies (router, dialog bus, waitForSelector), and exposes a tiny
// observable state object to the React layer. Intentionally decoupled from the
// DOM except for a single `data-tour-focus` attribute toggle for focus actions.

import {
  getTour,
  type StepAction,
  type Tour,
  type TourCtx,
  type TourStep,
} from "./registry";
import type { DialogBus } from "../lib/dialogBus";

export type TourControllerStatus = "idle" | "running" | "waiting";

export type TourControllerState = {
  tourId: string | null;
  variant: "full" | "highlights" | null;
  stepIndex: number;
  ctx: TourCtx;
  status: TourControllerStatus;
};

export type TourControllerDeps = {
  navigate: (to: string) => void;
  dialogBus: DialogBus;
  waitForSelector: (sel: string, timeoutMs?: number) => Promise<boolean>;
};

export type TourController = {
  start(tourId: string, variant?: "full" | "highlights"): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  dismiss(): Promise<void>;
  complete(opts?: { afterLeaveAlreadyRan?: boolean }): Promise<void>;
  getState(): TourControllerState;
  subscribe(cb: (state: TourControllerState) => void): () => void;
};

function makeCtx(initial: Record<string, unknown>): TourCtx {
  const values: Record<string, unknown> = { ...initial };
  const ctx: TourCtx = {
    values,
    set(k, v) {
      values[k] = v;
    },
    get<T = unknown>(k: string): T | undefined {
      return values[k] as T | undefined;
    },
  };
  return ctx;
}

function idleState(): TourControllerState {
  return {
    tourId: null,
    variant: null,
    stepIndex: 0,
    ctx: makeCtx({}),
    status: "idle",
  };
}

export function createTourController(
  deps: TourControllerDeps,
): TourController {
  let state: TourControllerState = idleState();
  let activeTour: Tour | null = null;
  const subscribers = new Set<(s: TourControllerState) => void>();

  function notify(): void {
    const snapshot: TourControllerState = { ...state };
    for (const cb of Array.from(subscribers)) {
      cb(snapshot);
    }
  }

  function setState(patch: Partial<TourControllerState>): void {
    state = { ...state, ...patch };
    notify();
  }

  async function runActions(actions: StepAction[]): Promise<void> {
    for (const action of actions) {
      switch (action.type) {
        case "navigate":
          deps.navigate(action.to);
          break;
        case "openDialog":
          deps.dialogBus.open(action.id, action.props);
          break;
        case "closeDialog":
          deps.dialogBus.close(action.id);
          break;
        case "ipc":
          await action.call();
          break;
        case "focus": {
          if (typeof document !== "undefined") {
            const el = document.querySelector(
              action.selector,
            ) as HTMLElement | null;
            if (el) {
              try {
                el.scrollIntoView({ block: "center", behavior: "smooth" });
              } catch {
                // jsdom or older DOMs may not support the options arg.
                el.scrollIntoView();
              }
              el.setAttribute("data-tour-focus", "true");
            }
          }
          break;
        }
      }
    }
  }

  async function enterStep(index: number): Promise<void> {
    if (!activeTour) return;
    const step: TourStep | undefined = activeTour.steps[index];
    if (!step) {
      // Past the end — treat as completion.
      await complete();
      return;
    }

    setState({ stepIndex: index, status: "running" });

    if (step.beforeEnter) {
      const result = await step.beforeEnter(state.ctx);
      if (Array.isArray(result)) {
        await runActions(result);
      }
    }

    if (step.waitForSelector) {
      setState({ status: "waiting" });
      await deps.waitForSelector(step.waitForSelector);
      // Only transition back if we're still on this same step and tour.
      if (activeTour && state.stepIndex === index && state.status === "waiting") {
        setState({ status: "running" });
      }
    }
  }

  function resolveNextIndex(current: number): number {
    if (!activeTour) return current + 1;
    const step = activeTour.steps[current];
    if (step?.branches) {
      const targetId = step.branches(state.ctx);
      if (targetId) {
        const targetIdx = activeTour.steps.findIndex(
          (s) => s.id === targetId,
        );
        if (targetIdx >= 0) return targetIdx;
      }
    }
    return current + 1;
  }

  async function runAfterLeave(step: TourStep | undefined): Promise<void> {
    if (!step?.afterLeave) return;
    await step.afterLeave(state.ctx);
  }

  async function start(
    tourId: string,
    variant: "full" | "highlights" = "full",
  ): Promise<void> {
    const tour = getTour(tourId, variant);
    if (!tour) {
      // Nothing to do. Reset to idle to avoid partial state.
      activeTour = null;
      state = idleState();
      notify();
      return;
    }

    activeTour = tour;
    const ctx = makeCtx(tour.ctxInit?.() ?? {});
    state = {
      tourId,
      variant,
      stepIndex: 0,
      ctx,
      status: "running",
    };
    notify();

    deps.navigate(tour.route);

    await enterStep(0);
  }

  async function next(): Promise<void> {
    if (!activeTour) return;
    const currentIndex = state.stepIndex;
    const currentStep = activeTour.steps[currentIndex];
    await runAfterLeave(currentStep);

    const nextIndex = resolveNextIndex(currentIndex);
    if (nextIndex >= activeTour.steps.length) {
      // Past the end — afterLeave for the final step already ran above.
      await complete({ afterLeaveAlreadyRan: true });
      return;
    }
    await enterStep(nextIndex);
  }

  async function prev(): Promise<void> {
    if (!activeTour) return;
    const target = Math.max(0, state.stepIndex - 1);
    if (target === state.stepIndex) return;
    await enterStep(target);
  }

  async function dismiss(): Promise<void> {
    if (!activeTour) return;
    const currentStep = activeTour.steps[state.stepIndex];
    await runAfterLeave(currentStep);
    activeTour = null;
    state = idleState();
    notify();
  }

  async function complete(opts: { afterLeaveAlreadyRan?: boolean } = {}): Promise<void> {
    if (!activeTour) return;
    const lastIndex = activeTour.steps.length - 1;
    if (!opts.afterLeaveAlreadyRan && state.stepIndex === lastIndex) {
      await runAfterLeave(activeTour.steps[lastIndex]);
    }
    activeTour = null;
    state = idleState();
    notify();
  }

  function getState(): TourControllerState {
    return state;
  }

  function subscribe(cb: (s: TourControllerState) => void): () => void {
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  }

  return {
    start,
    next,
    prev,
    dismiss,
    complete,
    getState,
    subscribe,
  };
}
