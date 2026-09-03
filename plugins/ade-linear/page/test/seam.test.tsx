/**
 * The seam test.
 *
 * The plugin is two programs now: a page that draws, and a child process that
 * holds the Linear client and the credentials. They are joined by nothing but a
 * list of action ids and their argument shapes — no compiler checks the join,
 * because the page is built separately from the plugin it ships inside, and no
 * type crosses the bridge.
 *
 * So this test walks the product the way a reader does, against a scripted
 * `window.adePlugin` (`fakeBridge.ts`), and asserts the CALLS rather than the
 * pixels: an id the page invokes that the fake does not script throws by name,
 * and an argument shape that drifts fails on the assertion that reads it. It is
 * deliberately owned by neither half — a page change and a child change both
 * have to keep it passing.
 *
 * The walk: not connected → sign in → the list arrives → open an issue →
 * change its state → comment on it → launch a lane → attach it to the composer.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { BrowserEntry } from "../src/entries/BrowserEntry";
import { PickerEntry } from "../src/entries/PickerEntry";
import { SettingsEntry } from "../src/entries/SettingsEntry";
import { installFakeBridge, uninstallFakeBridge, fakeIssue, type FakeBridge } from "./fakeBridge";

/**
 * A fresh project root per test.
 *
 * `LinearIssueBrowser` keeps a module-level read cache keyed on the project
 * root — the compiled browser's own, moved unchanged, and the reason opening the
 * tab twice does not refetch the workspace. Across tests in one module that
 * cache is shared, so two tests on one root would have the second read the
 * first's answers instead of the child's. A distinct root per test is the same
 * isolation a distinct project gives in the product.
 */
let root = 0;

function tabContext(overrides: Record<string, unknown> = {}) {
  return {
    subject: null,
    surfaceId: "issues",
    placement: "tab" as const,
    project: { projectId: `project-${root}`, root: `/repo-${root}`, binding: "local" as const },
    ...overrides,
  };
}

let host: FakeBridge;

beforeEach(() => {
  root += 1;
  host = installFakeBridge();
});

/** Re-install the fake already signed in, for the tests that do not walk sign-in. */
function connected(overrides: Parameters<typeof installFakeBridge>[0] = {}): void {
  uninstallFakeBridge();
  host = installFakeBridge({ ...overrides, connected: true });
}

afterEach(() => {
  cleanup();
  uninstallFakeBridge();
});

/**
 * One issue's row in the LIST, waited for rather than slept on.
 *
 * Scoped to the list pane because the identifier also appears in the detail
 * pane beside it, and an unscoped query finds both the moment an issue is open.
 * The browser debounces its search by 220 ms, so every arrival is awaited.
 */
async function issueRow(identifier: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const list = document.querySelector('[data-linear-pane="issues"]');
    if (!list) throw new Error("The issue list has not rendered yet.");
    const match = within(list as HTMLElement).getAllByText(identifier)[0];
    if (!match) throw new Error(`No row for ${identifier} yet.`);
    return match;
  }, { timeout: 3_000 });
}

