import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleNotch, DotsThree, GithubLogo, Image as ImageIcon, X } from "@phosphor-icons/react";
import type {
  CtoGetLinearIssuePickerDataResult,
  GitHubIssueAttachmentInput,
  LinearIssueCreateOptions,
  LinearProjectMilestone,
  NormalizedLinearIssue,
} from "../../../shared/types";
import { buildDeeplink } from "../../../shared/deeplinks";
import {
  missingRequiredGitHubFormField,
  serializeGitHubIssueForm,
  type GitHubIssueFormAnswers,
  type GitHubIssueTemplate,
} from "../../../shared/githubIssueTemplates";
import { isMacRuntimeTarget } from "../../lib/platform";
import { openIssueRef } from "../../lib/issueNavigation";
import { requestLinearIssueLaunch } from "../../lib/linearLaunchRequests";
import { announceIssueCreated, type IssueCreateRequest } from "../../lib/issueCreateRequests";
import { showToast } from "../app/toast/toastStore";
import { LinearAssigneeAvatar } from "../app/LinearIssueBrowserRows";
import { cachedLinearBrowserIssues } from "../app/LinearIssueBrowser";
import { PickerMenu, type PickerOption } from "../app/LinearIssuePropertyPickers";
import { PRIORITY_CHOICES } from "../app/linearIssueBrowserModel";
import { GitHubIssueStateIcon } from "../lanes/githubBrand";
import { LinearMark, LinearPriorityIcon, LinearStateIcon } from "../lanes/linearBrand";
import { cn } from "../ui/cn";
import { Dialog } from "../ui/dialog";
import {
  cachedGitHubIssues,
  loadGitHubRepoCatalog,
  normalizeGitHubIssue,
  noteGitHubIssueCreated,
  useGitHubCreateCatalog,
  useGitHubRepoCatalog,
  useProjectGitHubRepo,
} from "./githubIssueStore";
import { cachedLinearIssues, useActiveProjectRoot, useLinearPickerCatalog } from "./linearIssueStore";
import { requestGitHubIssueLaunch } from "./githubIssueLaunch";

/**
 * Starting a new issue in Linear or GitHub, in one composer: a big title, the
 * description, a row of property chips (the same pickers the viewer uses), and
 * a `⋯` row for the fields most issues skip. Templates fill it in; a GitHub
 * issue form replaces the description with its own fields.
 *
 * - The draft is saved per tracker while you type and cleared on create.
 * - Pictures pasted or dropped into the description upload to Linear at once,
 *   or go to GitHub with the issue through `gh --attach`.
 * - Similar open issues ADE already read show under the title, without a
 *   request, so a duplicate is caught before it is filed.
 * - An issue started from a chat gets a "Context" footer linking back to it.
 */

type Provider = "linear" | "github";

const LAST_PROVIDER_KEY = "ade.issueCreate.lastProvider";
const DRAFT_KEY = (provider: Provider) => `ade.issueCreate.draft.v1:${provider}`;
const MOD = () => (isMacRuntimeTarget() ? "⌘" : "Ctrl");

type LinearFields = {
  teamKey: string | null;
  stateId: string | null;
  priority: number | null;
  assigneeId: string | null;
  labelIds: string[];
  projectId: string | null;
  milestoneId: string | null;
  cycleId: string | null;
  estimate: number | null;
  dueDate: string;
  parent: string;
  templateId: string | null;
};

type GitHubFields = {
  labels: string[];
  assignees: string[];
  milestone: number | null;
  type: string | null;
  parent: string;
  templateKey: string | null;
};

type Draft = { title: string; body: string; linear: LinearFields; github: GitHubFields };

const EMPTY_LINEAR: LinearFields = {
  teamKey: null, stateId: null, priority: null, assigneeId: null, labelIds: [], projectId: null,
  milestoneId: null, cycleId: null, estimate: null, dueDate: "", parent: "", templateId: null,
};
const EMPTY_GITHUB: GitHubFields = { labels: [], assignees: [], milestone: null, type: null, parent: "", templateKey: null };

function readDraft(provider: Provider): Draft | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY(provider));
    const parsed = raw ? JSON.parse(raw) as Partial<Draft> : null;
    if (!parsed) return null;
    return {
      title: typeof parsed.title === "string" ? parsed.title : "",
      body: typeof parsed.body === "string" ? parsed.body : "",
      linear: { ...EMPTY_LINEAR, ...(parsed.linear ?? {}) },
      github: { ...EMPTY_GITHUB, ...(parsed.github ?? {}) },
    };
  } catch {
    return null;
  }
}

function writeDraft(provider: Provider, draft: Draft | null): void {
  try {
    if (!draft || (!draft.title.trim() && !draft.body.trim())) window.localStorage.removeItem(DRAFT_KEY(provider));
    else window.localStorage.setItem(DRAFT_KEY(provider), JSON.stringify(draft));
  } catch {
    // The draft is a convenience; losing it is not an error.
  }
}

function initialProvider(request: IssueCreateRequest): Provider {
  if (request.prefill?.parent) return request.prefill.parent.provider;
  if (request.provider) return request.provider;
  try {
    const last = window.localStorage.getItem(LAST_PROVIDER_KEY);
    if (last === "linear" || last === "github") return last;
  } catch {
    // fall through
  }
  return "linear";
}

/* ── Similar issues ────────────────────────────────────────────────────── */

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3));
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

type SimilarIssue = { key: string; label: string; title: string; open: () => void; icon: React.ReactNode };

/* ── Small pieces ──────────────────────────────────────────────────────── */

