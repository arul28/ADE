import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudePluginUiSnapshot } from "../../../shared/claudePluginUi";
import { createClaudePluginUiService } from "./claudePluginUiService";

const SESSION = "chat-1";

type Render = { tree?: unknown; hooked?: boolean } | "hang" | "fail" | "no-body";

/** A fake Claude query: answers `ui_render` per site from `renders`, and records every control request. */
function fakeQuery(renders: Record<string, Render> = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const request = vi.fn(async (body: Record<string, unknown>) => {
    sent.push(body);
    if (body.subtype !== "ui_render") {
      return { subtype: "success", response: body.subtype === "ui_close" ? { closed: true } : { handled: true } };
    }
    const render = renders[String(body.instance_id)] ?? { hooked: false };
    if (render === "hang") return new Promise(() => {});
    if (render === "fail") throw new Error("boom");
    if (render === "no-body") return { subtype: "error" };
    return { subtype: "success", response: { hooked: render.hooked ?? true, tree: render.tree } };
  });
  return { query: { request }, renders, sent, requestsOf: (subtype: string) => sent.filter((body) => body.subtype === subtype) };
}

const button = (label: string, handle: number) => ({ type: "Button", props: { key: label, label }, press: { plugin: "demo", handle } });
const band = (label: string, handle: number) => ({ type: "Box", children: [{ type: "Text", children: [label] }, button(label, handle)] });
const ui = (subtype: string, extra: Record<string, unknown> = {}) => ({ type: "system", subtype, ...extra });

function setup(options: { enabled?: boolean } = {}) {
  const state = { enabled: options.enabled ?? true };
  const published: ClaudePluginUiSnapshot[] = [];
  const service = createClaudePluginUiService({
    isEnabled: () => state.enabled,
    publish: (_sessionId, snapshot) => published.push(snapshot),
    logger: { debug: () => {} },
  });
  return { service, state, published, last: () => published.at(-1) };
}

/** Lets the render throttle fire and the answered requests settle. */
const settle = () => vi.advanceTimersByTimeAsync(250);

