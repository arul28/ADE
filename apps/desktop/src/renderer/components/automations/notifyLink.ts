import { describeTarget, parseDeeplink } from "../../../shared/deeplinks";
import { normalizeCustomNotificationLink } from "../../../shared/customNotificationLink";
import { isWorkBoardColumn, WORK_BOARD_COLUMN_LABEL, type WorkBoardColumn } from "../../../shared/types/chat";

/**
 * The "When tapped, open" choice of the Send notification step, as fields a
 * person fills in, and the `ade://` link those fields make.
 *
 * Every ADE place a link can name is here. The phone opens a chat, a pull
 * request, Activity or a Linear issue itself; a lane, file, commit, branch or
 * proof link shows the phone's "Send to your computer" card. Field values may
 * be `{{trigger.*}}` variables, which stay raw in the link and are filled in
 * when the automation runs.
 */
export type NotifyLinkKind =
  | "none"
  | "activity"
  | "chat"
  | "pr"
  | "linear"
  | "lane"
  | "file"
  | "commit"
  | "branch"
  | "proof"
  | "custom";

export type NotifyLinkFields = {
  column?: WorkBoardColumn | "";
  sessionId?: string;
  prNumber?: string;
  /** "owner/name". Optional for a pull request. */
  repo?: string;
  linearIssue?: string;
  laneId?: string;
  path?: string;
  line?: string;
  sha?: string;
  branch?: string;
  artifactId?: string;
  custom?: string;
};

export type NotifyLink = { kind: NotifyLinkKind; fields: NotifyLinkFields };

const VARIABLE_RE = /\{\{[^}]*\}\}/g;

export function hasVariable(value: string): boolean {
  return /\{\{[^}]*\}\}/.test(value);
}

/** Encodes a value for a link, leaving `{{…}}` variables as written. */
function encodePart(value: string): string {
  const trimmed = value.trim();
  let out = "";
  let last = 0;
  for (const match of trimmed.matchAll(VARIABLE_RE)) {
    out += encodeURIComponent(trimmed.slice(last, match.index));
    out += match[0];
    last = (match.index ?? 0) + match[0].length;
  }
  return out + encodeURIComponent(trimmed.slice(last));
}

/** Like `encodePart`, but keeps `/` between segments (paths, branches). */
function encodePath(value: string): string {
  return value.trim().split("/").map(encodePart).join("/");
}

function decodePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function withQuery(base: string, params: Array<[string, string | undefined]>): string {
  const query = params
    .filter((entry): entry is [string, string] => Boolean(entry[1]?.trim()))
    .map(([key, value]) => `${key}=${encodePart(value)}`)
    .join("&");
  return query ? `${base}?${query}` : base;
}

