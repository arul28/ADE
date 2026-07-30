/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AutoUpdatesSection } from "./AutoUpdatesSection";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ade");
});

describe("AutoUpdatesSection", () => {
  it("defaults automatic installs off and reveals the idle safety option when enabled", async () => {
    const updateGetPreferences = vi.fn(async () => ({
      automaticInstall: false,
      onlyWhenIdle: true,
    }));
    const updateSetPreferences = vi.fn(async () => ({
      automaticInstall: true,
      onlyWhenIdle: true,
    }));
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { updateGetPreferences, updateSetPreferences },
    });

    render(<AutoUpdatesSection />);

    const automaticInstall = await screen.findByRole("switch", {
      name: "Install ADE updates automatically",
    });
    expect(automaticInstall.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("switch", {
      name: "Wait until active work finishes",
    })).toBeNull();

    fireEvent.click(automaticInstall);

    await waitFor(() => expect(updateSetPreferences).toHaveBeenCalledWith({
      automaticInstall: true,
      onlyWhenIdle: true,
    }));
    const onlyWhenIdle = await screen.findByRole("switch", {
      name: "Wait until active work finishes",
    });
    expect(onlyWhenIdle.getAttribute("aria-checked")).toBe("true");
  });

  it("persists an explicit opt-out from the idle safety option", async () => {
    const updateSetPreferences = vi.fn(async () => ({
      automaticInstall: true,
      onlyWhenIdle: false,
    }));
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        updateGetPreferences: vi.fn(async () => ({
          automaticInstall: true,
          onlyWhenIdle: true,
        })),
        updateSetPreferences,
      },
    });

    render(<AutoUpdatesSection />);

    const onlyWhenIdle = await screen.findByRole("switch", {
      name: "Wait until active work finishes",
    });
    expect(onlyWhenIdle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(onlyWhenIdle);

    await waitFor(() => expect(updateSetPreferences).toHaveBeenCalledWith({
      automaticInstall: true,
      onlyWhenIdle: false,
    }));
    expect(onlyWhenIdle.getAttribute("aria-checked")).toBe("false");
  });
});
