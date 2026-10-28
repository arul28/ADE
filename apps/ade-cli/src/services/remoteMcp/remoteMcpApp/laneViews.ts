/** lanes_list, diff_changes and diff_patch. */
import { h, listButton, isObj, num, plural, rows, str } from "./dom";
import { drill, frame, listBody, scoped, state } from "./frame";
import { canCallTools } from "./host";
import type { BranchDiffChanges, DiffChanges, FileChange, FilePatch, LaneRow, Scope } from "./types";

export function viewLanes(r: unknown, scope: Scope): HTMLElement {
  const lanes = rows<LaneRow>(r);
  const items = lanes.map((l) => {
    const s = isObj(l.status) ? l.status : {};
    const changed = num(s.changedFileCount);
    const ahead = num(s.ahead);
    const behind = num(s.behind);
    const inner = [h("span", { cls: "dot", "data-s": s.dirty ? "warn" : l.archivedAt ? "" : "ok", title: s.dirty ? "Uncommitted changes" : "Clean" }),
      h("span", { cls: "grow", style: "display:flex;flex-direction:column;min-width:0" },
        h("span", { cls: "trunc", style: "font-weight:500" }, str(l.name) || l.id || "Lane"),
        h("span", { cls: "trunc mono small dim" }, str(l.branchRef) ?? "")),
      l.laneType === "primary" ? h("span", { cls: "tag", "data-t": "accent" }, "primary") : null,
      l.archivedAt ? h("span", { cls: "tag" }, "archived") : null,
      s.rebaseInProgress ? h("span", { cls: "tag", "data-t": "warn" }, "rebasing") : null,
      changed ? h("span", { cls: "small t2 num" }, plural(changed, "file")) : null,
      ahead || behind ? h("span", { cls: "small dim num", title: "Ahead / behind " + (l.baseRef || "base") },
        (ahead ? "↑" + ahead : "") + (behind ? " ↓" + behind : "")) : null];
    if (l.id && canCallTools()) {
      return listButton({ cls: "row", onclick: () => drill("diff_changes", scoped(scope, { lane: l.id }), "changes") }, inner);
    }
    return h("div", { cls: "row", role: "listitem" }, inner);
  });
  return frame(scope, "Lanes", lanes.length, listBody(items, 12, "No lanes."));
}
function splitPath(p: string): [string, string] {
  const i = p.lastIndexOf("/");
  return i < 0 ? ["", p] : [p.slice(0, i + 1), p.slice(i + 1)];
}
const KIND_TONE: Record<string, string> = { added: "ok", untracked: "ok", deleted: "crit", renamed: "accent", modified: "warn" };
/** One changed file; it opens its patch when it has one (`mode` null: a whole-branch list, which has no per-file patch mode). */
function fileRow(f: FileChange, mode: "unstaged" | "staged" | null, scope: Scope): HTMLElement {
  const path = str(f.path) ?? "";
  const [dir, base] = splitPath(path);
  const kind = String(f.kind ?? "").toLowerCase();
  const a = num(f.additions);
  const d = num(f.deletions);
  const lane = str(state.args.lane);
  const inner = [h("span", { cls: "dot", "data-s": KIND_TONE[kind] ?? "", title: kind || "changed" }),
    h("span", { cls: "grow trunc" }, h("span", { cls: "dim" }, dir), base),
    kind && kind !== "modified" ? h("span", { cls: "tag", "data-t": KIND_TONE[kind] ?? "" }, kind) : null,
    a !== null ? h("span", { cls: "num small add" }, "+" + a) : null, d !== null ? h("span", { cls: "num small del" }, "−" + d) : null];
  if (lane && path && mode && canCallTools() && kind !== "untracked") {
    return listButton({ cls: "row", onclick: () => drill("diff_patch", scoped(scope, { lane, path, mode }), "diff") }, inner);
  }
  return h("div", { cls: "row", role: "listitem" }, inner);
}
/** `DiffChanges` (staged / unstaged), or with `branch`, `BranchDiffChanges` (files since the base). */
export function viewDiffChanges(r: unknown, scope: Scope): HTMLElement {
  const res = (isObj(r) ? r : {}) as Partial<DiffChanges & BranchDiffChanges>;
  const groups: Array<[string, FileChange[], "unstaged" | "staged" | null]> = Array.isArray(res.files)
    ? [["Since " + (str(res.baseRef) ?? "base"), rows<FileChange>(res.files), null]]
    : [["Unstaged", rows<FileChange>(res.unstaged), "unstaged"], ["Staged", rows<FileChange>(res.staged), "staged"]];
  let total = 0;
  const body = h("div", { cls: "body flush" });
  for (const [label, files, mode] of groups) {
    if (!files.length) continue;
    total += files.length;
    body.appendChild(h("div", { cls: "sec" }, h("span", { cls: "eyebrow" }, label), h("span", { cls: "count" }, String(files.length))));
    const list = listBody(files.map((f) => fileRow(f, mode, scope)), 15, "");
    list.className = "";
    body.appendChild(list);
  }
  if (!total) body.appendChild(h("div", { cls: "empty" }, "No changes."));
  return frame(scope, "Changes", total, body);
}
export function viewDiffPatch(r: unknown, scope: Scope): HTMLElement {
  const res = (isObj(r) ? r : {}) as Partial<FilePatch>;
  const patch = typeof res.patch === "string" ? res.patch : "";
  const path = str(res.path) ?? str(state.args.path) ?? "Diff";
  const box = h("div", { cls: "diff", role: "region", "aria-label": "Diff of " + path });
  if (res.isBinary === true) box.appendChild(h("div", { cls: "f", style: "padding:10px 14px" }, "Binary file; no text diff."));
  else if (!patch) box.appendChild(h("div", { cls: "f", style: "padding:10px 14px" }, "No changes in this file."));
  else {
    const lines = patch.replace(/\n$/, "").split("\n");
    const cap = Math.min(lines.length, 1500);
    for (let i = 0; i < cap; i++) {
      const l = lines[i]!;
      let c = "";
      if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l)) c = "f";
      else if (l.charAt(0) === "@") c = "h";
      else if (l.charAt(0) === "+") c = "p";
      else if (l.charAt(0) === "-") c = "m";
      box.appendChild(h("div", { cls: c }, l || " "));
    }
    if (lines.length > cap || res.isTruncated === true) box.appendChild(h("div", { cls: "f" }, lines.length > cap ? (lines.length - cap) + " more lines not shown" : "The rest of this patch is not shown"));
  }
  const a = num(res.additions);
  const d = num(res.deletions);
  return frame(scope, splitPath(path)[1] || path, null, box, {
    headExtra: h("span", { style: "display:inline-flex;gap:6px;margin-left:4px" },
      a !== null ? h("span", { cls: "num small add" }, "+" + a) : null, d !== null ? h("span", { cls: "num small del" }, "−" + d) : null),
  });
}
