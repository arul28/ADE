/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ProjectInfo } from "../../../../shared/types";
import { invalidateAiDiscoveryCache } from "../../../lib/aiDiscoveryCache";
import { useAppStore } from "../../../state/appStore";
import {
  familiesFromStatus,
  opencodeBinaryInstalledFromStatus,
  resetProviderAuthStatusForTests,
  useProviderAuthStatus,
} from "./useProviderAuthStatus";

// `familiesFromStatus` is the pure mapper inside useProviderAuthStatus.
// We test it directly so the Claude availability shape (object with binary/auth,
// no `runtimeAvailable`) is correctly interpreted as "ok" when the user is
// actually authenticated. Prior regression: hook checked a nonexistent
// `runtimeAvailable` field and dimmed every Claude row even for working users.
describe("familiesFromStatus", () => {
  it("marks Claude as ok when auth.ready is true (no runtimeAvailable field)", () => {
    const out = familiesFromStatus({
      availableProviders: {
        claude: {
          binary: { present: true, source: "bundled", path: "/usr/local/bin/claude" },
          auth: { ready: true, mode: "oauth", detail: null },
        },
        codex: false,
        cursor: false,
        droid: false,
      },
    });
    expect(out.anthropic).toBe("ok");
  });

  it("marks Claude as unauthed when auth.ready is false", () => {
    const out = familiesFromStatus({
      availableProviders: {
        claude: {
          binary: { present: true, source: "bundled", path: null },
          auth: { ready: false, mode: "none", detail: "no login detected" },
        },
        codex: false,
        cursor: false,
        droid: false,
      },
    });
    expect(out.anthropic).toBe("unauthed");
  });

  it("treats legacy boolean Claude availability as the boolean value", () => {
    expect(
      familiesFromStatus({ availableProviders: { claude: true, codex: false, cursor: false, droid: false } })
        .anthropic,
    ).toBe("ok");
    expect(
      familiesFromStatus({ availableProviders: { claude: false, codex: false, cursor: false, droid: false } })
        .anthropic,
    ).toBe("unauthed");
  });

  it("honors legacy runtimeAvailable: true when present (backward compat with stubs)", () => {
    const out = familiesFromStatus({
      availableProviders: {
        claude: { runtimeAvailable: true } as unknown,
        codex: false,
        cursor: false,
        droid: false,
      },
    });
    expect(out.anthropic).toBe("ok");
  });

  it("maps codex/cursor/droid booleans correctly", () => {
    const out = familiesFromStatus({
      availableProviders: {
        claude: false,
        codex: true,
        cursor: false,
        droid: true,
      },
    });
    expect(out.openai).toBe("ok");
    expect(out.cursor).toBe("unauthed");
    expect(out.factory).toBe("ok");
  });

  it("sets opencode ok when any opencode provider is connected", () => {
    const out = familiesFromStatus({
      availableProviders: { claude: false, codex: false, cursor: false, droid: false },
      opencodeProviders: [
        { id: "anthropic", connected: false },
        { id: "google", connected: true },
      ],
    });
    expect(out.opencode).toBe("ok");
  });

  it("omits opencode entry when no opencode providers are connected", () => {
    const out = familiesFromStatus({
      availableProviders: { claude: false, codex: false, cursor: false, droid: false },
      opencodeProviders: [
        { id: "anthropic", connected: false },
        { id: "google", connected: false },
      ],
    });
    expect(out.opencode).toBeUndefined();
  });

  it("handles empty/missing input gracefully", () => {
    const out = familiesFromStatus({});
    expect(out.anthropic).toBe("unauthed");
    expect(out.openai).toBe("unauthed");
    expect(out.cursor).toBe("unauthed");
    expect(out.factory).toBe("unauthed");
    expect(out.opencode).toBeUndefined();
  });

  it("keeps a configured CLI-only Pi installation available for CLI pickers", () => {
    const status = {
      providerConnections: { pi: { authAvailable: true, runtimeAvailable: false } },
      piInstallation: { sdkAvailable: false, cliAvailable: true, availableModelIds: [] },
    };

    expect(familiesFromStatus(status).pi).toBe("unauthed");
    expect(familiesFromStatus(status, { allowCliOnlyModels: true }).pi).toBe("ok");
  });
});

