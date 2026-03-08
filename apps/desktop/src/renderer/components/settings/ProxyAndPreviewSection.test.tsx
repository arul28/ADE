/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProxyAndPreviewSection } from "./ProxyAndPreviewSection";
import type {
  LaneProxyEvent,
  OAuthRedirectEvent,
  OAuthRedirectStatus,
  OAuthSession,
  ProxyStatus,
  RedirectUriInfo,
} from "../../../shared/types";

type BridgeOptions = {
  oauthStatus?: OAuthRedirectStatus;
  redirectUris?: RedirectUriInfo[];
  redirectUriError?: Error;
  clipboardError?: Error;
  sessions?: OAuthSession[];
};

function setupWindowAde(options: BridgeOptions = {}) {
  const proxyStatus: ProxyStatus = {
    running: true,
    proxyPort: 8080,
    routes: [],
    startedAt: "2026-03-08T00:00:00.000Z",
  };

  const oauthStatus: OAuthRedirectStatus = options.oauthStatus ?? {
    enabled: true,
    routingMode: "state-parameter",
    activeSessions: [],
    callbackPaths: ["/oauth/callback", "/auth/callback"],
  };

  const redirectUris: RedirectUriInfo[] = options.redirectUris ?? [
    {
      provider: "Generic",
      uris: ["http://localhost:8080/oauth/callback"],
      instructions: "Use this redirect URI with your OAuth provider.",
    },
  ];

  let proxyListener: ((event: LaneProxyEvent) => void) | null = null;
  let oauthListener: ((event: OAuthRedirectEvent) => void) | null = null;

  (window as any).ade = {
    lanes: {
      proxyGetStatus: vi.fn(async () => proxyStatus),
      proxyStart: vi.fn(async () => proxyStatus),
      proxyStop: vi.fn(async () => undefined),
      onProxyEvent: vi.fn((cb: (event: LaneProxyEvent) => void) => {
        proxyListener = cb;
        return () => {
          proxyListener = null;
        };
      }),
      oauthGetStatus: vi.fn(async () => oauthStatus),
      oauthUpdateConfig: vi.fn(async () => undefined),
      oauthGenerateRedirectUris: options.redirectUriError
        ? vi.fn(async () => {
            throw options.redirectUriError;
          })
        : vi.fn(async () => redirectUris),
      oauthListSessions: vi.fn(async () => options.sessions ?? []),
      onOAuthEvent: vi.fn((cb: (event: OAuthRedirectEvent) => void) => {
        oauthListener = cb;
        return () => {
          oauthListener = null;
        };
      }),
    },
    app: {
      writeClipboardText: options.clipboardError
        ? vi.fn(async () => {
            throw options.clipboardError;
          })
        : vi.fn(async () => undefined),
    },
  };

  return {
    emitProxyEvent(event: LaneProxyEvent) {
      proxyListener?.(event);
    },
    emitOAuthEvent(event: OAuthRedirectEvent) {
      oauthListener?.(event);
    },
  };
}

describe("ProxyAndPreviewSection", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
    delete (window as any).ade;
    vi.restoreAllMocks();
  });

  it("preserves unsaved advanced edits when background OAuth session events arrive", async () => {
    const { emitOAuthEvent } = setupWindowAde();
    render(<ProxyAndPreviewSection />);

    await waitFor(() => {
      expect(screen.getByText("Automatic OAuth Routing")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /advanced settings/i }));

    const input = screen.getByLabelText("CALLBACK PATHS") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/custom/callback" } });
    expect(input.value).toBe("/custom/callback");

    emitOAuthEvent({
      type: "oauth-session-started",
      status: {
        enabled: true,
        routingMode: "state-parameter",
        activeSessions: [],
        callbackPaths: ["/oauth/callback", "/auth/callback"],
      },
      session: {
        id: "oauth-1",
        laneId: "lane-1",
        status: "active",
        callbackPath: "/oauth/callback",
        createdAt: "2026-03-08T00:00:01.000Z",
      },
    });

    expect(input.value).toBe("/custom/callback");
  });

  it("surfaces redirect URI loading failures without a misleading proxy hint", async () => {
    setupWindowAde({ redirectUriError: new Error("Bridge offline.") });
    render(<ProxyAndPreviewSection />);

    await waitFor(() => {
      expect(screen.getByText("Bridge offline.")).toBeTruthy();
    });

    expect(screen.queryByText(/Ensure the proxy is running/i)).toBeNull();
    expect(
      (screen.getByRole("switch", { name: /automatic oauth routing/i }) as HTMLButtonElement).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    expect((screen.getByLabelText("PROVIDER") as HTMLSelectElement).value).toBe(
      "Generic",
    );
  });

  it("shows clipboard failures inline on the copy action", async () => {
    setupWindowAde({ clipboardError: new Error("Clipboard unavailable.") });
    render(<ProxyAndPreviewSection />);

    await waitFor(() => {
      expect(screen.getByText("http://localhost:8080/oauth/callback")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /copy redirect uri/i }));

    await waitFor(() => {
      expect(screen.getByText("Clipboard unavailable.")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: /copy redirect uri/i }).textContent).toContain(
      "RETRY",
    );
  });
});
