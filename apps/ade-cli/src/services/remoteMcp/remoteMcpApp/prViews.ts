/** prs_list, prs_show and prs_checks. */
import { mdBlocks } from "./chatViews";
import { h, listButton, isObj, num, rel, rows, safeLink, str } from "./dom";
import { frame, listBody, scoped } from "./frame";
import { callTool, canCallTools, openLink, reportSize } from "./host";
import type { CheckRow, ChecksResult, PrDetail, PrRow, Scope } from "./types";

/** One GitHub check: its tone and word. */
function checkState(c: CheckRow): [string, string] {
  const co = String(c.conclusion ?? "").toLowerCase();
  if (c.status !== "completed") return ["warn", "pending"];
  if (co === "success") return ["ok", "passed"];
  if (co === "failure" || co === "timed_out" || co === "action_required") return ["crit", "failed"];
  if (co === "cancelled") return ["crit", "cancelled"];
  if (!co) return ["warn", "pending"];
  return ["", co];
}
/** A PR's rolled-up `checksStatus` (passing | failing | pending | none). */
function checksTone(s: unknown): string {
  return s === "passing" ? "ok" : s === "failing" ? "crit" : s === "pending" ? "warn" : "";
}
export function viewChecks(r: unknown, scope: Scope): HTMLElement {
  const res = (isObj(r) ? r : {}) as Partial<ChecksResult>;
  const rank: Record<string, number> = { crit: 0, warn: 1, ok: 2, "": 3 };
  const checks = rows<CheckRow>(res.checks).map((c) => ({ c, s: checkState(c) }));
  checks.sort((a, b) => rank[a.s[0]]! - rank[b.s[0]]!);
  const items = checks.map(({ c, s }) => {
    const url = safeLink(c.url);
    const inner = [h("span", { cls: "dot", "data-s": s[0] }), h("span", { cls: "grow trunc" }, str(c.name) || "check"),
      h("span", { cls: "small dim" }, s[1]), url ? h("span", { cls: "dim", "aria-hidden": "true" }, "↗") : null];
    return url
      ? listButton({ cls: "row", title: "Open " + url, onclick: () => openLink(url) }, inner)
      : h("div", { cls: "row", role: "listitem" }, inner);
  });
  const counts = isObj(res.checksCounts) ? res.checksCounts : null;
  const pass = num(counts?.passing) ?? 0;
  const fail = num(counts?.failing) ?? 0;
  const pend = num(counts?.pending) ?? 0;
  const total = num(counts?.total) ?? checks.length;
  const body = h("div", null,
    h("div", { cls: "strip" },
      h("div", null, h("small", { cls: "eyebrow" }, "Passed"), h("b", { style: "color:var(--ok)" }, String(pass), h("small", null, "/" + total))),
      h("div", null, h("small", { cls: "eyebrow" }, "Failed"), h("b", { style: fail ? "color:var(--crit)" : "color:var(--t3)" }, String(fail))),
      h("div", null, h("small", { cls: "eyebrow" }, "Pending"), h("b", { style: pend ? "color:var(--warn)" : "color:var(--t3)" }, String(pend)))),
    total ? h("div", { cls: "bar", "aria-hidden": "true" },
      h("span", { style: "flex:" + pass + ";background:var(--ok)" }), h("span", { style: "flex:" + fail + ";background:var(--crit)" }),
      h("span", { style: "flex:" + pend + ";background:var(--warn)" }),
      h("span", { style: "flex:" + Math.max(0, total - pass - fail - pend) + ";background:var(--track)" })) : null,
    listBody(items, 10, "No checks on this pull request."));
  const st = str(res.checksStatus);
  return frame(scope, "Checks" + prLabel(res.prId), null, body, { headExtra: st ? h("span", { cls: "tag", "data-t": checksTone(st) }, st) : null });
}
/** " · #123" for a PR number; nothing for a URL or an ADE id. */
function prLabel(prId: unknown): string {
  const id = str(prId);
  return id && /^\d+$/.test(id) ? " · #" + id : "";
}
function prStateColor(s: string): string {
  return s === "merged" ? "var(--pr-merged)" : s === "closed" ? "var(--pr-closed)" : s === "draft" ? "var(--t3)" : "var(--pr-open)";
}
function reviewWord(s: unknown): string {
  const w = String(s ?? "").toLowerCase().replace(/_/g, " ");
  return w && w !== "none" ? w : "";
}
export function viewPrList(r: unknown, scope: Scope): HTMLElement {
  const prs = rows<PrRow>(r);
  const items = prs.map((p) => {
    const url = safeLink(p.githubUrl);
    const inner = [h("span", { cls: "dot big", style: "background:" + prStateColor(String(p.state ?? "")) }),
      h("span", { cls: "grow trunc" }, h("span", { cls: "mono dim" }, p.githubPrNumber ? "#" + p.githubPrNumber + " " : ""), str(p.title) || "Pull request"),
      reviewWord(p.reviewStatus) ? h("span", { cls: "tag" }, reviewWord(p.reviewStatus)) : null,
      p.checksStatus && p.checksStatus !== "none" ? h("span", { cls: "dot", "data-s": checksTone(p.checksStatus), title: "Checks: " + p.checksStatus }) : null,
      h("span", { cls: "small dim num" }, rel(p.updatedAt ?? p.createdAt))];
    return url
      ? listButton({ cls: "row", onclick: () => openLink(url) }, inner)
      : h("div", { cls: "row", role: "listitem" }, inner);
  });
  return frame(scope, "Pull requests", prs.length, listBody(items, 10, "No pull requests."));
}
export function viewPrShow(r: unknown, scope: Scope): HTMLElement {
  const pr = (isObj(r) ? r : {}) as Partial<PrDetail>;
  const author = isObj(pr.author) ? str(pr.author.login) : null;
  const labels = rows<PrDetail["labels"][number]>(pr.labels);
  const reviewers = rows<PrDetail["requestedReviewers"][number]>(pr.requestedReviewers).map((x) => str(x.login)).filter(Boolean);
  const issues = rows<PrDetail["linkedIssues"][number]>(pr.linkedIssues);
  const meta = h("div", { cls: "row", style: "flex-wrap:wrap;gap:6px" },
    pr.isDraft === true ? h("span", { cls: "tag" }, "draft") : null,
    author ? h("span", { cls: "t2" }, "by " + author) : null,
    labels.map((l) => {
      const color = /^[0-9a-f]{6}$/i.test(String(l.color ?? "")) ? "#" + l.color : "var(--t3)";
      return h("span", { cls: "label" }, h("i", { style: "background:" + color }), str(l.name) || "label");
    }));
  const summary = h("div", { cls: "prsum", hidden: "" });
  const body = h("div", { cls: "body flush" }, summary, meta);
  fillPrSummary(summary, str(pr.prId), scope);
  if (reviewers.length) body.appendChild(h("div", { cls: "row small t2" }, "Review requested from " + reviewers.join(", ")));
  for (const issue of issues) {
    body.appendChild(h("div", { cls: "row small t2" }, h("span", { cls: "mono dim" }, "#" + issue.number), str(issue.title) ?? "", str(issue.state) ? h("span", { cls: "tag" }, String(issue.state)) : null));
  }
  const text = str(pr.body);
  if (text) {
    body.appendChild(h("div", { cls: "rule" }));
    const desc = mdBlocks(text.length > 6000 ? text.slice(0, 6000) + "…" : text, h("div", { cls: "prbody a", "data-open": "false" }));
    body.appendChild(desc);
    // Long descriptions open on request; a short one shows whole.
    requestAnimationFrame(() => {
      if (desc.scrollHeight <= desc.clientHeight + 4) { desc.dataset.open = "true"; return; }
      const more = h("button", { cls: "more", type: "button", "aria-expanded": "false" }, "Show more");
      more.addEventListener("click", () => {
        const open = desc.dataset.open !== "true";
        desc.dataset.open = String(open);
        more.textContent = open ? "Show less" : "Show more";
        more.setAttribute("aria-expanded", String(open));
      });
      desc.after(more);
    });
  }
  return frame(scope, "Pull request" + prLabel(pr.prId).replace(" · ", " "), null, body);
}

