/** chat_respond, chat_send and chat_start: one line saying what happened. */
import { h, safeLink, str } from "./dom";
import { openLink } from "./host";
import type { RespondResult, Scope, SendResult, StartResult } from "./types";

type WriteLine = { line: string; tone: string; note: string | null; link: string | null };
function chatName(title: unknown, sessionId: unknown): string {
  const id = str(sessionId);
  return str(title) ?? (id ? "chat " + id.slice(0, 8) : "chat");
}
export function respondLine(r: Partial<RespondResult>): WriteLine {
  const d = r.decision;
  const verb = d === "decline" ? "Denied" : d === "cancel" ? "Cancelled" : d === "accept_for_session" ? "Approved for this chat" : d === "accept" ? "Approved" : "Answered";
  return { line: verb + " · " + chatName(r.title, r.sessionId), tone: d === "decline" || d === "cancel" ? "crit" : "ok", note: null, link: safeLink(r.link) };
}
export function startLine(r: Partial<StartResult>): WriteLine {
  const chat = chatName(r.title, r.sessionId);
  const lane = str(r.lane) ? "in " + r.lane : null;
  if (r.phase === "failed" || r.phase === "cancelled") {
    return { line: (r.phase === "failed" ? "Could not start " : "Cancelled ") + chat, tone: "crit", note: str(r.error) ?? lane, link: safeLink(r.link) };
  }
  // "running" is the chat working on its prompt; "setting_up" is its lane still being made.
  const settingUp = r.phase === "setting_up";
  return { line: (settingUp ? "Starting " : "Started ") + chat, tone: settingUp ? "info" : "ok", note: lane, link: safeLink(r.link) };
}
export function sendLine(r: Partial<SendResult>): WriteLine {
  const chat = chatName(null, r.sessionId);
  const how = r.routedAction === "steer" ? "Steered the running turn"
    : r.routedAction === "interrupt-replace" ? "Interrupted and sent"
    : r.delivery === "queued" ? "Queued for after this turn"
    : "Message sent";
  return { line: how, tone: r.delivery === "queued" ? "info" : "ok", note: chat, link: safeLink(r.link) };
}
export function viewWrite(w: WriteLine, scope: Scope): HTMLElement {
  const body = h("div", { cls: "head", style: "height:auto;min-height:44px;padding:8px 14px" }, h("span", { cls: "dot big", "data-s": w.tone }),
    h("span", { cls: "grow", style: "display:flex;flex-direction:column;min-width:0" },
      h("span", { cls: "trunc", style: "font-weight:500" }, w.line), w.note ? h("span", { cls: "small dim trunc" }, w.note) : null),
    scope.machineName ? h("span", { cls: "chip" }, scope.machineName) : null,
    w.link ? h("button", { cls: "btn", type: "button", onclick: () => openLink(w.link!) }, "Open in ADE") : null);
  return h("section", { cls: "card", "aria-label": w.line }, body);
}
