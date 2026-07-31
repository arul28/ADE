/* @vitest-environment jsdom */
// @vitest-environment-options {"url":"https://app.ade-app.dev/"}

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DeeplinkTarget } from "../../../../shared/deeplinks";
import type { SyncRemoteCommandDescriptor } from "../../../../shared/types/sync";
import type { BrowserAccountClient, BrowserAccountSnapshot } from "../../account/client";
import type {
  AdeSyncClient,
  AdeSyncClientStatus,
  WebClientEnvironmentPruneResult,
  WebClientEnvironmentRecord,
} from "../../sync";
import { WebClientRoot } from "../WebClientRoot";
import {
  LONG_PRESS_MS,
  SESSION_LIFECYCLE_ATTRIBUTE,
  installSessionLifecycleChrome,
} from "../sessionLifecycleChrome";
import { parseOpenTarget, parseWebPath, targetToWebPath } from "../webRoutes";

const mocks = vi.hoisted(() => {
  const federated = {
    ade: {} as Window["ade"],
    restore: vi.fn<[], Promise<unknown>>(),
    dispose: vi.fn(),
    getOpenBindings: vi.fn(() => []),
    getActiveBinding: vi.fn(() => null),
    getSelectedHubTargetId: vi.fn(() => null),
    setSelectedHubTargetId: vi.fn(),
    getSelectedChatsTargetId: vi.fn(() => null),
    openProject: vi.fn(),
    activateChats: vi.fn(),
    subscribeActiveAdapter: vi.fn(() => () => undefined),
  };
  return {
    federated,
    createFederatedAdapter: vi.fn<[{
      manager: { listEnvironments(): WebClientEnvironmentRecord[] };
    }], typeof federated>(() => federated),
  };
});

const { federated, createFederatedAdapter } = mocks;

vi.mock("../../adapter/federated", () => ({
  createFederatedWebAdapter: mocks.createFederatedAdapter,
}));

vi.mock("../../../components/app/App", () => ({
  App: () => <div data-testid="app-root">{window.location.pathname}</div>,
}));

