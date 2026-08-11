import { describe, expect, it } from "vitest";
import {
  buildPluginBaseline,
  buildPluginPanelView,
  collectionsReferencedBy,
  PLUGIN_PANEL_MAX_COLLECTIONS,
  PLUGIN_PANEL_SNAPSHOT_MAX_ROWS,
  pluginRowKey,
  serializePluginRow,
} from "./pluginPanelBuilder";

type PanelRow = { collection: string; key: string; value_json: string; updated_at: string };

function createDb(options: {
  panel?: Record<string, unknown> | null;
  rows?: PanelRow[];
  onCollections?: (collections: string[]) => void;
}) {
  return {
    get: () => (options.panel === undefined ? { schema_json: "{}", vocab_version: 1 } : options.panel),
    all: (_sql: string, params?: unknown[]) => {
      options.onCollections?.((params ?? []).slice(1) as string[]);
      return (options.rows ?? []) as unknown as Array<Record<string, unknown>>;
    },
  };
}

describe("collectionsReferencedBy", () => {
  it("finds every data binding regardless of where it sits in the schema", () => {
    const schema = JSON.stringify({
      kind: "stack",
      children: [
        { kind: "list", data: { collection: "issues" } },
        { kind: "table", rows: [{ data: { collection: "runs" } }] },
        { kind: "text", value: "no binding here" },
      ],
    });
    expect(collectionsReferencedBy(schema)).toEqual(["issues", "runs"]);
  });

  it("returns nothing for a static panel or unparseable schema", () => {
    expect(collectionsReferencedBy(JSON.stringify({ kind: "text", value: "hi" }))).toEqual([]);
    // Plugin-authored input: malformed JSON is a rendering problem for the
    // client, never a throw on the sync event loop.
    expect(collectionsReferencedBy("{not json")).toEqual([]);
  });

  it("ignores a non-string collection and caps how many one panel may bind", () => {
    expect(collectionsReferencedBy(JSON.stringify({ data: { collection: 42 } }))).toEqual([]);
    const greedy = JSON.stringify({
      children: Array.from({ length: 40 }, (_, index) => ({ data: { collection: `c${index}` } })),
    });
    expect(collectionsReferencedBy(greedy)).toHaveLength(PLUGIN_PANEL_MAX_COLLECTIONS);
  });

  it("survives a deeply nested schema without recursing without bound", () => {
    // Hostile input: 5,000 levels of nesting must terminate at the depth guard.
    let nested: Record<string, unknown> = { data: { collection: "buried" } };
    for (let index = 0; index < 5_000; index += 1) nested = { child: nested };
    expect(() => collectionsReferencedBy(JSON.stringify(nested))).not.toThrow();
    expect(collectionsReferencedBy(JSON.stringify(nested))).toEqual([]);
  });
});

describe("buildPluginPanelView", () => {
  it("reports a missing panel as an empty view rather than an error", () => {
    // A plugin the user has not installed on this machine is supposed to
    // disappear silently, not to fail the subscription.
    const view = buildPluginPanelView(createDb({ panel: null }) as never, "graph", "main");
    expect(view).toEqual({ panel: null, rows: [], truncated: false });
  });

  it("queries only the collections the panel binds", () => {
    let asked: string[] = [];
    const db = createDb({
      panel: {
        title: "Issues",
        icon: "graph",
        surface: "work",
        schema_json: JSON.stringify({ data: { collection: "issues" } }),
        vocab_version: 1,
        updated_at: "t",
      },
      rows: [{ collection: "issues", key: "a", value_json: '{"n":1}', updated_at: "t" }],
      onCollections: (collections) => { asked = collections; },
    });
    const view = buildPluginPanelView(db as never, "graph", "main");
    expect(asked).toEqual(["issues"]);
    expect(view.panel?.title).toBe("Issues");
    expect(view.rows).toHaveLength(1);
    expect(view.truncated).toBe(false);
  });

  it("skips the row query entirely for a panel that binds nothing", () => {
    let queried = false;
    const db = {
      get: () => ({ schema_json: JSON.stringify({ kind: "text" }), vocab_version: 1 }),
      all: () => { queried = true; return []; },
    };
    expect(buildPluginPanelView(db as never, "graph", "main").rows).toEqual([]);
    expect(queried).toBe(false);
  });

  it("truncates at the snapshot ceiling and says so", () => {
    const rows: PanelRow[] = Array.from({ length: PLUGIN_PANEL_SNAPSHOT_MAX_ROWS + 1 }, (_, index) => ({
      collection: "issues",
      key: `k${index}`,
      value_json: "1",
      updated_at: "t",
    }));
    const view = buildPluginPanelView(
      createDb({
        panel: { schema_json: JSON.stringify({ data: { collection: "issues" } }), vocab_version: 1 },
        rows,
      }) as never,
      "graph",
      "main",
    );
    expect(view.rows).toHaveLength(PLUGIN_PANEL_SNAPSHOT_MAX_ROWS);
    expect(view.truncated).toBe(true);
  });
});

describe("pluginRowKey", () => {
  it("keeps rows distinct when a collection or key contains the delimiter", () => {
    expect(pluginRowKey({ collection: "a/b", key: "c" }))
      .not.toBe(pluginRowKey({ collection: "a", key: "b/c" }));
  });
});

describe("buildPluginBaseline (DROPPED-2)", () => {
  it("maps each row's identity to its serialized content", () => {
    const view = {
      rows: [
        { collection: "issues", key: "a", valueJson: '{"n":1}', updatedAt: "t1" },
        { collection: "issues", key: "b", valueJson: '{"n":2}', updatedAt: "t2" },
      ],
    };

    const baseline = buildPluginBaseline(view);

    expect(baseline.size).toBe(2);
    expect(baseline.get(pluginRowKey(view.rows[0]))).toBe(serializePluginRow(view.rows[0]));
    expect(baseline.get(pluginRowKey(view.rows[1]))).toBe(serializePluginRow(view.rows[1]));
  });

  it("changes when either the value or the updatedAt changes, and not otherwise", () => {
    const row = { collection: "issues", key: "a", valueJson: '{"n":1}', updatedAt: "t1" };
    const original = serializePluginRow(row);

    expect(serializePluginRow({ ...row, valueJson: '{"n":2}' })).not.toBe(original);
    expect(serializePluginRow({ ...row, updatedAt: "t2" })).not.toBe(original);
    expect(serializePluginRow({ ...row })).toBe(original);
  });
});
