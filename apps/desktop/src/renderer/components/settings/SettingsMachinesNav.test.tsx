/* @vitest-environment jsdom */

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OpenProjectBinding } from "../../../shared/types";
import type { ProjectMachine } from "../../state/projectMachines";
import { useSettingsMachinePage } from "./SettingsMachinesNav";

/**
 * `useSettingsMachinePage` is the one place a Machines page gets its pin, and
 * that pin is the machine identity a section keys its effects on. The machine
 * list re-derives on every cross-machine sync tick with a fresh binding object,
 * so the page must hand out the SAME pin while the machine's binding key holds;
 * an in-flight sign-in whose section re-subscribes on a new pin cancels itself.
 * A new key (rebound project, different host) must still produce a new pin.
 */

function binding(key: string): OpenProjectBinding {
  return {
    kind: "remote",
    key,
    targetId: "host-1",
    runtimeName: "Mac Studio",
    transport: "paired",
    projectId: "project-1",
    rootPath: "/Users/admin/Projects/ADE",
    displayName: "ADE",
  };
}

/**
 * A machine whose tab binding is `pin` — the shape `settingsTargetFor` reads
 * when the machine is the active binding and not This computer.
 */
function machine(pin: OpenProjectBinding, overrides: Partial<ProjectMachine> = {}): ProjectMachine {
  return {
    machineId: "host-1",
    machineName: "Mac Studio",
    online: true,
    isThisMachine: false,
    isActiveBinding: true,
    binding: pin,
    pin,
    routable: true,
    hasRepo: true,
    deviceId: null,
    hostname: null,
    version: null,
    ...overrides,
  };
}

describe("useSettingsMachinePage", () => {
  it("keeps the page's pin identity when the machine list re-derives with the same key", () => {
    const first = machine(binding("project-1:host-1"));
    const { result, rerender } = renderHook(
      ({ pageMachine }: { pageMachine: ProjectMachine }) => useSettingsMachinePage(pageMachine),
      { initialProps: { pageMachine: first } },
    );
    const originalPin = result.current?.pin;
    expect(originalPin).toBe(first.pin);

    // A sync tick: a fresh machine object and a fresh binding, same key.
    rerender({ pageMachine: machine(binding("project-1:host-1")) });

    expect(result.current?.pin).toBe(originalPin);
    // A section reading `target.binding` must get the same object `pin` names,
    // or the two URLs for one machine drift apart.
    expect(result.current?.target).toEqual({ kind: "pinned", binding: originalPin });
  });

  it("hands out a new pin when the machine's binding key changes", () => {
    const first = machine(binding("project-1:host-1"));
    const { result, rerender } = renderHook(
      ({ pageMachine }: { pageMachine: ProjectMachine }) => useSettingsMachinePage(pageMachine),
      { initialProps: { pageMachine: first } },
    );
    const originalPin = result.current?.pin;

    rerender({ pageMachine: machine(binding("project-1:host-2")) });

    expect(result.current?.pin).not.toBe(originalPin);
    expect(result.current?.pin?.key).toBe("project-1:host-2");
  });

  it("returns no page for no machine", () => {
    const { result } = renderHook(() => useSettingsMachinePage(null));
    expect(result.current).toBeNull();
  });
});
