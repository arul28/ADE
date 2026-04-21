import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetRegistryForTests,
  getTour,
  listTours,
  registerTour,
  type Tour,
} from "./registry";

function fixture(id: string, overrides: Partial<Tour> = {}): Tour {
  return {
    id,
    title: `${id} tour`,
    route: `/${id}`,
    steps: [],
    ...overrides,
  };
}

describe("onboarding registry", () => {
  beforeEach(() => {
    _resetRegistryForTests();
  });

  it("registerTour appends new tours in insertion order", () => {
    registerTour(fixture("lanes"));
    registerTour(fixture("work"));
    registerTour(fixture("prs"));

    const ids = listTours().map((t) => t.id);
    expect(ids).toEqual(["lanes", "work", "prs"]);
  });

  it("registerTour is idempotent by id — second call replaces without duplicating", () => {
    registerTour(fixture("lanes", { title: "old" }));
    registerTour(fixture("work"));
    // Replace the lanes tour with new content.
    registerTour(fixture("lanes", { title: "new", steps: [
      { target: "#x", title: "step", body: "body" },
    ] }));

    const tours = listTours();
    expect(tours).toHaveLength(2);
    // Insertion order preserved — lanes still comes before work.
    expect(tours.map((t) => t.id)).toEqual(["lanes", "work"]);
    expect(getTour("lanes")?.title).toBe("new");
    expect(getTour("lanes")?.steps).toHaveLength(1);
  });

  it("getTour returns undefined for unknown ids", () => {
    expect(getTour("nope")).toBeUndefined();
  });

  it("listTours returns a snapshot copy that does not mutate the store", () => {
    registerTour(fixture("lanes"));
    const snapshot = listTours();
    snapshot.push(fixture("fake"));
    expect(listTours().map((t) => t.id)).toEqual(["lanes"]);
  });
});
