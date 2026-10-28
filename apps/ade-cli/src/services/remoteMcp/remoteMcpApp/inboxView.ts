/** The inbox: each card answers in place through chat_respond or chat_send, in its own project. */
import { h, isObj, rel, rows, safeLink, str } from "./dom";
import { frame, scoped } from "./frame";
import { callTool, canCallTools, openLink, reportSize, resultText } from "./host";
import type { ChatInboxQuestion, InboxItem, Json, Scope } from "./types";

function itemQuestions(it: InboxItem): ChatInboxQuestion[] {
  const qs = rows<ChatInboxQuestion>(it.questions);
  if (qs.length) return qs;
  return str(it.text) ? [{ id: "", question: it.text }] : [];
}
/**
 * Where an item's answer goes: the item's own project (the every-project inbox
 * has none of its own), else the view's; and the computer that answered.
 */
function itemScope(it: InboxItem, scope: Scope): Scope {
  const p = isObj(it.project) ? it.project : null;
  const projectId = str(p?.id);
  return projectId ? { ...scope, projectId, projectName: str(p?.name), projectPath: null } : scope;
}
function inboxCard(it: InboxItem, scope: Scope, showProject: boolean): HTMLElement {
  const target = itemScope(it, scope);
  const kind = it.kind;
  const approval = kind === "approval" || kind === "plan";
  const ask = kind === "ask";
  const title = str(it.title) || "Chat";
  const link = safeLink(it.link);
  const wrap = h("div", { cls: "ask", role: "group", "aria-label": title });
  wrap.appendChild(h("div", { cls: "wl" }, h("span", { cls: "dot", "data-s": "warn" }),
    h("span", { style: "color:var(--warn);font-weight:500" }, kind === "plan" ? "Plan" : approval ? "Approval" : ask ? "Waiting on you" : "Question"),
    str(it.lane) ? h("span", { cls: "lane", style: "margin-left:4px" }, String(it.lane)) : null,
    showProject && target.projectName ? h("span", { cls: "chip", title: "Project" }, target.projectName) : null,
    h("span", { cls: "status dim" }, rel(it.since)),
    link ? h("button", { cls: "back", type: "button", style: "margin:0 -6px 0 0", title: "Open in ADE", onclick: () => openLink(link) }, "Open ↗") : null));
  wrap.appendChild(h("div", { cls: "wt trunc" }, title));
  const qs = itemQuestions(it);
  const multi = qs.length > 1;
  for (const q of qs) {
    const question = str(q.question);
    const header = str(q.header);
    const t = multi && header && question ? header + ": " + question : question ?? header;
    if (t) wrap.appendChild(h("div", { cls: "q" }, t));
  }
  if (str(it.detail)) {
    wrap.appendChild(h("details", { cls: "tool", style: "margin:-2px 0 8px" }, h("summary", null, "Details"), h("pre", { style: "white-space:pre-wrap" }, String(it.detail))));
  }
  const actions = h("div");
  const live = h("div", { "aria-live": "polite" });
  const writable = canCallTools();
  const lock = (on: boolean) => {
    wrap.querySelectorAll<HTMLButtonElement | HTMLInputElement>(".opts button,.free button,.free input").forEach((b) => { b.disabled = on; });
  };
  const send = (tool: "chat_respond" | "chat_send", answer: Json, label: string, btn: HTMLButtonElement, tone = "ok") => {
    if (!writable) return;
    lock(true);
    live.textContent = "";
    btn.textContent = "Sending…";
    const args = tool === "chat_send"
      ? scoped(target, { session: it.sessionId, text: answer.text })
      : scoped(target, { session: it.sessionId, request_id: it.requestId, ...answer });
    callTool(tool, args).then((res) => {
      if (!res || res.isError) throw new Error(resultText(res) || "ADE could not send that answer.");
      actions.textContent = "";
      actions.appendChild(h("div", { cls: "done" }, h("span", { cls: "dot big", "data-s": tone }), h("span", { cls: "grow" }, label)));
      reportSize();
    }).catch((e: unknown) => {
      lock(false);
      btn.textContent = btn.getAttribute("data-label");
      live.appendChild(h("div", { cls: "err" }, e instanceof Error && e.message ? e.message : "That did not go through."));
      reportSize();
    });
  };
  const freeText = (tool: "chat_respond" | "chat_send", hasOptions: boolean) => {
    const inp = h("input", { cls: "input", type: "text", placeholder: hasOptions ? "Or type an answer" : "Type an answer", "aria-label": "Answer for " + title, disabled: !writable });
    const go: HTMLButtonElement = h("button", {
      cls: "btn", type: "button", "data-label": "Send", disabled: !writable,
      onclick: () => { const v = inp.value.trim(); if (v) send(tool, { text: v }, (tool === "chat_send" ? "Sent · " : "Answered · ") + v, go); },
    }, "Send");
    inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); go.click(); } });
    return h("div", { cls: "free" }, inp, go);
  };
  if (approval) {
    const ap: HTMLButtonElement = h("button", {
      cls: "btn primary", type: "button", "data-label": "Approve", disabled: !writable,
      onclick: () => send("chat_respond", { decision: "approve" }, "Approved · " + title, ap, "ok"),
    }, "Approve");
    const dn: HTMLButtonElement = h("button", {
      cls: "btn", type: "button", "data-label": "Deny", "data-t": "crit", disabled: !writable,
      onclick: () => send("chat_respond", { decision: "deny" }, "Denied · " + title, dn, "crit"),
    }, "Deny");
    actions.appendChild(h("div", { cls: "opts" }, ap, dn));
  } else if (ask) {
    actions.appendChild(freeText("chat_send", false));
  } else {
    actions.appendChild(questionOptions(qs, title, writable, send));
    const hasOptions = qs.some((q) => rows(q.options).length > 0);
    if (!qs.some((q) => q.optionsOnly === true || q.secret === true)) actions.appendChild(freeText("chat_respond", hasOptions));
  }
  if (!writable) actions.appendChild(h("div", { cls: "small dim", style: "margin-top:6px" }, "Answer this in ADE, or ask me to."));
  wrap.appendChild(actions);
  wrap.appendChild(live);
  return wrap;
}
/** A question's option buttons: one click answers a lone single-choice question; otherwise pick, then Send answers. */
function questionOptions(
  qs: ChatInboxQuestion[],
  title: string,
  writable: boolean,
  send: (tool: "chat_respond", answer: Json, label: string, btn: HTMLButtonElement) => void,
): HTMLElement {
  const box = h("div");
  const instant = qs.length === 1 && !qs[0]!.multiSelect;
  const picks: Record<string, string[]> = {};
  let anyOptions = false;
  qs.forEach((q, qi) => {
    const options = rows<NonNullable<ChatInboxQuestion["options"]>[number]>(q.options);
    if (!options.length) return;
    anyOptions = true;
    const row = h("div", { cls: "opts", style: qs.length > 1 ? "margin-bottom:6px" : null, role: q.multiSelect ? "group" : null, "aria-label": str(q.question) || "Options" });
    options.forEach((o, i) => {
      const label = str(o.label) || "Option " + (i + 1);
      const b: HTMLButtonElement = h("button", {
        cls: "btn opt" + (o.recommended && instant ? " primary" : ""), type: "button", "data-label": label,
        "aria-pressed": instant ? null : "false", disabled: !writable,
        onclick: () => {
          if (instant) { send("chat_respond", { option: String(i + 1) }, "Answered · " + label, b); return; }
          const key = String(qi + 1);
          let cur = picks[key] ?? [];
          const at = cur.indexOf(label);
          if (q.multiSelect) { if (at >= 0) cur.splice(at, 1); else cur.push(label); } else cur = at >= 0 ? [] : [label];
          picks[key] = cur;
          row.querySelectorAll("button").forEach((x) => {
            const on = cur.indexOf(x.getAttribute("data-label") ?? "") >= 0;
            x.setAttribute("aria-pressed", on ? "true" : "false");
            x.classList.toggle("primary", on);
          });
        },
      }, h("span", null, label), str(o.description) ? h("small", null, String(o.description)) : null);
      row.appendChild(b);
    });
    box.appendChild(row);
  });
  if (!instant && anyOptions) {
    const sb: HTMLButtonElement = h("button", {
      cls: "btn primary", type: "button", "data-label": "Send answers", disabled: !writable,
      onclick: () => {
        const answers: Json = {};
        const labels: string[] = [];
        for (const k of Object.keys(picks)) {
          const picked = picks[k]!;
          if (!picked.length) continue;
          answers[k] = qs[Number(k) - 1]?.multiSelect ? picked : picked[0];
          labels.push(picked.join(", "));
        }
        if (labels.length) send("chat_respond", { answers }, "Answered · " + labels.join(" · "), sb);
      },
    }, "Send answers");
    box.appendChild(h("div", { cls: "free", "aria-label": "Answers for " + title }, sb));
  }
  return box;
}
export function viewInbox(r: unknown, scope: Scope): HTMLElement {
  const items = rows<InboxItem>(isObj(r) ? r.items : null);
  // Several projects in one list: each card names its own.
  const projects = new Set(items.map((it) => (isObj(it.project) ? str(it.project.id) : null) ?? scope.projectId));
  const body = h("div");
  if (!items.length) body.appendChild(h("div", { cls: "empty", style: "padding:6px 14px 14px" }, "Nothing waits on you."));
  for (const it of items) body.appendChild(inboxCard(it, scope, projects.size > 1));
  return frame(scope, "Needs you", items.length || null, body);
}
