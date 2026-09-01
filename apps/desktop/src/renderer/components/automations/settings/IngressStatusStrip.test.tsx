/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AutomationLinearIngressStatus } from "../../../../shared/types";
import { resetBuiltinSurfacePlugins, seedBuiltinSurfacePlugins } from "../../../../test/builtinSurfaces";
import { IngressStatusStrip } from "./IngressStatusStrip";

/**
 * The automations list header's Linear ingress row.
 *
 * `ade-linear` declares a `webhookIngress` channel of its own and reports its
 * own delivery state, so on a machine that has the plugin this row is a second
 * answer to one question — and its Connect button writes a token the plugin's
 * credential handoff now owns. The gate lives inside the strip rather than at
 * `RuleList`, so a second call site added later cannot leak it.
 *
 * The GitHub row is asserted alongside every case, because the gate must take
 * away the Linear row and nothing else.
 */

const UNCONFIGURED: AutomationLinearIngressStatus = {
  state: "unconfigured",
  webhookId: null,
  organizationId: null,
  lastEventAt: null,
  lastError: null,
  relayBaseUrl: "https://relay.example",
};

function mockLinearIngress(): { getStatus: ReturnType<typeof vi.fn> } {
  const getStatus = vi.fn(async () => UNCONFIGURED);
  const existing = (window as unknown as { ade?: Record<string, unknown> }).ade;
  Object.defineProperty(window, "ade", {
    configurable: true,
    writable: true,
    value: {
      ...(existing ?? {}),
      automations: { linearIngress: { getStatus, setup: vi.fn() } },
    },
  });
  return { getStatus };
}

beforeEach(() => {
  resetBuiltinSurfacePlugins();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetBuiltinSurfacePlugins();
});

describe("IngressStatusStrip", () => {
  it("draws the Linear row on a machine without the plugin", async () => {
    seedBuiltinSurfacePlugins([]);
    mockLinearIngress();
    render(<IngressStatusStrip ingressStatus={null} />);
    expect(await screen.findByText("Linear")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it("keeps drawing it while the plugin registry has not resolved", async () => {
    // Unresolved reads as "no plugin" for a superseded surface: the strip on a
    // machine that has never seen ade-linear must look exactly as it always has.
    mockLinearIngress();
    render(<IngressStatusStrip ingressStatus={null} />);
    expect(await screen.findByText("Linear")).toBeTruthy();
  });

  it("drops the Linear row once ade-linear is installed and enabled", async () => {
    seedBuiltinSurfacePlugins(["linear"]);
    const { getStatus } = mockLinearIngress();
    render(<IngressStatusStrip ingressStatus={null} />);
    await waitFor(() => expect(screen.getByText("GitHub")).toBeTruthy());
    expect(screen.queryByText("Linear")).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    // And no poll: `getStatus` is one of the compiled Linear verbs ADE stops
    // advertising once the plugin owns the surface.
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("leaves the GitHub row alone when ade-linear is installed", async () => {
    seedBuiltinSurfacePlugins(["linear"]);
    mockLinearIngress();
    render(<IngressStatusStrip ingressStatus={null} />);
    expect(await screen.findByText("GitHub")).toBeTruthy();
  });
});
