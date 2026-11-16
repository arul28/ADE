import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderCard, truncateBinaryPath } from "../src/models/ProviderCard";
import type { ProviderStatus } from "../src/sdkTypes";

/**
 * The card makes a claim about the user's machine, and it must only make one it
 * can support. "Not installed" is a filesystem fact; a status derived from the
 * model catalog never established it, and telling someone to install a CLI they
 * already have is the exact failure this distinction removes.
 */

function status(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    id: "claude",
    displayName: "Claude",
    installed: false,
    authenticated: false,
    ...overrides,
  };
}

describe("<ProviderCard> wording", () => {
  it("says Not installed when a runtime probed and found nothing", () => {
    render(<ProviderCard status={status({ source: "probed" })} />);
    expect(screen.getByText("Not installed")).toBeTruthy();
  });

  it("says Not detected when nobody probed", () => {
    render(<ProviderCard status={status({ source: "derived" })} />);
    expect(screen.getByText("Not detected")).toBeTruthy();
    expect(screen.queryByText("Not installed")).toBeNull();
  });

  it("keeps the signed-in and signed-out wording regardless of source", () => {
    const { unmount } = render(
      <ProviderCard status={status({ installed: true, source: "derived" })} />,
    );
    expect(screen.getByText("Not signed in")).toBeTruthy();
    unmount();

    render(
      <ProviderCard
        status={status({ installed: true, authenticated: true, source: "derived" })}
      />,
    );
    expect(screen.getByText("Ready")).toBeTruthy();
  });
});

describe("truncateBinaryPath", () => {
  it("leaves a path that already fits alone", () => {
    expect(truncateBinaryPath("/usr/local/bin/codex")).toBe("/usr/local/bin/codex");
  });

  it("never cuts the basename, because that is what identifies the binary", () => {
    const truncated = truncateBinaryPath(
      "/Users/someone/Library/Application Support/host/node_modules/.bin/claude",
    );
    expect(truncated.endsWith("/claude")).toBe(true);
    expect(truncated).toContain("…");
    expect(truncated.length).toBeLessThanOrEqual(44);
  });

  it("handles Windows separators", () => {
    const truncated = truncateBinaryPath(
      "C:\\Users\\someone\\AppData\\Roaming\\npm\\node_modules\\.bin\\claude.cmd",
    );
    expect(truncated.endsWith("\\claude.cmd")).toBe(true);
  });

  it("truncates from the front when the whole path is one long segment", () => {
    const truncated = truncateBinaryPath("a".repeat(80));
    expect(truncated.startsWith("…")).toBe(true);
    expect(truncated.length).toBeLessThanOrEqual(44);
  });
});
