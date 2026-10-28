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
    const env = res?.structuredContent;
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
  const parts = text.split(/\n?```[^\n]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) { container.appendChild(h("pre", null, part.replace(/\n$/, ""))); return; }
    for (const para of part.split(/\n{2,}/)) {
      let t = para.trim();
      if (!t) continue;
      const lines = t.split("\n");
      if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
        const ul = h("ul");
        for (const l of lines) ul.appendChild(inlineMd(h("li"), l.replace(/^\s*([-*]|\d+\.)\s+/, "")));
        container.appendChild(ul);
        continue;
      }
      const heading = /^#{1,6}\s+(.*)$/.exec(lines[0]!);
      if (heading) {
        container.appendChild(inlineMd(h("p", { cls: "mdh" }), heading[1]!));
        lines.shift();
        t = lines.join("\n").trim();
        if (!t) continue;
      }
      container.appendChild(inlineMd(h("p"), t));
    }
  });
  return container;
}
function inlineMd(el: HTMLElement, t: string): HTMLElement {
  for (const b of t.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)) {
    if (!b) continue;
    if (b.charAt(0) === "`" && b.length > 1) el.appendChild(h("code", null, b.slice(1, -1)));
    else if (b.slice(0, 2) === "**" && b.length > 4) el.appendChild(h("strong", null, b.slice(2, -2)));
    else el.appendChild(document.createTextNode(b));
  }
  return el;
}
export function viewChatRead(r: unknown, scope: Scope): HTMLElement {
  const read = (isObj(r) ? r : {}) as Partial<TranscriptRead>;
  const entries = rows<AgentChatTranscriptEntry>(read.entries);
  const tx = h("div", { cls: "tx", role: "log", "aria-label": "Transcript" });
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
