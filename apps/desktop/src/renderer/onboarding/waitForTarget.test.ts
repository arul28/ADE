/* @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { waitForSelector } from "./waitForTarget";

describe("waitForSelector", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("resolves true immediately when the element is already present", async () => {
    const el = document.createElement("div");
    el.id = "already-here";
    document.body.appendChild(el);

    const result = await waitForSelector("#already-here", { timeoutMs: 500 });
    expect(result).toBe(true);
  });

  it("resolves true when the element mounts after a delay", async () => {
    const pending = waitForSelector("#late", { timeoutMs: 2000, pollMs: 10 });
    setTimeout(() => {
      const el = document.createElement("div");
      el.id = "late";
      document.body.appendChild(el);
    }, 100);
    const result = await pending;
    expect(result).toBe(true);
  });

  it("resolves false when the element never appears within timeoutMs", async () => {
    const result = await waitForSelector("#never", {
      timeoutMs: 120,
      pollMs: 20,
    });
    expect(result).toBe(false);
  });

  it("resolves false when the abort signal fires", async () => {
    const controller = new AbortController();
    const pending = waitForSelector("#never-either", {
      timeoutMs: 5000,
      pollMs: 20,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(result).toBe(false);
  });
});
