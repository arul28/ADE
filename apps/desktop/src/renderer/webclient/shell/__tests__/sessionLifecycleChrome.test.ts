/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncRemoteCommandDescriptor } from "../../../../shared/types/sync";
import type { AdeSyncClient } from "../../sync";
import {
  LONG_PRESS_MS,
  SESSION_LIFECYCLE_ATTRIBUTE,
  installSessionLifecycleChrome,
} from "../sessionLifecycleChrome";

function descriptors(actions: string[]): SyncRemoteCommandDescriptor[] {
  return actions.map((action) => ({ action, scope: "project", policy: { viewerAllowed: true } }));
}

const FULL_LIFECYCLE = ["session.settleSession", "session.snoozeSession", "session.wakeSession"];

class FakeClient {
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
    return this as never as Pick<AdeSyncClient, "getCommandDescriptors" | "subscribe">;
  }
}

describe("installSessionLifecycleChrome", () => {
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it("marks the document unsupported until the host advertises the session commands", () => {
    const client = new FakeClient();
    dispose = installSessionLifecycleChrome(client.asClient());

    expect(document.documentElement.getAttribute(SESSION_LIFECYCLE_ATTRIBUTE)).toBe("unsupported");

    // A reconnect can land on a different ADE version, so the flag re-reads the
    // advertised list on every status change rather than only at install.
    client.advertised = descriptors(FULL_LIFECYCLE);
    client.emitStatus();
    expect(document.documentElement.getAttribute(SESSION_LIFECYCLE_ATTRIBUTE)).toBe("ready");

    client.advertised = descriptors(["work.listSessions"]);
    client.emitStatus();
    expect(document.documentElement.getAttribute(SESSION_LIFECYCLE_ATTRIBUTE)).toBe("unsupported");
  });

  it("installs one stylesheet that reveals and enlarges the control on coarse pointers", () => {
    const client = new FakeClient();
    client.advertised = descriptors(FULL_LIFECYCLE);
    dispose = installSessionLifecycleChrome(client.asClient());
    const secondInstall = installSessionLifecycleChrome(client.asClient());

    const styles = document.head.querySelectorAll("style#ade-web-session-lifecycle");
    expect(styles).toHaveLength(1);
    const css = styles[0]!.textContent ?? "";
    expect(css).toContain("@media (pointer: coarse)");
    expect(css).toContain('[data-testid="session-snooze-button"]');
    expect(css).toContain("pointer-events: auto");
    expect(css).toContain("display: none");

    secondInstall();
  });

  it("removes the flag and the stylesheet on dispose", () => {
    const client = new FakeClient();
    client.advertised = descriptors(FULL_LIFECYCLE);
    installSessionLifecycleChrome(client.asClient())();

    expect(document.documentElement.hasAttribute(SESSION_LIFECYCLE_ATTRIBUTE)).toBe(false);
    expect(document.head.querySelector("style#ade-web-session-lifecycle")).toBeNull();
  });
});

describe("long-press context menu bridge", () => {
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

  /** Minimal stand-in for a shared Work row: a card containing the control. */
  function renderRow(): { row: HTMLElement; title: HTMLElement; contextMenus: MouseEvent[] } {
    document.body.innerHTML = `
      <div id="row">
        <button id="title" type="button">Session one</button>
        <div><button data-testid="session-snooze-button" type="button">Snooze</button></div>
      </div>
    `;
    const row = document.getElementById("row") as HTMLElement;
    const contextMenus: MouseEvent[] = [];
    row.addEventListener("contextmenu", (event) => contextMenus.push(event as MouseEvent));
    return { row, title: document.getElementById("title") as HTMLElement, contextMenus };
  }

  function press(target: HTMLElement, init: Partial<PointerEventInit> = {}): void {
    // jsdom has no PointerEvent constructor; a MouseEvent carrying the pointer
    // fields is enough for the listener under test.
    const event = new MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10, ...init });
    Object.assign(event, { pointerType: "touch", isPrimary: true, ...init });
    target.dispatchEvent(event);
  }

  it("synthesises a contextmenu after a hold so touch reaches Settle and Keep active", () => {
    vi.useFakeTimers();
    coarsePointer(true);
    const client = new FakeClient();
    client.advertised = descriptors(FULL_LIFECYCLE);
    dispose = installSessionLifecycleChrome(client.asClient());
    const { title, contextMenus } = renderRow();

    press(title);
    vi.advanceTimersByTime(LONG_PRESS_MS + 1);

    expect(contextMenus).toHaveLength(1);
    expect(contextMenus[0]!.clientX).toBe(10);
  });

  it("treats a moved finger as a scroll, not a press", () => {
    vi.useFakeTimers();
    coarsePointer(true);
    const client = new FakeClient();
    dispose = installSessionLifecycleChrome(client.asClient());
    const { title, contextMenus } = renderRow();

    press(title);
    const move = new MouseEvent("pointermove", { bubbles: true, clientX: 10, clientY: 90 });
    document.dispatchEvent(move);
    vi.advanceTimersByTime(LONG_PRESS_MS + 1);

    expect(contextMenus).toEqual([]);
  });

  it("ignores holds on the control's own button and on precise pointers", () => {
    vi.useFakeTimers();
    coarsePointer(true);
    const client = new FakeClient();
    dispose = installSessionLifecycleChrome(client.asClient());
    const { contextMenus } = renderRow();

    press(document.querySelector("[data-testid='session-snooze-button']") as HTMLElement);
    vi.advanceTimersByTime(LONG_PRESS_MS + 1);
    expect(contextMenus).toEqual([]);

    dispose();
    coarsePointer(false);
    dispose = installSessionLifecycleChrome(client.asClient());
    press(document.getElementById("title") as HTMLElement);
    vi.advanceTimersByTime(LONG_PRESS_MS + 1);
    expect(contextMenus).toEqual([]);
  });
});
