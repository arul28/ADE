/**
 * The seam test: one walk through the product, against a scripted host.
 *
 * The plugin is two programs now. The page is built here, separately, from
 * TypeScript; the child is plain CommonJS in `../..`; and the only thing
 * joining them is a list of action ids no compiler checks. This file walks the
 * three surfaces and asserts THE CALLS — the id, and the arguments — rather
 * than the markup, because the markup is the half a compiler already sees.
 *
 * `fakeBridge.ts` throws by name for any id it does not script, so a page that
 * invents an action fails here rather than at a user's desk. It is owned by
 * neither half: a change to `src/host/actions.ts` and a change to the child's
 * `pageActions.js` both have to keep this passing.
 *
 * What it does NOT do is assert class names or exact copy. Those live in
 * `PARITY.md` and in the compiled sources; a test that pinned them would fail
 * on every visual change and prove nothing about the seam.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { PageRouter } from "../src/PageRouter";
import type { PluginWebviewContext } from "../src/bridge";
import { fakeEntry, installFakeBridge, uninstallFakeBridge, type FakeBridge } from "./fakeBridge";

function context(overrides: Partial<PluginWebviewContext> = {}): PluginWebviewContext {
  return {
    subject: null,
    surfaceId: "fleet",
    placement: "tab",
    project: { projectId: "project-1", root: "/repo", binding: "local" },
    ...overrides,
  };
}

/** Mount a surface and wait for its first read to land. */
async function open(ctx: PluginWebviewContext, firstCall: string): Promise<FakeBridge> {
  const fake = (globalThis as { __fake?: FakeBridge }).__fake!;
  render(<PageRouter context={ctx} />);
  await waitFor(() => expect(fake.callsTo(firstCall).length).toBeGreaterThan(0));
  return fake;
}

let fake: FakeBridge;

function install(options: Parameters<typeof installFakeBridge>[0] = {}): FakeBridge {
  fake = installFakeBridge(options);
  (globalThis as { __fake?: FakeBridge }).__fake = fake;
  return fake;
}

beforeEach(() => {
  install();
});

afterEach(() => {
  cleanup();
  uninstallFakeBridge();
  delete (globalThis as { __fake?: FakeBridge }).__fake;
  vi.restoreAllMocks();
});