/**
 * `prs show` answers with the detail only; its title, state, review, checks
 * and link come from the PR's row in `prs_list`, read once when the card opens.
 */
const prRowsCache: Record<string, Promise<Array<PrRow & { id?: string }>>> = {};
function fillPrSummary(el: HTMLElement, prId: string | null, scope: Scope): void {
  if (!prId || !canCallTools()) return;
  const key = (scope.projectId ?? "") + "|" + (scope.machineKey ?? "");
  const list = prRowsCache[key] ?? (prRowsCache[key] = callTool("prs_list", scoped(scope, {})).then((res) => {
    // A failed read is not remembered, so the next card asks again.
    if (!res || res.isError) throw new Error("prs_list failed");
    const env = res.structuredContent;
    return rows<PrRow & { id?: string }>(isObj(env) ? env.result : null);
  }));
  list.then((prs) => {
    // `prs show` answers with ADE's id for the PR.
    const row = prs.find((p) => p.id === prId);
    if (!row) return;
    const state = String(row.state ?? "");
    const review = reviewWord(row.reviewStatus);
    const url = safeLink(row.githubUrl);
    el.replaceChildren(
      h("div", { cls: "prtitle" }, h("span", { cls: "dot big", style: "background:" + prStateColor(state) }),
        h("span", { cls: "grow" }, str(row.title) || "Pull request"),
        url ? h("button", { cls: "btn", type: "button", onclick: () => openLink(url) }, "Open ↗") : null),
      h("div", { cls: "row", style: "flex-wrap:wrap;gap:6px;padding-top:0" },
        state ? h("span", { cls: "tag", "data-t": state === "open" ? "ok" : state === "closed" ? "crit" : "" }, state) : null,
        review ? h("span", { cls: "tag" }, "review: " + review) : null,
        row.checksStatus && row.checksStatus !== "none"
          ? h("span", { cls: "tag", "data-t": checksTone(row.checksStatus) }, "checks: " + row.checksStatus) : null,
        h("span", { cls: "small dim num" }, rel(row.updatedAt ?? row.createdAt))));
    el.hidden = false;
    reportSize();
  }, () => { delete prRowsCache[key]; });
}
