/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { OpenProjectBinding, ProjectInfo } from "../../../../shared/types";
import {
  AI_STATUS_CACHE_INVALIDATED_EVENT,
  getAiStatusCached,
  invalidateAiDiscoveryCache,
} from "../../../lib/aiDiscoveryCache";
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

  it("asks the composer machine whether OpenCode is installed", async () => {
    const isOpenCodeInstalled = vi.fn().mockResolvedValue({ installed: true });
    const getStatus = vi.fn().mockResolvedValue({
      mode: "subscription",
      availableProviders: { claude: false, codex: false, cursor: false, droid: false },
      models: { claude: [], codex: [], cursor: [] },
      features: [],
      detectedAuth: [],
    });
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: { ai: { getStatus, isOpenCodeInstalled } },
    });
    const pin = {
      kind: "remote" as const,
      key: "remote:studio:project-1",
      targetId: "studio",
      projectId: "project-1",
      rootPath: "/Users/studio/ADE",
      displayName: "Studio",
      runtimeName: "Studio",
    };

    function PinnedConsumer() {
      const auth = useProviderAuthStatus({ runtimePin: pin });
      return React.createElement("div", null, String(auth.opencodeBinaryInstalled));
    }

    render(React.createElement(PinnedConsumer));
    await waitFor(() => {
      expect(isOpenCodeInstalled).toHaveBeenCalledWith(pin);
    });
    expect(getStatus).toHaveBeenCalledWith(
      expect.objectContaining({}),
      pin,
    );
  });

  it("shares the unpinned Settings cache when the composer pin is the project tab", async () => {
    const status = {
      mode: "subscription",
      availableProviders: { claude: false, codex: true, cursor: false, droid: false },
      models: { claude: [], codex: [], cursor: [] },
      features: [],
      detectedAuth: [],
    };
    const getStatus = vi.fn().mockResolvedValue(status);
    const isOpenCodeInstalled = vi.fn().mockResolvedValue({ installed: false });
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: { ai: { getStatus, isOpenCodeInstalled } },
    });
    const pin = {
      kind: "local",
      key: "local:/Users/me/ADE",
      rootPath: "/Users/me/ADE",
      displayName: "ADE",
      gitOriginUrl: null,
    } satisfies OpenProjectBinding;
    useAppStore.setState({
      project: {
        rootPath: pin.rootPath,
        displayName: "ADE",
        baseRef: "main",
      } satisfies ProjectInfo,
      projectBinding: pin,
    });
    await getAiStatusCached({ projectRoot: pin.rootPath });
    getStatus.mockClear();

    function SameAsTabConsumer() {
      const auth = useProviderAuthStatus({ runtimePin: pin });
      return React.createElement("div", null, `${auth.status.openai ?? "empty"}:${String(auth.loaded)}`);
    }

    render(React.createElement(SameAsTabConsumer));
    expect(await screen.findByText("ok:true")).toBeTruthy();
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("refreshes unpinned provider status when the bound runtime changes with the same project root", async () => {
    const rootPath = "/Users/me/ADE";
    const mac = {
      kind: "local",
      key: "local:/Users/me/ADE",
      rootPath,
      displayName: "ADE",
      gitOriginUrl: null,
    } satisfies OpenProjectBinding;
    const studio = {
      kind: "remote",
      key: "remote:studio:project-1",
      targetId: "studio",
      projectId: "project-1",
      rootPath,
      displayName: "Studio",
      runtimeName: "Studio",
    } satisfies OpenProjectBinding;
    const unauthed = {
      mode: "subscription",
      availableProviders: { claude: false, codex: false, cursor: false, droid: false },
      models: { claude: [], codex: [], cursor: [] },
      features: [],
      detectedAuth: [],
    };
    const authed = {
      ...unauthed,
      availableProviders: { claude: false, codex: false, cursor: true, droid: false },
    };
    const getStatus = vi.fn().mockResolvedValue(unauthed);
    const isOpenCodeInstalled = vi.fn().mockResolvedValue({ installed: false });
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: { ai: { getStatus, isOpenCodeInstalled } },
    });
    useAppStore.setState({
      project: {
        rootPath,
        displayName: "ADE",
        baseRef: "main",
      } satisfies ProjectInfo,
      projectBinding: mac,
    });
    await getAiStatusCached({ projectRoot: rootPath });
    getStatus.mockClear();
    getStatus.mockResolvedValue(authed);

    function SameAsTabConsumer() {
      const pin = useAppStore((state) => state.projectBinding);
      const auth = useProviderAuthStatus({ runtimePin: pin });
      return React.createElement("div", null, `${auth.status.cursor ?? "empty"}:${String(auth.loaded)}`);
    }

    render(React.createElement(SameAsTabConsumer));
    expect(await screen.findByText("unauthed:true")).toBeTruthy();
    expect(getStatus).not.toHaveBeenCalled();

    act(() => {
      useAppStore.setState({ projectBinding: studio });
    });

    expect(await screen.findByText("ok:true")).toBeTruthy();
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(getStatus).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });

  it("does not treat a foreign pin as proof the unpinned cache matches the new tab", async () => {
    const rootPath = "/Users/me/ADE";
    const mac = {
      kind: "local",
      key: "local:/Users/me/ADE",
      rootPath,
      displayName: "ADE",
      gitOriginUrl: null,
    } satisfies OpenProjectBinding;
    const studio = {
      kind: "remote",
      key: "remote:studio:project-1",
      targetId: "studio",
      projectId: "project-1",
      rootPath,
      displayName: "Studio",
      runtimeName: "Studio",
    } satisfies OpenProjectBinding;
    const laptop = {
      kind: "remote",
      key: "remote:laptop:project-1",
      targetId: "laptop",
      projectId: "project-1",
      rootPath: "/Users/laptop/ADE",
      displayName: "Laptop",
      runtimeName: "Laptop",
    } satisfies OpenProjectBinding;
    const unauthed = {
      mode: "subscription",
      availableProviders: { claude: false, codex: false, cursor: false, droid: false },
      models: { claude: [], codex: [], cursor: [] },
      features: [],
      detectedAuth: [],
    };
    const authed = {
      ...unauthed,
      availableProviders: { claude: false, codex: false, cursor: true, droid: false },
    };
    const getStatus = vi.fn().mockResolvedValue(unauthed);
    const isOpenCodeInstalled = vi.fn().mockResolvedValue({ installed: false });
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: { ai: { getStatus, isOpenCodeInstalled } },
    });
    useAppStore.setState({
      project: {
        rootPath,
        displayName: "ADE",
        baseRef: "main",
      } satisfies ProjectInfo,
      projectBinding: mac,
    });
    await getAiStatusCached({ projectRoot: rootPath });
    getStatus.mockClear();
    getStatus.mockResolvedValue(authed);

    function Consumer({ pin }: { pin: OpenProjectBinding }) {
      const auth = useProviderAuthStatus({ runtimePin: pin });
      return React.createElement("div", null, `${auth.status.cursor ?? "empty"}:${String(auth.loaded)}`);
    }

    const { rerender } = render(React.createElement(Consumer, { pin: mac }));
    expect(await screen.findByText("unauthed:true")).toBeTruthy();

    rerender(React.createElement(Consumer, { pin: laptop }));
    await waitFor(() => {
      expect(getStatus).toHaveBeenCalled();
    });
    getStatus.mockClear();

    act(() => {
      useAppStore.setState({ projectBinding: studio });
    });
    rerender(React.createElement(Consumer, { pin: laptop }));
    await Promise.resolve();
    expect(getStatus).not.toHaveBeenCalled();

    rerender(React.createElement(Consumer, { pin: studio }));
    expect(await screen.findByText("ok:true")).toBeTruthy();
    expect(getStatus).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });

  it("does not re-probe OpenCode when the pin object is reallocated with the same key", async () => {
    const isOpenCodeInstalled = vi.fn().mockResolvedValue({ installed: true });
    const getStatus = vi.fn().mockResolvedValue({
      mode: "subscription",
      availableProviders: { claude: false, codex: false, cursor: false, droid: false },
      models: { claude: [], codex: [], cursor: [] },
      features: [],
      detectedAuth: [],
    });
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: { ai: { getStatus, isOpenCodeInstalled } },
    });
    const pinOf = () => ({
      kind: "remote" as const,
      key: "remote:studio:project-1",
      targetId: "studio",
      projectId: "project-1",
      rootPath: "/Users/studio/ADE",
      displayName: "Studio",
      runtimeName: "Studio",
    });

    function ChurnConsumer({ pin }: { pin: ReturnType<typeof pinOf> }) {
      const auth = useProviderAuthStatus({ runtimePin: pin });
      return React.createElement("div", null, String(auth.opencodeBinaryInstalled));
    }

    const { rerender } = render(React.createElement(ChurnConsumer, { pin: pinOf() }));
    await waitFor(() => {
      expect(isOpenCodeInstalled).toHaveBeenCalledTimes(1);
    });
    rerender(React.createElement(ChurnConsumer, { pin: pinOf() }));
    rerender(React.createElement(ChurnConsumer, { pin: pinOf() }));
    await Promise.resolve();
    expect(isOpenCodeInstalled).toHaveBeenCalledTimes(1);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it("applies AI-status cache events when project roots differ only by Windows path shape", async () => {
    const getStatus = vi.fn().mockResolvedValue({
      mode: "subscription",
      availableProviders: { claude: false, codex: true, cursor: false, droid: false },
      models: { claude: [], codex: [], cursor: [] },
      features: [],
      detectedAuth: [],
    });
    const isOpenCodeInstalled = vi.fn().mockResolvedValue({ installed: false });
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: { ai: { getStatus, isOpenCodeInstalled } },
    });
    useAppStore.setState({
      project: {
        rootPath: "C:\\Users\\me\\ADE",
        displayName: "ADE",
        baseRef: "main",
      } satisfies ProjectInfo,
      projectBinding: null,
    });

    function StatusConsumer() {
      const auth = useProviderAuthStatus();
      return React.createElement("div", null, `${auth.status.openai ?? "empty"}:${String(auth.loaded)}`);
    }

    render(React.createElement(StatusConsumer));
    expect(await screen.findByText("ok:true")).toBeTruthy();

    act(() => {
      window.dispatchEvent(new CustomEvent(AI_STATUS_CACHE_INVALIDATED_EVENT, {
        detail: { projectRoot: "c:/users/me/ADE", allProjects: false },
      }));
    });

    expect(await screen.findByText("empty:false")).toBeTruthy();
  });
});
