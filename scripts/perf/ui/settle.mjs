// The filter behind interaction.mjs's "content settled" and "content ready" numbers.
//
// Both functions are self-contained on purpose: interaction.mjs sends their source into
// the page with Function#toString, and apps/desktop/scripts/perf-settle.test.mjs runs the
// same functions in jsdom. The page and the test run one copy of the rule.

// A mutation is decoration, not page content, when:
//  - its target, or a node it adds or removes, sits inside an element marked
//    data-perf-ignore, anywhere in the document; or
//  - its target sits inside an aria-hidden="true" element that is itself inside the
//    content scope (the app's first <main>, which AppShell renders around every page).
//    The scope element itself does not count, and an aria-hidden ancestor above the
//    scope does not either: a modal dialog hides the whole app root that way, and that
//    must not hide the page.
// A childList record is also decoration when every node it adds or removes is, even if
// its target is not (TabBackground inserts its layer straight into <main>). A removed node
// is detached by the time the observer runs, so it is judged by its own attributes; the
// target of the removal covers its former ancestors.
export function isDecorativeRecord(record, scope) {
  const isDecorativeNode = (node) => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return false;
    if (el.closest("[data-perf-ignore]")) return true;
    const hidden = el.closest('[aria-hidden="true"]');
    return hidden !== null && hidden !== scope && scope.contains(hidden);
  };
  if (isDecorativeNode(record.target)) return true;
  if (record.type !== "childList") return false;
  const changed = [...record.addedNodes, ...record.removedNodes];
  return changed.length > 0 && changed.every(isDecorativeNode);
}

// The element whose text decides "content ready" for a mode.
//  tabs, projects: the last <main> in document order. Pages that render their own <main>
//    (Lanes, Browser, Personal chats, Music) nest it inside AppShell's, so the innermost
//    one is the page's; the rest (Work, PRs, Settings, CTO, History, Automations, Files)
//    get AppShell's, which wraps the page.
//  chats: the same rule. Work renders no <main> of its own, so the landmark is AppShell's,
//    which holds the whole Work surface, not just the chat. Its ready time is early.
//  pickers: null. Popovers render outside <main>, and the picker's own mutations show it.
export function contentLandmark(mode, doc) {
  if (mode === "pickers") return null;
  const mains = doc.querySelectorAll("main");
  return mains.length ? mains[mains.length - 1] : null;
}
