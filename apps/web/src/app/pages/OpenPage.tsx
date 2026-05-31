import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { ArrowUpRight, Download, GitBranch } from "lucide-react";

import { LinkButton } from "../../components/LinkButton";
import { Page } from "../../components/Page";
import { Section } from "../../components/Section";
import { useDocumentTitle } from "../../lib/useDocumentTitle";

type OpenTarget =
  | { kind: "lane"; laneId: string }
  | { kind: "session"; sessionId: string; laneId?: string }
  | { kind: "branch"; repo: string; branch: string; pr?: number }
  | { kind: "pr"; repo: string; number: number }
  | { kind: "linear-issue"; issueIdentifier: string; branch?: string }
  | { kind: "unknown" };

const CANONICAL_OPEN_ORIGIN = "https://ade-app.dev";

function parseQuery(search: string): OpenTarget {
  const params = new URLSearchParams(search);
  const type = (params.get("type") ?? "").toLowerCase();
  if (type === "lane") {
    const laneId = params.get("id") ?? "";
    if (laneId) return { kind: "lane", laneId };
  }
  if (type === "session") {
    const sessionId = params.get("id") ?? "";
    if (sessionId) {
      const laneId = params.get("lane") ?? "";
      return laneId ? { kind: "session", sessionId, laneId } : { kind: "session", sessionId };
    }
  }
  if (type === "branch") {
    const repo = params.get("repo") ?? "";
    const branch = params.get("branch") ?? "";
    if (repo && branch) {
      const pr = Number(params.get("pr") ?? "");
      return Number.isInteger(pr) && pr > 0
        ? { kind: "branch", repo, branch, pr }
        : { kind: "branch", repo, branch };
    }
  }
  if (type === "pr") {
    const repo = params.get("repo") ?? "";
    const number = Number(params.get("number") ?? "");
    if (repo && Number.isInteger(number) && number > 0) {
      return { kind: "pr", repo, number };
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
  return { kind: "unknown" };
}

function buildAdeUrl(target: OpenTarget): string | null {
  switch (target.kind) {
    case "lane":
      return `ade://lane/${encodeURIComponent(target.laneId)}`;
    case "session": {
      const base = `ade://session/${encodeURIComponent(target.sessionId)}`;
      return target.laneId ? `${base}?lane=${encodeURIComponent(target.laneId)}` : base;
    }
    case "branch": {
      const [owner, name] = target.repo.split("/");
      if (!owner || !name) return null;
      const branchSegments = target.branch
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      const base = `ade://repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branch/${branchSegments}`;
      return target.pr ? `${base}?pr=${target.pr}` : base;
    }
    case "pr": {
      const [owner, name] = target.repo.split("/");
      if (!owner || !name) return null;
      return `ade://pr/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${target.number}`;
    }
    case "linear-issue": {
      const base = `ade://linear-issue/${encodeURIComponent(target.issueIdentifier)}`;
      return target.branch ? `${base}?branch=${encodeURIComponent(target.branch)}` : base;
    }
    case "unknown":
      return null;
  }
}

function describeTarget(target: OpenTarget): { title: string; summary: string } {
  switch (target.kind) {
    case "lane":
      return {
        title: "Open worktree in ADE",
        summary: `Worktree ${target.laneId.slice(0, 8)}…`,
      };
    case "session":
      return {
        title: "Open work session in ADE",
        summary: target.laneId ? `Session ${target.sessionId} · worktree ${target.laneId.slice(0, 8)}…` : `Session ${target.sessionId}`,
      };
    case "branch":
      return {
        title: `Open ${target.repo} in ADE`,
        summary: `Branch ${target.branch}${target.pr ? ` · PR #${target.pr}` : ""}`,
      };
    case "pr":
      return {
        title: `Open ${target.repo}#${target.number} in ADE`,
        summary: `Pull request #${target.number}`,
      };
    case "linear-issue":
      return {
        title: `Open ${target.issueIdentifier} in ADE`,
        summary: target.branch ? `Branch ${target.branch}` : "Linear issue",
      };
    case "unknown":
      return {
        title: "Open in ADE",
        summary: "Missing or invalid link parameters.",
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

export function OpenPage() {
  const location = useLocation();
  const target = useMemo(() => parseQuery(location.search), [location.search]);
  const adeUrl = useMemo(() => buildAdeUrl(target), [target]);
  const { title, summary } = describeTarget(target);
  const [launchAttempted, setLaunchAttempted] = useState(false);

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

  // Try the ade:// upgrade automatically. If the OS routes the URL away from
  // this page we won't see the result; if it stays here, we show the fallback.
  useEffect(() => {
    if (!adeUrl) return;
    setLaunchAttempted(true);
    const t = setTimeout(() => {
      try {
        window.location.href = adeUrl;
      } catch {
        // ignore — fallback already visible
      }
    }, 250);
    return () => clearTimeout(t);
  }, [adeUrl]);

  return (
    <Page>
      <Section className="pt-24">
        <div className="mx-auto max-w-xl text-center space-y-6">
          <div className="inline-flex items-center justify-center rounded-full bg-emerald-500/10 px-4 py-1 text-emerald-300">
            <GitBranch className="mr-2 h-4 w-4" /> ADE deeplink
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          <p className="text-zinc-400">{summary}</p>
          {target.kind === "unknown" ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-6 text-left text-sm text-zinc-300">
              This link is missing required parameters. Verify the URL or generate a fresh link from ADE.
            </div>
          ) : null}
          {adeUrl ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-6 text-left text-sm">
              <div className="text-zinc-400">
                {launchAttempted
                  ? "Trying to open ADE — if nothing happens, ADE may not be installed."
                  : "Click below to launch ADE."}
              </div>
              <div className="mt-4 flex flex-wrap gap-3">
                <a
                  href={adeUrl}
                  className="inline-flex items-center justify-center rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-emerald-400"
                >
                  <ArrowUpRight className="mr-1 h-4 w-4" /> Open in ADE
                </a>
                <LinkButton to="/download" variant="secondary">
                  <Download className="mr-1 h-4 w-4" /> Install ADE
                </LinkButton>
              </div>
            </div>
          ) : null}
        </div>
      </Section>
    </Page>
  );
}