describe("opencodeBinaryInstalledFromStatus", () => {
  it("returns true only when opencodeBinaryInstalled is the boolean true", () => {
    expect(opencodeBinaryInstalledFromStatus({ opencodeBinaryInstalled: true })).toBe(true);
  });

  it("returns false when opencodeBinaryInstalled is false", () => {
    expect(opencodeBinaryInstalledFromStatus({ opencodeBinaryInstalled: false })).toBe(false);
  });

  it("returns false when opencodeBinaryInstalled is missing", () => {
    expect(opencodeBinaryInstalledFromStatus({})).toBe(false);
  });

  it("returns false for non-boolean truthy values (defensive)", () => {
    expect(opencodeBinaryInstalledFromStatus({ opencodeBinaryInstalled: "yes" })).toBe(false);
    expect(opencodeBinaryInstalledFromStatus({ opencodeBinaryInstalled: 1 })).toBe(false);
  });
});

describe("useProviderAuthStatus", () => {
  beforeEach(() => {
    resetProviderAuthStatusForTests();
  });

  afterEach(() => {
    cleanup();
    invalidateAiDiscoveryCache();
    useAppStore.setState({ project: null, projectBinding: null });
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });

  it("shares one project-scoped status request across concurrent picker consumers", async () => {
    const getStatus = vi.fn().mockResolvedValue({
      mode: "subscription",
      availableProviders: {
        claude: {
          binary: { present: false, source: "missing", path: null },
          auth: { ready: false, mode: "none", detail: null },
        },
        codex: true,
        cursor: false,
        droid: false,
      },
      models: { claude: [], codex: [], cursor: [], droid: [] },
      features: [],
      detectedAuth: [],
    });
    const isOpenCodeInstalled = vi.fn()
      .mockResolvedValueOnce({ installed: true })
      .mockResolvedValueOnce({ installed: false });
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: { ai: { getStatus, isOpenCodeInstalled } },
    });
    useAppStore.setState({
      project: {
        rootPath: "/project/shared-auth",
        displayName: "Shared auth",
        baseRef: "main",
      } satisfies ProjectInfo,
      projectBinding: null,
    });

    function ConcurrentConsumers() {
      const first = useProviderAuthStatus();
      const second = useProviderAuthStatus();
      return React.createElement(
        "div",
        null,
        `${first.status.openai}:${second.status.openai}:${String(first.opencodeBinaryInstalled)}`,
      );
    }

    render(React.createElement(ConcurrentConsumers));

    expect(await screen.findByText("ok:ok:true")).toBeTruthy();
    expect(getStatus).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(isOpenCodeInstalled).toHaveBeenCalledTimes(1);
    });

    act(() => {
      useAppStore.setState({
        project: {
          rootPath: "/project/other-runtime",
          displayName: "Other runtime",
          baseRef: "main",
        } satisfies ProjectInfo,
      });
    });

    expect(await screen.findByText("ok:ok:false")).toBeTruthy();
    expect(isOpenCodeInstalled).toHaveBeenCalledTimes(2);
  });

  it("skips status discovery when the picker already received auth state", async () => {
    const getStatus = vi.fn();
    const isOpenCodeInstalled = vi.fn().mockResolvedValue({ installed: true });
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        ai: {
          getStatus,
          isOpenCodeInstalled,
        },
      },
    });
    useAppStore.setState({
      project: {
        rootPath: "/project/external-auth",
        displayName: "External auth",
        baseRef: "main",
      } satisfies ProjectInfo,
      projectBinding: null,
    });

    function ExternalAuthConsumer() {
      const auth = useProviderAuthStatus({ loadStatus: false });
      return React.createElement("div", null, auth.loaded ? "loaded" : "idle");
    }

    render(React.createElement(ExternalAuthConsumer));

    expect(screen.getByText("idle")).toBeTruthy();
    expect(getStatus).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(isOpenCodeInstalled).toHaveBeenCalledTimes(1);
    });
  });
});