vi.mock("../../../components/app/RendererErrorBoundary", () => ({
  RendererErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("../../../state/appStore", () => ({
  useAppStore: {
    getState: () => ({
      applyAutoSizeChatFontOnLargeScreenIfNotOverridden: () => undefined,
    }),
  },
}));

const signedOutAccount: BrowserAccountSnapshot = {
  state: "signed_out",
  userId: null,
  email: null,
  name: null,
  imageUrl: null,
  expiresAt: null,
  machines: [],
  relayBaseUrls: ["wss://relay.example"],
  message: null,
};

const signedInAccount: BrowserAccountSnapshot = {
  ...signedOutAccount,
  state: "signed_in",
  userId: "account-current",
  email: "owner@example.test",
};

const idleStatus: AdeSyncClientStatus = {
  state: "idle",
  endpoint: null,
  envId: null,
  hostDeviceId: null,
  hostName: null,
  connectedAt: null,
  lastSeenAt: null,
  error: null,
  activeProjectId: null,
  selectedEnvId: null,
  readiness: "disconnected",
};

function environment(overrides: Partial<WebClientEnvironmentRecord> = {}): WebClientEnvironmentRecord {
  return {
    envId: "saved-local",
    machineName: "Current saved Mac",
    hostDeviceId: "saved-device",
    accountOwnerUserId: null,
    relayUrl: null,
    machineKeyUrl: null,
    addressCandidates: [],
    explicitWssEndpoints: ["wss://saved.example.test/sync"],
    port: 8787,
    pairedDeviceId: "browser-device",
    secret: "secret",
    dpopKeys: {} as CryptoKeyPair,
    siteId: "site-id",
    localDeviceId: "browser-device",
    localDeviceName: "ADE Web",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function syncClient(
  overrides: Partial<Record<keyof AdeSyncClient, unknown>> = {},
): AdeSyncClient {
  return {
    getStatus: () => idleStatus,
    listEnvironments: vi.fn(async () => []),
    pruneAccountOwnedEnvironments: vi.fn(async (): Promise<WebClientEnvironmentPruneResult> => ({
      removedIds: [],
      environments: [],
    })),
    subscribe: vi.fn(() => () => undefined),
    getCommandDescriptors: vi.fn(() => []),
    onProjectCatalog: vi.fn(() => () => undefined),
    onActiveProjectChanged: vi.fn(() => () => undefined),
    disconnect: vi.fn(),
    ...overrides,
  } as unknown as AdeSyncClient;
}

function accountClient(
  snapshot: BrowserAccountSnapshot,
  overrides: Partial<Record<keyof BrowserAccountClient, unknown>> = {},
): BrowserAccountClient {
  return {
    getSnapshot: () => snapshot,
    bootstrap: vi.fn(async () => snapshot),
    getAccessToken: vi.fn(async () => "token"),
    ...overrides,
  } as unknown as BrowserAccountClient;
}

beforeEach(() => {
  federated.restore.mockResolvedValue(null);
  federated.dispose.mockReset();
  createFederatedAdapter.mockClear();
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  sessionStorage.clear();
});

describe("WebClientRoot workspace bootstrap", () => {
  it("retires the pairing route and opens the permanent Hub", async () => {
    window.history.replaceState(null, "", "/pair#legacy-pairing-payload");

    render(
      <WebClientRoot
        client={syncClient()}
        accountClient={accountClient(signedOutAccount)}
      />,
    );

    expect((await screen.findByTestId("app-root")).textContent).toBe("/hub");
    expect(window.location.hash).toBe("");
    expect(createFederatedAdapter).toHaveBeenCalledOnce();
  });

  it("shows callback progress until account bootstrap completes", async () => {
    window.history.replaceState(null, "", "/account/callback?code=test&state=test");
    let resolveBootstrap!: (snapshot: BrowserAccountSnapshot) => void;
    const bootstrap = vi.fn(() => new Promise<BrowserAccountSnapshot>((resolve) => {
      resolveBootstrap = resolve;
    }));

    render(
      <WebClientRoot
        client={syncClient()}
        accountClient={accountClient(signedOutAccount, { bootstrap })}
      />,
    );

    expect(screen.getByRole("heading", { name: "Signing in…" })).toBeTruthy();
    resolveBootstrap(signedInAccount);
    expect((await screen.findByTestId("app-root")).textContent).toBe("/hub");
  });

  it("prunes account-owned browser trust before publishing environments", async () => {
    const surviving = environment({ accountOwnerUserId: "account-current" });
    const pruneAccountOwnedEnvironments = vi.fn(async () => ({
      removedIds: ["previous-account"],
      environments: [surviving],
    }));

    render(
      <WebClientRoot
        client={syncClient({ pruneAccountOwnedEnvironments })}
        accountClient={accountClient(signedInAccount)}
      />,
    );

    await screen.findByTestId("app-root");
    expect(pruneAccountOwnedEnvironments).toHaveBeenCalledWith("account-current");
    const manager = createFederatedAdapter.mock.calls[0]?.[0]?.manager;
    expect(manager.listEnvironments()).toEqual([surviving]);
  });

  it("restores the active repository before replaying its app route", async () => {
    window.history.replaceState(null, "", "/lanes?laneId=lane-1");
    federated.restore.mockResolvedValue({
      kind: "remote",
      key: "remote:machine:project",
    });

    render(
      <WebClientRoot
        client={syncClient()}
        accountClient={accountClient(signedOutAccount)}
      />,
    );

    expect((await screen.findByTestId("app-root")).textContent).toBe("/lanes");
    expect(window.location.search).toBe("?laneId=lane-1");
  });

  it("keeps browser storage failure non-fatal", async () => {
    const pruneAccountOwnedEnvironments = vi.fn(async () => {
      throw new Error("IndexedDB blocked");
    });

    render(
      <WebClientRoot
        client={syncClient({ pruneAccountOwnedEnvironments })}
        accountClient={accountClient(signedOutAccount)}
      />,
    );

    expect((await screen.findByTestId("app-root")).textContent).toBe("/hub");
    expect(createFederatedAdapter).toHaveBeenCalledOnce();
  });

  it("keeps a fresh-browser deeplink pending while the Hub chooses a project", async () => {
    window.history.replaceState(null, "", "/work?sessionId=session-1");

    render(
      <WebClientRoot
        client={syncClient()}
        accountClient={accountClient(signedOutAccount)}
      />,
    );

    expect((await screen.findByTestId("app-root")).textContent).toBe("/hub");
    expect(sessionStorage.getItem("ade-web:pending-target")).toContain("session-1");
  });

  it("boots the Hub under React strict mode", async () => {
    render(
      <React.StrictMode>
        <WebClientRoot
          client={syncClient()}
          accountClient={accountClient(signedOutAccount)}
        />
      </React.StrictMode>,
    );

    expect((await screen.findByTestId("app-root")).textContent).toBe("/hub");
  });
});

describe("web route translation", () => {
  const targets: DeeplinkTarget[] = [
    { kind: "lane", laneId: "11111111-2222-3333-4444-555555555555" },
    { kind: "session", sessionId: "sess-abc123" },
    {
      kind: "session",
      sessionId: "sess-abc123",
      laneId: "11111111-2222-3333-4444-555555555555",
    },
    { kind: "pr", repoOwner: "arul", repoName: "ade", prNumber: 708 },
    {
      kind: "branch",
      repoOwner: "arul",
      repoName: "ade",
      branch: "feature/web-shell",
      prNumber: 42,
    },
    { kind: "linear-issue", issueIdentifier: "ADE-123", branch: "arul/ade-123" },
  ];

  it("round-trips every supported deeplink shape through shared App routes", () => {
    const paths = targets.map(targetToWebPath);
    expect(paths.map(parseWebPath)).toEqual(targets);
    expect(paths[0]).toBe("/lanes?laneId=11111111-2222-3333-4444-555555555555");
    expect(paths[1]).toBe("/work?sessionId=sess-abc123");
  });

  it("preserves repository identity for PR routes while ignoring desktop-only extras", () => {
    const path = targetToWebPath({
      kind: "pr",
      repoOwner: "arul",
      repoName: "ade",
      prNumber: 708,
    });
    const url = new URL(path, "https://x.invalid");
    expect(url.pathname).toBe("/prs");
    expect(url.searchParams.get("repoOwner")).toBe("arul");
    expect(parseWebPath(`${path}&prId=abc&laneId=x`)).toEqual({
      kind: "pr",
      repoOwner: "arul",
      repoName: "ade",
      prNumber: 708,
    });
  });

  it("rejects routes that do not identify an addressable object", () => {
    expect(parseWebPath("/work")).toBeNull();
    expect(parseWebPath("/files")).toBeNull();
    expect(parseWebPath("/prs?pr=abc&repoOwner=a&repoName=b")).toBeNull();
  });

  it("parses hosted open URLs, bare queries, and rejects unknown targets", () => {
    expect(parseOpenTarget(
      "https://app.ade-app.dev/open?type=session&id=sess-1",
    )).toEqual({ kind: "session", sessionId: "sess-1" });
    expect(parseOpenTarget("?type=pr&repo=arul/ade&number=708")).toEqual({
      kind: "pr",
      repoOwner: "arul",
      repoName: "ade",
      prNumber: 708,
    });
    expect(parseOpenTarget("?type=bogus&id=1")).toBeNull();
  });
});

function descriptors(actions: string[]): SyncRemoteCommandDescriptor[] {
  return actions.map((action) => ({
    action,
    scope: "project",
    policy: { viewerAllowed: true },
  }));
}

const FULL_LIFECYCLE = [
  "session.settleSession",
  "session.snoozeSession",
  "session.wakeSession",
];

class FakeLifecycleClient {
  advertised: SyncRemoteCommandDescriptor[] = [];
  private readonly listeners = new Set<() => void>();

  getCommandDescriptors(): SyncRemoteCommandDescriptor[] {
    return this.advertised;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitStatus(): void {
    for (const listener of this.listeners) listener();
  }

  asClient(): Pick<AdeSyncClient, "getCommandDescriptors" | "subscribe"> {
    return this as Pick<AdeSyncClient, "getCommandDescriptors" | "subscribe">;
  }
}

describe("session lifecycle chrome", () => {
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function coarsePointer(matches: boolean): void {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("coarse") ? matches : false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  }

  function renderLifecycleRow(): {
    title: HTMLElement;
    contextMenus: MouseEvent[];
  } {
    document.body.innerHTML = `
      <div id="row">
        <button id="title" type="button">Session one</button>
        <div><button data-testid="session-snooze-button" type="button">Snooze</button></div>
      </div>
    `;
    const row = document.getElementById("row") as HTMLElement;
    const contextMenus: MouseEvent[] = [];
    row.addEventListener("contextmenu", (event) => contextMenus.push(event as MouseEvent));
    return {
      title: document.getElementById("title") as HTMLElement,
      contextMenus,
    };
  }

  function press(target: HTMLElement): void {
    const event = new MouseEvent("pointerdown", {
      bubbles: true,
      clientX: 10,
      clientY: 10,
    });
    Object.assign(event, { pointerType: "touch", isPrimary: true });
    target.dispatchEvent(event);
  }

  it("tracks lifecycle support across reconnects", () => {
    const client = new FakeLifecycleClient();
    dispose = installSessionLifecycleChrome(client.asClient());
    expect(document.documentElement.getAttribute(SESSION_LIFECYCLE_ATTRIBUTE))
      .toBe("unsupported");

    client.advertised = descriptors(FULL_LIFECYCLE);
    client.emitStatus();
    expect(document.documentElement.getAttribute(SESSION_LIFECYCLE_ATTRIBUTE))
      .toBe("ready");

    client.advertised = descriptors(["work.listSessions"]);
    client.emitStatus();
    expect(document.documentElement.getAttribute(SESSION_LIFECYCLE_ATTRIBUTE))
      .toBe("unsupported");
  });

  it("installs one coarse-pointer stylesheet and removes it on dispose", () => {
    const client = new FakeLifecycleClient();
    client.advertised = descriptors(FULL_LIFECYCLE);
    dispose = installSessionLifecycleChrome(client.asClient());
    const secondDispose = installSessionLifecycleChrome(client.asClient());
    const styles = document.head.querySelectorAll("style#ade-web-session-lifecycle");
    const css = styles[0]?.textContent ?? "";

    expect(styles).toHaveLength(1);
    expect(css).toContain("@media (pointer: coarse)");
    expect(css).toContain("pointer-events: auto");

    secondDispose();
    dispose();
    dispose = null;
    expect(document.documentElement.hasAttribute(SESSION_LIFECYCLE_ATTRIBUTE)).toBe(false);
    expect(document.head.querySelector("style#ade-web-session-lifecycle")).toBeNull();
  });

  it("opens the row context menu after a touch hold", () => {
    vi.useFakeTimers();
    coarsePointer(true);
    const client = new FakeLifecycleClient();
    client.advertised = descriptors(FULL_LIFECYCLE);
    dispose = installSessionLifecycleChrome(client.asClient());
    const { title, contextMenus } = renderLifecycleRow();

    press(title);
    vi.advanceTimersByTime(LONG_PRESS_MS + 1);

    expect(contextMenus).toHaveLength(1);
    expect(contextMenus[0]?.clientX).toBe(10);
    expect(contextMenus[0]?.button).toBe(2);
  });

  it("does not treat a scroll, control press, or precise pointer as a hold", () => {
    vi.useFakeTimers();
    coarsePointer(true);
    const client = new FakeLifecycleClient();
    dispose = installSessionLifecycleChrome(client.asClient());
    const { title, contextMenus } = renderLifecycleRow();

    press(title);
    document.dispatchEvent(new MouseEvent("pointermove", {
      bubbles: true,
      clientX: 10,
      clientY: 90,
    }));
    vi.advanceTimersByTime(LONG_PRESS_MS + 1);
    press(document.querySelector("[data-testid='session-snooze-button']") as HTMLElement);
    vi.advanceTimersByTime(LONG_PRESS_MS + 1);

    dispose();
    coarsePointer(false);
    dispose = installSessionLifecycleChrome(client.asClient());
    press(title);
    vi.advanceTimersByTime(LONG_PRESS_MS + 1);

    expect(contextMenus).toEqual([]);
    expect(document.documentElement.getAttribute(SESSION_LIFECYCLE_ATTRIBUTE))
      .toBe("unsupported");
    expect(document.querySelector("[data-testid='session-snooze-button']")).not.toBeNull();
  });
});