/** The link the fields make, or "" when the choice is "Just open ADE". */
export function buildNotifyLink({ kind, fields }: NotifyLink): string {
  const f = fields;
  switch (kind) {
    case "none":
      return "";
    case "activity":
      return withQuery("ade://activity", [["state", f.column || undefined]]);
    case "chat":
      return f.sessionId?.trim() ? `ade://session/${encodePart(f.sessionId)}` : "";
    case "pr": {
      const number = f.prNumber?.trim().replace(/^#/, "") ?? "";
      if (!number) return "";
      const [owner, name] = (f.repo ?? "").trim().split("/");
      return owner && name
        ? `ade://pr/${encodePart(owner)}/${encodePart(name)}/${encodePart(number)}`
        : `ade://pr/${encodePart(number)}`;
    }
    case "linear":
      return f.linearIssue?.trim() ? `ade://linear-issue/${encodePart(f.linearIssue.toUpperCase())}` : "";
    case "lane":
      return f.laneId?.trim() ? `ade://lane/${encodePart(f.laneId)}` : "";
    case "file":
      return f.path?.trim()
        ? withQuery(`ade://file/${encodePath(f.path.replace(/^\/+/, ""))}`, [["line", f.line], ["lane", f.laneId]])
        : "";
    case "commit":
      return f.sha?.trim() ? withQuery(`ade://commit/${encodePart(f.sha)}`, [["lane", f.laneId]]) : "";
    case "branch": {
      const [owner, name] = (f.repo ?? "").trim().split("/");
      return owner && name && f.branch?.trim()
        ? `ade://repo/${encodePart(owner)}/${encodePart(name)}/branch/${encodePath(f.branch)}`
        : "";
    }
    case "proof":
      return f.artifactId?.trim() ? `ade://artifact/${encodePart(f.artifactId)}` : "";
    case "custom":
      return f.custom?.trim() ?? "";
  }
}

/**
 * Reads a stored link back into the choice and fields that make it, so a
 * saved step opens on the right choice. A link this builder would not have
 * written opens as "Paste a link", unchanged.
 */
export function readNotifyLink(raw: string | null | undefined): NotifyLink {
  const link = raw?.trim() ?? "";
  if (!link) return { kind: "none", fields: {} };
  const read = (): NotifyLink | null => {
    const match = /^ade:\/\/([a-z-]+)(\/[^?]*)?(?:\?(.*))?$/i.exec(link);
    if (!match) return null;
    const host = match[1]!.toLowerCase();
    const segments = (match[2] ?? "").split("/").filter(Boolean).map(decodePart);
    const query = new Map<string, string>();
    for (const pair of (match[3] ?? "").split("&").filter(Boolean)) {
      const at = pair.indexOf("=");
      query.set(decodePart(at < 0 ? pair : pair.slice(0, at)), decodePart(at < 0 ? "" : pair.slice(at + 1)));
    }
    const only = (...keys: string[]) => [...query.keys()].every((key) => keys.includes(key));
    switch (host) {
      case "activity": {
        const state = query.get("state") ?? "";
        if (segments.length || !only("state") || (state && !isWorkBoardColumn(state))) return null;
        return { kind: "activity", fields: { column: (state || "") as WorkBoardColumn | "" } };
      }
      case "session":
        return segments.length === 1 && only() ? { kind: "chat", fields: { sessionId: segments[0] } } : null;
      case "pr":
        if (!only()) return null;
        if (segments.length === 1) return { kind: "pr", fields: { prNumber: segments[0] } };
        if (segments.length === 3) {
          return { kind: "pr", fields: { repo: `${segments[0]}/${segments[1]}`, prNumber: segments[2] } };
        }
        return null;
      case "linear-issue":
        return segments.length === 1 && only() ? { kind: "linear", fields: { linearIssue: segments[0] } } : null;
      case "lane":
        return segments.length === 1 && only() ? { kind: "lane", fields: { laneId: segments[0] } } : null;
      case "file":
        return segments.length && only("line", "lane")
          ? { kind: "file", fields: { path: segments.join("/"), line: query.get("line"), laneId: query.get("lane") } }
          : null;
      case "commit":
        return segments.length === 1 && only("lane")
          ? { kind: "commit", fields: { sha: segments[0], laneId: query.get("lane") } }
          : null;
      case "repo":
        return segments.length >= 4 && segments[2] === "branch" && only()
          ? { kind: "branch", fields: { repo: `${segments[0]}/${segments[1]}`, branch: segments.slice(3).join("/") } }
          : null;
      case "artifact":
        return segments.length === 1 && only() ? { kind: "proof", fields: { artifactId: segments[0] } } : null;
      default:
        return null;
    }
  };
  return read() ?? { kind: "custom", fields: { custom: link } };
}

/** What a tap does on the phone, said plainly. */
export const NOTIFY_LINK_PHONE_EFFECT: Record<NotifyLinkKind, string> = {
  none: "Opens the ADE app.",
  activity: "Opens Activity on the phone.",
  chat: "Opens the chat on the phone, on the machine it runs on.",
  pr: "Opens the pull request on the phone.",
  linear: "Opens the Linear issue on the phone.",
  lane: "The phone can't show a lane. It offers to open it on your computer.",
  file: "The phone can't show a file. It offers to open it on your computer.",
  commit: "The phone can't show a commit. It offers to open it on your computer.",
  branch: "The phone can't show a branch. It offers to open it on your computer.",
  proof: "The phone can't show proof. It offers to open it on your computer.",
  custom: "Opens the link you pasted.",
};

/** A stand-in for each variable, so a link with variables can be checked now. */
function sampleFor(variable: string): string {
  const name = variable.replace(/[{}\s]/g, "");
  if (/number$/i.test(name)) return "1";
  if (/lane\.id$|laneId$/i.test(name)) return "00000000-0000-4000-8000-000000000000";
  if (/branch$/i.test(name)) return "main";
  if (/repo$/i.test(name)) return "owner/repo";
  if (/sha$/i.test(name)) return "abcdef1";
  return "sample";
}

export type NotifyLinkCheck =
  | { state: "empty" }
  | { state: "ok"; link: string; opens: string; checkedWithSamples: boolean }
  | { state: "problem"; problem: string };

/**
 * Whether ADE can open the link. Variables are swapped for sample values first,
 * so the check covers the link's shape; the real values arrive at run time.
 */
export function checkNotifyLink(link: string): NotifyLinkCheck {
  const trimmed = link.trim();
  if (!trimmed) return { state: "empty" };
  const withVariables = hasVariable(trimmed);
  const sample = trimmed.replace(VARIABLE_RE, (variable) => encodeURIComponent(sampleFor(variable)));
  const result = normalizeCustomNotificationLink(sample);
  if (!result.ok) return { state: "problem", problem: result.problem };
  const parsed = parseDeeplink(result.link);
  const activity = /^ade:\/\/activity/i.test(result.link);
  const column = /[?&]state=([a-z_]+)/i.exec(result.link)?.[1];
  const shortPr = /^ade:\/\/pr\/(\d+)/i.exec(result.link)?.[1];
  const opens = parsed.ok
    ? describeTarget(parsed.target)
    : shortPr
      ? `pull request #${shortPr}`
      : activity
      ? column && isWorkBoardColumn(column)
        ? `Activity · ${WORK_BOARD_COLUMN_LABEL[column]}`
        : "Activity"
      : "ADE";
  return { state: "ok", link: trimmed, opens, checkedWithSamples: withVariables };
}