describe("createClaudePluginUiService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("draws the band a mod returns and forwards only an action that names a control it sent", async () => {
    const { service, last } = setup();
    const claude = fakeQuery({ "above-prompt": { tree: band("Bump", 7) } });
    service.attach(SESSION, claude.query);
    await settle();

    const shown = service.get(SESSION);
    expect(shown.live).toBe(true);
    expect(shown.band).toEqual(last()?.band);
    expect(JSON.stringify(shown.band)).toContain("Bump");
    expect(claude.requestsOf("ui_render")[0]).toMatchObject({ surface: "desktop", component: "AbovePrompt" });

    const press = { sessionId: SESSION, generation: shown.generation, kind: "press", target: { plugin: "demo", handle: 7 }, key: "Bump" };
    await expect(service.act(press)).resolves.toEqual({ handled: true });
    expect(claude.requestsOf("ui_press")).toEqual([{ subtype: "ui_press", plugin: "demo", handle: 7, surface: "desktop", key: "Bump" }]);

    const refused = [
      { ...press, generation: shown.generation - 1 },
      { ...press, target: { plugin: "demo", handle: 8 } },
      { ...press, target: { plugin: "demo", handle: "7" } },
      { ...press, target: { plugin: "dem", handle: 7 } },
      { ...press, kind: "launch" },
      { ...press, sessionId: "another-chat" },
      { ...press, kind: "input", value: "typed" },
      { ...press, kind: "input", value: "typed", site: { component: "Pane", paneId: "notes" } },
      { ...press, kind: "select", value: 3, site: { component: "AbovePrompt" } },
      { ...press, kind: "closePane", paneId: "notes" },
      null,
      "press",
    ];
    for (const args of refused) await expect(service.act(args)).resolves.toEqual({ handled: false });
    expect(claude.sent.filter((body) => body.subtype !== "ui_render")).toHaveLength(1);

    // A typed value reaches the site the control was drawn in.
    await expect(service.act({ ...press, kind: "input", value: "typed", site: { component: "AbovePrompt" } })).resolves.toEqual({ handled: true });
    expect(claude.requestsOf("ui_input")[0]).toMatchObject({ value: "typed", kind: "submit", component: "AbovePrompt", handle: 7 });
  });

  it("keeps status lines per mod, and sends a toast with one publish only", () => {
    const { service, last, published } = setup();
    const claude = fakeQuery();
    service.attach(SESSION, claude.query);

    expect(service.ingest(SESSION, claude.query, ui("ui_status", { plugin: "a", text: "one" }))).toBe(true);
    service.ingest(SESSION, claude.query, ui("ui_status", { plugin: "b", text: "two\u0000‮" }));
    service.ingest(SESSION, claude.query, ui("ui_status", { plugin: "a", text: "three" }));
    expect(last()?.statuses).toEqual([{ plugin: "b", text: "two" }, { plugin: "a", text: "three" }]);
    service.ingest(SESSION, claude.query, ui("ui_status", { plugin: "b", text: null }));
    expect(last()?.statuses).toEqual([{ plugin: "a", text: "three" }]);

    service.ingest(SESSION, claude.query, ui("ui_toast", { plugin: "a", text: "done", timeout_ms: 999_999, uuid: "t-1" }));
    expect(last()?.toast).toEqual({ id: "t-1", plugin: "a", text: "done", timeoutMs: 60_000 });
    // A read, and every later publish, carries no toast: it is news once.
    expect(service.get(SESSION).toast).toBeNull();
    service.ingest(SESSION, claude.query, ui("ui_status", { plugin: "c", text: "later" }));
    expect(last()?.toast).toBeNull();
    expect(published.filter((snapshot) => snapshot.toast).length).toBe(1);

    // Messages that are not mod UI stay with the turn.
    expect(service.ingest(SESSION, claude.query, { type: "assistant" })).toBe(false);
    expect(service.ingest(SESSION, claude.query, ui("init"))).toBe(false);
    expect(service.ingest(SESSION, claude.query, ui("ui_log", { plugin: "a", text: "debug" }))).toBe(true);
  });

  it("drops a mod message of a query that is not the chat's own", async () => {
    const { service, published } = setup();
    const current = fakeQuery();
    const replaced = fakeQuery();
    service.attach(SESSION, current.query);
    await settle();
    const before = published.length;

    // Consumed (it is still no part of a turn), but it changes nothing.
    expect(service.ingest(SESSION, replaced.query, ui("ui_status", { plugin: "old", text: "stale" }))).toBe(true);
    expect(service.ingest(SESSION, null, ui("ui_status", { plugin: "old", text: "stale" }))).toBe(true);
    expect(published.length).toBe(before);
    expect(service.get(SESSION).statuses).toEqual([]);
    expect(replaced.sent).toEqual([]);
  });

  it("keeps the tree and the controls on screen when a redraw fails", async () => {
    const { service } = setup();
    const claude = fakeQuery({ "above-prompt": { tree: band("First", 1) } });
    service.attach(SESSION, claude.query);
    await settle();
    const { generation } = service.get(SESSION);
    const pressFirst = { sessionId: SESSION, generation, kind: "press", target: { plugin: "demo", handle: 1 } };

    for (const failure of ["fail", "no-body", "hang"] as const) {
      claude.renders["above-prompt"] = failure;
      service.ingest(SESSION, claude.query, ui("ui_invalidate"));
      await vi.advanceTimersByTimeAsync(5_500);
      expect(JSON.stringify(service.get(SESSION).band)).toContain("First");
      expect(service.get(SESSION).live).toBe(true);
      await expect(service.act(pressFirst)).resolves.toEqual({ handled: true });
    }

    // A redraw that answers replaces both: the old control is refused, the new one works.
    claude.renders["above-prompt"] = { tree: band("Second", 2) };
    service.ingest(SESSION, claude.query, ui("ui_invalidate"));
    await settle();
    expect(JSON.stringify(service.get(SESSION).band)).toContain("Second");
    await expect(service.act(pressFirst)).resolves.toEqual({ handled: false });
    await expect(service.act({ ...pressFirst, target: { plugin: "demo", handle: 2 } })).resolves.toEqual({ handled: true });
  });

  it("does not publish a redraw that draws the same thing, and folds a burst of redraws", async () => {
    const { service, published } = setup();
    const claude = fakeQuery({ "above-prompt": { tree: band("Same", 1) } });
    service.attach(SESSION, claude.query);
    await settle();
    const publishedOnce = published.length;
    const rendersOnce = claude.requestsOf("ui_render").length;

    for (let index = 0; index < 20; index += 1) service.ingest(SESSION, claude.query, ui("ui_invalidate"));
    await settle();
    expect(claude.requestsOf("ui_render").length).toBe(rendersOnce + 1);
    expect(published.length).toBe(publishedOnce);
  });

  it("dims the band when the Claude process goes, and starts the next one with a new generation and no panes", async () => {
    const { service, last } = setup();
    const first = fakeQuery({ "above-prompt": { tree: band("Old", 1) }, notes: { tree: band("Pane", 5) } });
    service.attach(SESSION, first.query);
    service.ingest(SESSION, first.query, ui("ui_status", { plugin: "a", text: "busy" }));
    service.ingest(SESSION, first.query, ui("ui_panes", { panes: [{ id: "notes", title: "Notes", plugin: "demo" }, { id: "../bad id" }] }));
    await settle();
    const old = service.get(SESSION);
    expect(old.panes.map((pane) => pane.id)).toEqual(["notes"]);
    expect(JSON.stringify(old.panes[0]?.tree)).toContain("Pane");

    // A pane this process lists can be closed; a pane control needs its own site.
    const inPane = { sessionId: SESSION, generation: old.generation, kind: "input", value: "x", target: { plugin: "demo", handle: 5 } };
    await expect(service.act({ ...inPane, site: { component: "AbovePrompt" } })).resolves.toEqual({ handled: false });
    await expect(service.act({ ...inPane, site: { component: "Pane", paneId: "notes" } })).resolves.toEqual({ handled: true });
    await expect(service.act({ sessionId: SESSION, generation: old.generation, kind: "closePane", paneId: "notes" })).resolves.toEqual({ handled: true });
    expect(first.requestsOf("ui_close")).toEqual([{ subtype: "ui_close", id: "notes" }]);

    service.detach(SESSION);
    expect(last()).toMatchObject({ live: false, statuses: [], generation: old.generation });
    expect(JSON.stringify(last()?.band)).toContain("Old");
    await expect(service.act({ sessionId: SESSION, generation: old.generation, kind: "press", target: { plugin: "demo", handle: 1 } }))
      .resolves.toEqual({ handled: false });

    const second = fakeQuery({ "above-prompt": "hang" });
    service.attach(SESSION, second.query);
    const carried = service.get(SESSION);
    expect(carried.generation).toBeGreaterThan(old.generation);
    expect(carried).toMatchObject({ live: false, panes: [], statuses: [] });
    expect(JSON.stringify(carried.band)).toContain("Old");

    // The chat ends: clients are told to take the drawing down.
    service.forget(SESSION);
    expect(last()).toMatchObject({ generation: 0, band: null, live: false });
    expect(service.get(SESSION).band).toBeNull();
  });

  it("draws nothing while the setting is off, and follows the setting within a session", async () => {
    const { service, state, published, last } = setup({ enabled: false });
    const claude = fakeQuery({ "above-prompt": { tree: band("Band", 1) } });
    service.attach(SESSION, claude.query);
    await settle();
    // Nothing is asked of the Claude process, and nothing is sent to clients.
    expect(claude.sent).toEqual([]);
    expect(published).toEqual([]);
    // A mod's message is still consumed, so it never counts as turn activity.
    expect(service.ingest(SESSION, claude.query, ui("ui_status", { plugin: "a", text: "hidden" }))).toBe(true);
    await settle();
    expect(published).toEqual([]);
    expect(claude.sent).toEqual([]);
    expect(service.get(SESSION).generation).toBe(0);

    // Turned on: the next message of the running query starts the drawing.
    state.enabled = true;
    service.ingest(SESSION, claude.query, ui("ui_status", { plugin: "a", text: "shown" }));
    await settle();
    expect(service.get(SESSION)).toMatchObject({ live: true, statuses: [{ plugin: "a", text: "shown" }] });
    const { generation } = service.get(SESSION);

    // Turned off again: the drawing is taken down, and actions are refused.
    state.enabled = false;
    await expect(service.act({ sessionId: SESSION, generation, kind: "press", target: { plugin: "demo", handle: 1 } }))
      .resolves.toEqual({ handled: false });
    service.ingest(SESSION, claude.query, ui("ui_invalidate"));
    expect(last()).toMatchObject({ generation: 0, band: null, statuses: [] });
    expect(service.get(SESSION).band).toBeNull();
  });

  it("shows status lines but no controls when the SDK has no control channel", async () => {
    const { service } = setup();
    const noChannel = {};
    service.attach(SESSION, noChannel);
    service.ingest(SESSION, noChannel, ui("ui_status", { plugin: "a", text: "still shown" }));
    await settle();
    const shown = service.get(SESSION);
    expect(shown.statuses).toEqual([{ plugin: "a", text: "still shown" }]);
    expect(shown.live).toBe(false);
    expect(shown.band).toBeNull();
    await expect(service.act({ sessionId: SESSION, generation: shown.generation, kind: "press", target: { plugin: "demo", handle: 1 } }))
      .resolves.toEqual({ handled: false });
  });
});
