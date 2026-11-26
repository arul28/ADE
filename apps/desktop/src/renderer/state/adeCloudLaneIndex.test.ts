/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudMachine } from "../../shared/adeCloud";

const LANES_KEY = "ade.cloudLaneComputers.v1";
const COMPUTERS_KEY = "ade.cloudComputerIds.v1";
const originalAde = globalThis.window.ade;

let signedInAs: string | null = "user-a";

function laneMachine(instanceId: string, laneName: string): CloudMachine {
  return {
    instanceId,
    machineKey: `mk-${instanceId}`,
    state: "asleep",
    lane: { laneId: `lane-${instanceId}`, laneName, projectOrigin: "github.com/acme/app" },
  } as unknown as CloudMachine;
}

/** A fresh window (a reload): the modules load again and read this computer's storage. */
async function openWindow() {
  vi.resetModules();
  const account = await import("../lib/account");
  const index = await import("./adeCloudLaneIndex");
  const machines = await import("../components/remoteTargets/useCloudMachines");
  const settle = async () => {
    await account.fetchAccountStatus({ force: true });
    await new Promise((done) => setTimeout(done, 0));
  };
  await settle();
  return {
    laneNames: () => index.adeCloudLaneComputersNow().map((computer) => computer.laneName),
    note: index.noteCloudLaneMachines,
    readAccountMachines: machines.refreshCloudMachines,
    isCloudComputer: (instanceId: string) => index.isAdeCloudComputer({ hostname: instanceId }),
    signInAs: async (userId: string | null) => {
      signedInAs = userId;
      await settle();
    },
  };
}

beforeEach(() => {
  signedInAs = "user-a";
  window.localStorage.clear();
  window.__adeWebClient = undefined;
  globalThis.window.ade = {
    account: {
      status: vi.fn(async () => signedInAs
        ? { signedIn: true, userId: signedInAs, email: null, name: null, expiresAt: null, provider: null, imageUrl: null, sessionState: "active" }
        : { signedIn: false, userId: null, email: null, name: null, expiresAt: null, provider: null, imageUrl: null, sessionState: "signed_out" }),
    },
  } as unknown as typeof window.ade;
});

afterEach(() => {
  globalThis.window.ade = originalAde;
  window.__adeWebClient = undefined;
});

// A computer or a browser can be shared: one person's ADE Cloud lanes must
// never show for the next account signed in there.
describe("the ADE Cloud lane index across accounts", () => {
  it("on the desktop, keeps one account's copy for that account only", async () => {
    let window1 = await openWindow();
    window1.note([laneMachine("inst-a", "A's private lane")]);
    expect(window1.laneNames()).toEqual(["A's private lane"]);

    // A reload as the same account starts from the copy.
    window1 = await openWindow();
    expect(window1.laneNames()).toEqual(["A's private lane"]);

    // Another account signs in: A's lanes and computer ids go, here and in storage.
    await window1.signInAs("user-b");
    expect(window1.laneNames()).toEqual([]);
    expect(window1.isCloudComputer("inst-a")).toBe(false);
    expect(window.localStorage.getItem(LANES_KEY)).toBeNull();
    expect(window.localStorage.getItem(COMPUTERS_KEY)).toBeNull();

    // A copy left for A (a switch while ADE was closed) is never read for B.
    window1 = await openWindow();
    await window1.signInAs("user-a");
    window1.note([laneMachine("inst-a", "A's private lane")]);
    signedInAs = "user-b";
    const window2 = await openWindow();
    expect(window2.laneNames()).toEqual([]);
    expect(window2.isCloudComputer("inst-a")).toBe(false);

    // A sign-out drops the copy too.
    await window2.signInAs("user-a");
    const window3 = await openWindow();
    window3.note([laneMachine("inst-a", "A's private lane")]);
    await window3.signInAs(null);
    expect(window3.laneNames()).toEqual([]);
    expect(window.localStorage.getItem(LANES_KEY)).toBeNull();
  });

  it("drops a read of the account's computers that the last account started", async () => {
    let answer!: (result: unknown) => void;
    const listMachines = vi.fn(() => new Promise((done) => { answer = done; }));
    (window.ade as unknown as { cloud: unknown }).cloud = { listMachines };
    const page = await openWindow();
    page.readAccountMachines();
    await page.signInAs("user-b");
    answer({ state: "ok", machines: [laneMachine("inst-a", "A's private lane")] });
    await new Promise((done) => setTimeout(done, 0));
    expect(page.laneNames()).toEqual([]);
    expect(window.localStorage.getItem(LANES_KEY)).toBeNull();
  });

  it("on ADE Web, keeps nothing in the browser's storage", async () => {
    window.__adeWebClient = true;
    // What an older build left in this browser.
    window.localStorage.setItem(LANES_KEY, JSON.stringify([{ laneId: "lane-old", laneName: "An older build's lane", instanceId: "inst-old" }]));
    window.localStorage.setItem(COMPUTERS_KEY, JSON.stringify([{ instanceId: "inst-old", machineKey: null }]));
    const page = await openWindow();
    expect(page.laneNames()).toEqual([]);
    expect(page.isCloudComputer("inst-old")).toBe(false);
    expect(window.localStorage.getItem(LANES_KEY)).toBeNull();

    page.note([laneMachine("inst-a", "A's private lane")]);
    expect(page.laneNames()).toEqual(["A's private lane"]);
    expect(window.localStorage.getItem(LANES_KEY)).toBeNull();
    expect(window.localStorage.getItem(COMPUTERS_KEY)).toBeNull();

    // Back to A after B on the same page, or a reload as A: nothing comes back from storage.
    await page.signInAs("user-b");
    expect(page.laneNames()).toEqual([]);
    await page.signInAs("user-a");
    expect(page.laneNames()).toEqual([]);
    expect((await openWindow()).laneNames()).toEqual([]);
  });
});
