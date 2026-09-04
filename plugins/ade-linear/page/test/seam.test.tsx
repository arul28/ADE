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

import { BadgeCardEntry } from "../src/entries/BadgeCardEntry";
import { BrowserEntry } from "../src/entries/BrowserEntry";
import { DialogPickerEntry } from "../src/entries/DialogPickerEntry";
import { IssueContextEntry } from "../src/entries/IssueContextEntry";
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

/**
 * Choose a model in the open launch form, through the HOST's picker.
 *
 * The form SEEDS one now, from `chat.capabilities().defaultModel` — the same
 * seed ADE's own launch form opens on, computed on the host from the recents
 * the composer reads. So this is a reader changing a choice rather than making
 * a first one, and the walk still presses it because the press is the contract:
 * the chip opens ADE's picker and nothing of its own.
 */
async function chooseModel(): Promise<void> {
  const chip = await screen.findByRole("button", { name: "Model" }, { timeout: 3_000 });
  await act(async () => {
    fireEvent.click(chip);
  });
  await waitFor(() => {
    expect(host.callsTo("ui.pickModel").length).toBeGreaterThan(0);
  });
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
    await chooseModel();
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

  it("moves a launched issue to the error state when the kickoff turn fails", async () => {
    // The gap this closes. Entity frames say a SESSION exists, which a failed
    // kickoff leaves behind just as a successful one does — so inference alone
    // reported "Ready" for a batch that produced nothing. The chat frame
    // carries the turn, and it is the only thing that can say otherwise.
    connected();
    render(<BrowserEntry context={tabContext()} />);
    const row = await issueRow("ADE-1");
    await act(async () => {
      fireEvent.click(row);
    });
    const dock = document.querySelector('[data-linear-action-dock="true"]') as HTMLElement | null;
    const launch = within(dock!).getByRole("button", { name: /Launch lane \+ agent/i });
    await act(async () => {
      fireEvent.click(launch);
    });
    await chooseModel();
    const submitLaunch = await screen.findByRole("button", { name: /Launch 1 lane/i }, { timeout: 3_000 });
    await act(async () => {
      fireEvent.click(submitLaunch);
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageLaunchAgent").length).toBe(1);
    });

    await act(async () => {
      host.emit("host", {
        kind: "chat",
        ids: ["session-1"],
        overflow: false,
        turns: [{ sessionId: "session-1", state: "failed", message: "The runtime refused the model." }],
      });
    });
    // "Needs attention", not "Ready" — and carrying the runtime's own sentence,
    // because the reader needs to know WHY before they retry.
    expect(await screen.findByText("Needs attention", {}, { timeout: 3_000 })).toBeTruthy();
    await waitFor(() => {
      const carried = [...document.querySelectorAll("[title]")].some(
        (node) => node.getAttribute("title") === "The runtime refused the model.",
      );
      expect(carried).toBe(true);
    });
    expect(screen.queryByText("Ready")).toBeNull();
  });

  it("ignores an overflowed chat frame rather than guessing at the turns it dropped", async () => {
    // Past its ceiling the frame carries NO turns — more settled inside the
    // 120 ms window than it could name. A batch that big cannot report which of
    // its kickoffs failed, and saying nothing is the honest answer: the row
    // stays where the inference put it rather than being told a state no frame
    // reported.
    connected();
    render(<BrowserEntry context={tabContext()} />);
    const row = await issueRow("ADE-1");
    await act(async () => {
      fireEvent.click(row);
    });
    const dock = document.querySelector('[data-linear-action-dock="true"]') as HTMLElement | null;
    await act(async () => {
      fireEvent.click(within(dock!).getByRole("button", { name: /Launch lane \+ agent/i }));
    });
    await chooseModel();
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /Launch 1 lane/i }, { timeout: 3_000 }));
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageLaunchAgent").length).toBe(1);
    });
    await act(async () => {
      host.emit("host", { kind: "chat", ids: ["session-1"], overflow: true });
    });
    expect(screen.queryByText("Needs attention")).toBeNull();
  });

  it("sends the reader to the lane stack after a launch, and to the project picker with no project", async () => {
    connected();
    render(<BrowserEntry context={tabContext()} />);
    const row = await issueRow("ADE-1");
    await act(async () => {
      fireEvent.click(row);
    });
    const dock = document.querySelector('[data-linear-action-dock="true"]') as HTMLElement | null;
    await act(async () => {
      fireEvent.click(within(dock!).getByRole("button", { name: /Launch lane \+ agent/i }));
    });
    await chooseModel();
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /Launch 1 lane/i }, { timeout: 3_000 }));
    });
    await waitFor(() => {
      const deeplinks = host.callsTo("openDeeplink").map((call) => call.args.url);
      // The compiled panel rerouted to `#/lanes?drawer=stack`, a renderer route
      // no deeplink could name. This one names the lane the launch created and
      // asks for the stack drawer beside it.
      expect(deeplinks.some((url) => String(url).startsWith("ade://lane/") && String(url).includes("drawer=stack"))).toBe(true);
    });
  });

  it("copies the kickoff prompt only when the plugin's own setting says so", async () => {
    connected();
    // The toggle was an ADE preference the compiled flow read off the app
    // store; it is the plugin's own setting now, its switch is in the launch
    // form beside the prompt it copies, and OFF means no clipboard write at all
    // rather than a write the reader cannot see.
    render(<BrowserEntry context={tabContext()} />);
    const row = await issueRow("ADE-1");
    await act(async () => {
      fireEvent.click(row);
    });
    const dock = document.querySelector('[data-linear-action-dock="true"]') as HTMLElement | null;
    await act(async () => {
      fireEvent.click(within(dock!).getByRole("button", { name: /Launch lane \+ agent/i }));
    });
    await chooseModel();
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /Launch 1 lane/i }, { timeout: 3_000 }));
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageLaunchAgent").length).toBe(1);
    });
    // The setting defaults on, matching the manifest's `default: true` and the
    // app preference it replaced, so the prompt is saved.
    await waitFor(() => {
      expect(host.callsTo("clipboard.write").length).toBe(1);
    });
    expect(String(host.lastCall("clipboard.write")!.args.text)).toContain("Linear issue");
  });

  it("turns the clipboard copy off from the launch form, and then copies nothing", async () => {
    // The toggle moved out of the settings section and into the form. It writes
    // the same stored setting the launch flow reads — a per-launch checkbox that
    // forgot itself would be a worse control than the preference it replaced —
    // so the assertion is on the config write AND on the launch that follows it.
    connected({ config: { launchPromptClipboard: false } });
    render(<BrowserEntry context={tabContext()} />);
    const row = await issueRow("ADE-1");
    await act(async () => {
      fireEvent.click(row);
    });
    const dock = document.querySelector('[data-linear-action-dock="true"]') as HTMLElement | null;
    await act(async () => {
      fireEvent.click(within(dock!).getByRole("button", { name: /Launch lane \+ agent/i }));
    });
    await chooseModel();

    const toggle = await screen.findByRole(
      "switch",
      { name: /Copy the launch prompt to the clipboard/i },
      { timeout: 3_000 },
    );
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    });
    await act(async () => {
      fireEvent.click(toggle);
    });
    await waitFor(() => {
      expect(host.lastCall("config.set")!.args).toEqual({ key: "launchPromptClipboard", value: true });
    });

    // And with the STORED value still false — the fake answers what it was
    // installed with — the launch copies nothing.
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /Launch 1 lane/i }, { timeout: 3_000 }));
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageLaunchAgent").length).toBe(1);
    });
    expect(host.callsTo("clipboard.write").length).toBe(0);
  });

  it("opens ADE's own pickers for model, lane, permission and reasoning", async () => {
    // Native order: session type, ModelPicker (fast inside), reasoning,
    // permission. No Provider chip and no Fast toggle.
    connected({
      lanes: [{
        id: "lane-1",
        name: "ADE-1",
        branch: "ade/ade-1",
        laneType: "worktree",
        path: "/tmp/ade-1",
        linearIssueId: null,
        linearIssueKey: null,
        linearIssueLinks: [],
      }],
    });
    render(<BrowserEntry context={tabContext()} />);
    const row = await issueRow("ADE-1");
    await act(async () => {
      fireEvent.click(row);
    });
    const dock = document.querySelector('[data-linear-action-dock="true"]') as HTMLElement | null;
    await act(async () => {
      fireEvent.click(within(dock!).getByRole("button", { name: /Launch lane \+ agent/i }));
    });

    expect(screen.queryByRole("button", { name: "Provider" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Fast" })).toBeNull();

    await chooseModel();
    expect(host.callsTo("ui.pickModel").length).toBeGreaterThan(0);
    expect(host.lastCall("ui.pickModel")!.args).toHaveProperty("rect");
    expect(host.lastCall("ui.pickModel")!.args).not.toHaveProperty("selected");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reasoning effort" }));
    });
    await waitFor(() => {
      // BOTH, which is the contract: `ui.pickReasoningEffort({provider, model})`.
      // The page took a `provider` argument, named it `_provider` and posted
      // `{model, value, rect}` — so a host that resolves the ladder through the
      // provider (a model its static table does not carry, an ACP or Pi model
      // whose rungs only its provider can name) had nothing to resolve it with
      // and opened its fallback ladder instead of the model's own.
      expect(host.lastCall("ui.pickReasoningEffort")!.args).toMatchObject({
        model: "claude-opus-5",
        provider: "claude",
      });
    });
    expect(host.lastCall("ui.pickModel")!.args).not.toHaveProperty("selected");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Permissions" }));
    });
    await waitFor(() => {
      expect(host.lastCall("ui.pickPermissionMode")!.args).toMatchObject({ provider: "claude" });
    });

    expect(screen.queryByRole("combobox")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Existing lane" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Lane" }));
    });
    await waitFor(() => {
      expect(host.callsTo("ui.pickLane").length).toBe(1);
    });
  });

  it("draws no header and no backdrop of its own inside the host's picker", async () => {
    // The bug: `PickerEntry` drew `LinearPaneModal`'s full chrome in a
    // placement the host had already framed and titled — a portalled
    // `bg-black/55` backdrop across the whole guest, a second branded header
    // over the host's own, and a dialog centred at
    // `min(1760px, 100vw - 28px)` by `min(940px, 100dvh - 28px)`, which in a
    // 360×420 popover is a pane five times its width.
    connected();
    render(<PickerEntry context={tabContext({ surfaceId: "picker", placement: "composer-picker" })} />);
    await issueRow("ADE-1");
    expect(document.querySelector("[data-linear-pane-backdrop]")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // The list itself is still there, filling the frame the host sized.
    expect(document.querySelector('[data-linear-pane="issues"]')).toBeTruthy();
  });

  it("keeps its own header where nothing else draws one", async () => {
    // The rule is per PLACEMENT, not per entry. An `overlay` is a page floating
    // over the app with no host frame around it, so dropping the chrome there
    // would leave a headerless list with no way out of it.
    connected();
    render(<PickerEntry context={tabContext({ surfaceId: "picker", placement: "overlay" })} />);
    await issueRow("ADE-1");
    expect(document.querySelector("[data-linear-pane-backdrop]")).toBeTruthy();
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it("links to the lane the picker was opened for, rather than to the composer", async () => {
    // One surface, two callers. The composer's own menu row opens it with no
    // pointer and the answer is a chip; the chat menu's Attach row opens it
    // through `openIssuePickerSurface`, which passes the chat's lane — because
    // that card's Attach means "link this issue to this chat's lane".
    connected({
      lanes: [{
        id: "lane-1",
        name: "ADE-1",
        branch: "ade/ade-1",
        laneType: "worktree",
        path: null,
        linearIssueId: null,
        linearIssueKey: null,
        linearIssueLinks: [],
      }],
    });
    render(
      <PickerEntry
        context={tabContext({
          surfaceId: "picker",
          placement: "composer-picker",
          pointer: { laneId: "lane-1" },
        })}
      />,
    );
    const row = await issueRow("ADE-1");
    await act(async () => {
      fireEvent.click(row);
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Attach issue" }, { timeout: 3_000 }));
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageLinkIssue").length).toBe(1);
    });
    expect(host.lastCall("invoke:pageLinkIssue")!.args).toEqual({ issueId: "issue-1", laneId: "lane-1" });
    expect(host.callsTo("composer.attach").length).toBe(0);
  });

  it("opens the launch form on the model ADE's own composer opens on", async () => {
    // The form used to seed nothing, so Launch was disabled until the reader
    // opened a picker and chose the same model the composer beside them was
    // already on. `chat.capabilities().defaultModel` is that seed, and the
    // chips print the host's own labels for it rather than its ids.
    connected();
    render(<BrowserEntry context={tabContext()} />);
    const row = await issueRow("ADE-1");
    await act(async () => {
      fireEvent.click(row);
    });
    const dock = document.querySelector('[data-linear-action-dock="true"]') as HTMLElement | null;
    await act(async () => {
      fireEvent.click(within(dock!).getByRole("button", { name: /Launch lane \+ agent/i }));
    });

    const model = await screen.findByRole("button", { name: "Model" }, { timeout: 3_000 });
    await waitFor(() => {
      expect(model.textContent).toContain("Opus 5");
    });
    expect(screen.getByRole("button", { name: "Reasoning effort" }).textContent).toContain("High");
    expect(screen.getByRole("button", { name: "Permissions" }).textContent).toContain("Accept edits");
    // And the launch can proceed without a single picker being opened.
    expect(host.callsTo("ui.pickModel").length).toBe(0);
    const launch = screen.getByRole("button", { name: /Launch 1 lane/i });
    expect(launch.hasAttribute("disabled")).toBe(false);
  });

  it("opens on the first available model when the host answers no seed", async () => {
    // A host still on the older `chat.capabilities()` answers no `defaultModel`
    // at all. The compiled modal seeded `useModelRecents()[0]` and fell back to
    // the Claude default, then the OpenCode one; the same ladder over the
    // catalogue stands in, so the form is never opened on nothing.
    connected();
    host.setAction("pageCapabilities", () => ({ providers: [] }));
    render(<BrowserEntry context={tabContext()} />);
    const row = await issueRow("ADE-1");
    await act(async () => {
      fireEvent.click(row);
    });
    const dock = document.querySelector('[data-linear-action-dock="true"]') as HTMLElement | null;
    await act(async () => {
      fireEvent.click(within(dock!).getByRole("button", { name: /Launch lane \+ agent/i }));
    });
    const model = await screen.findByRole("button", { name: "Model" }, { timeout: 3_000 });
    await waitFor(() => {
      expect(model.textContent).toContain("Opus 5");
    });
    // The provider's own starting point is still a real choice, so those two
    // chips keep their "Default" placeholder rather than printing a value the
    // reader never picked.
    expect(screen.getByRole("button", { name: "Permissions" }).textContent).toContain("Default");
    expect(screen.getByRole("button", { name: /Launch 1 lane/i }).hasAttribute("disabled")).toBe(false);
  });

  it("never draws a dead chip: a press with no model opens the model picker first", async () => {
    // The permission chip was gated on `Boolean(provider)` and the reasoning
    // chip on `Boolean(modelId)`, and on a host that answers no seed the form
    // had neither — so both opened on a reader who could not tell what to press
    // to make them live. Now the press asks for the model and then for the
    // control it was for.
    connected();
    // No seed AND no catalogue: the one state where the form genuinely opens
    // with nothing chosen, which is the state the chips used to be dead in.
    host.setAction("pageCapabilities", () => ({ providers: [], defaultModel: null }));
    host.setAction("pageModels", () => []);
    render(<BrowserEntry context={tabContext()} />);
    const row = await issueRow("ADE-1");
    await act(async () => {
      fireEvent.click(row);
    });
    const dock = document.querySelector('[data-linear-action-dock="true"]') as HTMLElement | null;
    await act(async () => {
      fireEvent.click(within(dock!).getByRole("button", { name: /Launch lane \+ agent/i }));
    });

    const permissions = await screen.findByRole("button", { name: "Permissions" }, { timeout: 3_000 });
    expect(permissions.hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Reasoning effort" }).hasAttribute("disabled")).toBe(false);

    // The host's model picker answers a model with NO provider on it, which is
    // the case `resolveLaunchProviderAndModel` exists for. With no catalogue
    // either it falls back to OpenCode — never to the empty string, which the
    // host refuses the popover for in a sentence the reader then has to decode.
    host.setPicker("model", { id: "claude-opus-5", label: "Opus 5", provider: null });
    await act(async () => {
      fireEvent.click(permissions);
    });
    await waitFor(() => {
      expect(host.callsTo("ui.pickModel").length).toBe(1);
    });
    await waitFor(() => {
      expect(host.lastCall("ui.pickPermissionMode")!.args).toMatchObject({ provider: "opencode" });
    });
    expect(host.lastCall("ui.pickPermissionMode")!.args.provider).not.toBe("");
  });

  it("gives the chat menu's Linear row every verb the chat header used to have", async () => {
    // The chat-header button and its dropdown are gone. What replaced them is a
    // row in the chat's three-dot menu under Issue context, opening this page
    // as an anchored popover — so the four verbs the header offered have to be
    // here, or the removal is a loss rather than a move.
    //
    // The `chat-card` placement of the SAME surface still draws only the chips
    // (the transcript row the compiled `UserMessageIssueContext` drew), which is
    // the case below this one.
    connected({
      lanes: [{
        id: "lane-1",
        name: "ADE-1",
        branch: "ade/ade-1",
        laneType: "worktree",
        path: null,
        linearIssueId: null,
        linearIssueKey: null,
        linearIssueLinks: [{ issueId: "issue-1", issueKey: "ADE-1", sessionId: "session-1" }],
      }],
    });
    render(
      <IssueContextEntry
        context={tabContext({
          surfaceId: "issue-context",
          placement: "popover",
          subject: { kind: "session", id: "session-1" },
        })}
      />,
    );

    const open = await screen.findByRole("button", { name: /Open in Linear/i }, { timeout: 3_000 });
    await act(async () => {
      fireEvent.click(open);
    });
    // `openInLinear` answers `{openUrl}` for the HOST to act on. A page that
    // navigated a window itself would be reaching past its placement.
    await waitFor(() => {
      expect(host.lastCall("invoke:openInLinear")!.args).toEqual({ issueId: "issue-1" });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Comment progress/i }));
    });
    await waitFor(() => {
      expect(host.lastCall("invoke:commentProgress")!.args).toEqual({ sessionId: "session-1" });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Detach$/i }));
    });
    await waitFor(() => {
      expect(host.lastCall("invoke:pageUnlinkIssue")!.args).toEqual({ issueId: "issue-1", laneId: "lane-1" });
    });

    // And attach, which was the composer's picker rather than the header's —
    // carried here because a chat with no issue attached is exactly the chat a
    // reader opens this card to fix. It routes to the PICKER placement rather
    // than opening a modal inside a 360×420 popover.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Attach a Linear issue/i }));
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:openIssuePickerSurface").length).toBe(1);
    });
    expect(host.lastCall("invoke:openIssuePickerSurface")!.args).toEqual({ laneId: "lane-1" });
    // No pane, no backdrop, no second header — the list opens in the placement
    // that is a list.
    expect(document.querySelector("[data-linear-pane-backdrop]")).toBeNull();
    // The card asked one question and it is answered elsewhere, so it closes.
    await waitFor(() => {
      expect(host.callsTo("surface.close").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("attaches from a chat that carries no issue yet, which is the chat the row is for", async () => {
    // `pageLanes` answers a lane's Linear links and nothing else, so the lane
    // could only ever be found for a chat that ALREADY had an issue. The row
    // therefore sat permanently disabled — "ADE cannot tell which lane this
    // chat belongs to" — on every chat where pressing it was the point. The
    // chat's own session names its lane.
    connected({
      lanes: [{
        id: "lane-1",
        name: "ADE-1",
        branch: "ade/ade-1",
        laneType: "worktree",
        path: null,
        linearIssueId: null,
        linearIssueKey: null,
        linearIssueLinks: [],
      }],
    });
    render(
      <IssueContextEntry
        context={tabContext({
          surfaceId: "issue-context",
          placement: "popover",
          subject: { kind: "session", id: "session-1" },
        })}
      />,
    );
    const attach = await screen.findByRole(
      "button",
      { name: /Attach a Linear issue/i },
      { timeout: 3_000 },
    );
    await waitFor(() => {
      expect(host.callsTo("invoke:pageSessionLane").length).toBe(1);
    });
    expect(host.lastCall("invoke:pageSessionLane")!.args).toEqual({ sessionId: "session-1" });
    await waitFor(() => {
      expect(attach.hasAttribute("disabled")).toBe(false);
    });
  });

  it("draws only the chips in the transcript, where a menu was never pressed", async () => {
    connected({
      lanes: [{
        id: "lane-1",
        name: "ADE-1",
        branch: "ade/ade-1",
        laneType: "worktree",
        path: null,
        linearIssueId: null,
        linearIssueKey: null,
        linearIssueLinks: [{ issueId: "issue-1", issueKey: "ADE-1", sessionId: "session-1" }],
      }],
    });
    render(
      <IssueContextEntry
        context={tabContext({
          surfaceId: "issue-context",
          placement: "overlay",
          subject: { kind: "session", id: "session-1" },
        })}
      />,
    );
    await waitFor(() => {
      expect(document.querySelector("[data-chat-attachment-tray]")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: /Comment progress/i })).toBeNull();
  });

  it("resolves a badge card from an issue id alone", async () => {
    // Linear's search does not match a raw uuid, so a lane row badge carrying
    // an id and no key anywhere used to draw "No Linear issue on this lane"
    // over an issue that plainly exists. `pageIssueById` is the read that can
    // answer it, and the card asks it FIRST.
    connected();
    render(
      <BadgeCardEntry
        context={tabContext({
          surfaceId: "badge-card",
          placement: "popover",
          subject: { kind: "lane", id: "lane-9" },
          pointer: { issueId: "issue-1" },
        })}
      />,
    );
    await waitFor(() => {
      expect(host.callsTo("invoke:pageIssueById").length).toBe(1);
    });
    expect(host.lastCall("invoke:pageIssueById")!.args).toEqual({ issueId: "issue-1" });
    expect(await screen.findByText("ADE-1", {}, { timeout: 3_000 })).toBeTruthy();
    // And it never fell through to the key path, which is what could not answer.
    expect(host.callsTo("invoke:pageSearchIssues").length).toBe(0);
  });

  it("answers the dialog it is drawn inside rather than the composer", async () => {
    // A composer picker attaches a chip and closes itself. A dialog section is a
    // field in a form ADE owns, and the dialog is waiting on the answer.
    connected();
    render(
      <DialogPickerEntry
        context={tabContext({
          surfaceId: "dialog-picker",
          placement: "dialog-picker",
          subject: { kind: "dialog", dialog: "create-lane" },
        })}
      />,
    );
    const row = await issueRow("ADE-1");
    await act(async () => {
      fireEvent.click(row);
    });
    const use = await screen.findByRole("button", { name: "Use for this lane" }, { timeout: 3_000 });
    await act(async () => {
      fireEvent.click(use);
    });
    await waitFor(() => {
      expect(host.callsTo("dialog.submit").length).toBe(1);
    });
    expect(host.lastCall("dialog.submit")!.args).toMatchObject({
      issue: { provider: "linear", issueId: "issue-1", identifier: "ADE-1" },
    });
    // The dialog around the page owns closing. A section that also closed the
    // surface would take the dialog down before it could use the answer.
    expect(host.callsTo("composer.attach").length).toBe(0);
    expect(host.callsTo("surface.close").length).toBe(0);
  });

  it("reports its height through the bridge verb and nowhere else", async () => {
    connected();
    render(<SettingsEntry context={tabContext({ surfaceId: "settings", placement: "settings-section" })} />);
    await waitFor(() => {
      expect(host.callsTo("invoke:pageConnection").length).toBeGreaterThan(0);
    });
    // The two unofficial channels are gone: the page no longer writes its
    // height onto the document, and no longer posts a frame to the parent.
    expect(document.documentElement.style.height).toBe("");
    expect(document.body.style.height).toBe("");
  });

  it("connects with an API key, names a default team, and disconnects", async () => {
    // The three settings writes the walk never reached. Each is a credential or
    // a stored preference crossing the seam, and each answers a shape the card
    // reads back — so a rename on either side is a card that stops reflecting
    // what the reader just did.
    render(<SettingsEntry context={tabContext({ surfaceId: "settings", placement: "settings-section" })} />);

    const key = await screen.findByLabelText("Linear API key", {}, { timeout: 3_000 });
    await act(async () => {
      fireEvent.change(key, { target: { value: "lin_api_secret" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageSaveApiKey").length).toBe(1);
    });
    expect(host.lastCall("invoke:pageSaveApiKey")!.args).toEqual({ token: "lin_api_secret" });

    // The card redraws from the connection the child answered, not from the
    // form's own optimism.
    const disconnect = await screen.findByRole("button", { name: /Disconnect/i }, { timeout: 3_000 });

    // The default team is the plugin's OWN setting, written through
    // `config.set` rather than through an action. The control is a text field
    // when the plugin knows no teams yet, and that one commits on BLUR — a
    // write per keystroke would be one `config.set` per letter of "ENG".
    const team = await screen.findByLabelText(/Default team key/i, {}, { timeout: 3_000 });
    await act(async () => {
      fireEvent.change(team, { target: { value: "ENG" } });
    });
    await act(async () => {
      fireEvent.blur(team);
    });
    await waitFor(() => {
      expect(host.callsTo("config.set").length).toBeGreaterThan(0);
    });
    expect(host.lastCall("config.set")!.args).toMatchObject({ key: "defaultTeamKey", value: "ENG" });

    await act(async () => {
      fireEvent.click(disconnect);
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageDisconnect").length).toBe(1);
    });
    // And the card redraws from the connection the CHILD answered. The page
    // holds no credential of its own to clear, so "disconnected" has to arrive
    // over the seam or the reader is looking at a stale card.
    expect(await screen.findByLabelText("Linear API key", {}, { timeout: 3_000 })).toBeTruthy();
  });

  it("assigns an issue to the reader from the detail pane", async () => {
    // One of the four controls the plugin's own vocabulary panel has and the
    // compiled browser did not, so nothing else proves its argument shape —
    // and `assigneeId: null` is a real value here, which is why the write
    // cannot be inferred from a truthiness check on either side.
    connected();
    render(<BrowserEntry context={tabContext()} />);
    const row = await issueRow("ADE-1");
    await act(async () => {
      fireEvent.click(row);
    });
    const assign = await screen.findByRole("button", { name: /Assign to me/i }, { timeout: 3_000 });
    await act(async () => {
      fireEvent.click(assign);
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageAssignIssue").length).toBe(1);
    });
    expect(host.lastCall("invoke:pageAssignIssue")!.args).toMatchObject({ issueId: "issue-1" });
  });

  it("points Settings at Automations and does not register the webhook there", async () => {
    // Register, the URL and the signing secret live on the Automations tile.
    // This card keeps the pointer, and the clipboard toggle lives on the launch
    // form — a switch two screens from the prompt it copies is a switch nobody
    // finds.
    connected();
    render(<SettingsEntry context={tabContext({ surfaceId: "settings", placement: "settings-section" })} />);
    expect(await screen.findByText(/Linear automations live in Automations/i, {}, { timeout: 3_000 })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Register/i })).toBeNull();
    expect(screen.queryByRole("switch", { name: /Copy the launch prompt to the clipboard/i })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Open Automations/i }));
    });
    await waitFor(() => {
      expect(host.lastCall("openDeeplink")!.args).toEqual({ url: "ade://automations" });
    });
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
    // Node 22 withholds `localStorage` unless `--localstorage-file` is set;
    // jsdom still provides it. Either way, nothing was written here.
    expect(window.localStorage?.length ?? 0).toBe(0);
  });

  it("follows lane, session and chat changes rather than polling for them", async () => {
    connected();
    render(<BrowserEntry context={tabContext()} />);
    await waitFor(() => {
      // Two subscriptions, and they answer different questions. The entity
      // frames say a lane or a session moved; the chat frames carry the kickoff
      // turn, which is the only thing that can report a launch that FAILED.
      expect(host.callsTo("host.subscribe").length).toBeGreaterThan(1);
    });
    const kinds = host.callsTo("host.subscribe").map((call) => call.args.kinds);
    expect(kinds).toContainEqual(["lane", "session"]);
    expect(kinds).toContainEqual(["chat"]);

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
    // The six ids the page shares with the manifest table in `actions.js`,
    // deliberately. Three are the webhook: the Automations trigger tile presses
    // `webhookStatus` and `registerWebhook` by name, so a second copy in the
    // page table would be a second place to keep in step. Two are the chat's
    // own verbs, which the compiled chat-header menu pressed and the chat
    // menu's issue-context card presses now.
    //
    // The sixth is `openIssuePickerSurface`, and it has to be in that table
    // rather than this one: it answers `{openWebview}`, which is control flow
    // over ADE's own UI that only a manifest ACTION may ask for. No socket
    // names it, which is what keeps it clear of the rule that a socket already
    // declaring its `webviewSurfaceId` must never answer a second open.
    const elsewhere = new Set([
      "webhookStatus",
      "registerWebhook",
      "unregisterWebhook",
      "openInLinear",
      "openIssuePickerSurface",
      "commentProgress",
    ]);

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

  it("re-reads issues when the host asks for a refresh", async () => {
    render(<BrowserEntry context={tabContext()} />);
    await waitFor(() => {
      expect(host.callsTo("invoke:pageSearchIssues").length).toBeGreaterThan(0);
    });
    const before = host.callsTo("invoke:pageSearchIssues").length;
    await act(async () => {
      host.emit("refresh", {});
    });
    await waitFor(() => {
      expect(host.callsTo("invoke:pageSearchIssues").length).toBeGreaterThan(before);
    });
  });

  it("leaves Waiting once Linear finishes while ADE was in the background", async () => {
    host.setAction("pageConnectOAuth", () => ({ ok: true, authSession: { id: "linear" } }));
    render(
      <SettingsEntry context={tabContext({ surfaceId: "settings", placement: "settings-section" })} />,
    );
    const connect = await screen.findByRole("button", { name: "Sign in with Linear" }, { timeout: 3_000 });
    await act(async () => {
      fireEvent.click(connect);
    });
    expect(await screen.findByRole("button", { name: "Waiting for Linear..." }, { timeout: 3_000 })).toBeTruthy();

    host.setConnected(true);
    await act(async () => {
      host.emit("changed", { kind: "viewer" });
    });
    await waitFor(() => {
      expect(screen.getByText(/Signed in as Ada/)).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Waiting for Linear..." })).toBeNull();
  });

  it("leaves Waiting when the window comes forward after Linear finishes", async () => {
    host.setAction("pageConnectOAuth", () => ({ ok: true, authSession: { id: "linear" } }));
    render(
      <SettingsEntry context={tabContext({ surfaceId: "settings", placement: "settings-section" })} />,
    );
    const connect = await screen.findByRole("button", { name: "Sign in with Linear" }, { timeout: 3_000 });
    await act(async () => {
      fireEvent.click(connect);
    });
    expect(await screen.findByRole("button", { name: "Waiting for Linear..." }, { timeout: 3_000 })).toBeTruthy();

    host.setConnected(true);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => {
      expect(screen.getByText(/Signed in as Ada/)).toBeTruthy();
    });
  });

  it("leaves Sign in on a keep-alive tab when the connection lands", async () => {
    render(<BrowserEntry context={tabContext()} />);
    expect(await screen.findByRole("button", { name: "Sign in" }, { timeout: 3_000 })).toBeTruthy();

    host.setConnected(true);
    await act(async () => {
      host.emit("changed", { kind: "viewer" });
    });
    await issueRow("ADE-1");
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("leaves Sign in when the window comes forward after the connection lands", async () => {
    render(<BrowserEntry context={tabContext()} />);
    expect(await screen.findByRole("button", { name: "Sign in" }, { timeout: 3_000 })).toBeTruthy();

    host.setConnected(true);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await issueRow("ADE-1");
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });
});
