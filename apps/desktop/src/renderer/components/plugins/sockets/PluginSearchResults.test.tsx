/* @vitest-environment jsdom */

import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ADE_NAVIGATE_TARGET_EVENT } from "../../../lib/openExternal";
import {
  PLUGIN_SEARCH_PROVIDER_TIMEOUT_MS,
  usePluginSearchResults,
} from "./usePluginSearchResults";

/**
 * The `searchProviders` engine registration, from a manifest declaration to a
 * palette row.
 *
 * The load-bearing assertions are the ones about TIME, because that is what
 * separates this socket from every other one: a provider is invoked live while
 * someone types, so the palette's correctness depends on what happens when one
 * of them is slow (dropped, others still render), when one answers late for a
 * question that has moved on (ignored), and when one is simply broken (skipped,
 * silently). The rest — attribution, the per-plugin cap — is the same contract
 * `PluginPaletteCommands.test.tsx` holds the palette socket to.
 */

type Invocation = { action: string; args: Record<string, unknown>; timeoutMs: unknown };

const invoked: Invocation[] = [];

/** Peak simultaneous in-flight invocations: the proof that the fan-out is parallel. */
let inFlight = 0;
let peakInFlight = 0;

/** Set per test. Returns whatever the provider "answers" with. */
let respond: (action: string, args: Record<string, unknown>) => Promise<unknown> = async () => ({
  results: [],
});

/** A provider that answers after `ms` of fake time. */
function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

function rowsOf(count: number, prefix: string): { id: string; title: string }[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    title: `${prefix} ${index}`,
  }));
}

beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      list: async () => [
        {
          pluginId: "notes",
          displayName: "Notes",
          enabled: true,
          accent: null,
          icon: null,
          disabledContributions: [],
          // The manifest cap is two providers per plugin; both are asked, and
          // the row cap below applies across the pair rather than to each.
          searchProviders: [
            { id: "titles", label: "Note titles", action: "search.titles" },
            { id: "bodies", label: "Note bodies", action: "search.bodies" },
          ],
        },
        {
          pluginId: "tracker",
          displayName: "Tracker",
          enabled: true,
          accent: null,
          icon: null,
          disabledContributions: [],
          searchProviders: [{ id: "issues", label: "Issues", action: "search.issues" }],
        },
        {
          // Switched off: the plugin-level kill switch is the one that has to
          // hold here, or a disabled plugin would still be answering keystrokes.
          pluginId: "archived",
          displayName: "Archived",
          enabled: false,
          accent: null,
          icon: null,
          disabledContributions: [],
          searchProviders: [{ id: "old", label: "Old", action: "search.old" }],
        },
      ],
      getManifest: async () => null,
      listContributions: async () => [],
      invoke: async (input: {
        pluginId: string;
        action: string;
        args?: Record<string, unknown>;
        timeoutMs?: number;
      }) => {
        invoked.push({
          action: input.action,
          args: input.args ?? {},
          timeoutMs: input.timeoutMs,
        });
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        try {
          return await respond(input.action, input.args ?? {});
        } finally {
          inFlight -= 1;
        }
      },
    },
  };
});

