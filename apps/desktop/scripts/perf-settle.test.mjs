// The mutation filter behind interaction.mjs's content-settled and content-ready numbers,
// run against a jsdom fixture shaped like the app: AppShell's <main> holds TabBackground's
// decorative layer, a page with an elapsed badge, and content. Run with:
//   node --test ./scripts/perf-settle.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { contentLandmark, isDecorativeRecord } from "../../../scripts/perf/ui/settle.mjs";

const HTML = `<!doctype html><body>
  <div id="root">
    <main id="shell">
      <div id="layer" class="ade-tab-bg" aria-hidden="true" data-perf-ignore="true"></div>
      <div id="page">
        <p id="title">Lanes</p>
        <span id="elapsed" aria-hidden="true" data-perf-ignore="true">Working 3s</span>
      </div>
    </main>
  </div>
  <div id="topbar" data-perf-ignore="true">12:00</div>
  <div id="plain">static</div>
</body>`;

function fixture(html = HTML) {
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  const { document } = dom.window;
  const scope = document.querySelector("main");
  const mo = new dom.window.MutationObserver(() => {});
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  // Runs `mutate` and returns how many records it made and how many the filter keeps as content.
  // Records made before the call (such as an attribute set on the fixture) are flushed first.
  const measure = (mutate, isDecorative = isDecorativeRecord) => {
    mo.takeRecords();
    mutate();
    const records = mo.takeRecords();
    return { records: records.length, content: records.filter((r) => !isDecorative(r, scope)).length };
  };
  return { dom, document, scope, measure, close: () => { mo.disconnect(); dom.window.close(); } };
}

function layer(document) {
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("data-perf-ignore", "true");
  return el;
}

function elementWith(document, tag, props) {
  return Object.assign(document.createElement(tag), props);
}

test("TabBackground's layers, inserted, restyled and removed, are not content", (t) => {
  const f = fixture();
  t.after(f.close);
  const { document, scope } = f;
  const fade = layer(document);
  assert.deepEqual(f.measure(() => scope.insertBefore(fade, document.getElementById("page"))), { records: 1, content: 0 });
  assert.deepEqual(f.measure(() => { fade.className = "ade-tab-bg fade"; }), { records: 1, content: 0 });
  assert.deepEqual(f.measure(() => fade.remove()), { records: 1, content: 0 });
  assert.deepEqual(f.measure(() => document.getElementById("layer").remove()), { records: 1, content: 0 });
});

test("an elapsed badge ticking is not content, whether its text node or its span changes", (t) => {
  const f = fixture();
  t.after(f.close);
  const elapsed = f.document.getElementById("elapsed");
  assert.deepEqual(f.measure(() => { elapsed.firstChild.nodeValue = "Working 4s"; }), { records: 1, content: 0 });
  assert.deepEqual(f.measure(() => { elapsed.textContent = "Working 5s"; }), { records: 1, content: 0 });
});

test("removing a decorative node is not content, though its ancestors are detached by the time the observer runs", (t) => {
  const f = fixture();
  t.after(f.close);
  const elapsed = f.document.getElementById("elapsed");
  assert.deepEqual(f.measure(() => elapsed.remove()), { records: 1, content: 0 });
});

test("page text, page elements and page attributes are content", (t) => {
  const f = fixture();
  t.after(f.close);
  const { document } = f;
  const title = document.getElementById("title");
  const page = document.getElementById("page");
  assert.deepEqual(f.measure(() => { title.firstChild.nodeValue = "Work"; }), { records: 1, content: 1 });
  assert.deepEqual(f.measure(() => { title.className = "heading"; }), { records: 1, content: 1 });
  assert.deepEqual(f.measure(() => page.append(elementWith(document, "p", { textContent: "row" }))), { records: 1, content: 1 });
  assert.deepEqual(f.measure(() => title.remove()), { records: 1, content: 1 });
});

test("one record that adds decoration and content together is content", (t) => {
  const f = fixture();
  t.after(f.close);
  const { document } = f;
  const fragment = document.createDocumentFragment();
  fragment.append(layer(document), elementWith(document, "p", { textContent: "row" }));
  // One record with two added nodes, so the mixed case is what gets judged.
  assert.deepEqual(f.measure(() => document.getElementById("page").append(fragment)), { records: 1, content: 1 });
});