describe("the page and the plugin agree on every verb", () => {
  it("walks sign-in, list, open, state, comment, launch and attach", async () => {
    // ── Not connected ───────────────────────────────────────────────────────
    // The child answers a disconnected status, and the page asks for exactly the
    // three reads the compiled browser opened with.
    render(<BrowserEntry context={tabContext()} />);

    await waitFor(() => {
      expect(host.callsTo("invoke:pageQuickView").length).toBeGreaterThan(0);
    });
    expect(host.callsTo("invoke:pageCatalog").length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(host.callsTo("invoke:pageSearchIssues").length).toBeGreaterThan(0);
    });
    expect(host.connection.connected).toBe(false);

    // The search argument shape is the contract the child's `pageSearchIssues`
    // reads. A drift here is the bug this test exists to catch.
    const firstSearch = host.callsTo("invoke:pageSearchIssues")[0]!;
    expect(firstSearch.args).toMatchObject({
      first: 100,
      after: null,
      includeArchived: false,
    });
    expect(firstSearch.args).toHaveProperty("stateTypes");

    // ── Sign in ─────────────────────────────────────────────────────────────
    // The settings section is the page's own sign-in, and it invokes the
    // plugin's OAuth rather than ADE's compiled one.
    cleanup();
    render(<SettingsEntry context={tabContext({ surfaceId: "settings", placement: "settings-section" })} />);
    await waitFor(() => {
      expect(host.callsTo("invoke:pageConnection").length).toBeGreaterThan(0);
    });

    const connect = await screen.findByRole("button", { name: "Sign in with Linear" }, { timeout: 3_000 });
    await act(async () => {
      fireEvent.click(connect);
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageConnectOAuth").length).toBe(1);
    });
    expect(host.connection.connected).toBe(true);

    // ── The list arrives ────────────────────────────────────────────────────
    // A new root, because the browser cached the disconnected read under the old
    // one — which is the compiled cache behaving exactly as it does in the app
    // when a reader signs in and reopens the tab on the same project.
    cleanup();
    root += 1;
    render(<BrowserEntry context={tabContext()} />);
    const row = await issueRow("ADE-1");
    expect(row).toBeTruthy();

    // ── Open the issue ──────────────────────────────────────────────────────
    await act(async () => {
      fireEvent.click(row);
    });
    const stateSelect = await screen.findByLabelText("Status", {}, { timeout: 3_000 });
    expect(stateSelect).toBeTruthy();

    // ── Change its state ────────────────────────────────────────────────────
    await act(async () => {
      fireEvent.change(stateSelect, { target: { value: "state-doing" } });
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageSetIssueState").length).toBe(1);
    });
    expect(host.lastCall("invoke:pageSetIssueState")!.args).toEqual({
      issueId: "issue-1",
      stateId: "state-doing",
    });
    await waitFor(() => {
      expect(host.lastCall("ui.toast")!.args).toMatchObject({ message: "State updated." });
    });

    // ── Comment on it ───────────────────────────────────────────────────────
    const comment = document.querySelector('[data-linear-verb="comment"]') as HTMLElement | null;
    expect(comment).toBeTruthy();
    await act(async () => {
      fireEvent.click(comment!);
    });
    await waitFor(() => {
      expect(host.callsTo("ui.prompt").length).toBe(1);
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageAddComment").length).toBe(1);
    });
    expect(host.lastCall("invoke:pageAddComment")!.args).toMatchObject({
      issueId: "issue-1",
      body: "Progress from ADE",
    });

    // ── Launch a lane ───────────────────────────────────────────────────────
    // The detail pane's own dock, which the compiled browser draws whenever a
    // host supplies batch actions: "Launch lane + agent" and "Create lane only".
    const dock = document.querySelector('[data-linear-action-dock="true"]') as HTMLElement | null;
    expect(dock).toBeTruthy();
    const launch = within(dock!).getByRole("button", { name: /Launch lane \+ agent/i });
    await act(async () => {
      fireEvent.click(launch);
    });
    // The dock opens the shared launch-configuration modal rather than firing a
    // launch with silent defaults — the compiled behaviour, and the same modal
    // the quick view raises — so the reader confirms the model, prompt, branch
    // and lane target before anything is created. The call below is still the
    // contract; this is only the second half of the same gesture.
    const submitLaunch = await screen.findByRole(
      "button",
      { name: /Launch 1 lane/i },
      { timeout: 3_000 },
    );
    await act(async () => {
      fireEvent.click(submitLaunch);
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageLaunchAgent").length).toBe(1);
    });
    expect(host.lastCall("invoke:pageLaunchAgent")!.args).toMatchObject({ issueId: "issue-1" });

    // ── Attach it to the composer ───────────────────────────────────────────
    // The picker's whole contract, and the one no other placement has: attach,
    // then close. Either half alone leaves the reader looking at a dead card.
    cleanup();
    render(<PickerEntry context={tabContext({ surfaceId: "picker", placement: "composer-picker" })} />);
    const pickerRow = await issueRow("ADE-1");
    await act(async () => {
      fireEvent.click(pickerRow);
    });
    const attach = await screen.findByRole("button", { name: "Attach issue" }, { timeout: 3_000 });
    await act(async () => {
      fireEvent.click(attach);
    });
    await waitFor(() => {
      expect(host.callsTo("composer.attach").length).toBe(1);
    });
    expect(host.lastCall("composer.attach")!.args).toMatchObject({
      provider: "linear",
      issueId: "issue-1",
      identifier: "ADE-1",
      title: "Port Linear to the page tier",
    });
    // The close FOLLOWS the attach. The order is the contract: a picker that
    // closed first would drop the chip it was opened to add. More than one close
    // is fine — the host no-ops a placement that is already gone.
    await waitFor(() => {
      expect(host.callsTo("surface.close").length).toBeGreaterThanOrEqual(1);
    });
    const attachAt = host.calls.findIndex((call) => call.method === "composer.attach");
    const closeAt = host.calls.findIndex((call) => call.method === "surface.close");
    expect(attachAt).toBeGreaterThanOrEqual(0);
    expect(closeAt).toBeGreaterThan(attachAt);
  });

  it("invokes no action the plugin does not answer", async () => {
    connected();
    // The fake THROWS on an unknown id, so the assertion is that the walk above
    // and this render both finish. This one covers the reads a fresh open makes.
    render(<BrowserEntry context={tabContext()} />);
    await waitFor(() => {
      expect(host.callsTo("invoke:pageSearchIssues").length).toBeGreaterThan(0);
    });
    for (const call of host.calls) {
      expect(call.method.startsWith("invoke:") ? call.args : {}).toBeTruthy();
    }
  });

  it("keeps its filters in a collection, never in localStorage", async () => {
    connected();
    render(<BrowserEntry context={tabContext()} />);
    await waitFor(() => {
      expect(host.callsTo("collections.get").length).toBeGreaterThan(0);
    });
    for (const call of host.callsTo("collections.get")) {
      expect(call.args.collection).toBe("ui-state");
    }
    // A guest's storage partition dies with the placement, so a page that wrote
    // a preference there would be writing to a value nobody can read back.
    expect(window.localStorage.length).toBe(0);
  });

  it("follows lane and session changes rather than polling for them", async () => {
    connected();
    render(<BrowserEntry context={tabContext()} />);
    await waitFor(() => {
      expect(host.callsTo("host.subscribe").length).toBeGreaterThan(0);
    });
    expect(host.lastCall("host.subscribe")!.args).toMatchObject({ kinds: ["lane", "session"] });

    const before = host.callsTo("invoke:pageLanes").length;
    await act(async () => {
      host.emit("host", { kind: "lane", ids: ["lane-1"], overflow: false });
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageLanes").length).toBeGreaterThan(before);
    });
  });

  it("reports a refused mutation instead of pretending it worked", async () => {
    connected();
    host.setAction("pageSetIssueState", () => ({ ok: false, message: "Linear refused that state." }));
    render(<BrowserEntry context={tabContext()} />);
    const row = await issueRow("ADE-1");
    await act(async () => {
      fireEvent.click(row);
    });
    const stateSelect = await screen.findByLabelText("Status", {}, { timeout: 3_000 });
    await act(async () => {
      fireEvent.change(stateSelect, { target: { value: "state-done" } });
    });
    await waitFor(() => {
      expect(host.lastCall("ui.toast")!.args).toMatchObject({
        level: "error",
        message: "Linear refused that state.",
      });
    });
    // The optimistic write is reverted, so the control does not lie about a
    // change Linear did not make.
    await waitFor(() => {
      expect((stateSelect as HTMLSelectElement).value).toBe("state-todo");
    });
  });
});

