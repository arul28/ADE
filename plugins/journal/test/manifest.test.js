"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin.json"), "utf8"));
// Required at module scope, exactly as the child bootstrap does it: a missing
// export or a syntax error fails here rather than at install time.
const entry = require(path.join(ROOT, manifest.entry));

const actions = new Set(Object.keys(entry.actions));

/* ── The cross-file agreements the manifest parser cannot check ─────────── */

test("every socket names an action or a panel this plugin actually has", () => {
  const panels = new Set(manifest.panels.map((panel) => panel.id));
  for (const socket of manifest.sockets) {
    if (socket.actionId) {
      assert.ok(actions.has(socket.actionId), `socket ${socket.id} names missing action ${socket.actionId}`);
    }
    if (socket.panelId) {
      assert.ok(panels.has(socket.panelId), `socket ${socket.id} names missing panel ${socket.panelId}`);
    }
    for (const item of socket.menu ?? []) {
      assert.ok(actions.has(item.actionId), `menu item ${item.label} names missing action ${item.actionId}`);
    }
  }
});

test("every surface names a panel, which is what three of four clients render", () => {
  const panels = new Set(manifest.panels.map((panel) => panel.id));
  for (const surface of manifest.surfaces) {
    assert.ok(surface.panelId, `surface ${surface.id} declares no panelId`);
    assert.ok(panels.has(surface.panelId), `surface ${surface.id} names missing panel ${surface.panelId}`);
  }
});

test("every refreshAction is a real action, or the gesture is silently lost", () => {
  for (const panel of manifest.panels) {
    if (!panel.refreshAction) continue;
    assert.ok(actions.has(panel.refreshAction), `panel ${panel.id} names missing action ${panel.refreshAction}`);
  }
});

test("every engine registration names a real action", () => {
  for (const tool of manifest.tools) {
    assert.ok(actions.has(tool.action ?? tool.name), `tool ${tool.name} names missing action`);
  }
  for (const provider of manifest.searchProviders) {
    assert.ok(actions.has(provider.action ?? provider.id), `search provider ${provider.id} names missing action`);
  }
  for (const binding of manifest.keybindings) {
    assert.ok(actions.has(binding.action), `keybinding ${binding.binding} names missing action`);
  }
});

test("every CLI word is an action, or `ade journal <word>` reads as a typo", () => {
  for (const word of manifest.cli) {
    assert.ok(actions.has(word), `cli word ${word} has no handler`);
  }
});

test("the plugin id is the CLI word the user asked for", () => {
  // `ade journal today` is `ade <pluginId> <word>`, so the id is not cosmetic.
  assert.equal(manifest.name, "journal");
  assert.ok(manifest.cli.includes("today"));
});

test("no action claims the reserved ade: prefix", () => {
  for (const name of actions) assert.ok(!name.startsWith("ade:"), `${name} claims ADE's own prefix`);
});

/* ── Declared capability matches what the code reaches for ──────────────── */

test("every collection the code touches is declared", () => {
  const source = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const declared = new Set(Object.keys(manifest.collections));
  for (const match of source.matchAll(/collections\.(?:get|put|delete|list)\(\s*"([^"]+)"/g)) {
    assert.ok(declared.has(match[1]), `index.js touches undeclared collection ${match[1]}`);
  }
  assert.ok(declared.has("notes") && declared.has("state"));
});

test("the host the code posts to is the host the manifest declares", () => {
  const source = fs.readFileSync(path.join(ROOT, "journal.js"), "utf8");
  assert.ok(source.includes("hooks.slack.com"));
  assert.deepEqual(manifest.network.hosts, ["hooks.slack.com"]);
});

test("the standup keybinding carries a modifier and is not one ADE or the OS answers first", () => {
  const reserved = new Set(["mod+n", "mod+w", "mod+q", "mod+m", "mod+s", "mod+p", "mod+shift+f", "mod+0", "mod+comma", "mod+minus", "mod+equal", "mod+plus"]);
  for (const binding of manifest.keybindings) {
    const chord = binding.binding.toLowerCase();
    assert.match(chord, /^(mod|ctrl|alt|shift)\+/, "a bare-key binding is refused outright");
    assert.ok(!reserved.has(chord), `${chord} double-fires with the window or OS`);
    assert.ok(!/\+(c|d|m)$/.test(chord), "ctrl+c/d/m end a process");
  }
});