function Chip({
  label,
  children,
  anchorRef,
  onClick,
  muted,
}: {
  label: string;
  children: React.ReactNode;
  anchorRef?: React.RefObject<HTMLButtonElement>;
  onClick: () => void;
  muted?: boolean;
}) {
  return (
    <button
      ref={anchorRef}
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 min-w-0 max-w-[220px] items-center gap-1.5 rounded-md border border-fg/[0.08] bg-fg/[0.02] px-2 text-[11.5px] transition-colors hover:border-fg/[0.16] hover:bg-fg/[0.05]",
        muted ? "text-[color:var(--kit-text-3)]" : "text-fg/85",
      )}
    >
      {children}
    </button>
  );
}

/** A chip that opens a filterable picker. */
function ChipPicker({
  label,
  display,
  options,
  selected,
  multi,
  placeholder,
  onOpen,
  onPick,
  muted,
}: {
  label: string;
  display: React.ReactNode;
  options: PickerOption[];
  selected: string[];
  multi?: boolean;
  placeholder: string;
  onOpen?: () => void;
  onPick: (id: string) => void;
  muted?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Chip label={label} anchorRef={ref} muted={muted} onClick={() => { onOpen?.(); setOpen(true); }}>{display}</Chip>
      <PickerMenu
        open={open}
        anchorRef={ref}
        onClose={() => setOpen(false)}
        options={options}
        selectedIds={new Set(selected)}
        multi={multi}
        placeholder={placeholder}
        onPick={(id) => {
          if (!multi) setOpen(false);
          onPick(id);
        }}
      />
    </>
  );
}

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
}

function estimateScale(options: LinearIssueCreateOptions | null): Array<{ value: number; label: string }> {
  if (!options || options.estimationType === "notUsed") return [];
  const extended = options.estimationExtended;
  let scale: Array<{ value: number; label: string }>;
  switch (options.estimationType) {
    case "exponential":
      scale = [1, 2, 4, 8, 16, ...(extended ? [32, 64] : [])].map((value) => ({ value, label: String(value) }));
      break;
    case "fibonacci":
      scale = [1, 2, 3, 5, 8, ...(extended ? [13, 21] : [])].map((value) => ({ value, label: String(value) }));
      break;
    case "tShirt":
      scale = [["XS", 1], ["S", 2], ["M", 3], ["L", 5], ["XL", 8], ...(extended ? [["XXL", 13], ["XXXL", 21]] : [])]
        .map(([label, value]) => ({ value: value as number, label: label as string }));
      break;
    default:
      scale = [1, 2, 3, 4, 5, ...(extended ? [6, 7] : [])].map((value) => ({ value, label: String(value) }));
  }
  return options.estimationAllowZero ? [{ value: 0, label: "0" }, ...scale] : scale;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file."));
    reader.readAsDataURL(file);
  });
}

function imageFiles(list: FileList | null | undefined): File[] {
  return [...(list ?? [])].filter((file) => file.type.startsWith("image/"));
}

/* ── The dialog ────────────────────────────────────────────────────────── */

