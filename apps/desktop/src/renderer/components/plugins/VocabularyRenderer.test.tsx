/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { PluginPanelView, VocabularyBoundary } from "./VocabularyRenderer";
import type { VocabRenderContext } from "./vocabularyComponents";
import { PLUGIN_FIXTURES, pluginFixtureRows } from "./pluginFixtures";
import type { PluginCollectionRow } from "../../lib/pluginRuntimeBridge";
import { VOCAB_LIMITS, bindingKey, type VocabAction } from "../../../shared/plugins/vocabulary";
import * as openExternalModule from "../../lib/openExternal";

/**
 * These cover the one promise the renderer makes that a type system cannot:
 * a panel is never blank and never takes the tab down with it. Everything else
 * about how a panel looks is the fixture page's job, not a test's — there are
 * no snapshot assertions here on purpose.
 */

function makeContext(overrides: Partial<VocabRenderContext> = {}): VocabRenderContext {
  return {
    pluginId: "test-plugin",
    rowsByBinding: new Map<string, PluginCollectionRow[]>(),
    dispatch: vi.fn(async () => {}),
    active: true,
    state: {},
    setStateValue: vi.fn(),
    declarations: [],
    selection: {},
    selectionDeclarations: [],
    toggleRow: vi.fn(),
    clearSelection: vi.fn(),
    // A group with no host opinion follows the schema's own `defaultOpen`, which
    // is what an untouched section does in the real host too.
    groupOpen: (node) => node.defaultOpen ?? true,
    toggleGroup: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PluginPanelView", () => {
  it("renders every fixture without throwing and never leaves the panel empty", () => {
    for (const fixture of PLUGIN_FIXTURES) {
      const { container, unmount } = render(
        <PluginPanelView
          schema={fixture.schema}
          context={makeContext({ rowsByBinding: pluginFixtureRows(fixture) })}
        />,
      );
      expect(container.textContent?.trim(), `fixture ${fixture.id} rendered blank`).toBeTruthy();
      unmount();
    }
  });

  it("falls back to the plugin's own words when the schema is unrenderable", () => {
    render(
      <PluginPanelView
        schema={{
          v: 99,
          fallback: { title: "Graph", text: "3 lanes, 1 conflict." },
          body: [],
        }}
        context={makeContext()}
      />,
    );

    expect(screen.getByText("Graph")).toBeTruthy();
    expect(screen.getByText("3 lanes, 1 conflict.")).toBeTruthy();
    // The diagnosis is available, but it is not what leads.
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText(/vocabulary v1/)).toBeTruthy();
  });

  it("still says something when the schema declares no fallback at all", () => {
    const { container } = render(
      <PluginPanelView schema={{ v: 1, body: [] }} context={makeContext()} />,
    );
    expect(container.textContent).toContain("This panel can’t be shown");
  });

  it("degrades an unknown component in place without dropping its siblings", () => {
    render(
      <PluginPanelView
        schema={{
          v: 1,
          fallback: { title: "T", text: "B" },
          body: [
            { component: "text", text: "before" },
            { component: "hologram" },
            { component: "text", text: "after" },
          ],
        }}
        context={makeContext()}
      />,
    );

    expect(screen.getByText("before")).toBeTruthy();
    expect(screen.getByText("after")).toBeTruthy();
    expect(screen.getByText("Not supported here")).toBeTruthy();
  });

  it("surfaces a failed action inline instead of leaving the button silent", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("The plugin refused that action.");
    });
    render(
      <PluginPanelView
        schema={{
          v: 1,
          fallback: { title: "T", text: "B" },
          body: [{ component: "button", label: "Run", onPress: { action: "run" } }],
        }}
        context={makeContext({ dispatch })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => {
      expect(screen.getByText("The plugin refused that action.")).toBeTruthy();
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("asks before running a list row's action, the way a button already does", async () => {
    // A row used to dispatch straight through, so the same destructive action
    // prompted behind a button and ran silently behind a row.
    const dispatch = vi.fn(async (_action: VocabAction, _args?: Record<string, unknown>) => {});
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const row = {
      title: "bc-1",
      onPress: { action: "delete-agent", confirm: "Delete this agent?" },
    };
    render(
      <PluginPanelView
        schema={{
          v: 1,
          fallback: { title: "T", text: "B" },
          body: [{ component: "list", items: [row] }],
        }}
        context={makeContext({ dispatch })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /bc-1/ }));
    expect(confirm).toHaveBeenCalledWith("Delete this agent?");
    expect(dispatch).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: /bc-1/ }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
  });

  it("makes a collection-driven row pressable only for an action its binding allowed", async () => {
    const dispatch = vi.fn(async (_action: VocabAction, _args?: Record<string, unknown>) => {});
    const rowsByBinding = new Map<string, PluginCollectionRow[]>([
      [bindingKey({ collection: "fleet" }), [
        { key: "1", value: { title: "allowed row", onPress: { action: "open-agent" } } } as PluginCollectionRow,
        { key: "2", value: { title: "refused row", onPress: { action: "delete-everything" } } } as PluginCollectionRow,
      ]],
    ]);
    render(
      <PluginPanelView
        schema={{
          v: 1,
          fallback: { title: "T", text: "B" },
          body: [{ component: "list", bind: { collection: "fleet", allowActions: ["open-agent"] } }],
        }}
        context={makeContext({ dispatch, rowsByBinding })}
      />,
    );

    // Both rows render; only the allowed one is a control.
    expect(screen.getByText("refused row")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /refused row/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /allowed row/ }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "open-agent" }));
  });

  it("draws a rich row and keeps its trailing buttons out of the row's own press", async () => {
    const dispatch = vi.fn(async (_action: VocabAction, _args?: Record<string, unknown>) => {});
    render(
      <PluginPanelView
        schema={{
          v: 1,
          fallback: { title: "T", text: "B" },
          body: [{
            component: "list",
            items: [{
              title: "bc-1",
              subtitle: "Fix the login redirect",
              mono: "origin/fix-login-redirect",
              badge: { text: "Running", tone: "accent" },
              onPress: { action: "open-agent" },
              actions: [{ action: "stop", label: "Stop" }],
            }],
          }],
        }}
        context={makeContext({ dispatch })}
      />,
    );

    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("origin/fix-login-redirect")).toBeTruthy();
    // The row's press and its trailing button are two separate controls. A
    // button nested inside the row button would not render at all.
    const rowPress = () => screen.getByRole("button", { name: /bc-1/ }) as HTMLButtonElement;
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "stop" }));
    // One runner for the whole row: while an action is in flight the rest of
    // the row is held, so a reader cannot start a second action against data
    // the first one is already changing.
    expect(rowPress().disabled).toBe(true);

    await waitFor(() => expect(rowPress().disabled).toBe(false));
    fireEvent.click(rowPress());
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "open-agent" }));
  });

  it("asks before running a row's trailing action, the way the row's own press does", async () => {
    const dispatch = vi.fn(async (_action: VocabAction, _args?: Record<string, unknown>) => {});
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <PluginPanelView
        schema={{
          v: 1,
          fallback: { title: "T", text: "B" },
          body: [{
            component: "list",
            items: [{
              title: "bc-1",
              actions: [{ action: "delete-agent", label: "Delete", confirm: "Delete this agent?" }],
            }],
          }],
        }}
        context={makeContext({ dispatch })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect(confirm).toHaveBeenCalledWith("Delete this agent?");
    expect(dispatch).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
  });

  it("keeps a row's overflow actions behind a menu until it is opened", async () => {
    const dispatch = vi.fn(async (_action: VocabAction, _args?: Record<string, unknown>) => {});
    render(
      <PluginPanelView
        schema={{
          v: 1,
          fallback: { title: "T", text: "B" },
          body: [{
            component: "list",
            items: [{
              title: "bc-1",
              overflow: [{ action: "archive", label: "Archive" }],
            }],
          }],
        }}
        context={makeContext({ dispatch })}
      />,
    );

    expect(screen.queryByRole("menuitem", { name: /Archive/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Archive/ }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "archive" })));
    // Pressing an item closes the menu: one left open over the row below it
    // reads as belonging to the wrong row.
    expect(screen.queryByRole("menuitem", { name: /Archive/ })).toBeNull();
  });

  it("withholds a video source until the hosting surface is visible", () => {
    const schema = {
      v: 1,
      fallback: { title: "T", text: "B" },
      body: [{ component: "video", src: "https://cdn.example.com/clip.mp4" }],
    };

    const hidden = render(<PluginPanelView schema={schema} context={makeContext({ active: false })} />);
    expect(hidden.container.querySelector("video")?.getAttribute("src")).toBeNull();
    hidden.unmount();

    const visible = render(<PluginPanelView schema={schema} context={makeContext({ active: true })} />);
    expect(visible.container.querySelector("video")?.getAttribute("src"))
      .toBe("https://cdn.example.com/clip.mp4");
  });

  it("loads media only from schemes a panel is allowed to point at", () => {
    const image = (src: string) => ({
      v: 1,
      fallback: { title: "T", text: "B" },
      body: [{ component: "image", src, alt: "A screenshot" }],
    });

    for (const allowed of ["https://cdn.example.com/a.png", "data:image/png;base64,AAAA"]) {
      const view = render(<PluginPanelView schema={image(allowed)} context={makeContext()} />);
      expect(view.container.querySelector("img")?.getAttribute("src")).toBe(allowed);
      view.unmount();
    }

    for (const refused of ["file:///etc/passwd", "javascript:alert(1)", "/relative.png", "HTTP://x/a.png"]) {
      const view = render(<PluginPanelView schema={image(refused)} context={makeContext()} />);
      expect(view.container.querySelector("img"), `${refused} was loaded`).toBeNull();
      // Refusing the fetch must not blank the node: the alt text still says
      // what was meant to be there.
      expect(view.container.textContent).toContain("A screenshot");
      view.unmount();
    }
  });

  /**
   * `$context` as bindable rows. Each row is a key and a scalar, so this is the
   * case that broke when the shared reader dropped the row key: the node drew
   * its `emptyText` beside a context that was right there.
   */
  it("draws a keyValue bound to `$context` from the context's own keys", () => {
    const schema = {
      v: 1,
      fallback: { title: "Decision", text: "Open ADE." },
      body: [{ component: "keyValue", emptyText: "Nothing logged.", bind: { collection: "$context" } }],
    };
    const rowsByBinding = new Map<string, PluginCollectionRow[]>([
      [bindingKey({ collection: "$context" }), [
        { key: "Lane", value: "alpha-build" } as PluginCollectionRow,
        { key: "Logged", value: "Aug 30, 2026" } as PluginCollectionRow,
      ]],
    ]);

    const { container } = render(
      <PluginPanelView schema={schema} context={makeContext({ rowsByBinding })} />,
    );

    expect(container.textContent).toContain("Lane");
    expect(container.textContent).toContain("alpha-build");
    expect(container.textContent).not.toContain("Nothing logged.");
  });

  /**
   * A settings form: no Apply button, and every committed edit dispatches. A
   * toggle and a select commit on the change itself; a text field commits on
   * blur or Enter, never per keystroke.
   */
  describe("a form that applies on change", () => {
    const applySchema = {
      v: 1,
      fallback: { title: "Settings", text: "Open ADE." },
      body: [{
        component: "form",
        applyOnChange: { action: "applySettings" },
        fields: [
          { kind: "toggle", id: "digest", label: "Weekly digest" },
          { kind: "text", id: "note", label: "Note" },
        ],
      }],
    };

    it("draws no submit button, and dispatches the whole form on a toggle", async () => {
      const dispatch = vi.fn(async (_action: VocabAction, _args?: Record<string, unknown>) => {});
      render(<PluginPanelView schema={applySchema} context={makeContext({ dispatch })} />);

      expect(screen.queryByRole("button", { name: /save|apply/i })).toBeNull();

      fireEvent.click(screen.getByLabelText("Weekly digest"));

      await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ action: "applySettings" });
      // The WHOLE map, not just the field that moved — the same payload a submit
      // would have sent, so the plugin reads one shape either way.
      expect(dispatch.mock.calls[0]?.[1]).toEqual({ digest: true, note: "" });
    });

    it("does not dispatch a text field per keystroke, only when it commits", async () => {
      const dispatch = vi.fn(async (_action: VocabAction, _args?: Record<string, unknown>) => {});
      render(<PluginPanelView schema={applySchema} context={makeContext({ dispatch })} />);
      const note = screen.getByLabelText("Note");

      fireEvent.change(note, { target: { value: "ke" } });
      fireEvent.change(note, { target: { value: "kept" } });
      expect(dispatch).not.toHaveBeenCalled();

      fireEvent.blur(note);
      await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      expect(dispatch.mock.calls[0]?.[1]).toEqual({ digest: false, note: "kept" });
    });
  });

  it("keeps the submit button, and Enter's ordinary meaning, on a form without applyOnChange", async () => {
    const dispatch = vi.fn(async (_action: VocabAction, _args?: Record<string, unknown>) => {});
    const schema = {
      v: 1,
      fallback: { title: "Settings", text: "Open ADE." },
      body: [{
        component: "form",
        fields: [{ kind: "text", id: "note", label: "Note" }],
        submit: { label: "Save", onPress: { action: "save" } },
      }],
    };
    render(<PluginPanelView schema={schema} context={makeContext({ dispatch })} />);

    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "hi" } });
    fireEvent.blur(screen.getByLabelText("Note"));
    expect(dispatch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(dispatch.mock.calls[0]?.[1]).toEqual({ note: "hi" });
  });
});

