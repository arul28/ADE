/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetRegistryForTests,
  registerTour,
  type Tour,
} from "./registry";
import {
  createTourController,
  type TourControllerDeps,
  type TourControllerState,
} from "./TourController";
import { createDialogBus, type DialogBus } from "../lib/dialogBus";

type Fixtures = {
  deps: TourControllerDeps;
  navigate: ReturnType<typeof vi.fn>;
  dialogBus: DialogBus;
  waitForSelector: ReturnType<typeof vi.fn>;
  openSpy: ReturnType<typeof vi.fn>;
  closeSpy: ReturnType<typeof vi.fn>;
};

function makeFixtures(): Fixtures {
  const navigate = vi.fn();
  const dialogBus = createDialogBus();
  const openSpy = vi.fn();
  const closeSpy = vi.fn();
  dialogBus.subscribeAll((event) => {
    if (event.type === "open") openSpy(event.id, event.props);
    if (event.type === "close") closeSpy(event.id);
  });
  const waitForSelector = vi.fn(async () => true);
  const deps: TourControllerDeps = {
    navigate,
    dialogBus,
    waitForSelector: waitForSelector as unknown as TourControllerDeps["waitForSelector"],
  };
  return { deps, navigate, dialogBus, waitForSelector, openSpy, closeSpy };
}

describe("TourController", () => {
  beforeEach(() => {
    _resetRegistryForTests();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("start() initializes ctx from ctxInit and navigates to the tour's route", async () => {
    const tour: Tour = {
      id: "demo",
      title: "demo",
      route: "/demo",
      ctxInit: () => ({ laneName: "tour-sample" }),
      steps: [
        { id: "hero", target: "", title: "Hero", body: "Welcome" },
      ],
    };
    registerTour(tour);

    const { deps, navigate } = makeFixtures();
    const controller = createTourController(deps);
    await controller.start("demo");

    expect(navigate).toHaveBeenCalledWith("/demo");
    const state = controller.getState();
    expect(state.tourId).toBe("demo");
    expect(state.variant).toBe("full");
    expect(state.stepIndex).toBe(0);
    expect(state.ctx.get<string>("laneName")).toBe("tour-sample");
  });

  it("next() runs beforeEnter and executes returned StepActions in order", async () => {
    const tour: Tour = {
      id: "demo",
      title: "demo",
      route: "/demo",
      steps: [
        { id: "first", target: "", title: "First", body: "first" },
        {
          id: "second",
          target: "",
          title: "Second",
          body: "second",
          beforeEnter: () => [
            { type: "navigate", to: "/lanes" },
            {
              type: "openDialog",
              id: "lanes.create",
              props: { seed: "hi" },
            },
          ],
        },
      ],
    };
    registerTour(tour);

    const { deps, navigate, openSpy } = makeFixtures();
    const controller = createTourController(deps);
    await controller.start("demo");

    navigate.mockClear();
    await controller.next();

    expect(navigate).toHaveBeenCalledWith("/lanes");
    expect(openSpy).toHaveBeenCalledWith("lanes.create", { seed: "hi" });
    expect(controller.getState().stepIndex).toBe(1);
  });

  it("branches() return value overrides the default index+1 transition", async () => {
    const tour: Tour = {
      id: "demo",
      title: "demo",
      route: "/demo",
      ctxInit: () => ({ path: "b" }),
      steps: [
        {
          id: "split",
          target: "",
          title: "Split",
          body: "split",
          branches: (ctx) =>
            ctx.get<string>("path") === "b" ? "target" : null,
        },
        { id: "skipMe", target: "", title: "Skip", body: "skip" },
        { id: "target", target: "", title: "Target", body: "target" },
      ],
    };
    registerTour(tour);

    const { deps } = makeFixtures();
    const controller = createTourController(deps);
    await controller.start("demo");

    await controller.next();
    expect(controller.getState().stepIndex).toBe(2);
  });

  it("awaits waitForSelector and transitions waiting → running", async () => {
    let resolveWait: (v: boolean) => void = () => {};
    const waitPromise = new Promise<boolean>((res) => {
      resolveWait = res;
    });
    const tour: Tour = {
      id: "demo",
      title: "demo",
      route: "/demo",
      steps: [
        { id: "first", target: "", title: "First", body: "first" },
        {
          id: "second",
          target: "",
          title: "Second",
          body: "second",
          waitForSelector: "#does-not-exist-yet",
        },
      ],
    };
    registerTour(tour);

    const { deps, waitForSelector } = makeFixtures();
    (waitForSelector as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => waitPromise,
    );
    const controller = createTourController(deps);
    await controller.start("demo");

    const states: TourControllerState[] = [];
    controller.subscribe((s) => states.push({ ...s }));

    const nextPromise = controller.next();

    // Give microtasks a tick to propagate setState -> "waiting".
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.getState().status).toBe("waiting");
    expect(
      states.some((s) => s.status === "waiting" && s.stepIndex === 1),
    ).toBe(true);

    resolveWait(true);
    await nextPromise;

    expect(controller.getState().status).toBe("running");
    expect(controller.getState().stepIndex).toBe(1);
  });

  it("dismiss() runs afterLeave and resets to idle", async () => {
    const afterLeave = vi.fn();
    const tour: Tour = {
      id: "demo",
      title: "demo",
      route: "/demo",
      steps: [
        {
          id: "first",
          target: "",
          title: "First",
          body: "first",
          afterLeave,
        },
      ],
    };
    registerTour(tour);

    const { deps } = makeFixtures();
    const controller = createTourController(deps);
    await controller.start("demo");

    await controller.dismiss();

    expect(afterLeave).toHaveBeenCalledTimes(1);
    const state = controller.getState();
    expect(state.tourId).toBe(null);
    expect(state.status).toBe("idle");
    expect(state.stepIndex).toBe(0);
  });

  it("subscribe() callbacks fire on state change and stop firing after unsubscribe", async () => {
    const tour: Tour = {
      id: "demo",
      title: "demo",
      route: "/demo",
      steps: [
        { id: "first", target: "", title: "First", body: "first" },
        { id: "second", target: "", title: "Second", body: "second" },
      ],
    };
    registerTour(tour);

    const { deps } = makeFixtures();
    const controller = createTourController(deps);

    const cb = vi.fn();
    const unsubscribe = controller.subscribe(cb);

    await controller.start("demo");
    const callsAfterStart = cb.mock.calls.length;
    expect(callsAfterStart).toBeGreaterThan(0);

    await controller.next();
    const callsAfterNext = cb.mock.calls.length;
    expect(callsAfterNext).toBeGreaterThan(callsAfterStart);

    unsubscribe();
    await controller.dismiss();
    expect(cb.mock.calls.length).toBe(callsAfterNext);
  });
});