test("the button colour clears 3:1 against BOTH ADE backdrops, or it is dropped without a word", () => {
  // Mirrors `sanitizePluginActionColor`. Nothing logs a refusal and doctor does
  // not report it: the button simply is not the colour we chose. So pin it.
  const linear = (value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex) => {
    const digits = hex.slice(1);
    return 0.2126 * linear(parseInt(digits.slice(0, 2), 16))
      + 0.7152 * linear(parseInt(digits.slice(2, 4), 16))
      + 0.0722 * linear(parseInt(digits.slice(4, 6), 16));
  };
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const colours = manifest.sockets.map((socket) => socket.color).filter(Boolean);
  assert.ok(colours.length, "the chat-header button declares a colour");
  for (const colour of colours) {
    assert.match(colour, /^#[0-9a-fA-F]{6}$/);
    const value = luminance(colour);
    for (const backdrop of [0.0035, 0.898]) {
      assert.ok(ratio(value, backdrop) >= 3, `${colour} fails 3:1 against ${backdrop}`);
    }
  }
});

test("every icon is a token from the shared list, or it draws a puzzle piece on every client", () => {
  const tokens = new Set([
    "beer", "bell", "bookmark", "brain", "bug", "calendar", "chart", "chart-bar", "chat", "clock",
    "clock-counter-clockwise", "cloud", "code", "compass", "cube", "currency", "database", "desktop",
    "device-mobile", "envelope", "eye", "file", "flag", "folder", "gear", "git-branch", "git-commit",
    "git-pull-request", "globe", "graph", "heart", "image", "kanban", "key", "lightning", "link", "list",
    "list-checks", "lock", "magic", "microphone", "music", "note", "package", "palette", "play", "plug",
    "puzzle", "robot", "rocket", "rows", "shield", "sparkle", "star", "storefront", "table", "tag",
    "terminal", "timer", "toolbox", "trend", "users", "video", "wrench",
  ]);
  const named = [
    manifest.icon,
    ...manifest.surfaces.map((surface) => surface.icon),
    ...manifest.panels.map((panel) => panel.icon),
    ...manifest.sockets.flatMap((socket) => [socket.icon, ...(socket.menu ?? []).map((item) => item.icon)]),
  ].filter(Boolean);
  for (const icon of named) assert.ok(tokens.has(icon), `${icon} is not an icon token`);
});

/* ── Panels ─────────────────────────────────────────────────────────────── */

function countNodes(node) {
  if (Array.isArray(node)) return node.reduce((total, child) => total + countNodes(child), 0);
  if (!node || typeof node !== "object" || !node.component) return 0;
  return 1 + countNodes(node.children ?? []);
}

function depthOf(node, depth = 1) {
  if (!node?.children?.length) return depth;
  return Math.max(...node.children.map((child) => depthOf(child, depth + 1)));
}

test("every declared panel schema exists, is valid JSON, and declares a fallback", () => {
  for (const panel of manifest.panels) {
    const file = path.join(ROOT, panel.schemaFile);
    const schema = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(schema.v, 1, `${panel.id} declares the wrong vocabulary version`);
    assert.ok(schema.fallback?.title, `${panel.id} has no fallback title — fatal on every client`);
    assert.ok(schema.fallback?.text, `${panel.id} has no fallback text`);
    assert.ok(schema.fallback?.deeplink?.startsWith("ade://plugin/journal/"), `${panel.id}'s fallback strands the reader`);
    assert.ok(countNodes(schema.body) <= 200, `${panel.id} is over maxNodes`);
    assert.ok(Math.max(...schema.body.map((node) => depthOf(node))) <= 8, `${panel.id} is over maxDepth`);
    assert.ok(Buffer.byteLength(JSON.stringify(schema)) <= 65_536, `${panel.id} is over maxSchemaBytes`);
  }
});

test("every onPress in a panel names an action this plugin exports", () => {
  const walk = (node, seen) => {
    if (Array.isArray(node)) return node.forEach((child) => walk(child, seen));
    if (!node || typeof node !== "object") return;
    for (const action of [node.onPress, node.onChange, node.submit?.onPress, node.action?.onPress]) {
      if (action?.action) seen.add(action.action);
    }
    for (const row of node.actions ?? []) if (row.action) seen.add(row.action);
    for (const row of node.overflow ?? []) if (row.action) seen.add(row.action);
    walk(node.children ?? [], seen);
  };
  for (const panel of manifest.panels) {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, panel.schemaFile), "utf8"));
    const seen = new Set();
    walk(schema.body, seen);
    for (const action of seen) {
      assert.ok(actions.has(action), `panel ${panel.id} presses missing action ${action}`);
    }
  }
});

