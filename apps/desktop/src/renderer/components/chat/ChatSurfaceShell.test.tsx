/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatSurfaceShell } from "./ChatSurfaceShell";

describe("ChatSurfaceShell", () => {
  afterEach(() => {
    cleanup();
  });

  it("wraps content in a scale transform when contentScale is not 1", () => {
    const { container } = render(
      <ChatSurfaceShell mode="standard" contentScale={1.5}>
        <div data-testid="child">hello</div>
      </ChatSurfaceShell>,
    );
    const scaled = container.querySelector('[style*="scale(1.5)"]');
    expect(scaled).toBeTruthy();
    expect(screen.getByTestId("child")).toBeTruthy();
  });

  it("does not add an extra scale wrapper when contentScale is 1", () => {
    const { container } = render(
      <ChatSurfaceShell mode="standard" contentScale={1}>
        <div data-testid="child">hello</div>
      </ChatSurfaceShell>,
    );
    expect(container.querySelector('[style*="scale(1)"]')).toBeNull();
    expect(screen.getByTestId("child")).toBeTruthy();
  });
});
