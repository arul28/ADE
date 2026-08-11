/**
 * Crawler regression tests. `node --test registry/scripts/`
 *
 * Node's own test runner, no dependencies, for the same reason the crawler has
 * none: this directory is extracted into a public repository whose CI installs
 * nothing.
 *
 * The crawler runs on import and resolves its files from its own directory, so
 * each case builds a throwaway registry — scripts, schema, curated files — and
 * runs it there with `fetch` stubbed. What it asserts is the part that is a
 * security property rather than a formatting one: `official` comes from
 * `official.json` and from nowhere else, including from ids that resolve on
 * `Object.prototype`.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const HERE = import.meta.dirname;
const REGISTRY = path.join(HERE, "..");

const OFFICIAL_DIGEST = "a".repeat(64);

/** A repository the stubbed GitHub search will return. */
function repository(fullName, index) {
  return {
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    owner: { login: fullName.split("/")[0] },
    description: "repo blurb",
    stargazers_count: 10 - index,
    created_at: "2026-01-01T00:00:00.000Z",
    pushed_at: "2026-08-01T00:00:00.000Z",
  };
}

/**
 * Run the crawler in a scratch registry and return the index it wrote, or the
 * failure it refused with.
 */
function crawl({ manifests, official, featured = [], installs = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-registry-crawl-"));
  try {
    fs.cpSync(path.join(REGISTRY, "scripts"), path.join(dir, "scripts"), { recursive: true });
    fs.cpSync(path.join(REGISTRY, "schema"), path.join(dir, "schema"), { recursive: true });
    fs.writeFileSync(path.join(dir, "official.json"), JSON.stringify({ version: 1, plugins: official }));
    fs.writeFileSync(path.join(dir, "featured.json"), JSON.stringify({ version: 1, featured }));
    fs.writeFileSync(
      path.join(dir, "run.mjs"),
      `const manifests = ${JSON.stringify(manifests)};
const installs = ${JSON.stringify(installs)};
const repos = Object.keys(manifests).map((fullName, index) => (${repository.toString()})(fullName, index));
globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.includes("/search/repositories")) return new Response(JSON.stringify({ items: repos }));
  if (target.includes("/plugins/installs")) return new Response(JSON.stringify({ counts: installs }));
  const match = /\\/repos\\/(.+?)\\/contents\\/(.+)$/.exec(target);
  if (match) {
    if (match[2] === "README.md") return new Response("readme body");
    const manifest = manifests[match[1]];
    return manifest ? new Response(JSON.stringify(manifest)) : new Response("no", { status: 404 });
  }
  return new Response("no", { status: 404 });
};
await import("./scripts/crawl.mjs");
`,
    );
    let failure = null;
    try {
      execFileSync(process.execPath, ["run.mjs"], { cwd: dir, stdio: "pipe", encoding: "utf8" });
    } catch (error) {
      failure = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    const indexPath = path.join(dir, "index.json");
    const index = fs.existsSync(indexPath)
      ? JSON.parse(fs.readFileSync(indexPath, "utf8"))
      : null;
    return { index, failure };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const GRAPH = {
  name: "graph",
  version: "1.4.0",
  displayName: "Graph",
  description: "Lane graph.",
  icon: "graph",
  accent: "#7C6FF0",
  entry: "index.js",
  surfaces: [{ kind: "tab", id: "graph", title: "Graph", panelId: "main" }],
  sockets: [{ socket: "row-menu-item", surface: "lanes", id: "reveal", actionId: "reveal" }],
};

test("stamps official from the curated file and nowhere else", () => {
  const { index } = crawl({
    manifests: {
      "ade-plugins/graph": GRAPH,
      // Claims the badge in its own manifest, which anyone can write.
      "someone/timer": { name: "timer", version: "0.2.0", displayName: "Timer", description: "d", official: true },
    },
    official: { graph: { repo: "https://github.com/ade-plugins/graph", checksums: { "1.4.0": OFFICIAL_DIGEST } } },
    featured: ["graph"],
    installs: [{ pluginId: "graph", installs: 42 }],
  });
  const byId = Object.fromEntries((index?.entries ?? []).map((entry) => [entry.pluginId, entry]));
  assert.equal(byId.graph.official, true);
  assert.equal(byId.graph.featured, true);
  assert.equal(byId.graph.installs, 42);
  assert.deepEqual(byId.graph.checksums, { "1.4.0": OFFICIAL_DIGEST });
  assert.equal(byId.timer.official, false);
});

test("an id that resolves on Object.prototype cannot forge the Official badge", () => {
  // "constructor" is a valid plugin id, and `curated.official.plugins[id]` on a
  // plain object resolved it to Object's own constructor — truthy, so the entry
  // was published `official: true` with no checksums, which installs as
  // "vouched for by ADE, verified against nothing".
  const { index } = crawl({
    manifests: {
      "attacker/proto": {
        name: "constructor",
        version: "1.0.0",
        displayName: "Totally Official",
        description: "d",
      },
    },
    official: { graph: { repo: "https://github.com/ade-plugins/graph", checksums: {} } },
  });
  const entry = (index?.entries ?? []).find((row) => row.pluginId === "constructor");
  assert.ok(entry, "the entry is still listed, as a community plugin");
  assert.equal(entry.official, false);
  assert.equal(entry.checksums, undefined);
});

test("refuses a repository claiming an id bound to another repository", () => {
  const { index } = crawl({
    manifests: {
      "ade-plugins/graph": GRAPH,
      "impostor/graph": { name: "graph", version: "9.9.9", displayName: "Graph (fake)", description: "d" },
    },
    official: { graph: { repo: "https://github.com/ade-plugins/graph", checksums: {} } },
  });
  const claimed = (index?.entries ?? []).filter((entry) => entry.pluginId === "graph");
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].repo, "https://github.com/ade-plugins/graph");
});

test("publishes facts, not the install modal's copy", () => {
  const { index } = crawl({
    manifests: { "ade-plugins/graph": GRAPH },
    official: {},
  });
  const entry = index.entries[0];
  // "Adds:" lines are product copy the app derives from these facts. A crawler
  // that wrote them owned a second copy of the wording, and the two diverged.
  assert.equal(entry.adds, undefined);
  assert.deepEqual(entry.surfaces, ["lanes"]);
  assert.deepEqual(entry.sockets, ["row-menu-item"]);
  // Never measured is absent, not zero: a zero renders as a measurement.
  assert.equal(entry.installs, undefined);
});

test("refuses to publish a document that does not match the schema", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-registry-schema-"));
  try {
    fs.cpSync(path.join(REGISTRY, "scripts"), path.join(dir, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(dir, "schema"));
    // A schema the assembled index cannot satisfy stands in for a contract the
    // crawler drifted away from; either way the run must fail rather than
    // publish something every install would silently drop entries from.
    const schema = JSON.parse(fs.readFileSync(path.join(REGISTRY, "schema", "index.schema.json"), "utf8"));
    schema.properties.entries.maxItems = 0;
    fs.writeFileSync(path.join(dir, "schema", "index.schema.json"), JSON.stringify(schema));
    fs.writeFileSync(path.join(dir, "official.json"), JSON.stringify({ version: 1, plugins: {} }));
    fs.writeFileSync(path.join(dir, "featured.json"), JSON.stringify({ version: 1, featured: [] }));
    fs.writeFileSync(
      path.join(dir, "run.mjs"),
      `globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.includes("/search/repositories")) {
    return new Response(JSON.stringify({ items: [${JSON.stringify(repository("ade-plugins/graph", 0))}] }));
  }
  if (target.includes("/plugins/installs")) return new Response(JSON.stringify({ counts: [] }));
  if (target.includes("plugin.json")) return new Response(${JSON.stringify(JSON.stringify(GRAPH))});
  return new Response("no", { status: 404 });
};
await import("./scripts/crawl.mjs");
`,
    );
    let failed = false;
    let output = "";
    try {
      execFileSync(process.execPath, ["run.mjs"], { cwd: dir, stdio: "pipe", encoding: "utf8" });
    } catch (error) {
      failed = true;
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    assert.ok(failed, "the run fails");
    assert.match(output, /does not match schema/);
    assert.equal(fs.existsSync(path.join(dir, "index.json")), false, "and writes nothing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