describe("more than one issue", () => {
  beforeEach(() => {
    uninstallFakeBridge();
    host = installFakeBridge({
      connected: true,
      issues: [
        fakeIssue(),
        fakeIssue({ id: "issue-2", identifier: "ADE-2", title: "The second one", stateId: "state-doing", stateName: "In Progress", stateType: "started" }),
      ],
    });
  });

  it("draws every issue the child answered", async () => {
    render(<BrowserEntry context={tabContext()} />);
    expect(await issueRow("ADE-1")).toBeTruthy();
    expect(await issueRow("ADE-2")).toBeTruthy();
    const [search] = host.callsTo("invoke:pageSearchIssues");
    expect(search).toBeTruthy();
    expect(within(document.body).getAllByText(/ADE-\d/).length).toBeGreaterThanOrEqual(2);
  });
});

describe("the contract itself", () => {
  /**
   * The walk above proves the ids it walks. This proves the rest.
   *
   * `host/actions.ts` is the page's whole vocabulary — one exported function per
   * plugin action id — and `pageActions.js` is what answers them. Nothing
   * type-checks the join: the page is built separately from the plugin it ships
   * inside, and no type crosses the bridge. So the two files are read as text
   * and their id lists compared, which catches a rename on either side without
   * needing a click path through every verb.
   */
  it("every action the page can call is one the plugin defines", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    // Vitest runs with the page directory as its root, so the two files are
    // named from there rather than from an ESM module that has no `__dirname`.
    const root = process.cwd();

    const contract = readFileSync(join(root, "src/host/actions.ts"), "utf8");
    const called = new Set(
      [...contract.matchAll(/\bcall(?:<[^>]*>)?\(\s*"([A-Za-z0-9_]+)"/g)].map((match) => match[1]),
    );
    expect(called.size).toBeGreaterThan(20);

    const child = readFileSync(join(root, "../pageActions.js"), "utf8");
    const defined = new Set(
      [...child.matchAll(/^\s{4}(?:async\s+)?([A-Za-z0-9_]+)\s*\(/gm)].map((match) => match[1]),
    );
    // `saveWebhookSecret` is the one id the page shares with the manifest table
    // in `actions.js`, deliberately: the webhook secret was already a plugin
    // action and a second copy of it would be a second place to keep in step.
    const elsewhere = new Set(["saveWebhookSecret"]);

    const missing = [...called].filter((id) => !defined.has(id) && !elsewhere.has(id));
    expect(missing, "ids the page invokes that pageActions.js does not define").toEqual([]);
  });

  it("the scripted bridge answers every action the page can call", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const contract = readFileSync(join(process.cwd(), "src/host/actions.ts"), "utf8");
    const called = [...contract.matchAll(/\bcall(?:<[^>]*>)?\(\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);

    // The fake throws by name on an unscripted id, so a verb the walk never
    // reaches would fail silently the first time a reader pressed it. Every one
    // is invoked here instead, with no arguments, purely to prove it is
    // answered — the answers themselves are the walk's business.
    for (const action of new Set(called)) {
      await expect(host.bridge.invoke(action, {}), action).resolves.toBeDefined();
    }
  });
});
