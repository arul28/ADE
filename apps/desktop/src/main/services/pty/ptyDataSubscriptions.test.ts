import type { WebContents } from "electron";
import { describe, expect, it } from "vitest";

import {
  setPtyDataSubscriptionsForSender,
  shouldSendPtyDataToWebContents,
} from "./ptyDataSubscriptions";

type TestWebContents = {
  id: number;
  once(event: string, listener: () => void): TestWebContents;
  destroyForTest(): void;
};

function createWebContents(id: number): WebContents & { destroyForTest(): void } {
  let onDestroyed: (() => void) | null = null;
  const sender: TestWebContents = {
    id,
    once(event: string, listener: () => void): TestWebContents {
      if (event === "destroyed") onDestroyed = listener;
      return sender;
    },
    destroyForTest(): void {
      onDestroyed?.();
    },
  };
  return sender as unknown as WebContents & { destroyForTest(): void };
}

describe("ptyDataSubscriptions", () => {
  it("filters registered subscribers without blocking unregistered windows", () => {
    const subscribed = createWebContents(9001);
    const unregistered = createWebContents(9002);

    setPtyDataSubscriptionsForSender(subscribed, new Set(["pty-visible"]));

    expect(shouldSendPtyDataToWebContents(subscribed, "pty-visible")).toBe(true);
    expect(shouldSendPtyDataToWebContents(subscribed, "pty-hidden")).toBe(false);
    expect(shouldSendPtyDataToWebContents(unregistered, "pty-hidden")).toBe(true);

    subscribed.destroyForTest();
  });
});
