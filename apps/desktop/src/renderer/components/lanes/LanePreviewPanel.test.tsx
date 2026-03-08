/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanePreviewPanel } from "./LanePreviewPanel";
import type { LanePreviewInfo, LaneProxyEvent, ProxyStatus } from "../../../shared/types";

function setupWindowAde(overrides?: {
  proxyStatus?: ProxyStatus;
  previewInfo?: LanePreviewInfo | null;
  previewError?: Error;
}) {
  const proxyStatus: ProxyStatus = overrides?.proxyStatus ?? {
    running: true,
    proxyPort: 8080,
    routes: [],
    startedAt: "2026-03-08T00:00:00.000Z",
  };
  const previewInfo: LanePreviewInfo | null =
    overrides?.previewInfo ?? {
      laneId: "lane-1",
      hostname: "feature-alpha.localhost",
      previewUrl: "http://feature-alpha.localhost:8080",
      proxyPort: 8080,
      targetPort: 3000,
      active: true,
    };

  (window as any).ade = {
    lanes: {
      proxyGetStatus: vi.fn(async () => proxyStatus),
      proxyGetPreviewInfo: overrides?.previewError
        ? vi.fn(async () => {
            throw overrides.previewError;
          })
        : vi.fn(async () => previewInfo),
      proxyOpenPreview: vi.fn(async () => undefined),
      onProxyEvent: vi.fn((_cb: (event: LaneProxyEvent) => void) => () => undefined),
    },
    app: {
      writeClipboardText: vi.fn(async () => undefined),
      openExternal: vi.fn(async () => undefined),
    },
  };
}

describe("LanePreviewPanel", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
    delete (window as any).ade;
  });

  it("renders preview details and copies the generated URL", async () => {
    setupWindowAde();
    render(<LanePreviewPanel laneId="lane-1" />);

    await waitFor(() => {
      expect(screen.getByText("http://feature-alpha.localhost:8080")).toBeTruthy();
    });

    fireEvent.click(screen.getByTitle("Copy preview URL"));

    await waitFor(() => {
      expect((window as any).ade.app.writeClipboardText).toHaveBeenCalledWith(
        "http://feature-alpha.localhost:8080"
      );
    });

    expect(screen.getByText("Copied to clipboard")).toBeTruthy();
  });

  it("surfaces preview loading failures instead of silently swallowing them", async () => {
    setupWindowAde({ previewError: new Error("Preview unavailable.") });
    render(<LanePreviewPanel laneId="lane-1" />);

    await waitFor(() => {
      expect(screen.getByText("Preview unavailable.")).toBeTruthy();
    });
  });
});