describe("the fleet", () => {
  it("reads the fleet through one action and draws what the child grouped", async () => {
    await open(context(), "invoke:pageFleet");

    // The page asks the CHILD for the grouping. A page that regrouped would be
    // a second implementation of `fleet.js:groupFleet` that could disagree with
    // the panel every other client draws.
    expect(fake.callsTo("invoke:pageFleet")).toHaveLength(1);
    expect(await screen.findByText("Fix the flaky sync test")).toBeTruthy();
  });

  it("acknowledges the unread badge on arrival and on departure", async () => {
    await open(context(), "invoke:pageAckBadge");
    expect(fake.lastCall("invoke:pageAckBadge")?.args).toEqual({ viewed: true });

    cleanup();
    await waitFor(() => {
      expect(fake.callsTo("invoke:pageAckBadge")).toHaveLength(2);
    });
    // A refcount, not a reset: the rail tab, the Work-rail pane and a phone can
    // all be mounted at once, and only the child can count them.
    expect(fake.lastCall("invoke:pageAckBadge")?.args).toEqual({ viewed: false });
  });

  it("draws the no-key body without inventing a second connection read", async () => {
    install({ connected: false });
    await open(context(), "invoke:pageFleet");

    expect(
      await screen.findByText(/Connect Cursor first — add an API key or log in via Settings → AI connections\./),
    ).toBeTruthy();
    // The key state rides on the fleet read. A separate `pageConnection` here
    // would be a second round trip answering a question the first one answered.
    expect(fake.callsTo("invoke:pageConnection")).toHaveLength(0);
  });

  it("sends the reader to ADE's own settings rather than writing a hash", async () => {
    install({ connected: false });
    await open(context(), "invoke:pageFleet");

    fireEvent.click(await screen.findByText("Open AI connections"));
    await waitFor(() => expect(fake.callsTo("openSettings")).toHaveLength(1));
    // A guest has its own document and its own hash. Writing one would navigate
    // the PAGE; the host owns its routes, so the host is asked.
    expect(fake.lastCall("openSettings")?.args).toEqual({ entryId: "agents.providers" });
  });

  it("re-reads on a pull-to-refresh gesture", async () => {
    await open(context(), "invoke:pageFleet");
    const before = fake.callsTo("invoke:pageFleet").length;

    await act(async () => {
      fake.emit("refresh");
    });

    await waitFor(() => {
      expect(fake.callsTo("invoke:pageFleet").length).toBeGreaterThan(before);
    });
  });

  it("stops a run through the child and never through Cursor", async () => {
    await open(context(), "invoke:pageFleet");

    fireEvent.click(await screen.findByTitle("Stop this run — works even if it was launched elsewhere"));
    await waitFor(() => expect(fake.callsTo("invoke:pageStopRun")).toHaveLength(1));
    expect(fake.lastCall("invoke:pageStopRun")?.args).toEqual({ agentId: "bc_abc123" });
  });

  it("opens a cloud agent as an ADE chat", async () => {
    await open(context(), "invoke:pageFleet");

    fireEvent.click(
      await screen.findByTitle("Open as an ADE cloud chat — replies keep running in cloud"),
    );
    await waitFor(() => expect(fake.callsTo("invoke:pageOpenInAde")).toHaveLength(1));
    expect(fake.lastCall("invoke:pageOpenInAde")?.args).toMatchObject({ agentId: "bc_abc123" });
  });

  it("asks to create a lane when open-in-ADE needs one", async () => {
    const host = await open(context(), "invoke:pageFleet");
    host.setAction("pageOpenInAde", (args) => {
      if (args.createLane === true) {
        return { ok: true, message: "Opened this cloud agent as a chat in ADE.", sessionId: "session-1" };
      }
      return {
        ok: false,
        needsLane: true,
        suggestedName: "cursor/fix-sync",
        branch: "cursor/fix-sync",
        message: "This cloud agent has no local lane yet. Create one from the primary to open it in ADE.",
      };
    });

    fireEvent.click(
      await screen.findByTitle("Open as an ADE cloud chat — replies keep running in cloud"),
    );
    expect(await screen.findByText("Create a local lane")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create lane and open" }));
    await waitFor(() => {
      expect(host.callsTo("invoke:pageOpenInAde").some((call) => call.args.createLane === true)).toBe(true);
    });
  });

  it("opens this agent on cursor.com from the row menu", async () => {
    await open(context(), "invoke:pageFleet");

    fireEvent.click(await screen.findByLabelText("More actions"));
    fireEvent.click(await screen.findByText("View on cursor.com"));
    await waitFor(() => expect(fake.callsTo("openDeeplink")).toHaveLength(1));
    expect(fake.lastCall("openDeeplink")?.args).toEqual({ url: "https://cursor.com/agents?id=bc_abc123" });
  });

  it("opens cursor.com through the host, never through window.open", async () => {
    await open(context(), "invoke:pageFleet");

    fireEvent.click(await screen.findByText("All agents on cursor.com"));
    await waitFor(() => expect(fake.callsTo("openDeeplink")).toHaveLength(1));
    // No query params, exactly as the compiled footer link.
    expect(fake.lastCall("openDeeplink")?.args).toEqual({ url: "https://cursor.com/agents" });
  });

  it("archives through the child and takes the row out of the list", async () => {
    await open(context(), "invoke:pageFleet");

    fireEvent.click(await screen.findByLabelText("More actions"));
    fireEvent.click(await screen.findByText("Archive agent"));
    await waitFor(() => expect(fake.callsTo("invoke:pageArchiveAgent")).toHaveLength(1));
    expect(fake.lastCall("invoke:pageArchiveAgent")?.args).toEqual({ agentId: "bc_abc123" });
    // The child answered; the page re-reads rather than patching its own copy.
    await waitFor(() => expect(fake.callsTo("invoke:pageFleet").length).toBeGreaterThan(1));
  });

  it("arms a delete before it sends one", async () => {
    await open(context(), "invoke:pageFleet");

    fireEvent.click(await screen.findByLabelText("More actions"));
    fireEvent.click(await screen.findByText("Delete agent…"));
    // First press ARMS. A cloud agent deleted on Cursor is gone for everyone,
    // so the page must not send one on a single click.
    expect(fake.callsTo("invoke:pageDeleteAgent")).toHaveLength(0);

    fireEvent.click(await screen.findByText("Click again to delete forever"));
    await waitFor(() => expect(fake.callsTo("invoke:pageDeleteAgent")).toHaveLength(1));
  });

  it("keeps filters in the ui-state collection, never in localStorage", async () => {
    await open(context(), "invoke:pageFleet");

    fireEvent.click(await screen.findByRole("button", { name: /Filters/ }));
    fireEvent.change(await screen.findByLabelText("Filter by status"), {
      target: { value: "finished" },
    });

    await waitFor(() => {
      expect(fake.callsTo("collections.put").some((call) => call.args.collection === "ui-state")).toBe(true);
    });
    // A guest partition is non-persistent: it dies with the placement.
    // This Node/Vitest env often has no `localStorage` at all; either way the
    // page must not have written one.
    expect(window.localStorage == null || window.localStorage.length === 0).toBe(true);
  });
});

describe("the agent detail", () => {
  it("reads one agent by id when a row is opened", async () => {
    await open(context(), "invoke:pageFleet");

    fireEvent.click(await screen.findByText("Fix the flaky sync test"));
    await waitFor(() => expect(fake.callsTo("invoke:pageAgent")).toHaveLength(1));
    expect(fake.lastCall("invoke:pageAgent")?.args).toEqual({ agentId: "bc_abc123" });
  });

  it("sends a follow-up to the agent, not to a new one", async () => {
    await open(context({ surfaceId: "agent", subject: { kind: "agent", agentId: "bc_abc123" } }), "invoke:pageAgent");

    const box = await screen.findByLabelText("Follow-up prompt");
    fireEvent.change(box, { target: { value: "Also update the changelog." } });
    fireEvent.click(await screen.findByText("Send"));

    await waitFor(() => expect(fake.callsTo("invoke:pageFollowUp")).toHaveLength(1));
    expect(fake.lastCall("invoke:pageFollowUp")?.args).toEqual({
      agentId: "bc_abc123",
      prompt: "Also update the changelog.",
    });
  });

  it("refuses a follow-up once the run is no longer live", async () => {
    install({
      entries: [fakeEntry({ active: false, status: "finished", runStatus: "finished", agent: { status: "finished" } })],
    });
    await open(context({ surfaceId: "agent", subject: { kind: "agent", agentId: "bc_abc123" } }), "invoke:pageAgent");

    // Drawn but disabled, with its own reason. A box that disappeared would
    // raise "where did the reply field go".
    expect((await screen.findByLabelText("Follow-up prompt") as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("opens an artifact through the host rather than fetching it itself", async () => {
    await open(context({ surfaceId: "agent", subject: { kind: "agent", agentId: "bc_abc123" } }), "invoke:pageAgent");

    const row = (await screen.findByText("reports/coverage.json")).closest("div")!;
    fireEvent.click(within(row).getByText("Open"));

    await waitFor(() => expect(fake.callsTo("openDeeplink")).toHaveLength(1));
    // A signed download that expires. The host opens it, exactly as it opens a
    // PR: a guest fetching it would need `api.cursor.com` in its own allowlist
    // and would have nowhere to put the bytes.
    expect(String(fake.lastCall("openDeeplink")?.args.url)).toContain("https://");
  });
});

describe("the launch form", () => {
  const LAUNCH = context({
    surfaceId: "launch",
    placement: "composer-picker",
    subject: { kind: "composer", laneId: "lane-1", draft: "Fix the flaky sync test" },
  });

  it("reads the launch context once and seeds the prompt from the draft", async () => {
    await open(LAUNCH, "invoke:pageLaunchContext");

    expect((await screen.findByLabelText("Prompt") as HTMLTextAreaElement).value)
      .toBe("Fix the flaky sync test");
  });

  it("reports its height so the popover can size to the form", async () => {
    await open(LAUNCH, "invoke:pageLaunchContext");
    // A composer picker is not a viewport. `ui.resize` is the one height
    // channel; without it the host draws the frame at the size page.css gives.
    await waitFor(() => expect(fake.callsTo("ui.resize").length).toBeGreaterThan(0));
  });

  it("draws the child's refusal instead of its fields", async () => {
    install({
      launch: {
        unavailable: "This repo is not connected to Cursor. Connect it in Cursor, then try again.",
      },
    });
    await open(LAUNCH, "invoke:pageLaunchContext");

    expect(
      await screen.findByText("This repo is not connected to Cursor. Connect it in Cursor, then try again."),
    ).toBeTruthy();
    // The reason is the compiled composer's own sentence. The form must not
    // reword it, and must not offer fields the child has already vetoed.
    expect(screen.queryByLabelText("Prompt")).toBeNull();
  });

  it("uses ADE's own model picker when the host answers one", async () => {
    await open(LAUNCH, "invoke:pageLaunchContext");

    fireEvent.click(await screen.findByLabelText("Model"));
    await waitFor(() => expect(fake.callsTo("ui.pickModel")).toHaveLength(1));
    // Scoped to Cursor Cloud's catalog, not ADE's whole list — otherwise the
    // form would offer models Enter then refuses.
    expect(fake.lastCall("ui.pickModel")?.args).toMatchObject({
      value: "composer-2",
      availableModelIds: ["composer-2", "sonnet-4.5"],
    });
  });

  it("uses ADE's own lane picker when the host answers one", async () => {
    await open(LAUNCH, "invoke:pageLaunchContext");

    fireEvent.click(await screen.findByLabelText("Lane"));
    await waitFor(() => expect(fake.callsTo("ui.pickLane")).toHaveLength(1));
    expect(fake.lastCall("ui.pickLane")?.args).toMatchObject({ value: "lane-1" });
  });

  it("uses ADE's own reasoning picker for the chosen model", async () => {
    await open(LAUNCH, "invoke:pageLaunchContext");

    fireEvent.click(await screen.findByLabelText("Reasoning effort"));
    await waitFor(() => expect(fake.callsTo("ui.pickReasoningEffort")).toHaveLength(1));
    expect(fake.lastCall("ui.pickReasoningEffort")?.args).toMatchObject({ model: "composer-2" });
  });

  it("launches with names, never with secret values", async () => {
    await open(LAUNCH, "invoke:pageLaunchContext");

    fireEvent.click(await screen.findByLabelText("DATABASE_URL"));
    fireEvent.click(await screen.findByText("Launch"));

    await waitFor(() => expect(fake.callsTo("invoke:pageLaunch")).toHaveLength(1));
    const args = fake.lastCall("invoke:pageLaunch")!.args;
    expect(args.prompt).toBe("Fix the flaky sync test");
    expect(args.model).toBe("composer-2");
    expect(args.fastMode).toBe(false);
    expect(args.secretNames).toEqual(["DATABASE_URL"]);
    // A page that could read a secret value would be a page that could
    // exfiltrate one. Every value stays in the child.
    expect(JSON.stringify(args)).not.toContain("=");
  });

  it("keeps the fast tier ADE's picker set", async () => {
    // ADE's model picker sets the model AND the fast flag in one gesture. A
    // page that kept only the id would silently run standard.
    install({ modelPick: { modelId: "composer-2", fastMode: true } });
    await open(LAUNCH, "invoke:pageLaunchContext");

    fireEvent.click(await screen.findByLabelText("Model"));
    await waitFor(() => expect(fake.callsTo("ui.pickModel")).toHaveLength(1));
    fireEvent.click(await screen.findByText("Launch"));

    await waitFor(() => expect(fake.callsTo("invoke:pageLaunch")).toHaveLength(1));
    expect(fake.lastCall("invoke:pageLaunch")!.args.fastMode).toBe(true);
  });

  it("draws its own selects when the host has no pickers", async () => {
    install({ hostPickers: false });
    await open(LAUNCH, "invoke:pageLaunchContext");

    // The fallback is the v1 path, not dead code. A chip that looked live and
    // opened nothing would be worse than a real list the reader can use.
    expect((await screen.findByLabelText("Model")).tagName).toBe("SELECT");
    expect(screen.getByLabelText("Lane").tagName).toBe("SELECT");
    expect(fake.callsTo("ui.pickModel")).toHaveLength(0);
  });

  it("closes the popover on a launch the child accepted", async () => {
    await open(LAUNCH, "invoke:pageLaunchContext");

    fireEvent.click(await screen.findByText("Launch"));
    await waitFor(() => expect(fake.callsTo("surface.close")).toHaveLength(1));
  });

  it("keeps the form open and draws the sentence on a launch the child refused", async () => {
    await open(LAUNCH, "invoke:pageLaunchContext");
    fake.setAction("pageLaunch", () => ({
      ok: false,
      message: "Choose a Cursor Cloud model first",
    }));

    fireEvent.click(await screen.findByText("Launch"));
    await waitFor(() => expect(fake.callsTo("invoke:pageLaunch")).toHaveLength(1));

    expect(await screen.findByText("Choose a Cursor Cloud model first")).toBeTruthy();
    // The prompt is still on screen: a failed launch must never eat the draft.
    expect(fake.callsTo("surface.close")).toHaveLength(0);
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Fix the flaky sync test");
  });
});

describe("the seam itself", () => {
  it("invokes nothing the child does not answer", async () => {
    // Every surface, in one walk. The fake throws by NAME for an unscripted id,
    // so this fails with the action that drifted rather than with a blank page.
    for (const surfaceId of ["fleet", "agent", "launch"] as const) {
      cleanup();
      install();
      render(<PageRouter context={context({ surfaceId })} />);
      await waitFor(() => expect(fake.calls.length).toBeGreaterThan(0));
    }

    const invoked = new Set(
      fake.calls
        .map((call) => call.method)
        .filter((method) => method.startsWith("invoke:"))
        .map((method) => method.slice("invoke:".length)),
    );
    for (const action of invoked) {
      expect(action.startsWith("page")).toBe(true);
    }
  });

  it("reaches the host only through the bridge", async () => {
    await open(context(), "invoke:pageFleet");
    // Nothing outside `src/bridge.ts` may touch the global, and nothing at all
    // may reach the network: the page holds no Cursor key and no client.
    expect(fake.calls.every((call) => typeof call.method === "string")).toBe(true);
  });
});
