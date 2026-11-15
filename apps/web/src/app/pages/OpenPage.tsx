import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  AppWindow,
  ChevronRight,
  CircleDot,
  Download,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Globe,
  Image as ImageIcon,
  Link2Off,
  MessageSquare,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";

import { Page } from "../../components/Page";
import { cn } from "../../lib/cn";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { MARKETING_FEATURES } from "../../lib/marketingAnalytics";

type OpenTarget =
  | { kind: "lane"; laneId: string; envelope?: OpenEnvelope; ownership?: OpenOwnership }
  | {
      kind: "session";
      sessionId: string;
      laneId?: string;
      event?: number;
      offset?: number;
      envelope?: OpenEnvelope;
      ownership?: OpenOwnership;
    }
  | { kind: "file"; path: string; line?: number; laneId?: string }
  | { kind: "commit"; sha: string; laneId?: string; envelope?: OpenEnvelope }
  | { kind: "artifact"; artifactId: string; envelope?: OpenEnvelope }
  | { kind: "branch"; repo: string; branch: string; pr?: number }
  | { kind: "pr"; repo?: string; number: number; tab?: string; ownership?: OpenOwnership }
  | { kind: "linear-issue"; issueIdentifier: string; branch?: string }
  | { kind: "settings"; entryId: string; machineId?: string }
  | { kind: "lane-share"; grantId: string }
  | { kind: "unknown" };

/** The computer and project a link belongs to (`shared/deeplinks.ts` DeeplinkOwnership). */
type OpenOwnership = { accountMachineKey: string; projectId: string; projectRoot?: string };

type OpenEnvelope = {
  repo?: string;
  branch?: string;
  pr?: number;
  linear?: string;
};

const CANONICAL_OPEN_ORIGIN = "https://ade-app.dev";

// The desktop parser's shapes (`shared/deeplinks.ts`): ADE refuses anything else.
const SETTINGS_ENTRY_ID_RE = /^[a-z0-9][a-z0-9.-]{0,95}$/;
// A lane share invite names its grant only; the account directory decides who may see it.
const LANE_SHARE_GRANT_ID_RE = /^ls_[0-9a-f]{32}$/;
const MACHINE_ID_BAD_RE = /[\x00-\x1f\x7f]/;

function positiveInteger(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw ?? "");
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw ?? "");
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readEnvelope(params: URLSearchParams): OpenEnvelope | undefined {
  const envelope: OpenEnvelope = {};
  const repo = params.get("repo") ?? "";
  if (repo.includes("/")) envelope.repo = repo;
  const branch = params.get("branch") ?? "";
  if (branch) envelope.branch = branch;
  const pr = positiveInteger(params.get("pr"));
  if (pr) envelope.pr = pr;
  const linear = params.get("linear") ?? "";
  if (linear) envelope.linear = linear;
  return Object.keys(envelope).length > 0 ? envelope : undefined;
}

/**
 * Both or neither, with the desktop parser's limits. `null` is a link that
 * names an owner badly (one half, too long): ADE refuses those, so the page
 * calls the link broken instead of opening it without its owner.
 */
function readOwnership(params: URLSearchParams): OpenOwnership | undefined | null {
  const named = params.has("accountMachineKey") || params.has("projectId");
  const accountMachineKey = (params.get("accountMachineKey") ?? "").trim();
  const projectId = (params.get("projectId") ?? "").trim();
  if (!accountMachineKey || !projectId) return named ? null : undefined;
  if (accountMachineKey.length > 128 || projectId.length > 512) return null;
  if (MACHINE_ID_BAD_RE.test(accountMachineKey) || MACHINE_ID_BAD_RE.test(projectId)) return null;
  // Older links carry the publisher's private project id with its root path,
  // which is what lets ADE find that project. No link minted today has it.
  const projectRoot = (params.get("projectRoot") ?? "").trim();
  return projectRoot && projectRoot.length <= 4_096
    ? { accountMachineKey, projectId, projectRoot }
    : { accountMachineKey, projectId };
}