describe("the markdown node", () => {
  /**
   * Asserted by CONTENT, never by snapshot. What matters about a rendered
   * document is which element carries which words and where a link goes — a
   * snapshot would pin the padding too, and would go red for every design pass
   * while staying green through a broken link.
   */
  function renderMarkdown(text: string, overrides: Partial<VocabRenderContext> = {}) {
    return render(
      <PluginPanelView
        schema={{
          v: 1,
          fallback: { title: "Issue", text: "Open ADE." },
          body: [{ component: "markdown", text }],
        }}
        context={makeContext(overrides)}
      />,
    );
  }

  it("draws a golden document: heading, emphasis, code, link, task list, quote, rule", () => {
    const { container } = renderMarkdown([
      "## Fix the login redirect",
      "",
      "The redirect drops `next` when the session is **stale**.",
      "See [ADE-122](https://linear.app/ade/issue/ADE-122).",
      "",
      "- [x] Reproduce on main",
      "- [ ] Add a regression test",
      "",
      "> Reviewer: ~~blocked~~ ready.",
      "",
      "```ts",
      "const next = 1;",
      "```",
      "",
      "---",
    ].join("\n"));

    expect(container.querySelector("h2")?.textContent).toBe("Fix the login redirect");
    expect(container.querySelector("strong")?.textContent).toBe("stale");
    expect(container.querySelector("s")?.textContent).toBe("blocked");
    // Inline code and the fenced block are different elements: one is a run
    // inside a sentence, the other is a block a reader can scan.
    expect(container.querySelector("p code")?.textContent).toBe("next");
    expect(container.querySelector("pre code")?.textContent).toBe("const next = 1;");
    expect(container.querySelector("pre code")?.getAttribute("data-language")).toBe("ts");
    expect(container.querySelector("blockquote")?.textContent).toContain("ready.");
    expect(container.querySelector("hr")).not.toBeNull();

    const link = container.querySelector("a");
    expect(link?.textContent).toBe("ADE-122");
    expect(link?.getAttribute("href")).toBe("https://linear.app/ade/issue/ADE-122");

    const items = container.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("Reproduce on main");
  });

  it("renders a task checkbox as inert decoration, not a control", () => {
    const { container } = renderMarkdown("- [x] done\n- [ ] not done");
    // No input, no button, nothing focusable: the plugin declared no action for
    // a checkbox, so a pressable one would change nothing and say nothing.
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("[aria-hidden]")).toHaveLength(2);
  });

  it("renders script and img payloads as text, with no element and no href", () => {
    const { container } = renderMarkdown('<script>alert(1)</script> and <img src=x onerror=y>');
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("refuses a javascript: link and keeps its words as plain text", () => {
    const { container } = renderMarkdown("[Click me](javascript:alert(1))");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("Click me");
  });

  it("opens an https link through the plugin's own external-open path", () => {
    const openExternal = vi.spyOn(openExternalModule, "openExternalUrl").mockImplementation(() => {});
    const { container } = renderMarkdown("[the issue](https://linear.app/ade/issue/ADE-1)");

    const link = container.querySelector("a");
    if (!link) throw new Error("expected a link");
    fireEvent.click(link);

    // The click never navigates the renderer; it hands the URL to the same
    // function the `{openUrl}` action verb uses.
    expect(openExternal).toHaveBeenCalledWith("https://linear.app/ade/issue/ADE-1");
  });

  it("shows an over-long document as its source, with a line saying why", () => {
    const { container } = renderMarkdown(`# Heading\n\n${"a".repeat(VOCAB_LIMITS.maxMarkdownChars)}`);
    // No formatting: a cut lands wherever it lands, and half-parsed prose says
    // less about what happened than the source plus one sentence.
    expect(container.querySelector("h1")).toBeNull();
    expect(container.textContent).toContain("# Heading");
    expect(container.textContent).toContain("shown as written");
  });

  it("says so when a document has more blocks than a panel draws", () => {
    const many = Array.from({ length: VOCAB_LIMITS.maxMarkdownBlocks + 5 }, (_u, i) => `p${i}`);
    const { container } = renderMarkdown(many.join("\n\n"));
    expect(container.textContent).toContain("The rest of this text is not shown.");
  });
});

describe("VocabularyBoundary", () => {
  it("contains a throwing leaf instead of letting it blank the tab", () => {
    // React logs the caught error; silence it so the suite output stays readable.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = (): React.ReactElement => {
      throw new Error("leaf exploded");
    };

    const { container } = render(
      <VocabularyBoundary fallback={{ title: "Graph", text: "3 lanes, 1 conflict." }}>
        <Boom />
      </VocabularyBoundary>,
    );

    expect(container.textContent).toContain("3 lanes, 1 conflict.");
  });

  it("gives the panel another go once the schema or the plugin changes", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = (): React.ReactElement => {
      throw new Error("leaf exploded");
    };

    const { container, rerender } = render(
      <VocabularyBoundary fallback={{ title: "Graph", text: "3 lanes, 1 conflict." }} resetKey="a">
        <Boom />
      </VocabularyBoundary>,
    );
    expect(container.textContent).toContain("3 lanes, 1 conflict.");

    // Same identity: still broken, and deliberately so — re-running the same
    // failing schema on every registry poll would just re-throw.
    rerender(
      <VocabularyBoundary fallback={{ title: "Graph", text: "3 lanes, 1 conflict." }} resetKey="a">
        <p>fixed</p>
      </VocabularyBoundary>,
    );
    expect(container.textContent).not.toContain("fixed");

    rerender(
      <VocabularyBoundary fallback={{ title: "Graph", text: "3 lanes, 1 conflict." }} resetKey="b">
        <p>fixed</p>
      </VocabularyBoundary>,
    );
    expect(container.textContent).toContain("fixed");
  });
});

