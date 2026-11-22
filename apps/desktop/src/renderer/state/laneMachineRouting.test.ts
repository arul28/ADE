/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { ADE_CLOUD_MACHINE_ID } from "../../shared/adeCloudMachine";
import { LANES_MACHINE_FILTER_ALL } from "./laneMachineFilterIds";
import {
  buildLaneMachineFilterEntries,
  effectiveLaneMachineFilter,
  laneFilterEntryId,
  type LaneMachineFilterMachine,
} from "./laneMachineRouting";

function machine(overrides: Partial<LaneMachineFilterMachine> & Pick<LaneMachineFilterMachine, "entryId" | "name" | "laneCount">): LaneMachineFilterMachine {
  return { isCloud: false, isThisMachine: false, ...overrides };
}

describe("the Lanes Computer filter's entries", () => {
  it.each([
    {
      name: "one entry per computer, ADE Cloud once and last, All first",
      machines: [
        machine({ entryId: laneFilterEntryId("studio", false), name: "Studio Mac", laneCount: 2 }),
        machine({ entryId: laneFilterEntryId("this-mac", false), name: "This computer", isThisMachine: true, laneCount: 3 }),
        // Two checkouts of one computer: one entry, both counts.
        machine({ entryId: laneFilterEntryId("studio#checkout:two", false), name: "Studio Mac", laneCount: 1 }),
        // Every ADE Cloud computer is one machine to the person.
        machine({ entryId: laneFilterEntryId("cloud-a", true), name: "ADE Cloud", isCloud: true, laneCount: 1 }),
        machine({ entryId: laneFilterEntryId("cloud-b", true), name: "ADE Cloud", isCloud: true, laneCount: 2 }),
        // Nothing to show here: not a choice.
        machine({ entryId: laneFilterEntryId("old-laptop", false), name: "Old Laptop", laneCount: 0 }),
      ],
      expected: [
        [LANES_MACHINE_FILTER_ALL, 9],
        ["this-mac", 3],
        ["studio", 3],
        [ADE_CLOUD_MACHINE_ID, 3],
      ],
    },
    {
      name: "All and the computer when this project lives on one computer",
      machines: [machine({ entryId: laneFilterEntryId("this-mac", false), name: "This computer", isThisMachine: true, laneCount: 4 })],
      expected: [
        [LANES_MACHINE_FILTER_ALL, 4],
        ["this-mac", 4],
      ],
    },
  ])("$name", ({ machines, expected }) => {
    const entries = buildLaneMachineFilterEntries({ machines });
    expect(entries.map((entry) => [entry.id, entry.laneCount])).toEqual(expected);
    expect(entries[0]?.kind).toBe("all");
  });

  it("a stored computer that is no longer listed reads as All, and returns when it is back", () => {
    const listed = buildLaneMachineFilterEntries({
      machines: [machine({ entryId: laneFilterEntryId("this-mac", false), name: "This computer", isThisMachine: true, laneCount: 1 })],
    });
    expect(effectiveLaneMachineFilter("this-mac", listed)).toBe("this-mac");
    // A computer that went offline (its lanes left the list) must not leave the
    // sidebar filtered with no entry left to click.
    expect(effectiveLaneMachineFilter("studio", listed)).toBe(LANES_MACHINE_FILTER_ALL);
    // The old "Without a computer" entry's stored value reads as All.
    expect(effectiveLaneMachineFilter("__no_computer__", listed)).toBe(LANES_MACHINE_FILTER_ALL);
    expect(effectiveLaneMachineFilter("studio", [])).toBe(LANES_MACHINE_FILTER_ALL);
  });
});