function parseQuery(search: string): OpenTarget {
  const params = new URLSearchParams(search);
  const type = (params.get("type") ?? "").toLowerCase();
  const read = readOwnership(params);
  if (read === null && (type === "lane" || type === "session" || type === "pr")) return { kind: "unknown" };
  const ownership = read ?? undefined;
  if (type === "lane") {
    const laneId = params.get("id") ?? "";
    if (laneId) return { kind: "lane", laneId, envelope: readEnvelope(params), ownership };
  }
  if (type === "session") {
    const sessionId = params.get("id") ?? "";
    if (sessionId) {
      const laneId = params.get("lane") ?? "";
      const event = nonNegativeInteger(params.get("event"));
      const offset = nonNegativeInteger(params.get("offset"));
      return {
        kind: "session",
        sessionId,
        ...(laneId ? { laneId } : {}),
        ...(event != null ? { event } : {}),
        ...(offset != null ? { offset } : {}),
        envelope: readEnvelope(params),
        ownership,
      };
    }
  }
  if (type === "file") {
    const path = params.get("path") ?? "";
    if (path) {
      const line = positiveInteger(params.get("line"));
      const laneId = params.get("lane") ?? "";
      return { kind: "file", path, ...(line ? { line } : {}), ...(laneId ? { laneId } : {}) };
    }
  }
  if (type === "commit") {
    const sha = params.get("sha") ?? "";
    if (sha) {
      const laneId = params.get("lane") ?? "";
      return { kind: "commit", sha, ...(laneId ? { laneId } : {}), envelope: readEnvelope(params) };
    }
  }
  if (type === "artifact") {
    const artifactId = params.get("id") ?? "";
    if (artifactId) return { kind: "artifact", artifactId, envelope: readEnvelope(params) };
  }
  if (type === "branch") {
    const repo = params.get("repo") ?? "";
    const branch = params.get("branch") ?? "";
    if (repo && branch) {
      const pr = positiveInteger(params.get("pr"));
      return pr
        ? { kind: "branch", repo, branch, pr }
        : { kind: "branch", repo, branch };
    }
  }
  if (type === "pr") {
    const repo = params.get("repo") ?? "";
    const number = positiveInteger(params.get("number"));
    const tab = (params.get("tab") ?? "").trim();
    if (number && (repo.includes("/") || ownership)) {
      return {
        kind: "pr",
        ...(repo.includes("/") ? { repo } : {}),
        number,
        ...(tab ? { tab } : {}),
        ...(ownership ? { ownership } : {}),
      };
    }
  }
  if (type === "linear-issue") {
    const issueIdentifier = params.get("issue") ?? "";
    const branch = params.get("branch") ?? "";
    if (issueIdentifier) {
      return branch
        ? { kind: "linear-issue", issueIdentifier, branch }
        : { kind: "linear-issue", issueIdentifier };
    }
  }
  if (type === "lane-share") {
    const grantId = (params.get("id") ?? "").trim();
    if (LANE_SHARE_GRANT_ID_RE.test(grantId)) return { kind: "lane-share", grantId };
  }
  if (type === "settings") {
    const entryId = (params.get("id") ?? "").toLowerCase();
    if (SETTINGS_ENTRY_ID_RE.test(entryId)) {
      const machineId = (params.get("machine") ?? "").trim();
      return machineId && machineId.length <= 512 && !MACHINE_ID_BAD_RE.test(machineId)
        ? { kind: "settings", entryId, machineId }
        : { kind: "settings", entryId };
    }
  }
  return { kind: "unknown" };
}