/**
 * The three capabilities a panel gains at the pointer: a folded section, a
 * batch, and a control too long for a strip. The shared rules are covered in
 * `shared/plugins/vocabularyState.test.ts`; these cover what only a rendered
 * panel can answer.
 */
describe("groups, selection and the menu form", () => {
  it("folds a group's body away without dropping its siblings", () => {
    const schema = {
      v: 1,
      fallback: { title: "T", text: "B" },
      body: [
        {
          component: "group",
          title: "In Progress",
          badge: 2,
          children: [{ component: "text", text: "inside" }],
        },
        { component: "text", text: "after" },
      ],
    };

    const open = render(<PluginPanelView schema={schema} context={makeContext()} />);
    expect(screen.getByText("inside")).toBeTruthy();
    expect(screen.getByRole("button", { name: /In Progress/ }).getAttribute("aria-expanded"))
      .toBe("true");
    open.unmount();

    // A closed section is unmounted, not hidden: an image inside it must not
    // load and a hundred rows inside it must not lay out.
    render(
      <PluginPanelView schema={schema} context={makeContext({ groupOpen: () => false })} />,
    );
    expect(screen.queryByText("inside")).toBeNull();
    expect(screen.getByText("after")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("asks the host to fold, rather than remembering the fold itself", () => {
    const toggleGroup = vi.fn();
    render(
      <PluginPanelView
        schema={{
          v: 1,
          fallback: { title: "T", text: "B" },
          body: [{ component: "group", title: "Done", groupKey: "done", children: [] }],
        }}
        context={makeContext({ toggleGroup })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Done/ }));
    // Held by the host and keyed by the group's own key, so a republish that
    // inserts a section above it cannot re-open what the reader closed.
    expect(toggleGroup).toHaveBeenCalledWith(expect.objectContaining({ groupKey: "done" }));
  });

  it("ticks only the rows that have a key, and only for a list the host admitted", () => {
    const toggleRow = vi.fn();
    const body = [{
      component: "list",
      items: [{ title: "bc-1", key: "1" }, { title: "bc-2" }],
      selectable: { stateKey: "issues", actions: [{ action: "launch", label: "Create lanes" }] },
    }];
    const schema = { v: 1, fallback: { title: "T", text: "B" }, body };

    // No declaration: the panel declared more selectable lists than the ceiling
    // allows, so this one draws as the plain list it was before ticks existed.
    const plain = render(<PluginPanelView schema={schema} context={makeContext()} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    plain.unmount();

    render(
      <PluginPanelView
        schema={schema}
        context={makeContext({
          toggleRow,
          selectionDeclarations: [{ stateKey: "issues", max: 100, actionIds: ["launch"] }],
        })}
      />,
    );
    // The keyless row renders and is simply not selectable.
    expect(screen.getByText("bc-2")).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select bc-1" }));
    expect(toggleRow).toHaveBeenCalledWith("issues", "1", undefined);
  });

  it("extends from the anchor when the reader holds shift, and toggles when they do not", () => {
    const toggleRow = vi.fn();
    render(
      <PluginPanelView
        schema={{
          v: 1,
          fallback: { title: "T", text: "B" },
          body: [{
            component: "list",
            items: [{ title: "a", key: "1" }, { title: "b", key: "2" }],
            selectable: { stateKey: "issues", actions: [{ action: "launch", label: "Go" }] },
          }],
        }}
        context={makeContext({
          toggleRow,
          selectionDeclarations: [{ stateKey: "issues", max: 100, actionIds: ["launch"] }],
        })}
      />,
    );

    // The list passes the rows it drew, in draw order; the host holds the anchor.
    fireEvent.click(screen.getByRole("checkbox", { name: "Select b" }), { shiftKey: true });
    expect(toggleRow).toHaveBeenCalledWith("issues", "2", ["1", "2"]);
  });

  it("draws the bar only once something visible is ticked, and hands it those rows", async () => {
    const dispatch = vi.fn(async () => {});
    const declarations = [{ stateKey: "issues", max: 100, actionIds: ["launch"] }];
    const schema = {
      v: 1,
      fallback: { title: "T", text: "B" },
      body: [{
        component: "list",
        items: [{ title: "a", key: "1" }, { title: "b", key: "2" }],
        selectable: { stateKey: "issues", actions: [{ action: "launch", label: "Create lanes" }] },
      }],
    };

    const empty = render(
      <PluginPanelView
        schema={schema}
        context={makeContext({ selectionDeclarations: declarations })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Create lanes" })).toBeNull();
    empty.unmount();

    render(
      <PluginPanelView
        schema={schema}
        context={makeContext({
          dispatch,
          selectionDeclarations: declarations,
          // "3" is ticked and not on screen — a filter is hiding it. It keeps its
          // tick and stays out of the batch.
          selection: { issues: ["2", "3"] },
        })}
      />,
    );
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create lanes" }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: "launch" }),
      { selection: ["2"] },
    );
  });

  it("asks before running a bulk action, the way a row already does", async () => {
    const dispatch = vi.fn(async () => {});
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <PluginPanelView
        schema={{
          v: 1,
          fallback: { title: "T", text: "B" },
          body: [{
            component: "list",
            items: [{ title: "a", key: "1" }],
            selectable: {
              stateKey: "issues",
              actions: [{ action: "archive", label: "Archive", confirm: "Archive 1 issue?" }],
            },
          }],
        }}
        context={makeContext({
          dispatch,
          selection: { issues: ["1"] },
          selectionDeclarations: [{ stateKey: "issues", max: 100, actionIds: ["archive"] }],
        })}
      />,
    );

    // A mistake over a batch costs eleven rows, so the gate matters more here.
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(confirm).toHaveBeenCalledWith("Archive 1 issue?");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("draws a control past the strip ceiling as a menu over the host's resolved options", () => {
    const options = Array.from({ length: VOCAB_LIMITS.maxStateOptions + 2 }, (_, index) => ({
      value: `p${index}`,
      label: `Project ${index}`,
    }));
    const setStateValue = vi.fn();
    render(
      <PluginPanelView
        schema={{
          v: 1,
          fallback: { title: "T", text: "B" },
          body: [{
            component: "segmented",
            stateKey: "project",
            label: "Project",
            // The schema's own list is the "All" sentinel and nothing else. The
            // options are data, and the host is the only thing that has them.
            options: [{ value: "", label: "All projects" }],
            optionsFrom: { collection: "projects", valueField: "id", labelField: "name" },
          }],
        }}
        context={makeContext({
          setStateValue,
          declarations: [{
            stateKey: "project",
            label: "Project",
            initial: "",
            optionsFrom: { collection: "projects", valueField: "id" },
            options: [{ value: "", label: "All projects" }, ...options],
          }],
        })}
      />,
    );

    const menu = screen.getByRole("combobox", { name: "Project" });
    expect(menu).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(options.length + 1);

    fireEvent.change(menu, { target: { value: "p3" } });
    expect(setStateValue).toHaveBeenCalledWith("project", "p3");
  });
});
