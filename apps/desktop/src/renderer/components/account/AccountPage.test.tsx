/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SignInCard } from "./AccountPage";

const beginLogin = vi.fn(async () => undefined);

vi.mock("../../lib/accountLogin", () => ({
  useAccountLogin: () => ({
    phase: "idle",
    error: null,
    beginLogin,
    cancel: vi.fn(),
  }),
}));

describe("AccountPage signed-out card", () => {
  afterEach(() => {
    cleanup();
    beginLogin.mockClear();
  });

  it("presents one truthful browser action with combined account language", () => {
    render(<SignInCard configured onSignedIn={vi.fn()} />);

    expect(screen.getByText("Continue to ADE")).toBeTruthy();
    expect(screen.getByText(/account is created automatically/i)).toBeTruthy();
    expect(screen.getByText(/browser page offers the sign-in methods enabled for ADE/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Continue with/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue in browser" }));
    expect(beginLogin).toHaveBeenCalledTimes(1);
  });

  it("keeps local pairing explicitly available without an account", () => {
    render(<SignInCard configured={false} onSignedIn={vi.fn()} />);

    expect(screen.getByText(/Account access isn't set up on this machine yet/i)).toBeTruthy();
    expect(screen.getByText("Local pairing works without an account.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue in browser" }).hasAttribute("disabled")).toBe(true);
  });
});