function buildAdeUrl(target: OpenTarget): string | null {
  switch (target.kind) {
    case "lane": {
      const base = `ade://lane/${encodeURIComponent(target.laneId)}`;
      return appendQuery(base, [...envelopeEntries(target.envelope), ...ownershipEntries(target.ownership)]);
    }
    case "session": {
      const base = `ade://session/${encodeURIComponent(target.sessionId)}`;
      return appendQuery(base, [
        ["lane", target.laneId],
        ["event", target.event],
        ["offset", target.offset],
        ...envelopeEntries(target.envelope),
        ...ownershipEntries(target.ownership),
      ]);
    }
    case "file": {
      const base = `ade://file/${encodePath(target.path)}`;
      return appendQuery(base, [
        ["line", target.line],
        ["lane", target.laneId],
      ]);
    }
    case "commit": {
      const base = `ade://commit/${encodeURIComponent(target.sha)}`;
      return appendQuery(base, [
        ["lane", target.laneId],
        ...envelopeEntries(target.envelope),
      ]);
    }
    case "artifact": {
      const base = `ade://artifact/${encodeURIComponent(target.artifactId)}`;
      return appendQuery(base, envelopeEntries(target.envelope));
    }
    case "branch": {
      const [owner, name] = target.repo.split("/");
      if (!owner || !name) return null;
      const base = `ade://repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branch/${encodePath(target.branch)}`;
      return appendQuery(base, [["pr", target.pr]]);
    }
    case "pr": {
      const [owner, name] = (target.repo ?? "").split("/");
      const base = owner && name
        ? `ade://pr/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${target.number}`
        : `ade://pr/${target.number}`;
      return appendQuery(base, [["tab", target.tab], ...ownershipEntries(target.ownership)]);
    }
    case "linear-issue": {
      const base = `ade://linear-issue/${encodeURIComponent(target.issueIdentifier)}`;
      return target.branch ? `${base}?branch=${encodeURIComponent(target.branch)}` : base;
    }
    case "settings":
      return appendQuery(`ade://settings/${encodeURIComponent(target.entryId)}`, [["machine", target.machineId]]);
    case "lane-share":
      return `ade://lane-share/${encodeURIComponent(target.grantId)}`;
    case "unknown":
      return null;
  }
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function envelopeEntries(envelope: OpenEnvelope | undefined): Array<[string, string | number | undefined]> {
  if (!envelope) return [];
  return [
    ["repo", envelope.repo],
    ["branch", envelope.branch],
    ["pr", envelope.pr],
    ["linear", envelope.linear],
  ];
}

function ownershipEntries(ownership: OpenOwnership | undefined): Array<[string, string | undefined]> {
  return ownership
    ? [
        ["accountMachineKey", ownership.accountMachineKey],
        ["projectId", ownership.projectId],
        ["projectRoot", ownership.projectRoot],
      ]
    : [];
}

function appendQuery(base: string, entries: Array<[string, string | number | undefined]>): string {
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value == null || value === "") continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

function describeTarget(target: OpenTarget): { title: string; summary: string; valueLabel?: string; value?: string } {
  switch (target.kind) {
    case "lane":
      return {
        title: "Open lane in ADE",
        summary: `Lane ${target.laneId.slice(0, 8)}…`,
      };
    case "session":
      return {
        title: "Open chat in ADE",
        summary: `Chat ${target.sessionId.slice(0, 8)}…`,
      };
    case "file":
      return {
        title: "Open file in ADE",
        summary: target.line ? `Line ${target.line}` : "Repository file",
        valueLabel: "File",
        value: target.path,
      };
    case "commit":
      return {
        title: "Open commit in ADE",
        summary: "Git commit",
        valueLabel: "Commit",
        value: target.sha,
      };
    case "artifact":
      return {
        title: "Open artifact in ADE",
        summary: "Proof artifact",
        valueLabel: "Artifact",
        value: target.artifactId,
      };
    case "branch":
      return {
        title: `Open ${target.repo} in ADE`,
        summary: `Branch ${target.branch}${target.pr ? ` · PR #${target.pr}` : ""}`,
      };
    case "pr":
      return {
        title: target.repo ? `Open ${target.repo}#${target.number} in ADE` : `Open PR #${target.number} in ADE`,
        summary: `Pull request #${target.number}`,
      };
    case "linear-issue":
      return {
        title: `Open ${target.issueIdentifier} in ADE`,
        summary: target.branch ? `Branch ${target.branch}` : "Linear issue",
      };
    case "settings":
      return {
        title: "Open a setting in ADE",
        summary: "Opens this setting in ADE's Settings.",
        valueLabel: "Setting",
        value: target.entryId,
      };
    case "lane-share":
      return {
        title: "Open a shared lane in ADE",
        summary: "Someone shared a lane with you. Sign in to ADE with the email the invite went to, then accept it.",
      };
    case "unknown":
      return {
        title: "This ADE link is broken",
        summary: "It is missing what it should open.",
      };
  }
}

function setOgTag(property: string, content: string): void {
  if (typeof document === "undefined") return;
  let el = document.querySelector(`meta[property="${property}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("property", property);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

/** Where the person chose to open ADE links, remembered on this browser. */
type OpenPreference = "app" | "app-beta" | "web";
const OPEN_PREFERENCE_KEY = "ade.openLinksIn";
/**
 * ADE Web's origin: its sign-in and keys live there. A dev build may point at
 * a local web client to check the link page against it.
 */
const WEB_CLIENT_ORIGIN = (import.meta.env.DEV
  ? (import.meta.env.VITE_ADE_WEB_CLIENT_ORIGIN as string | undefined)?.trim().replace(/\/+$/, "")
  : undefined) || "https://app.ade-app.dev";
/** The web client: same query, its own origin. */
const WEB_CLIENT_OPEN_URL = `${WEB_CLIENT_ORIGIN}/open`;
/** ADE Web's status frame (webclient/linkStatus in the desktop package). */
const LINK_STATUS_URL = `${WEB_CLIENT_ORIGIN}/link-status`;
/** How long the page waits for that frame before it stops asking. */
const LINK_STATUS_WAIT_MS = 4_000;
/** How long a remembered "app" waits before offering the browser instead. */
const APP_FALLBACK_MS = 2_500;
/**
 * A remembered choice opens after this pause, with "Change" and "Open now" in
 * view. Long enough to read the line and press Change; "Open now" skips it.
 * The old 0.8 s read as a flash with no chance to choose.
 */
const AUTO_OPEN_MS = 1_500;
/** `?choose=1` shows the choices even when one is remembered. */
const CHOOSE_PARAM = "choose";

/**
 * After trying the app: still waiting, the page went to the background (the
 * app or the browser's "open ADE?" prompt took over), or nothing happened.
 */
type AppAttempt = "idle" | "trying" | "handedOff" | "noResponse";

/** What ADE Web on this browser knows: signed in, and which computers are online (null: unknown). */
type LinkStatus = { signedIn: boolean; onlineComputers: string[] | null };

function statusLine(attempt: AppAttempt): string {
  switch (attempt) {
    case "noResponse":
      return "ADE didn't open? Open it in ADE Web instead, or install the app.";
    case "handedOff":
      return "Opened in the ADE app. Didn't work? Open it in ADE Web instead.";
    case "trying":
      return "Opening the ADE app…";
    case "idle":
      return "Open it in";
  }
}

function autoOpenLine(preference: OpenPreference): string {
  if (preference === "web") return "Opening in ADE Web…";
  if (preference === "app-beta") return "Opening in ADE Beta…";
  return "Opening in the ADE app…";
}

/** "Studio is online.", "Studio and 2 more are online." */
function onlineComputersLine(names: string[]): string {
  const [first] = names;
  if (!first) return "None of your computers is online right now.";
  return names.length === 1 ? `${first} is online.` : `${first} and ${names.length - 1} more are online.`;
}

/** The frame's message, checked field by field: it crosses origins. */
function readLinkStatus(data: unknown): LinkStatus | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record.type !== "ade-link-status" || record.version !== 1 || typeof record.signedIn !== "boolean") return null;
  const raw = record.onlineComputers;
  const onlineComputers = Array.isArray(raw)
    ? raw.filter((name): name is string => typeof name === "string" && name.trim().length > 0)
      .slice(0, 50)
      .map((name) => name.trim().slice(0, 80))
    : null;
  return { signedIn: record.signedIn, onlineComputers: record.signedIn ? onlineComputers : null };
}

/** iPhone and iPad, including an iPad that reports itself as a Mac. */
function isAppleMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function readOpenPreference(): OpenPreference | null {
  try {
    const value = window.localStorage.getItem(OPEN_PREFERENCE_KEY);
    return value === "app" || value === "app-beta" || value === "web" ? value : null;
  } catch {
    return null;
  }
}

function writeOpenPreference(value: OpenPreference | null): void {
  try {
    if (value) window.localStorage.setItem(OPEN_PREFERENCE_KEY, value);
    else window.localStorage.removeItem(OPEN_PREFERENCE_KEY);
  } catch {
    // Private mode: the choice holds for this visit only.
  }
}

/** The page's own query without the page-only `choose` flag. */
function linkQuery(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(CHOOSE_PARAM);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** The web client opens every kind of ADE link, so any link that parsed can go there. */
function webClientUrlFor(target: OpenTarget, search: string): string | null {
  if (target.kind === "unknown") return null;
  return `${WEB_CLIENT_OPEN_URL}${linkQuery(search)}`;
}

/**
 * Asks ADE Web's status frame whether this browser is signed in there and
 * which computers are online. Null until it answers, and for good when it
 * does not answer in time (signed out of a blocked frame, an old deploy).
 */
function useLinkStatus(enabled: boolean): { status: LinkStatus | null; frame: ReactNode } {
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [waiting, setWaiting] = useState(enabled);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    if (!enabled) return;
    setWaiting(true);
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== WEB_CLIENT_ORIGIN || event.source !== frameRef.current?.contentWindow) return;
      const next = readLinkStatus(event.data);
      if (!next) return;
      setStatus(next);
      setWaiting(false);
    };
    window.addEventListener("message", onMessage);
    const giveUp = setTimeout(() => setWaiting(false), LINK_STATUS_WAIT_MS);
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(giveUp);
    };
  }, [enabled]);
  const frame = enabled && waiting ? (
    <iframe ref={frameRef} src={LINK_STATUS_URL} title="ADE Web status" aria-hidden tabIndex={-1} hidden />
  ) : null;
  return { status, frame };
}

export function OpenPage() {
  const location = useLocation();
  const target = useMemo(() => parseQuery(location.search), [location.search]);
  const adeUrl = useMemo(() => buildAdeUrl(target), [target]);
  // The whole query goes on unchanged, so nothing the link carries is lost.
  const webUrl = useMemo(() => webClientUrlFor(target, location.search), [target, location.search]);
  const { title, summary, valueLabel, value } = describeTarget(target);
  const forceChoice = useMemo(() => new URLSearchParams(location.search).get(CHOOSE_PARAM) === "1", [location.search]);
  const [preference, setPreference] = useState<OpenPreference | null>(() => readOpenPreference());
  // Only a choice remembered from an earlier visit opens on its own, after a
  // pause with Change in view. A choice made on this page has already opened.
  const [autoOpen, setAutoOpen] = useState<OpenPreference | null>(() => (forceChoice ? null : preference));
  const [remember, setRemember] = useState(true);
  const [appAttempt, setAppAttempt] = useState<AppAttempt>("idle");
  const [attemptCount, setAttemptCount] = useState(0);
  // The ADE Beta iPhone app registers `ade-beta://` instead of `ade://`.
  const betaUrl = useMemo(() => (adeUrl ? adeUrl.replace(/^ade:/, "ade-beta:") : null), [adeUrl]);
  const offerBeta = useMemo(() => isAppleMobile(), []);
  const autoOpenUrl = autoOpen === "web" ? webUrl : autoOpen === "app" ? adeUrl : autoOpen === "app-beta" ? betaUrl : null;
  const counting = autoOpenUrl != null && appAttempt === "idle";
  // The computers matter only while the choices are on screen, and only on a
  // computer: on a phone "the ADE app" is the phone's own app.
  const { status: linkStatus, frame: linkStatusFrame } = useLinkStatus(
    !counting && target.kind !== "unknown" && Boolean(adeUrl) && !offerBeta,
  );

  useDocumentTitle(title);

  // ADE Web is a likely next stop: warm its connection while the page is up.
  useEffect(() => {
    if (!webUrl) return;
    const link = document.createElement("link");
    link.rel = "preconnect";
    link.href = WEB_CLIENT_ORIGIN;
    document.head.appendChild(link);
    return () => link.remove();
  }, [webUrl]);

  // Set dynamic OpenGraph tags so unfurlers that execute JS pick them up.
  // CAVEAT: most chat-app unfurlers (Slack, Discord, iMessage) do NOT execute
  // JS; for full unfurl coverage the apps/web build should be migrated to a
  // static-site pre-render step that bakes per-route OG tags into the served
  // HTML. og:image intentionally omitted until an actual asset exists at
  // /og/open.png.
  useEffect(() => {
    setOgTag("og:title", title);
    setOgTag("og:description", summary);
    setOgTag("og:type", "website");
    setOgTag("og:url", `${CANONICAL_OPEN_ORIGIN}/open${location.search}`);
  }, [title, summary, location.search]);

  const launchApp = (url: string) => {
    setAppAttempt("trying");
    setAttemptCount((count) => count + 1);
    window.location.href = url;
  };

  // A click decides this visit: it cancels a remembered choice still pending,
  // so the page never opens two places. With "Remember" on it becomes the
  // choice; with it off, the page forgets any earlier one.
  const choose = (value: OpenPreference) => {
    setAutoOpen(null);
    const next = remember ? value : null;
    writeOpenPreference(next);
    setPreference(next);
  };

  const openInApp = (value: "app" | "app-beta") => {
    const url = value === "app-beta" ? betaUrl : adeUrl;
    if (!url) return;
    choose(value);
    launchApp(url);
  };

  const openInBrowser = () => {
    if (!webUrl) return;
    choose("web");
    window.location.assign(webUrl);
  };

  const openRemembered = (choice: OpenPreference, url: string) => {
    setAutoOpen(null);
    if (choice === "web") window.location.replace(url);
    else launchApp(url);
  };

  /** Stop the automatic open and show every choice. */
  const changeChoice = () => {
    setAutoOpen(null);
    setAppAttempt("idle");
  };

  // A remembered choice opens on its own after the pause. Without one nothing
  // launches until the person picks: a page can't tell whether an app took an
  // ade:// link (some browsers ask, some do nothing at all), so guessing would
  // strand them. Escape stops it, like Change.
  useEffect(() => {
    if (!counting || !autoOpen || !autoOpenUrl) return;
    const timer = setTimeout(() => openRemembered(autoOpen, autoOpenUrl), AUTO_OPEN_MS);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") changeChoice();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [counting, autoOpen, autoOpenUrl]);

  // Still here a while after trying the app: offer the browser and the
  // installer. A page that went to the background meanwhile handed off.
  useEffect(() => {
    if (attemptCount === 0) return;
    const handedOff = () => setAppAttempt("handedOff");
    const onVisibility = () => {
      if (document.visibilityState === "hidden") handedOff();
    };
    window.addEventListener("blur", handedOff);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = setTimeout(
      () => setAppAttempt((attempt) => (attempt === "trying" ? "noResponse" : attempt)),
      APP_FALLBACK_MS,
    );
    return () => {
      clearTimeout(timer);
      window.removeEventListener("blur", handedOff);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [attemptCount]);
  const appFailed = appAttempt === "noResponse";

  // Facts first: once the app did not answer, ADE Web is the way on. Signed in
  // to ADE Web here, an online computer puts the app first and none puts ADE
  // Web first. Otherwise the app leads, as it is fastest when installed.
  const onlineComputers = linkStatus?.signedIn ? linkStatus.onlineComputers : null;
  const browserLeads = appFailed || !adeUrl || (onlineComputers != null && onlineComputers.length === 0);
  const appHint = onlineComputers
    ? onlineComputersLine(onlineComputers)
    : "On this device. Fastest when ADE is installed.";
  const KindIcon = KIND_ICONS[target.kind];

  const appChoice = adeUrl ? (
    <OpenChoice
      key="app"
      icon={<AppWindow className={CHOICE_ICON} />}
      title="The ADE app"
      hint={appHint}
      lead={!browserLeads}
      analyticsFeature={MARKETING_FEATURES.OPEN_IN_DESKTOP}
      onClick={() => openInApp("app")}
    />
  ) : null;
  const webChoice = webUrl ? (
    <OpenChoice
      key="web"
      icon={<Globe className={CHOICE_ICON} />}
      title="ADE Web"
      hint="In this browser. Nothing to install."
      lead={browserLeads}
      analyticsFeature={MARKETING_FEATURES.OPEN_WEB_CLIENT}
      onClick={openInBrowser}
    />
  ) : null;
  const betaChoice = betaUrl && offerBeta ? (
    <OpenChoice
      key="beta"
      icon={<AppWindow className={CHOICE_ICON} />}
      title="ADE Beta"
      hint="The TestFlight app on this iPhone or iPad."
      lead={false}
      analyticsFeature={MARKETING_FEATURES.OPEN_IN_DESKTOP}
      onClick={() => openInApp("app-beta")}
    />
  ) : null;
  const choices = browserLeads ? [webChoice, appChoice, betaChoice] : [appChoice, betaChoice, webChoice];

  return (
    <Page className="relative grid min-h-screen place-items-center overflow-hidden px-5 py-24 sm:px-6">
      <Link to="/" className="focus-ring absolute left-6 top-6 rounded-md sm:left-7" aria-label="ADE home">
        <img src="/logo.png" alt="ADE" className="h-9 w-auto" draggable={false} />
      </Link>
      {/* The same soft accent glow the ADE app puts behind its start screens. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[42%] h-[60vw] max-h-[720px] w-[60vw] max-w-[720px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent opacity-[0.12] blur-[140px]"
      />

      <div className="relative grid w-full max-w-[520px] gap-6">
        <div className="flex items-start gap-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-border/80 bg-card/70 text-fg">
            <KindIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-balance text-[28px] font-bold leading-tight tracking-[-0.02em] text-fg">{title}</h1>
            <p className="mt-1 text-[15px] leading-relaxed text-muted-fg">{summary}</p>
            {value ? (
              <p className="mt-1 break-all font-mono text-[13px] text-fg/80">
                {valueLabel ? <span className="font-sans text-muted-fg">{valueLabel}: </span> : null}
                {value}
              </p>
            ) : null}
          </div>
        </div>

        {target.kind === "unknown" ? (
          <div className="rounded-2xl border border-border/80 bg-card/60 p-5 text-sm leading-relaxed text-fg backdrop-blur-xl">
            Ask for a fresh link, or{" "}
            <a
              className="focus-ring rounded-sm font-medium underline underline-offset-4"
              href={`${WEB_CLIENT_ORIGIN}/`}
            >
              open ADE Web
            </a>
            .
          </div>
        ) : null}

        {counting && autoOpen && autoOpenUrl ? (
          <div className="overflow-hidden rounded-2xl border border-border/80 bg-card/60 shadow-glass-md backdrop-blur-xl">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
              <p className="min-w-0 flex-1 text-sm font-semibold text-fg" role="status" aria-live="polite">
                {autoOpenLine(autoOpen)}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={changeChoice}
                  className="focus-ring rounded-lg px-3 py-1.5 text-[13px] font-medium text-fg transition-colors hover:bg-fg/[0.07]"
                >
                  Change
                </button>
                <button
                  type="button"
                  onClick={() => openRemembered(autoOpen, autoOpenUrl)}
                  className="focus-ring rounded-lg bg-accent px-3 py-1.5 text-[13px] font-semibold text-accent-fg transition-opacity hover:opacity-90"
                >
                  Open now
                </button>
              </div>
            </div>
            {/* How long until it opens: a bar that fills over the pause. */}
            <div aria-hidden className="h-[3px] bg-fg/[0.06] motion-reduce:hidden">
              <div
                className="h-full origin-left bg-accent/70"
                style={{ animation: `ade-open-countdown ${AUTO_OPEN_MS}ms linear forwards` }}
              />
            </div>
            <style>{"@keyframes ade-open-countdown { from { transform: scaleX(0); } to { transform: scaleX(1); } }"}</style>
          </div>
        ) : adeUrl || webUrl ? (
          <div className="overflow-hidden rounded-2xl border border-border/80 bg-card/60 shadow-glass-md backdrop-blur-xl">
            <p className="px-5 pb-1 pt-4 text-[13px] text-muted-fg" aria-live="polite">
              {statusLine(appAttempt)}
            </p>
            <div className="grid gap-1 p-2">{choices}</div>
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-border/70 px-5 py-3 text-xs text-muted-fg">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-[var(--color-accent)]"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                Remember my choice on this browser
              </label>
              {appFailed || !preference ? (
                <Link
                  to="/"
                  data-ade-analytics-feature={MARKETING_FEATURES.VIEW_DOWNLOAD_PAGE}
                  className="focus-ring inline-flex items-center gap-1 rounded-sm font-medium underline-offset-4 transition-colors hover:text-fg hover:underline"
                >
                  <Download className="h-3.5 w-3.5" /> Get the ADE app
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}
        {linkStatusFrame}
      </div>
    </Page>
  );
}

const KIND_ICONS: Record<OpenTarget["kind"], LucideIcon> = {
  lane: GitBranch,
  session: MessageSquare,
  file: FileText,
  commit: GitCommitHorizontal,
  artifact: ImageIcon,
  branch: GitBranch,
  pr: GitPullRequest,
  "linear-issue": CircleDot,
  "lane-share": Users,
  settings: Settings,
  unknown: Link2Off,
};

const CHOICE_ICON = "h-[18px] w-[18px]";

/** One place a link can open: a full-width row, the suggested one tinted. */
function OpenChoice({
  icon,
  title,
  hint,
  lead,
  analyticsFeature,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  lead: boolean;
  analyticsFeature: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-ade-analytics-feature={analyticsFeature}
      className={cn(
        "focus-ring group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors",
        lead ? "bg-accent/15 hover:bg-accent/25" : "hover:bg-fg/[0.06]",
      )}
    >
      <span
        className={cn(
          "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
          lead ? "bg-accent text-accent-fg" : "bg-fg/[0.07] text-fg",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-fg">{title}</span>
        <span className="block text-[13px] leading-snug text-muted-fg">{hint}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-fg transition-transform group-hover:translate-x-0.5 group-hover:text-fg" />
    </button>
  );
}
