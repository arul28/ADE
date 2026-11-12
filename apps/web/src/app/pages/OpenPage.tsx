import { useEffect, useMemo, useState, type ReactNode } from "react";
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
/** The web client: same query, its own origin (its sign-in and keys live there). */
const WEB_CLIENT_OPEN_URL = "https://app.ade-app.dev/open";
/** How long a remembered "app" waits before offering the browser instead. */
const APP_FALLBACK_MS = 2_500;
/** A remembered "browser" pauses this long, so the choice can still be changed. */
const WEB_REDIRECT_MS = 800;

/**
 * After trying the app: still waiting, the page went to the background (the
 * app or the browser's "open ADE?" prompt took over), or nothing happened.
 */
type AppAttempt = "idle" | "trying" | "handedOff" | "noResponse";

function statusLine(redirectingToWeb: boolean, attempt: AppAttempt): string {
  if (redirectingToWeb && attempt === "idle") return "Opening in your browser…";
  switch (attempt) {
    case "noResponse":
      return "ADE didn't open? Open it in your browser instead, or install the app.";
    case "handedOff":
      return "Opened in the ADE app. Didn't work? Open it in your browser instead.";
    case "trying":
      return "Opening the ADE app…";
    case "idle":
      return "Open it in";
  }
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

/** The web client opens every kind of ADE link, so any link that parsed can go there. */
function webClientUrlFor(target: OpenTarget, search: string): string | null {
  if (target.kind === "unknown") return null;
  return `${WEB_CLIENT_OPEN_URL}${search}`;
}

export function OpenPage() {
  const location = useLocation();
  const target = useMemo(() => parseQuery(location.search), [location.search]);
  const adeUrl = useMemo(() => buildAdeUrl(target), [target]);
  // The whole query goes on unchanged, so nothing the link carries is lost.
  const webUrl = useMemo(() => webClientUrlFor(target, location.search), [target, location.search]);
  const { title, summary, valueLabel, value } = describeTarget(target);
  const [preference, setPreference] = useState<OpenPreference | null>(() => readOpenPreference());
  // Only a choice remembered from an earlier visit opens on its own. A choice
  // made on this page has already opened, and Change cancels a pending one.
  const [autoOpen, setAutoOpen] = useState<OpenPreference | null>(preference);
  const [remember, setRemember] = useState(true);
  const [appAttempt, setAppAttempt] = useState<AppAttempt>("idle");
  const [attemptCount, setAttemptCount] = useState(0);
  // The ADE Beta iPhone app registers `ade-beta://` instead of `ade://`.
  const betaUrl = useMemo(() => (adeUrl ? adeUrl.replace(/^ade:/, "ade-beta:") : null), [adeUrl]);
  const offerBeta = useMemo(() => isAppleMobile(), []);

  useDocumentTitle(title);

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
  // so the page never opens two places.
  const choose = (value: OpenPreference) => {
    setAutoOpen(null);
    if (preference || !remember) return;
    writeOpenPreference(value);
    setPreference(value);
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

  const forgetChoice = () => {
    writeOpenPreference(null);
    setPreference(null);
    setAutoOpen(null);
    setAppAttempt("idle");
  };

  // A remembered choice runs on its own. Without one nothing launches until the
  // person picks: a page can't tell whether an app took an ade:// link (some
  // browsers ask, some do nothing at all), so guessing would strand them.
  useEffect(() => {
    if (autoOpen === "web") {
      if (!webUrl) return;
      // A pause long enough to press Change.
      const redirect = setTimeout(() => window.location.replace(webUrl), WEB_REDIRECT_MS);
      return () => clearTimeout(redirect);
    }
    const url = autoOpen === "app" ? adeUrl : autoOpen === "app-beta" ? betaUrl : null;
    if (!url) return;
    const launch = setTimeout(() => launchApp(url), 150);
    return () => clearTimeout(launch);
  }, [autoOpen, adeUrl, betaUrl, webUrl]);

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

  // Once the app did not answer, the browser is the way on, so it leads.
  const browserLeads = appFailed || !adeUrl;
  const KindIcon = KIND_ICONS[target.kind];

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
              href={WEB_CLIENT_OPEN_URL.replace(/\/open$/, "/")}
            >
              open the ADE web app
            </a>
            .
          </div>
        ) : null}

        {adeUrl || webUrl ? (
          <div className="overflow-hidden rounded-2xl border border-border/80 bg-card/60 shadow-glass-md backdrop-blur-xl">
            <p className="px-5 pb-1 pt-4 text-[13px] text-muted-fg" aria-live="polite">
              {statusLine(autoOpen === "web", appAttempt)}
            </p>
            <div className="grid gap-1 p-2">
              {adeUrl ? (
                <OpenChoice
                  icon={<AppWindow className={CHOICE_ICON} />}
                  title="The ADE app"
                  hint="On this device. Fastest when ADE is installed."
                  lead={!browserLeads}
                  analyticsFeature={MARKETING_FEATURES.OPEN_IN_DESKTOP}
                  onClick={() => openInApp("app")}
                />
              ) : null}
              {betaUrl && offerBeta ? (
                <OpenChoice
                  icon={<AppWindow className={CHOICE_ICON} />}
                  title="ADE Beta"
                  hint="The TestFlight app on this iPhone or iPad."
                  lead={false}
                  analyticsFeature={MARKETING_FEATURES.OPEN_IN_DESKTOP}
                  onClick={() => openInApp("app-beta")}
                />
              ) : null}
              {webUrl ? (
                <OpenChoice
                  icon={<Globe className={CHOICE_ICON} />}
                  title="Your browser"
                  hint="Nothing to install. Sign in with your ADE account."
                  lead={browserLeads}
                  analyticsFeature={MARKETING_FEATURES.OPEN_WEB_CLIENT}
                  onClick={openInBrowser}
                />
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-border/70 px-5 py-3 text-xs text-muted-fg">
              {preference ? (
                <button
                  type="button"
                  onClick={forgetChoice}
                  className="focus-ring rounded-sm text-left transition-colors hover:text-fg"
                >
                  {preference === "web"
                    ? "Links open in your browser."
                    : preference === "app-beta"
                      ? "Links open in ADE Beta."
                      : "Links open in the ADE app."}{" "}
                  <span className="underline underline-offset-4">Change</span>
                </button>
              ) : (
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-[var(--color-accent)]"
                    checked={remember}
                    onChange={(event) => setRemember(event.target.checked)}
                  />
                  Remember my choice on this browser
                </label>
              )}
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
