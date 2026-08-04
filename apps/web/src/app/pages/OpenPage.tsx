import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { ArrowUpRight, Download, GitBranch } from "lucide-react";

import { LinkButton } from "../../components/LinkButton";
import { Page } from "../../components/Page";
import { Section } from "../../components/Section";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { MARKETING_FEATURES } from "../../lib/marketingAnalytics";

type OpenTarget =
  | { kind: "lane"; laneId: string; envelope?: OpenEnvelope }
  | { kind: "session"; sessionId: string; laneId?: string; event?: number; offset?: number; envelope?: OpenEnvelope }
  | { kind: "file"; path: string; line?: number; laneId?: string }
  | { kind: "commit"; sha: string; laneId?: string; envelope?: OpenEnvelope }
  | { kind: "artifact"; artifactId: string; envelope?: OpenEnvelope }
  | { kind: "branch"; repo: string; branch: string; pr?: number }
  | { kind: "pr"; repo: string; number: number }
  | { kind: "linear-issue"; issueIdentifier: string; branch?: string }
  | { kind: "unknown" };

type OpenEnvelope = {
  repo?: string;
  branch?: string;
  pr?: number;
  linear?: string;
};

const CANONICAL_OPEN_ORIGIN = "https://ade-app.dev";

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

function parseQuery(search: string): OpenTarget {
  const params = new URLSearchParams(search);
  const type = (params.get("type") ?? "").toLowerCase();
  if (type === "lane") {
    const laneId = params.get("id") ?? "";
    if (laneId) return { kind: "lane", laneId, envelope: readEnvelope(params) };
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
    if (repo && number) {
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
    case "lane": {
      const base = `ade://lane/${encodeURIComponent(target.laneId)}`;
      return appendQuery(base, envelopeEntries(target.envelope));
    }
    case "session": {
      const base = `ade://session/${encodeURIComponent(target.sessionId)}`;
      return appendQuery(base, [
        ["lane", target.laneId],
        ["event", target.event],
        ["offset", target.offset],
        ...envelopeEntries(target.envelope),
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
        title: "Open worktree in ADE",
        summary: `Worktree ${target.laneId.slice(0, 8)}…`,
      };
    case "session":
      return {
        title: "Open work session in ADE",
        summary: target.laneId ? `Session ${target.sessionId} · worktree ${target.laneId.slice(0, 8)}…` : `Session ${target.sessionId}`,
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
  const { title, summary, valueLabel, value } = describeTarget(target);
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
          {value ? (
            <div className="text-sm text-zinc-500">
              {valueLabel ? <span>{valueLabel}: </span> : null}
              <span className="font-mono text-zinc-300">{value}</span>
            </div>
          ) : null}
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
                  data-ade-analytics-feature={MARKETING_FEATURES.OPEN_IN_DESKTOP}
                  className="inline-flex items-center justify-center rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-emerald-400"
                >
                  <ArrowUpRight className="mr-1 h-4 w-4" /> Open in ADE
                </a>
                <LinkButton to="/" analyticsFeature={MARKETING_FEATURES.VIEW_DOWNLOAD_PAGE} variant="secondary">
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