test("the journal's filters stay inside the state ceilings, and every where clause names a declared key", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "panels/journal.json"), "utf8"));
  const keys = new Set();
  const clauses = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    if (node.component === "segmented") {
      keys.add(node.stateKey);
      assert.ok(node.options.length >= 2 && node.options.length <= 8, `${node.stateKey} is outside 2–8 options`);
    }
    if (node.bind?.where) clauses.push(...node.bind.where);
    walk(node.children ?? []);
  };
  walk(schema.body);
  assert.ok(keys.size <= 4, "maxStateKeys is 4");
  assert.ok(clauses.length <= 4, "maxWhereClauses is 4");
  const named = new Set();
  const readState = (clause) => {
    if (!clause || typeof clause !== "object") return;
    // Five operators name a state key, not one. `since` and `before` read their
    // operand as a TIME, and a reader that only knew `equals` would have called
    // the range filter unwired and passed while it was.
    for (const operator of ["equals", "notEquals", "in", "notIn", "since", "before"]) {
      const operand = clause[operator];
      if (operand && typeof operand === "object" && operand.$state) named.add(operand.$state);
    }
    for (const child of clause.or ?? clause.and ?? []) readState(child);
    if (clause.not) readState(clause.not);
  };
  clauses.forEach(readState);
  for (const key of named) {
    // A comparison naming a key no control declares is INACTIVE, not false — so
    // it would silently show everything rather than fail. Nothing catches this
    // at runtime, which is why it is caught here.
    assert.ok(keys.has(key), `where clause reads $state "${key}", which no control declares`);
  }
  assert.deepEqual([...named].sort(), [...keys].sort(), "every filter is wired to a clause and back");
  // The lane filter is minted at runtime from the lanes that have notes, and a
  // `segmented` holding one option is malformed — so the static schema ships
  // without it rather than with a lone "All lanes" that would draw an error
  // marker on first render.
  assert.ok(!keys.has("lane"), "the static schema must not ship a one-option lane filter");
});

test("C4: every note binding filters on time, and no panel reads a stored day flag", () => {
  // The flags this replaced were a function of NOW written onto a row, so they
  // were wrong from the next midnight until something rewrote them. A `since`
  // clause is resolved on the reader's clock at every re-render instead.
  const clauses = [];
  for (const panel of manifest.panels) {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, panel.schemaFile), "utf8"));
    const raw = JSON.stringify(schema);
    assert.ok(!raw.includes('"field":"today"'), `${panel.id} still filters on a stored day flag`);
    assert.ok(!raw.includes('"field":"week"'), `${panel.id} still filters on a stored week flag`);
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      if (node.bind?.collection === "notes") clauses.push(...(node.bind.where ?? []));
      walk(node.children ?? []);
    };
    walk(schema.body);
  }
  const times = clauses.filter((clause) => clause.since || clause.before);
  assert.ok(times.length >= 2, "both note panels answer a time question");
  for (const clause of times) {
    assert.equal(clause.field, "at", "the row's own timestamp is the only time field it stores");
    const operand = clause.since ?? clause.before;
    // `$rel` needs a sign and a lower-case unit; anything else drops with a
    // warning and the binding then shows EVERY row.
    if (operand.$rel !== undefined) assert.match(operand.$rel, /^[+-]\d{1,6}[mhd]$/);
    else assert.ok(operand.$state, "a time operand is a $rel offset or a $state selection");
  }
});

test("C2: a first press is not a guess — the button names its verb and the panels explain themselves", () => {
  const header = manifest.sockets.find((socket) => socket.socket === "chat-header-action");
  // The user's words were "i have no clue what it does it has four options and
  // im not sure what clicking them even does".
  assert.match(header.label, /note/i, "the button says what pressing it writes");
  assert.ok(header.label.length <= 40, "a header label over 40 chars is truncated");
  for (const item of header.menu) {
    assert.ok(item.label.length <= 40, `${item.label} is over the menu's ceiling`);
    assert.ok(item.label.split(" ").length > 1, `"${item.label}" is a bare verb with no object`);
  }
  // The two that WRITE come before the two that NAVIGATE, so the group reads as
  // one thing rather than five unrelated verbs.
  const writes = header.menu.map((item) => item.actionId.startsWith("log"));
  assert.deepEqual(writes, [true, true, false, false]);
  // A `chat-header-action` payload carries no tooltip or description field — so
  // the explanation lives where a payload can actually hold it.
  assert.equal(header.tooltip, undefined, "no client renders one; promising it would be a lie");
  for (const panelId of ["journal", "today"]) {
    const panel = manifest.panels.find((entry) => entry.id === panelId);
    const raw = JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, panel.schemaFile), "utf8")));
    assert.ok(raw.includes(header.label), `${panelId} never names the button the reader has to press`);
    assert.ok(raw.includes("/note"), `${panelId} never mentions the command`);
  }
});

test("B4: the declared badge's label describes the slot, not an empty state", () => {
  const badge = manifest.sockets.find((socket) => socket.socket === "row-badge");
  // A declared badge draws NOTHING now — it reserves the slot — but the label
  // still describes it in the install disclosure. The old label was "0", chosen
  // to read acceptably as the chip it used to paint on every lane row.
  assert.notEqual(badge.label, "0");
  assert.ok(/[A-Za-z]/.test(badge.label), "a label with no words explains nothing at install time");
  assert.ok(badge.label.length <= 32, "a badge's text is bounded at 32");
});

test("every binding that carries a row action allows it, or the row is not pressable", () => {
  for (const panel of manifest.panels) {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, panel.schemaFile), "utf8"));
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      if (node.bind?.collection === "notes") {
        assert.ok(node.bind.allowActions?.includes("deleteNote"), `${panel.id} binds notes without allowing its delete`);
        assert.ok(node.bind.allowActions.length <= 16, "maxBindingAllowActions");
      }
      walk(node.children ?? []);
    };
    walk(schema.body);
  }
});