test("decoration outside the content <main> counts only when marked data-perf-ignore", (t) => {
  const f = fixture();
  t.after(f.close);
  const { document } = f;
  assert.deepEqual(f.measure(() => { document.getElementById("topbar").firstChild.nodeValue = "12:01"; }), { records: 1, content: 0 });
  assert.deepEqual(f.measure(() => { document.getElementById("plain").firstChild.nodeValue = "changed"; }), { records: 1, content: 1 });
});

test("an aria-hidden ancestor above the content <main> does not hide the page", (t) => {
  const f = fixture();
  t.after(f.close);
  const { document } = f;
  // A modal dialog marks the app root aria-hidden while it is open.
  document.getElementById("root").setAttribute("aria-hidden", "true");
  assert.deepEqual(f.measure(() => { document.getElementById("title").firstChild.nodeValue = "Work"; }), { records: 1, content: 1 });
});

test("aria-hidden inside the content <main> hides its subtree; aria-hidden=\"false\" does not", (t) => {
  const f = fixture();
  t.after(f.close);
  const { document } = f;
  const page = document.getElementById("page");
  const hidden = elementWith(document, "div", { id: "hidden-panel" });
  hidden.setAttribute("aria-hidden", "true");
  hidden.append(elementWith(document, "p", { id: "hp", textContent: "x" }));
  assert.deepEqual(f.measure(() => page.append(hidden)), { records: 1, content: 0 });
  assert.deepEqual(f.measure(() => { document.getElementById("hp").firstChild.nodeValue = "y"; }), { records: 1, content: 0 });

  const shown = elementWith(document, "div", { id: "shown-panel" });
  shown.setAttribute("aria-hidden", "false");
  shown.append(elementWith(document, "p", { id: "sp", textContent: "x" }));
  assert.deepEqual(f.measure(() => page.append(shown)), { records: 1, content: 1 });
  assert.deepEqual(f.measure(() => { document.getElementById("sp").firstChild.nodeValue = "y"; }), { records: 1, content: 1 });
});

test("the content <main> itself being aria-hidden does not hide its own content", (t) => {
  const f = fixture();
  t.after(f.close);
  const { document, scope } = f;
  scope.setAttribute("aria-hidden", "true");
  assert.deepEqual(f.measure(() => { document.getElementById("title").firstChild.nodeValue = "Work"; }), { records: 1, content: 1 });
});

test("the source of the filter, evaluated in the page, gives the same answers as the module", (t) => {
  // interaction.mjs evaluates this exact source in the page. Run it in the same jsdom window.
  const f = fixture();
  t.after(f.close);
  const { document, scope } = f;
  const pageCopy = f.dom.window.eval(`(${isDecorativeRecord.toString()})`);
  assert.deepEqual(f.measure(() => scope.insertBefore(layer(document), document.getElementById("page")), pageCopy), { records: 1, content: 0 });
  assert.deepEqual(f.measure(() => { document.getElementById("title").firstChild.nodeValue = "Work"; }, pageCopy), { records: 1, content: 1 });
  assert.deepEqual(f.measure(() => { document.getElementById("elapsed").firstChild.nodeValue = "Working 4s"; }, pageCopy), { records: 1, content: 0 });
});

test("contentLandmark: the innermost <main>, or none for pickers", (t) => {
  const nested = new JSDOM(`<body><main id="shell"><main id="page-main"><p>x</p></main></main></body>`);
  t.after(() => nested.window.close());
  assert.equal(contentLandmark("tabs", nested.window.document).id, "page-main");
  assert.equal(contentLandmark("projects", nested.window.document).id, "page-main");
  assert.equal(contentLandmark("chats", nested.window.document).id, "page-main");
  assert.equal(contentLandmark("pickers", nested.window.document), null);

  const plain = new JSDOM(`<body><main id="shell"><p>x</p></main></body>`);
  t.after(() => plain.window.close());
  assert.equal(contentLandmark("tabs", plain.window.document).id, "shell");

  const none = new JSDOM(`<body><div>x</div></body>`);
  t.after(() => none.window.close());
  assert.equal(contentLandmark("tabs", none.window.document), null);
});