beforeEach(() => {
  vi.useFakeTimers();
  invoked.length = 0;
  inFlight = 0;
  peakInFlight = 0;
  respond = async () => ({ results: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

function Harness({ query, active = true }: { query: string; active?: boolean }) {
  const rows = usePluginSearchResults(query, active);
  return (
    <div>
      <span data-testid="titles">{rows.map((row) => row.title).join("|")}</span>
      <span data-testid="hints">{rows.map((row) => row.hint).join("|")}</span>
      <span data-testid="count">{rows.length}</span>
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            <button type="button" onClick={row.run}>
              {row.title}
            </button>
            <span data-testid={`keywords-${row.title}`}>{row.keywords.join(",")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Advance fake time and let every promise the advance unblocked settle. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await Promise.resolve();
  });
}

/** Mount, resolve the install list, and run the 150ms debounce out. */
async function settle(): Promise<void> {
  await tick(0);
  await tick(0);
  await tick(150);
  await tick(0);
}

function titles(): string[] {
  const text = screen.getByTestId("titles").textContent ?? "";
  return text.length > 0 ? text.split("|") : [];
}

describe("contributed search results", () => {
  it("attributes every row to its plugin and carries the query as a keyword", async () => {
    respond = async (action) =>
      action === "search.titles"
        ? { results: [{ id: "n1", title: "Release checklist", subtitle: "Edited today" }] }
        : { results: [] };

    render(<Harness query="release" />);
    await settle();

    // Attribution is what tells two plugins' identically-titled rows apart, and
    // it leads: the question a reader has about an unfamiliar row is whose it is.
    expect(screen.getByTestId("hints").textContent).toBe("Notes plugin · Edited today");
    // The query rides in the keywords because the palette filters its commands
    // by substring — without it the palette would silently re-filter answers a
    // provider had already matched.
    expect(screen.getByTestId("keywords-Release checklist").textContent)
      .toBe("plugin,notes,Notes,release");
  });

  it("caps a plugin at eight rows across all of its providers", async () => {
    respond = async (action) => {
      if (action === "search.titles") return { results: rowsOf(6, "title") };
      if (action === "search.bodies") return { results: rowsOf(6, "body") };
      return { results: rowsOf(3, "issue") };
    };

    render(<Harness query="q" />);
    await settle();

    const rendered = titles();
    // Twelve rows offered by one plugin's two providers; eight rendered. The cap
    // is per PLUGIN, so the second provider contributes only the remaining two.
    expect(rendered.filter((title) => title.startsWith("title")).length).toBe(6);
    expect(rendered.filter((title) => title.startsWith("body")).length).toBe(2);
    // A different plugin has its own eight, so the cap never starves a neighbour.
    expect(rendered.filter((title) => title.startsWith("issue")).length).toBe(3);
  });

  it("drops a provider that misses the budget and renders the ones that answered", async () => {
    respond = async (action) => {
      // Never answers. The palette must not wait for it, and must never show it.
      if (action === "search.issues") return new Promise(() => {});
      if (action === "search.titles") return { results: [{ id: "fast", title: "Fast row" }] };
      return { results: [] };
    };

    render(<Harness query="q" />);
    await settle();

    expect(titles()).toEqual(["Fast row"]);
    // It was asked — being dropped is a timeout, not a refusal to invoke.
    expect(invoked.map((call) => call.action)).toContain("search.issues");
    // Past the budget, and still only the fast provider's row.
    await tick(PLUGIN_SEARCH_PROVIDER_TIMEOUT_MS + 50);
    expect(titles()).toEqual(["Fast row"]);
  });

  it("sends the budget to the host as well as enforcing it locally", async () => {
    render(<Harness query="q" />);
    await settle();

    expect(invoked.length).toBeGreaterThan(0);
    for (const call of invoked) {
      expect(call.timeoutMs).toBe(PLUGIN_SEARCH_PROVIDER_TIMEOUT_MS);
      expect(call.args).toEqual({ query: "q" });
    }
  });

  it("ignores a late answer to a superseded query", async () => {
    let resolveStale: ((value: unknown) => void) | null = null;
    respond = async (action, args) => {
      if (action !== "search.titles") return { results: [] };
      if (args.query === "aa") {
        return new Promise((resolve) => {
          resolveStale = resolve;
        });
      }
      return { results: [{ id: "fresh", title: "Fresh row" }] };
    };

    const view = render(<Harness query="aa" />);
    await settle();
    expect(titles()).toEqual([]);

    // The question moves on while the first round is still in flight.
    view.rerender(<Harness query="aab" />);
    await tick(150);
    await tick(0);
    expect(titles()).toEqual(["Fresh row"]);

    // The stale round answers INSIDE its own budget, so only the generation
    // guard can be what drops it — this is the bug that makes a palette feel
    // haunted, rows for two keystrokes ago appearing under what you type now.
    await act(async () => {
      resolveStale?.({ results: [{ id: "stale", title: "Stale row" }] });
      await Promise.resolve();
    });
    expect(titles()).toEqual(["Fresh row"]);
  });

  it("skips a provider that throws or answers with garbage without losing the others", async () => {
    respond = async (action) => {
      if (action === "search.titles") throw new Error("provider exploded");
      // Not an array and not `{results}`: a shape this build does not know.
      if (action === "search.bodies") return { rows: "everything", ok: true };
      return { results: [{ id: "i1", title: "Issue row" }] };
    };

    render(<Harness query="q" />);
    await settle();

    expect(titles()).toEqual(["Issue row"]);
  });

  it("never invokes a provider while the palette is closed or the query is empty", async () => {
    const view = render(<Harness query="notes" active={false} />);
    await settle();
    await tick(500);
    expect(invoked).toHaveLength(0);

    view.rerender(<Harness query="   " active />);
    await settle();
    await tick(500);
    expect(invoked).toHaveLength(0);
  });

  it("never invokes a disabled plugin's provider", async () => {
    render(<Harness query="q" />);
    await settle();

    expect(invoked.map((call) => call.action)).not.toContain("search.old");
  });


  it("invokes every provider in parallel rather than in sequence", async () => {
    respond = async (action) => after(200, { results: [{ id: action, title: `Row ${action}` }] });

    render(<Harness query="q" />);
    await settle();
    // One provider's latency, not three. Serially this would need 600ms, and the
    // 300ms budget would have dropped the last two before they ever answered.
    await tick(210);

    expect(titles().sort()).toEqual([
      "Row search.bodies",
      "Row search.issues",
      "Row search.titles",
    ]);
    expect(peakInFlight).toBe(3);
  });

  it("opens a row that carries its own navigate target through app navigation", async () => {
    respond = async (action) =>
      action === "search.titles"
        ? {
          results: [{
            id: "n1",
            title: "Go somewhere",
            navigate: { panelId: "detail", context: { noteId: "n1" } },
          }],
        }
        : { results: [] };

    const targets: unknown[] = [];
    const listener = (event: Event): void => {
      targets.push((event as CustomEvent<{ target: unknown }>).detail.target);
    };
    window.addEventListener(ADE_NAVIGATE_TARGET_EVENT, listener);

    render(<Harness query="q" />);
    await settle();
    const before = invoked.length;

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Go somewhere" }));
    });
    window.removeEventListener(ADE_NAVIGATE_TARGET_EVENT, listener);

    // Routed through the ordinary navigation target, which is what puts it
    // behind the same installed-and-enabled gate a `plugin` deeplink passes.
    expect(targets).toEqual([
      { kind: "plugin", pluginId: "notes", panelId: "detail", context: { noteId: "n1" } },
    ]);
    // A row that already knows where it goes costs no second round trip.
    expect(invoked).toHaveLength(before);
  });

  it("asks the provider again for a row that carries no navigate target", async () => {
    respond = async (action) =>
      action === "search.titles"
        ? { results: [{ id: "n2", title: "Resolve me" }] }
        : { results: [] };

    render(<Harness query="q" />);
    await settle();
    invoked.length = 0;

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Resolve me" }));
    });

    // `{query, resultId}` beside the surface context: this is how a provider
    // does its expensive work at open time instead of on every keystroke.
    expect(invoked).toHaveLength(1);
    expect(invoked[0]?.action).toBe("search.titles");
    expect(invoked[0]?.args).toEqual({
      context: { kind: "surface", surface: "app" },
      query: "q",
      resultId: "n2",
    });
  });
});
