/** chat_list and chat_read, and the small markdown renderer they share with prs_show. */
import { capitalize, h, listButton, isObj, modelName, plural, providerColor, providerName, rel, rows, str } from "./dom";
import { drill, frame, listBody, scoped, state } from "./frame";
import { callTool, canCallTools, reportSize } from "./host";
import type { AgentChatTranscriptEntry, ChatRow, LaneRow, Scope, TranscriptRead } from "./types";

/** chat_list rows carry a lane id only; one lanes_list call (same project and computer) names them. */
const laneNameCache: Record<string, Promise<Record<string, string>>> = {};
function fillLaneNames(spans: Array<{ el: HTMLElement; id: string }>, scope: Scope): void {
  if (!spans.length) return;
  const apply = (names: Record<string, string>) => {
    for (const s of spans) s.el.textContent = names[s.id] || "Lane";
    reportSize();
  };
  if (!canCallTools()) { apply({}); return; }
  const key = (scope.projectId ?? "") + "|" + (scope.machineKey ?? "");
  const names = laneNameCache[key] ?? (laneNameCache[key] = callTool("lanes_list", scoped(scope, {})).then((res) => {
    // A failed read is not remembered: the rejection below drops it, so the next card asks again.
    if (!res || res.isError) throw new Error("lanes_list failed");
    const env = res.structuredContent;
    const map: Record<string, string> = {};
    for (const lane of rows<LaneRow>(isObj(env) ? env.result : null)) if (lane.id) map[lane.id] = lane.name ?? "";
    return map;
  }));
  names.then(apply, () => { delete laneNameCache[key]; apply({}); });
}
/** `AgentChatSessionStatus` (active | idle | ended), plus a tracked CLI's status as text. */
function chatStatus(status: unknown): [string, string] {
  const st = String(status ?? "").toLowerCase();
  if (st === "active") return ["info", "Working"];
  if (st === "idle") return ["ok", "Done"];
  if (st === "ended") return ["", "Ended"];
  return ["", st ? capitalize(st) : ""];
}
export function viewChatList(r: unknown, scope: Scope): HTMLElement {
  const chats = rows<ChatRow>(r);
  const laneSpans: Array<{ el: HTMLElement; id: string }> = [];
  const items = chats.map((c) => {
    const [tone, word] = chatStatus(c.status);
    const title = str(c.title) || "Untitled chat";
    const when = rel(c.lastActivityAt ?? c.currentTurnStartedAt);
    const lane = c.laneId ? h("span", { cls: "lane", title: c.laneId }) : null;
    if (lane && c.laneId) laneSpans.push({ el: lane, id: c.laneId });
    const provider = str(c.provider) ?? "";
    const inner = [
      h("div", { cls: "wl" }, lane,
        h("span", { cls: "status", "data-s": tone }, tone ? h("span", { cls: "dot", "data-s": tone }) : null, word,
          when ? h("span", { cls: "dim" }, " · " + when) : null)),
      h("div", { cls: "wt trunc" }, title),
      h("div", { cls: "wp" }, h("i", null, str(c.lastOutputPreview) ?? ""),
        h("span", { cls: "mono small dim", style: "flex:none" },
          h("span", { cls: "swatch", style: "display:inline-block;margin-right:5px;background:" + providerColor(provider) }),
          modelName(c.model) || providerName(provider))),
    ];
    if (c.sessionId && canCallTools()) {
      return listButton({
        cls: "row wrow", "aria-label": title + ", " + word,
        onclick: () => drill("chat_read", scoped(scope, { session: c.sessionId }), "chat", title),
      }, inner);
    }
    return h("div", { cls: "wrow", role: "listitem" }, inner);
  });
  fillLaneNames(laneSpans, scope);
  return frame(scope, "Chats", chats.length, listBody(items, 12, "No chats."));
}
export function mdBlocks(text: string, container: HTMLElement): HTMLElement {
  // HTML comments (bot markers) and `<details>`-style tags say nothing here.
  const clean = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<\/?(details|summary|br|sub|sup|p|div)[^>]*>/gi, "");
  const parts = clean.split(/\n?```[^\n]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) { container.appendChild(h("pre", null, part.replace(/\n$/, ""))); return; }
    for (const para of part.split(/\n{2,}/)) {
      let t = para.trim();
      if (!t) continue;
      const lines = t.split("\n");
      const table = mdTable(lines);
      if (table) { container.appendChild(table); continue; }
      const heading = /^#{1,6}\s+(.*)$/.exec(lines[0]!);
      if (heading) {
        container.appendChild(inlineMd(h("p", { cls: "mdh" }), heading[1]!));
        lines.shift();
        t = lines.join("\n").trim();
        if (!t) continue;
      }
      // Runs of list lines become lists; the lines between them stay text.
      const item = /^(\s*)([-*+]|\d+\.)\s+/;
      let text: string[] = [];
      let list: HTMLElement | null = null;
      const flush = () => { if (text.length) container.appendChild(inlineMd(h("p"), text.join("\n"))); text = []; };
      for (const l of t.split("\n")) {
        const m = item.exec(l);
        if (m) {
          flush();
          if (!list) { list = h("ul"); container.appendChild(list); }
          list.appendChild(inlineMd(h("li", m[1]!.length >= 2 ? { cls: "sub" } : null), l.slice(m[0].length)));
        } else {
          list = null;
          text.push(l);
        }
      }
      flush();
    }
  });
  return container;
}
/** A GitHub table (`| a | b |` over `|---|---|`), when the paragraph is one; text before it stays text. */
function mdTable(lines: string[]): HTMLElement | null {
  const sep = lines.findIndex((l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l));
  if (sep < 1 || !lines.slice(sep - 1).every((l) => l.includes("|"))) return null;
  const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const wrap = h("div", { cls: "mdt" });
  const lead = lines.slice(0, sep - 1).join("\n").trim();
  if (lead) wrap.appendChild(inlineMd(h("p"), lead));
  const head = h("tr");
  for (const c of cells(lines[sep - 1]!)) head.appendChild(inlineMd(h("th"), c));
  const body = h("tbody");
  for (const l of lines.slice(sep + 1)) {
    const tr = h("tr");
    for (const c of cells(l)) tr.appendChild(inlineMd(h("td"), c));
    body.appendChild(tr);
  }
  wrap.appendChild(h("div", { cls: "mdt-scroll" }, h("table", null, h("thead", null, head), body)));
  return wrap;
}
function inlineMd(el: HTMLElement, t: string): HTMLElement {
  // Links keep their words; images and their alt text are dropped.
  const plain = t.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  for (const b of plain.split(/(`[^`\n]+`|\*\*[^*\n]+?\*\*)/)) {
    if (!b) continue;
    if (b.charAt(0) === "`" && b.length > 1) el.appendChild(h("code", null, b.slice(1, -1)));
    else if (b.slice(0, 2) === "**" && b.length > 4) el.appendChild(inlineMd(h("strong"), b.slice(2, -2)));
    else el.appendChild(document.createTextNode(b));
  }
  return el;
}
export function viewChatRead(r: unknown, scope: Scope): HTMLElement {
  const read = (isObj(r) ? r : {}) as Partial<TranscriptRead>;
  const entries = rows<AgentChatTranscriptEntry>(read.entries);
  const tx = h("div", { cls: "tx", role: "log", "aria-label": "Transcript", tabindex: "0" });
  if (read.truncated === true) tx.appendChild(h("div", { cls: "eyebrow", style: "text-align:center" }, "Earlier messages not shown"));
  if (!entries.length) tx.appendChild(h("div", { cls: "empty" }, "No messages yet."));
  for (const e of entries) {
    const text = str(e.displayText) ?? str(e.text) ?? "(empty)";
    tx.appendChild(e.role === "user" ? h("div", { cls: "u" }, text) : mdBlocks(text, h("div", { cls: "a" })));
  }
  const card = frame(scope, state.title || "Chat", entries.length ? plural(entries.length, "message") : null, tx);
  requestAnimationFrame(() => { tx.scrollTop = tx.scrollHeight; });
  return card;
}
