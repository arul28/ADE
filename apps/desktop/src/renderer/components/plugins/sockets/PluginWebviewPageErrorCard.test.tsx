/* @vitest-environment jsdom */

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { PluginWebviewPageErrorCard } from "./PluginWebviewPageErrorCard";

describe("plugin webview page error card", () => {
  it("draws the plugin name, the error, Reload and Open logs", () => {
    const onReload = vi.fn();
    const onOpenLogs = vi.fn();
    render(
      <PluginWebviewPageErrorCard
        pluginName="Acme"
        message="The page didn’t load."
        onReload={onReload}
        onOpenLogs={onOpenLogs}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Acme");
    expect(screen.getByText("The page didn’t load.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    fireEvent.click(screen.getByRole("button", { name: "Open logs" }));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onOpenLogs).toHaveBeenCalledTimes(1);
  });
});
