// Injected by render-count.mjs before the renderer loads (`reload` mode).
(() => {
  // Render counter in the style of React DevTools' didFiberRender: walk only the
  // parts of the tree React actually processed this commit (a child pointer
  // equal to the alternate's means the whole subtree was skipped).
  const counts = new Map();
  const mounts = new Map();
  const tops = new Map();
  const propDiffs = new Map();
  const hookDiffs = new Map();
  window.__hookWatch = new Set(["TerminalsPage"]);
  const preview = (v) => { try { if (v == null) return String(v); if (typeof v === "function") return "fn"; if (Array.isArray(v)) return "arr" + v.length; if (typeof v === "object") return "{" + Object.keys(v).slice(0, 4).join(",") + "}"; return String(v).slice(0, 30); } catch { return "?"; } };
  window.__renderCountOn = false;
  window.__watchNames = new Set(["AgentChatPane", "AgentChatComposer", "WorkViewArea", "SessionCard", "HeaderUsageControl", "TopBar", "ProjectSidebar", "Dialog", "CommandPalette", "WithLatestHandlers(SessionCard)"]);
  const nameOf = (fiber) => {
    const t = fiber.type;
    if (!t || typeof t === "string") return null;
    return t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name)) || null;
  };
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const isComponent = (f) => f.tag === 0 || f.tag === 1 || f.tag === 11 || f.tag === 15 || f.tag === 14;
  const visit = (next, parentRendered, path) => {
    const prev = next.alternate;
    const name = isComponent(next) ? nameOf(next) : null;
    let rendered = false;
    if (name) {
      if (!prev) { bump(mounts, name); rendered = true; }
      else if (prev.memoizedProps !== next.memoizedProps || prev.memoizedState !== next.memoizedState || prev.ref !== next.ref) rendered = true;
      if (rendered) {
        bump(counts, name);
        if (!parentRendered) bump(tops, `${name}  [in ${path.slice(-3).join(">")}]`);
        if (prev && window.__hookWatch.has(name) && prev.memoizedProps === next.memoizedProps) {
          let h = next.memoizedState, ah = prev.memoizedState, i = 0;
          while (h && ah && i < 800) {
            const v = h.memoizedState, av = ah.memoizedState;
            const isMemo = Array.isArray(v) && v.length === 2 && (Array.isArray(v[1]) || v[1] === null);
            const isEffect = v && typeof v === "object" && "create" in v;
            if (v !== av && !isMemo && !isEffect) bump(hookDiffs, `${name} hook#${i} ${preview(av)} -> ${preview(v)}`);
            h = h.next; ah = ah.next; i++;
          }
        }
        if (prev && window.__watchNames.has(name) && prev.memoizedProps !== next.memoizedProps) {
          const a = prev.memoizedProps || {}, b = next.memoizedProps || {};
          const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
          bump(propDiffs, `${name}: ${keys.slice(0, 6).join(",") || "(new props obj, same values)"}`);
        }
      }
    }
    if (next.child && (!prev || prev.child !== next.child)) {
      const childPath = name ? [...path, name] : path;
      const pr = name ? rendered : parentRendered;
      let child = next.child;
      while (child) { visit(child, pr, childPath); child = child.sibling; }
    }
  };
  window.__renderCountsReset = () => { hookDiffs.clear(); counts.clear(); mounts.clear(); tops.clear(); propDiffs.clear(); };
  window.__renderCounts = () => ({
    renders: Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]).slice(0, 300)),
    mounts: Object.fromEntries([...mounts].sort((a, b) => b[1] - a[1]).slice(0, 40)),
    propDiffs: Object.fromEntries([...propDiffs].sort((a, b) => b[1] - a[1]).slice(0, 40)),
    stateCauses: Object.fromEntries([...hookDiffs].sort((a, b) => b[1] - a[1]).slice(0, 40)),
  });
  window.__tops = () => Object.fromEntries([...tops].sort((a, b) => b[1] - a[1]).slice(0, 40));
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id; },
    onCommitFiberRoot(_id, root) {
      window.__lastRoot = root;
      if (!window.__renderCountOn) return;
      try { const cur = root.current; if (cur.alternate && cur.alternate.child === cur.child) return; let c = cur.child; while (c) { visit(c, false, []); c = c.sibling; } } catch (e) { window.__hookErr = String(e); }
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };
})();
