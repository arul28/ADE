/** usage_limits and machines_list. */
import { dur, h, isObj, num, providerColor, providerName, rows, str } from "./dom";
import { NO_SCOPE, frame, listBody } from "./frame";
import type { Json, MachineRow, Scope, UsageLimitsAccount, UsageLimitsReport } from "./types";

export function viewUsage(r: unknown, scope: Scope): HTMLElement {
  const report = (isObj(r) ? r : {}) as Partial<UsageLimitsReport>;
  const accounts = rows<UsageLimitsAccount>(report.accounts);
  const byProvider = new Map<string, UsageLimitsAccount[]>();
  for (const a of accounts) {
    const p = String(a.provider || "other");
    const list = byProvider.get(p) ?? [];
    list.push(a);
    byProvider.set(p, list);
  }
  const body = h("div", { cls: "body flush" });
  for (const [provider, list] of byProvider) {
    body.appendChild(h("div", { cls: "sec" }, h("span", { cls: "swatch", style: "background:" + providerColor(provider) }),
      h("span", { style: "font-weight:600;font-size:12.5px" }, providerName(provider))));
    for (const a of list) body.appendChild(usageAccount(a));
  }
  for (const note of Array.isArray(report.notes) ? report.notes : []) if (str(note)) body.appendChild(h("div", { cls: "row small dim" }, String(note)));
  if (!accounts.length) body.appendChild(h("div", { cls: "empty" }, "No usage readings on this computer."));
  return frame(scope, "Usage limits", null, body);
}
function usageAccount(a: UsageLimitsAccount): HTMLElement {
  const box = h("div", { cls: "acct" }, h("div", { cls: "row", style: "padding:0;min-height:20px" },
    h("span", { cls: "grow trunc t2" }, str(a.email) ?? str(a.label) ?? "Signed in on this computer"),
    a.plan ? h("span", { cls: "tag" }, String(a.plan)) : null,
    a.nextChat === true ? h("span", { cls: "tag", "data-t": "accent", title: "The next chat starts on this account" }, "next chat") : null,
    a.state && a.state !== "ok" ? h("span", { cls: "tag", "data-t": "warn" }, String(a.state).replace(/_/g, " ")) : null));
  if (a.note) box.appendChild(h("div", { cls: "small dim" }, String(a.note)));
  for (const w of rows<UsageLimitsAccount["windows"][number]>(a.windows)) {
    const left = num(w.percentLeft);
    const lvl = left === null ? "" : left <= 5 ? "crit" : left <= 20 ? "warn" : "";
    const pace = isObj(w.pace) ? w.pace : null;
    const resets = dur(num(w.resetsInMinutes));
    const note: string[] = [];
    if (resets) note.push("resets in " + resets);
    const runsOut = num(pace?.runsOutInMinutes);
    if (pace?.lastsToReset === false && runsOut !== null) note.push("runs out in " + dur(runsOut));
    if (num(w.countLeft) !== null && num(w.countTotal) !== null) note.push(w.countLeft + " of " + w.countTotal + " left");
    const label = str(w.label) ?? str(w.type) ?? "Window";
    box.appendChild(h("div", { cls: "win" }, h("span", { cls: "t2 trunc" }, label),
      h("div", {
        cls: "meter", "data-l": lvl, role: "meter", "aria-valuemin": "0", "aria-valuemax": "100",
        "aria-valuenow": left === null ? "" : String(left), "aria-label": label + " left",
      }, h("span", { style: "width:" + (left === null ? 0 : Math.max(0, Math.min(100, left))) + "%" })),
      h("span", { cls: "num small", style: lvl ? "color:var(--" + lvl + ")" : "" }, left === null ? "—" : Math.round(left) + "% left"),
      note.length ? h("span", { cls: "r", style: pace?.lastsToReset === false ? "color:var(--warn)" : null }, note.join(" · ")) : null));
  }
  return box;
}
/** Why a computer does not serve, in a tag's few words (RemoteMcpNotServingReason). */
const NOT_SERVING_TAGS: Record<string, string> = {
  off_for_account: "off", left_out: "left out", signed_out: "signed out", relay_disconnected: "relay down",
  account_vault_unreachable: "vault can't sync", waiting_for_account_secret: "setting up", older_ade: "update ADE", offline: "offline",
};
/** `machines_list`: `{ machines: MachineRow[] }`, with no project. */
export function viewMachines(sc: Json): HTMLElement {
  const machines = rows<MachineRow>(sc.machines);
  const items = machines.map((m) => {
    const online = m.online === true;
    const status = m.online === null ? "Online unknown" : online ? "Online" : "Offline";
    return h("div", { cls: "row", role: "listitem" }, h("span", { cls: "dot", "data-s": online ? "ok" : "", title: status }),
      h("span", { cls: "grow", style: "display:flex;flex-direction:column;min-width:0" },
        h("span", { cls: "trunc", style: "font-weight:500" }, str(m.name) || str(m.key) || "Computer"),
        h("span", { cls: "small dim trunc" }, status)),
      m.isThisMachine === true ? h("span", { cls: "tag", "data-t": "accent" }, "this computer") : null,
      m.supported === false ? h("span", { cls: "tag", "data-t": "warn" }, "update ADE")
        : m.included === false ? h("span", { cls: "tag", "data-t": "warn" }, "left out")
        : m.serving === true ? h("span", { cls: "tag", "data-t": "ok" }, "serving")
        : m.serving === null ? h("span", { cls: "tag" }, "serving unknown")
        : h("span", { cls: "tag", "data-t": "warn" }, NOT_SERVING_TAGS[str(m.notServingReason) ?? ""] ?? "not serving"));
  });
  return frame(NO_SCOPE, "Computers", machines.length, listBody(items, 20, "No computers on this account."));
}