export function IssueCreateDialog({ request, onClose }: { request: IssueCreateRequest; onClose: () => void }) {
  const projectRoot = useActiveProjectRoot();
  const parent = request.prefill?.parent ?? null;
  const [provider, setProvider] = useState<Provider>(() => initialProvider(request));
  const hasPrefill = Boolean(request.prefill?.title || request.prefill?.body);
  const [title, setTitle] = useState(() => request.prefill?.title ?? (hasPrefill ? "" : readDraft(initialProvider(request))?.title ?? ""));
  const [body, setBody] = useState(() => request.prefill?.body ?? (hasPrefill ? "" : readDraft(initialProvider(request))?.body ?? ""));
  const [linear, setLinear] = useState<LinearFields>(() => {
    const draft = hasPrefill ? null : readDraft("linear")?.linear;
    const base = { ...EMPTY_LINEAR, ...(draft ?? {}) };
    if (parent?.provider === "linear") return { ...base, parent: parent.identifier, teamKey: parent.teamKey ?? base.teamKey };
    return base;
  });
  const [github, setGitHub] = useState<GitHubFields>(() => {
    const draft = hasPrefill ? null : readDraft("github")?.github;
    const base = { ...EMPTY_GITHUB, ...(draft ?? {}) };
    if (parent?.provider === "github") return { ...base, parent: String(parent.number) };
    return base;
  });
  const [formAnswers, setFormAnswers] = useState<GitHubIssueFormAnswers>({});
  const [attachments, setAttachments] = useState<GitHubIssueAttachmentInput[]>([]);
  const [uploads, setUploads] = useState(0);
  const [showMore, setShowMore] = useState(() => Boolean(parent));
  const [createMore, setCreateMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  // Remember the tracker, and keep the draft, as the user types.
  useEffect(() => {
    try { window.localStorage.setItem(LAST_PROVIDER_KEY, provider); } catch { /* ignore */ }
  }, [provider]);
  useEffect(() => {
    const timer = window.setTimeout(() => writeDraft(provider, { title, body, linear, github }), 400);
    return () => window.clearTimeout(timer);
  }, [body, github, linear, provider, title]);

  /* Linear data */
  const catalog = useLinearPickerCatalog();
  const teams = useMemo(() => {
    const byKey = new Map<string, { key: string; id: string; name: string }>();
    for (const state of catalog?.states ?? []) {
      if (!state.teamKey || byKey.has(state.teamKey)) continue;
      const project = catalog?.projects.find((entry) => entry.teamKey === state.teamKey);
      byKey.set(state.teamKey, { key: state.teamKey, id: state.teamId, name: project?.teamName ?? state.teamKey });
    }
    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  }, [catalog]);
  const teamKey = linear.teamKey && teams.some((team) => team.key === linear.teamKey) ? linear.teamKey : teams[0]?.key ?? null;
  const [createOptions, setCreateOptions] = useState<LinearIssueCreateOptions | null>(null);
  useEffect(() => {
    if (provider !== "linear" || !teamKey) return;
    let cancelled = false;
    setCreateOptions(null);
    void window.ade?.cto?.getLinearIssueCreateOptions?.({ teamKey })
      .then((options) => { if (!cancelled) setCreateOptions(options); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [provider, teamKey]);
  const [milestones, setMilestones] = useState<LinearProjectMilestone[]>([]);
  useEffect(() => {
    if (!linear.projectId) {
      setMilestones([]);
      return;
    }
    let cancelled = false;
    void window.ade?.cto?.listLinearProjectMilestones?.({ projectId: linear.projectId })
      .then((list) => { if (!cancelled) setMilestones(list ?? []); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [linear.projectId]);

  /* GitHub data */
  const { repo } = useProjectGitHubRepo();
  const repoCatalog = useGitHubRepoCatalog(provider === "github" ? repo : null);
  const createCatalog = useGitHubCreateCatalog(provider === "github" ? repo : null);
  useEffect(() => {
    if (provider === "github" && repo) loadGitHubRepoCatalog(repo);
  }, [provider, repo]);
  const templates = createCatalog.templates?.templates ?? [];
  const template: GitHubIssueTemplate | null = templates.find((entry) => entry.key === github.templateKey) ?? null;
  const formTemplate = template?.kind === "form" ? template : null;
  const templateRequired = provider === "github" && createCatalog.templates?.blankIssuesEnabled === false && templates.length > 0;

  const applyGitHubTemplate = (next: GitHubIssueTemplate | null) => {
    setGitHub((current) => ({
      ...current,
      templateKey: next?.key ?? null,
      labels: next ? [...new Set([...current.labels, ...next.labels])] : current.labels,
      assignees: next ? [...new Set([...current.assignees, ...next.assignees])] : current.assignees,
      type: next?.type ?? current.type,
    }));
    if (next?.title && !title.trim()) setTitle(next.title);
    if (next?.kind === "markdown" && next.body && !body.trim()) setBody(next.body);
    if (next?.kind === "form") {
      const answers: GitHubIssueFormAnswers = {};
      next.fields.forEach((field, index) => {
        if ((field.type === "input" || field.type === "textarea") && field.value) answers[index] = field.value;
        if (field.type === "dropdown" && field.defaultIndex != null && field.options[field.defaultIndex]) {
          answers[index] = [field.options[field.defaultIndex]!];
        }
      });
      setFormAnswers(answers);
    }
  };

  const applyLinearTemplate = (templateId: string | null) => {
    const next = createOptions?.templates.find((entry) => entry.id === templateId) ?? null;
    setLinear((current) => ({
      ...current,
      templateId,
      priority: next?.priority ?? current.priority,
      labelIds: next ? [...new Set([...current.labelIds, ...next.labelIds])] : current.labelIds,
    }));
    if (next?.title && !title.trim()) setTitle(next.title);
  };

  /* Similar issues, from what ADE already read */
  const [similar, setSimilar] = useState<SimilarIssue[]>([]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const mine = words(title);
      if (mine.size < 2) {
        setSimilar([]);
        return;
      }
      if (provider === "linear") {
        const pool = new Map<string, NormalizedLinearIssue>();
        for (const issue of [...cachedLinearIssues(), ...cachedLinearBrowserIssues()]) pool.set(issue.id, issue);
        setSimilar([...pool.values()]
          .filter((issue) => issue.stateType !== "completed" && issue.stateType !== "canceled")
          .map((issue) => ({ issue, score: similarity(mine, words(issue.title)) }))
          .filter((entry) => entry.score >= 0.6)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map(({ issue }) => ({
            key: issue.id,
            label: issue.identifier,
            title: issue.title,
            icon: <LinearStateIcon stateType={issue.stateType} size={11} />,
            open: () => openIssueRef({ ref: { provider: "linear", identifier: issue.identifier, url: issue.url }, source: "issue-viewer" }),
          })));
      } else if (repo) {
        setSimilar(cachedGitHubIssues(repo.owner, repo.name)
          .filter((issue) => issue.state === "open")
          .map((issue) => ({ issue, score: similarity(mine, words(issue.title)) }))
          .filter((entry) => entry.score >= 0.6)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map(({ issue }) => ({
            key: String(issue.number),
            label: `#${issue.number}`,
            title: issue.title,
            icon: <GitHubIssueStateIcon state={issue.state} stateReason={issue.stateReason} size={11} />,
            open: () => openIssueRef({ ref: { provider: "github", owner: issue.owner, repo: issue.repo, number: issue.number, url: issue.url }, source: "issue-viewer" }),
          })));
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [provider, repo, title]);

  /* Pictures */
  const insertAtCursor = useCallback((text: string) => {
    const element = bodyRef.current;
    setBody((current) => {
      if (!element) return `${current}${current && !current.endsWith("\n") ? "\n" : ""}${text}`;
      const start = element.selectionStart ?? current.length;
      const end = element.selectionEnd ?? current.length;
      return `${current.slice(0, start)}${text}${current.slice(end)}`;
    });
  }, []);

  const addPictures = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    if (provider === "github") {
      const next = await Promise.all(files.map(async (file) => ({
        filename: file.name || "image.png",
        contentType: file.type || "image/png",
        dataBase64: await fileToBase64(file),
      })));
      setAttachments((current) => [...current, ...next].slice(0, 10));
      return;
    }
    const upload = window.ade?.cto?.uploadLinearFile;
    if (!upload) {
      setError("Uploading pictures to Linear is not available here.");
      return;
    }
    for (const file of files) {
      setUploads((count) => count + 1);
      try {
        const result = await upload({ filename: file.name || "image.png", contentType: file.type || "image/png", dataBase64: await fileToBase64(file) });
        insertAtCursor(`![${result.filename}](${result.assetUrl})\n`);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Linear refused the picture.");
      } finally {
        setUploads((count) => count - 1);
      }
    }
  }, [insertAtCursor, provider]);

  /* Create */
  const contextFooter = useMemo(() => {
    const sessionId = request.context?.sessionId;
    if (!sessionId) return "";
    const chatLink = buildDeeplink({ kind: "session", sessionId, ...(request.context?.laneId ? { laneId: request.context.laneId } : {}) });
    const lane = request.context?.laneName ? ` in lane **${request.context.laneName}**` : "";
    return `\n\n<details><summary>Context</summary>\n\nStarted from [an ADE chat](${chatLink})${lane}.\n\n</details>`;
  }, [request.context]);

  const reset = () => {
    setTitle("");
    setBody("");
    setFormAnswers({});
    setAttachments([]);
    setError(null);
    writeDraft(provider, null);
    titleRef.current?.focus();
  };

  const submit = async () => {
    if (busy || uploads > 0) return;
    const trimmed = title.trim();
    if (!trimmed) {
      setError("Give the issue a title.");
      titleRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (provider === "linear") {
        if (!teamKey) throw new Error("Pick a team.");
        const create = window.ade?.cto?.createLinearIssue;
        if (!create) throw new Error("Creating Linear issues is not available here.");
        let parentId: string | null = null;
        if (linear.parent.trim()) {
          const parentIssue = await window.ade?.cto?.getLinearIssue?.({ issueId: linear.parent.trim() });
          if (!parentIssue) throw new Error(`Linear didn't return the parent ${linear.parent.trim()}.`);
          parentId = parentIssue.id;
        }
        const issue = await create({
          teamKey,
          title: trimmed,
          description: `${body}${contextFooter}`,
          stateId: linear.stateId,
          priority: linear.priority,
          assigneeId: linear.assigneeId,
          labelIds: linear.labelIds,
          projectId: linear.projectId,
          projectMilestoneId: linear.projectId ? linear.milestoneId : null,
          cycleId: linear.cycleId,
          estimate: linear.estimate,
          dueDate: linear.dueDate || null,
          parentId,
          templateId: linear.templateId,
        });
        showToast({
          tone: "success",
          title: `Created ${issue.identifier}`,
          message: issue.title,
          actions: [{ label: "Start lane", onClick: () => requestLinearIssueLaunch({ issues: [issue], laneOnly: false }) }],
        });
        announceIssueCreated({ provider: "linear", issue });
        if (!createMore && request.origin !== "pane") {
          openIssueRef({ ref: { provider: "linear", identifier: issue.identifier, url: issue.url }, source: "issue-viewer" });
        }
      } else {
        if (!repo) throw new Error("This project has no GitHub repository.");
        if (templateRequired && !template) throw new Error("This repository asks for a template. Pick one.");
        if (formTemplate) {
          const missing = missingRequiredGitHubFormField(formTemplate, formAnswers);
          if (missing) throw new Error(`Fill in "${missing}".`);
        }
        const create = window.ade?.github?.createIssue;
        if (!create) throw new Error("Creating GitHub issues is not available here.");
        const description = formTemplate ? serializeGitHubIssueForm(formTemplate, formAnswers) : body;
        const parentNumber = Number(github.parent.replace(/^#/, ""));
        const result = await create({
          owner: repo.owner,
          name: repo.name,
          input: {
            title: trimmed,
            body: `${description}${contextFooter}`,
            labels: github.labels,
            assignees: github.assignees,
            milestone: github.milestone,
            type: github.type,
            parentNumber: Number.isInteger(parentNumber) && parentNumber > 0 ? parentNumber : null,
            attachments,
          },
        });
        const issue = normalizeGitHubIssue(repo.owner, repo.name, result.issue);
        if (!issue) throw new Error("GitHub created the issue but did not return it.");
        noteGitHubIssueCreated(projectRoot, issue);
        showToast({
          tone: result.warnings.length ? "warning" : "success",
          title: `Created #${issue.number}`,
          message: result.warnings.length ? result.warnings.join(" ") : issue.title,
          actions: [{ label: "Start lane", onClick: () => requestGitHubIssueLaunch(issue) }],
        });
        announceIssueCreated({ provider: "github", owner: issue.owner, repo: issue.repo, number: issue.number });
        if (!createMore && request.origin !== "pane") {
          openIssueRef({ ref: { provider: "github", owner: issue.owner, repo: issue.repo, number: issue.number, url: issue.url }, source: "issue-viewer" });
        }
      }
      if (createMore) reset();
      else {
        writeDraft(provider, null);
        onClose();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The issue was not created.");
    } finally {
      setBusy(false);
    }
  };

  /* Linear chips */
  const linearStates = (catalog?.states ?? []).filter((state) => state.teamKey === teamKey);
  const state = linearStates.find((entry) => entry.id === linear.stateId) ?? null;
  const assignee = catalog?.users.find((user) => user.id === linear.assigneeId) ?? null;
  const teamLabels = (catalog?.labels ?? []).filter((label) => !label.teamKey || label.teamKey === teamKey);
  const pickedLabels = teamLabels.filter((label) => linear.labelIds.includes(label.id));
  const projects = (catalog?.projects ?? []).filter((project) => !project.teamKey || project.teamKey === teamKey);
  const project = projects.find((entry) => entry.id === linear.projectId) ?? null;
  const cycle = createOptions?.cycles.find((entry) => entry.id === linear.cycleId) ?? null;
  const scale = estimateScale(createOptions);
  const linearTemplate = createOptions?.templates.find((entry) => entry.id === linear.templateId) ?? null;

  const linearChips = (
    <>
      <ChipPicker
        label="Status"
        display={state ? <><LinearStateIcon stateType={state.type} size={12} />{state.name}</> : "Default status"}
        muted={!state}
        options={linearStates.map((entry) => ({ id: entry.id, label: entry.name, icon: <LinearStateIcon stateType={entry.type} size={12} /> }))}
        selected={linear.stateId ? [linear.stateId] : []}
        placeholder="Status…"
        onPick={(id) => setLinear((current) => ({ ...current, stateId: id }))}
      />
      <ChipPicker
        label="Priority"
        display={<><LinearPriorityIcon priority={linear.priority ?? 0} size={12} />{PRIORITY_CHOICES.find((choice) => choice.value === (linear.priority ?? 0))?.label ?? "No priority"}</>}
        muted={!linear.priority}
        options={PRIORITY_CHOICES.map((choice) => ({ id: String(choice.value), label: choice.label, icon: <LinearPriorityIcon priority={choice.value} size={12} /> }))}
        selected={[String(linear.priority ?? 0)]}
        placeholder="Priority…"
        onPick={(id) => setLinear((current) => ({ ...current, priority: Number(id) }))}
      />
      <ChipPicker
        label="Assignee"
        display={<><LinearAssigneeAvatar name={assignee ? assignee.displayName ?? assignee.name : null} avatarUrl={assignee?.avatarUrl ?? null} size={14} />{assignee ? assignee.displayName ?? assignee.name : "Assignee"}</>}
        muted={!assignee}
        options={[
          { id: "", label: "Unassigned" },
          ...(catalog?.users ?? []).filter((user) => user.active).map((user) => ({
            id: user.id,
            label: user.displayName ?? user.name,
            keywords: `${user.name} ${user.email ?? ""}`,
            icon: <LinearAssigneeAvatar name={user.displayName ?? user.name} avatarUrl={user.avatarUrl ?? null} size={14} />,
          })),
        ]}
        selected={[linear.assigneeId ?? ""]}
        placeholder="Assign to…"
        onPick={(id) => setLinear((current) => ({ ...current, assigneeId: id || null }))}
      />
      <ChipPicker
        label="Labels"
        display={pickedLabels.length
          ? <><span className="flex gap-0.5">{pickedLabels.slice(0, 3).map((label) => <span key={label.id} className="block h-2 w-2 rounded-full" style={{ backgroundColor: label.color ?? "var(--kit-fill)" }} />)}</span>{pickedLabels.length === 1 ? pickedLabels[0]!.name : `${pickedLabels.length} labels`}</>
          : "Labels"}
        muted={!pickedLabels.length}
        multi
        options={teamLabels.map((label) => ({ id: label.id, label: label.name, icon: <span className="block h-2 w-2 rounded-full" style={{ backgroundColor: label.color ?? "var(--kit-fill)" }} /> }))}
        selected={linear.labelIds}
        placeholder="Labels…"
        onPick={(id) => setLinear((current) => ({ ...current, labelIds: toggle(current.labelIds, id) }))}
      />
      <ChipPicker
        label="Project"
        display={project ? project.name : "Project"}
        muted={!project}
        options={[{ id: "", label: "No project" }, ...projects.map((entry) => ({ id: entry.id, label: entry.name }))]}
        selected={[linear.projectId ?? ""]}
        placeholder="Project…"
        onPick={(id) => setLinear((current) => ({ ...current, projectId: id || null, milestoneId: null }))}
      />
    </>
  );

  const linearMore = (
    <>
      {project ? (
        <ChipPicker
          label="Milestone"
          display={milestones.find((entry) => entry.id === linear.milestoneId)?.name ?? "Milestone"}
          muted={!linear.milestoneId}
          options={[{ id: "", label: "No milestone" }, ...milestones.map((entry) => ({ id: entry.id, label: entry.name }))]}
          selected={[linear.milestoneId ?? ""]}
          placeholder="Milestone…"
          onPick={(id) => setLinear((current) => ({ ...current, milestoneId: id || null }))}
        />
      ) : null}
      {createOptions?.cyclesEnabled ? (
        <ChipPicker
          label="Cycle"
          display={cycle ? `Cycle ${cycle.number}${cycle.active ? " (current)" : ""}` : "Cycle"}
          muted={!cycle}
          options={[{ id: "", label: "No cycle" }, ...createOptions.cycles.map((entry) => ({
            id: entry.id,
            label: `${entry.name || `Cycle ${entry.number}`}${entry.active ? " (current)" : ""}`,
          }))]}
          selected={[linear.cycleId ?? ""]}
          placeholder="Cycle…"
          onPick={(id) => setLinear((current) => ({ ...current, cycleId: id || null }))}
        />
      ) : null}
      {scale.length ? (
        <ChipPicker
          label="Estimate"
          display={linear.estimate != null ? `Estimate ${scale.find((entry) => entry.value === linear.estimate)?.label ?? linear.estimate}` : "Estimate"}
          muted={linear.estimate == null}
          options={[{ id: "", label: "No estimate" }, ...scale.map((entry) => ({ id: String(entry.value), label: entry.label }))]}
          selected={[linear.estimate == null ? "" : String(linear.estimate)]}
          placeholder="Estimate…"
          onPick={(id) => setLinear((current) => ({ ...current, estimate: id === "" ? null : Number(id) }))}
        />
      ) : null}
      <label className="inline-flex h-7 items-center gap-1.5 rounded-md border border-fg/[0.08] px-2 text-[11.5px] text-[color:var(--kit-text-3)]">
        Due
        <input
          type="date"
          aria-label="Due date"
          className="bg-transparent text-fg/85 outline-none [color-scheme:dark]"
          value={linear.dueDate}
          onChange={(event) => setLinear((current) => ({ ...current, dueDate: event.target.value }))}
        />
      </label>
      <label className="inline-flex h-7 items-center gap-1.5 rounded-md border border-fg/[0.08] px-2 text-[11.5px] text-[color:var(--kit-text-3)]">
        Parent
        <input
          aria-label="Parent issue"
          placeholder="ADE-123"
          className="w-[84px] bg-transparent font-mono text-fg/85 outline-none placeholder:text-[color:var(--kit-text-3)]"
          value={linear.parent}
          disabled={parent?.provider === "linear"}
          onChange={(event) => setLinear((current) => ({ ...current, parent: event.target.value.toUpperCase() }))}
        />
      </label>
    </>
  );

  /* GitHub chips */
  const ghPeople = repoCatalog?.people ?? [];
  const ghLabels = repoCatalog?.labels ?? [];
  const ghMilestones = repoCatalog?.milestones ?? [];
  const githubChips = (
    <>
      <ChipPicker
        label="Labels"
        display={github.labels.length ? (github.labels.length === 1 ? github.labels[0]! : `${github.labels.length} labels`) : "Labels"}
        muted={!github.labels.length}
        multi
        options={ghLabels.map((label) => ({ id: label.name, label: label.name, icon: <span className="block h-2 w-2 rounded-full" style={{ backgroundColor: label.color ?? "var(--kit-fill)" }} /> }))}
        selected={github.labels}
        placeholder={repoCatalog ? "Labels…" : "Loading labels…"}
        onPick={(id) => setGitHub((current) => ({ ...current, labels: toggle(current.labels, id) }))}
      />
      <ChipPicker
        label="Assignees"
        display={github.assignees.length ? (github.assignees.length === 1 ? github.assignees[0]! : `${github.assignees.length} people`) : "Assignees"}
        muted={!github.assignees.length}
        multi
        options={ghPeople.map((person) => ({ id: person.login, label: person.login, icon: <LinearAssigneeAvatar name={person.login} avatarUrl={person.avatarUrl} size={14} /> }))}
        selected={github.assignees}
        placeholder={repoCatalog ? "Assign people…" : "Loading people…"}
        onPick={(id) => setGitHub((current) => ({ ...current, assignees: toggle(current.assignees, id) }))}
      />
      {ghMilestones.length ? (
        <ChipPicker
          label="Milestone"
          display={ghMilestones.find((entry) => entry.number === github.milestone)?.title ?? "Milestone"}
          muted={github.milestone == null}
          options={[{ id: "", label: "No milestone" }, ...ghMilestones.map((entry) => ({ id: String(entry.number), label: entry.title }))]}
          selected={[github.milestone == null ? "" : String(github.milestone)]}
          placeholder="Milestone…"
          onPick={(id) => setGitHub((current) => ({ ...current, milestone: id ? Number(id) : null }))}
        />
      ) : null}
      {createCatalog.types.length ? (
        <ChipPicker
          label="Type"
          display={github.type ?? "Type"}
          muted={!github.type}
          options={[{ id: "", label: "No type" }, ...createCatalog.types.map((entry) => ({ id: entry.name, label: entry.name }))]}
          selected={[github.type ?? ""]}
          placeholder="Issue type…"
          onPick={(id) => setGitHub((current) => ({ ...current, type: id || null }))}
        />
      ) : null}
    </>
  );

  const githubMore = (
    <label className="inline-flex h-7 items-center gap-1.5 rounded-md border border-fg/[0.08] px-2 text-[11.5px] text-[color:var(--kit-text-3)]">
      Parent
      <input
        aria-label="Parent issue number"
        placeholder="#123"
        className="w-[64px] bg-transparent font-mono text-fg/85 outline-none placeholder:text-[color:var(--kit-text-3)]"
        value={github.parent}
        disabled={parent?.provider === "github"}
        onChange={(event) => setGitHub((current) => ({ ...current, parent: event.target.value }))}
      />
    </label>
  );

  /* Template chip */
  const templateOptions: PickerOption[] = provider === "linear"
    ? [{ id: "", label: "No template" }, ...(createOptions?.templates ?? []).map((entry) => ({ id: entry.id, label: entry.name }))]
    : [
      ...(createCatalog.templates?.blankIssuesEnabled !== false ? [{ id: "", label: "Blank issue" }] : []),
      ...templates.map((entry) => ({ id: entry.key, label: entry.name, keywords: entry.about ?? "" })),
    ];
  const templateLabel = provider === "linear" ? linearTemplate?.name ?? null : template?.name ?? null;
  const hasTemplates = provider === "linear" ? (createOptions?.templates.length ?? 0) > 0 : templates.length > 0;

  const scopeLabel = provider === "linear" ? null : repo ? `${repo.owner}/${repo.name}` : "No GitHub repository";

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="New issue"
      hideHeader
      size="lg"
      bodyPadding={false}
      scrollBody={false}
      preventAutoFocus
      testId="issue-create"
    >
      <div
        className="flex max-h-[min(720px,calc(100vh-64px))] flex-col"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (isMacRuntimeTarget() ? event.metaKey : event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <header className="kit-card-head border-b border-[color:var(--kit-rule)]">
          {parent ? (
            provider === "linear" ? <LinearMark size={14} /> : <GithubLogo size={14} weight="fill" />
          ) : (
            <div className="kit-seg" data-case="sentence" role="group" aria-label="Tracker">
              <button type="button" className="inline-flex items-center gap-1" aria-pressed={provider === "linear"} onClick={() => setProvider("linear")}>
                <LinearMark size={11} /> Linear
              </button>
              <button type="button" className="inline-flex items-center gap-1" aria-pressed={provider === "github"} onClick={() => setProvider("github")}>
                <GithubLogo size={11} weight="fill" /> GitHub
              </button>
            </div>
          )}
          {provider === "linear" ? (
            <ChipPicker
              label="Team"
              display={teamKey ?? "Team"}
              options={teams.map((team) => ({ id: team.key, label: `${team.key} · ${team.name}` }))}
              selected={teamKey ? [teamKey] : []}
              placeholder="Team…"
              onPick={(id) => setLinear((current) => ({ ...current, teamKey: id, stateId: null, labelIds: [], projectId: null, milestoneId: null, cycleId: null, templateId: null }))}
            />
          ) : (
            <span className="truncate text-[12px] text-[color:var(--kit-text-2)]">{scopeLabel}</span>
          )}
          <span className="text-[color:var(--kit-text-3)]">›</span>
          <span className="text-[12px]">{parent ? `New sub-issue of ${parent.provider === "linear" ? parent.identifier : `#${parent.number}`}` : "New issue"}</span>
          <span className="ml-auto flex items-center gap-1">
            {hasTemplates ? (
              <ChipPicker
                label="Template"
                display={templateLabel ?? (templateRequired ? "Pick a template" : "Template")}
                muted={!templateLabel}
                options={templateOptions}
                selected={[provider === "linear" ? linear.templateId ?? "" : github.templateKey ?? ""]}
                placeholder="Template…"
                onPick={(id) => {
                  if (provider === "linear") applyLinearTemplate(id || null);
                  else applyGitHubTemplate(templates.find((entry) => entry.key === id) ?? null);
                }}
              />
            ) : null}
            <button type="button" className="kit-icon-btn" aria-label="Close" title="Close (Esc). The draft is kept." onClick={onClose}>
              <X size={13} />
            </button>
          </span>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3 pt-4">
          <input
            ref={titleRef}
            autoFocus
            aria-label="Issue title"
            placeholder="Issue title"
            className="w-full bg-transparent text-[19px] font-semibold tracking-[-0.01em] text-fg outline-none placeholder:text-[color:var(--kit-text-3)] focus:!shadow-none"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          {similar.length ? (
            <div className="mt-2 flex flex-col gap-0.5 rounded-md border border-[color:var(--kit-panel-edge)] bg-[color:var(--kit-panel-bg)] px-2 py-1.5">
              <div className="kit-eyebrow">Similar open issues</div>
              {similar.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[12px] hover:bg-[color:var(--kit-hover)]"
                  title="Open it. Your draft is kept."
                  onClick={() => {
                    entry.open();
                    onClose();
                  }}
                >
                  {entry.icon}
                  <span className="kit-num shrink-0 text-[11px] text-[color:var(--kit-text-2)]">{entry.label}</span>
                  <span className="truncate text-fg/85">{entry.title}</span>
                </button>
              ))}
            </div>
          ) : null}

          {formTemplate ? (
            <GitHubIssueFormFields template={formTemplate} answers={formAnswers} onChange={setFormAnswers} />
          ) : (
            <div
              className="relative mt-3"
              onDragOver={(event) => {
                if ([...event.dataTransfer.types].includes("Files")) event.preventDefault();
              }}
              onDrop={(event) => {
                const files = imageFiles(event.dataTransfer.files);
                if (!files.length) return;
                event.preventDefault();
                void addPictures(files);
              }}
            >
              <textarea
                ref={bodyRef}
                aria-label="Issue description"
                placeholder="Add a description… (Markdown; paste or drop pictures)"
                className="min-h-[160px] w-full resize-y bg-transparent text-[13px] leading-relaxed text-fg/90 outline-none placeholder:text-[color:var(--kit-text-3)] focus:!shadow-none"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                onPaste={(event) => {
                  const files = imageFiles(event.clipboardData.files);
                  if (!files.length) return;
                  event.preventDefault();
                  void addPictures(files);
                }}
              />
            </div>
          )}

          {provider === "github" && attachments.length ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {attachments.map((attachment, index) => (
                <span key={`${attachment.filename}-${index}`} className="inline-flex h-6 items-center gap-1 rounded-md border border-fg/[0.08] px-1.5 text-[11px] text-fg/80">
                  <ImageIcon size={11} />
                  <span className="max-w-[160px] truncate">{attachment.filename}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.filename}`}
                    className="text-[color:var(--kit-text-3)] hover:text-fg"
                    onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                  >
                    <X size={9} weight="bold" />
                  </button>
                </span>
              ))}
              <span className="text-[11px] text-[color:var(--kit-text-3)]">Uploaded with the issue through GitHub CLI.</span>
            </div>
          ) : null}
          {uploads > 0 ? (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-[color:var(--kit-text-3)]">
              <CircleNotch size={11} className="animate-spin" /> Uploading {uploads === 1 ? "a picture" : `${uploads} pictures`}…
            </div>
          ) : null}
          {contextFooter ? (
            <p className="mt-2 text-[11px] text-[color:var(--kit-text-3)]">A “Context” footer links this issue back to the chat.</p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-t border-[color:var(--kit-rule)] px-4 py-2.5">
          {provider === "linear" ? linearChips : githubChips}
          <button
            type="button"
            className="kit-icon-btn"
            aria-label={showMore ? "Fewer fields" : "More fields"}
            title={showMore ? "Fewer fields" : "More fields"}
            aria-pressed={showMore}
            onClick={() => setShowMore((value) => !value)}
          >
            <DotsThree size={14} weight="bold" />
          </button>
          {showMore ? (
            <div className="flex w-full flex-wrap items-center gap-1.5">
              {provider === "linear" ? linearMore : githubMore}
            </div>
          ) : null}
        </div>

        <footer className="flex items-center gap-2 border-t border-[color:var(--kit-rule)] px-4 py-2.5">
          <label className="flex items-center gap-1.5 text-[11.5px] text-[color:var(--kit-text-2)]">
            <input type="checkbox" checked={createMore} onChange={(event) => setCreateMore(event.target.checked)} />
            Create more
          </label>
          {error ? <span role="alert" className="min-w-0 flex-1 truncate text-[11.5px] text-[color:var(--kit-crit)]" title={error}>{error}</span> : <span className="flex-1" />}
          <span className="text-[11px] text-[color:var(--kit-text-3)]">{MOD()}↵</span>
          <button
            type="button"
            className="kit-btn kit-btn-primary"
            disabled={busy || uploads > 0 || (provider === "github" && !repo)}
            onClick={() => void submit()}
          >
            {busy ? <CircleNotch size={12} className="animate-spin" /> : null}
            Create issue
          </button>
        </footer>
      </div>
    </Dialog>
  );
}

/** An issue form's fields as native controls. */
function GitHubIssueFormFields({
  template,
  answers,
  onChange,
}: {
  template: GitHubIssueTemplate;
  answers: GitHubIssueFormAnswers;
  onChange: (next: GitHubIssueFormAnswers) => void;
}) {
  const set = (index: number, value: GitHubIssueFormAnswers[number]) => onChange({ ...answers, [index]: value });
  return (
    <div className="mt-3 flex flex-col gap-4">
      {template.fields.map((field, index) => {
        if (field.type === "markdown") {
          return <p key={index} className="whitespace-pre-wrap text-[12px] text-[color:var(--kit-text-2)]">{field.value}</p>;
        }
        const heading = (
          <div className="mb-1 text-[12.5px] font-medium text-fg/90">
            {field.label}
            {"required" in field && field.required ? <span className="ml-1 text-[color:var(--kit-crit)]">*</span> : null}
            {field.description ? <div className="text-[11.5px] font-normal text-[color:var(--kit-text-3)]">{field.description}</div> : null}
          </div>
        );
        if (field.type === "input") {
          return (
            <label key={index} className="block">
              {heading}
              <input
                className="ade-dialog-input"
                placeholder={field.placeholder ?? undefined}
                value={String(answers[index] ?? "")}
                onChange={(event) => set(index, event.target.value)}
              />
            </label>
          );
        }
        if (field.type === "textarea") {
          return (
            <label key={index} className="block">
              {heading}
              <textarea
                className="ade-dialog-input !h-auto min-h-[88px] resize-y py-2"
                placeholder={field.placeholder ?? undefined}
                value={String(answers[index] ?? "")}
                onChange={(event) => set(index, event.target.value)}
              />
            </label>
          );
        }
        if (field.type === "dropdown") {
          const chosen = Array.isArray(answers[index]) ? answers[index] as string[] : [];
          return (
            <div key={index}>
              {heading}
              <div className="flex flex-wrap gap-1.5">
                {field.options.map((option) => {
                  const on = chosen.includes(option);
                  return (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={on}
                      className={cn(
                        "h-7 rounded-md border px-2 text-[11.5px]",
                        on ? "border-[color:var(--color-accent)] bg-[color:var(--kit-active)] text-fg" : "border-fg/[0.1] text-fg/80 hover:bg-[color:var(--kit-hover)]",
                      )}
                      onClick={() => set(index, field.multiple ? toggle(chosen, option) : on ? [] : [option])}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        }
        if (field.type !== "checkboxes") return null;
        const checked = Array.isArray(answers[index]) ? answers[index] as boolean[] : [];
        return (
          <div key={index}>
            {heading}
            <div className="flex flex-col gap-1">
              {field.options.map((option, optionIndex) => (
                <label key={option.label} className="flex items-start gap-2 text-[12px] text-fg/85">
                  <input
                    type="checkbox"
                    className="mt-[3px]"
                    checked={Boolean(checked[optionIndex])}
                    onChange={(event) => {
                      const next = [...checked];
                      next[optionIndex] = event.target.checked;
                      set(index, next);
                    }}
                  />
                  <span>
                    {option.label}
                    {option.required ? <span className="ml-1 text-[color:var(--kit-crit)]">*</span> : null}
                  </span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export type { CtoGetLinearIssuePickerDataResult };
