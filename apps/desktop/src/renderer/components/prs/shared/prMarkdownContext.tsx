import React from "react";
import { GitMerge, GitPullRequest, Info, Lightbulb, Warning, WarningOctagon, XCircle, Megaphone, type Icon } from "@phosphor-icons/react";
import type { PrState } from "../../../../shared/types/prs";
import { getFileIcon } from "../../files/filePresentation";
import { COLORS } from "../../lanes/laneDesignTokens";

/**
 * What PR markdown knows about the PR it is rendered in. Provided by the PR
 * detail Overview; absent everywhere else (chat, previews), where the markdown
 * falls back to plain inline code and plain links.
 */
export type PrMarkdownEnv = {
  /** Repo paths changed by this PR. */
  prFiles: string[];
  /** Open a file: in the PR's Files tab when `inPr`, else the ADE Files editor. */
  onOpenFile?: (path: string, inPr: boolean) => void;
  /** State of other PRs in this repo, for `#123` pills. */
  prStateByNumber?: ReadonlyMap<number, PrState>;
  onOpenPr?: (number: number) => void;
};

export const PrMarkdownEnvContext = React.createContext<PrMarkdownEnv | null>(null);

const FILE_LIKE = /^[\w@~.\-/]+\.[A-Za-z0-9]{1,8}(?::\d+(?:-\d+)?)?$/;

/**
 * Resolve inline code to a file: an exact PR path, a unique PR path ending in
 * it (`modelManifest.ts` → `apps/desktop/src/shared/modelManifest.ts`), or a
 * repo-looking path with a slash. Anything else stays code.
 */
export function resolveInlineFile(text: string, prFiles: string[]): { path: string; line: number | null; inPr: boolean } | null {
  const trimmed = text.trim();
  if (!FILE_LIKE.test(trimmed) || trimmed.startsWith("http")) return null;
  const [rawPath, rawLine] = trimmed.split(":");
  const path = (rawPath ?? "").replace(/^\.\//, "");
  const line = rawLine ? Number.parseInt(rawLine, 10) : null;
  if (!path) return null;
  const exact = prFiles.find((file) => file === path);
  if (exact) return { path: exact, line, inPr: true };
  const suffix = prFiles.filter((file) => file.endsWith(`/${path}`));
  if (suffix.length === 1) return { path: suffix[0]!, line, inPr: true };
  if (path.includes("/") && !path.startsWith("~") && !path.startsWith("/")) return { path, line, inPr: false };
  return null;
}

export function PrFileChip({ path, line, inPr, onOpen }: { path: string; line: number | null; inPr: boolean; onOpen?: () => void }) {
  const slash = path.lastIndexOf("/");
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dir = slash >= 0 ? path.slice(0, slash) : "";
  const shortDir = dir.split("/").slice(-2).join("/");
  const { icon: Glyph, color } = getFileIcon(name);
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${path}${line ? `:${line}` : ""}${inPr ? " — open in Files" : " — open in the editor"}`}
      data-testid="pr-md-file-chip"
      data-in-pr={inPr || undefined}
      className="inline-flex max-w-full items-center gap-1 rounded-[5px] px-1.5 align-baseline font-mono text-[11.5px] leading-[1.6] transition-colors hover:brightness-125"
      style={{
        background: "color-mix(in srgb, var(--color-fg) 7%, transparent)",
        color: "var(--color-fg)",
        border: "none",
        cursor: onOpen ? "pointer" : "default",
        verticalAlign: "baseline",
      }}
    >
      <Glyph size={12} style={{ color, flexShrink: 0 }} />
      <span className="truncate">{name}{line ? `:${line}` : ""}</span>
      {shortDir ? <span className="truncate opacity-50">· {shortDir}</span> : null}
    </button>
  );
}

const PR_PILL_TONE: Record<PrState, string> = {
  open: COLORS.success,
  draft: COLORS.textMuted,
  merged: COLORS.accent,
  closed: COLORS.danger,
};

export function PrRefPill({ number, state, onOpen, href }: { number: number; state: PrState | null; onOpen?: () => void; href?: string }) {
  const tone = state ? PR_PILL_TONE[state] : COLORS.accent;
  const Glyph = state === "merged" ? GitMerge : state === "closed" ? XCircle : GitPullRequest;
  return (
    <a
      href={href}
      onClick={(event) => {
        if (!onOpen) return;
        event.preventDefault();
        onOpen();
      }}
      data-testid="pr-md-ref-pill"
      data-state={state ?? "unknown"}
      className="inline-flex items-center gap-0.5 rounded-full px-1.5 align-baseline font-mono text-[11.5px] font-semibold no-underline transition-colors hover:brightness-125"
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)`, textDecoration: "none" }}
    >
      <Glyph size={11} weight="bold" />#{number}
    </a>
  );
}

export type GithubAlertKind = "note" | "tip" | "important" | "warning" | "caution";

export const GITHUB_ALERT: Record<GithubAlertKind, { label: string; color: string; icon: Icon }> = {
  note: { label: "Note", color: COLORS.info, icon: Info },
  tip: { label: "Tip", color: COLORS.success, icon: Lightbulb },
  important: { label: "Important", color: COLORS.accent, icon: Megaphone },
  warning: { label: "Warning", color: COLORS.warning, icon: Warning },
  caution: { label: "Caution", color: COLORS.danger, icon: WarningOctagon },
};

export function PrAlertCallout({ kind, children }: { kind: GithubAlertKind; children: React.ReactNode }) {
  const alert = GITHUB_ALERT[kind];
  const Glyph = alert.icon;
  return (
    <div
      data-testid="pr-md-alert"
      data-kind={kind}
      className="mb-3 rounded-lg py-2 pl-3 pr-3 last:mb-0"
      style={{ borderLeft: `3px solid ${alert.color}`, background: `color-mix(in srgb, ${alert.color} 8%, transparent)` }}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: alert.color }}>
        <Glyph size={14} weight="fill" />
        {alert.label}
      </div>
      <div className="text-[13px]">{children}</div>
    </div>
  );
}
