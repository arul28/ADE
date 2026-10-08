import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleNotch, DotsThree, GithubLogo, Image as ImageIcon, X } from "@phosphor-icons/react";
import type { GitHubIssueAttachmentInput, LinearIssueCreateOptions, LinearProjectMilestone } from "../../../shared/types";
import { buildDeeplink } from "../../../shared/deeplinks";
import type { GitHubIssueFormAnswers, GitHubIssueTemplate } from "../../../shared/githubIssueTemplates";
import { isMacRuntimeTarget } from "../../lib/platform";
import { openIssueRef } from "../../lib/issueNavigation";
import { requestLinearIssueLaunch } from "../../lib/linearLaunchRequests";
import { announceIssueCreated, type IssueCreateRequest } from "../../lib/issueCreateRequests";
import { showToast } from "../app/toast/toastStore";
import { LinearMark } from "../lanes/linearBrand";
import { Dialog } from "../ui/dialog";
import { GitHubIssueFormFields } from "./GitHubIssueFormFields";
import {
  loadGitHubRepoCatalog,
  noteGitHubIssueCreated,
  useGitHubCreateCatalog,
  useGitHubRepoCatalog,
  useProjectGitHubRepo,
} from "./githubIssueStore";
import { requestGitHubIssueLaunch } from "./githubIssueLaunch";
import {
  ChipPicker,
  GitHubCreateChips,
  GitHubMoreFields,
  LinearCreateChips,
  LinearMoreFields,
  linearTeamProjects,
} from "./issueCreateChips";
import {
  initialIssueForm,
  rememberIssueProvider,
  writeIssueDraft,
  type GitHubFields,
  type IssueDraft,
  type IssueProvider,
  type LinearFields,
} from "./issueCreateDraft";
import { submitGitHubIssue, submitLinearIssue } from "./issueCreateSubmit";
import type { PickerOption } from "./IssuePickerMenu";
import { useActiveProjectRoot } from "../../state/appStore";
import { useLinearPickerCatalog } from "./linearIssueStore";
import { useSimilarIssues } from "./useSimilarIssues";

/**
 * Starting a new issue in Linear or GitHub, in one composer: a big title, the
 * description, a row of property chips (the same pickers the viewer uses), and
 * a `⋯` row for the fields most issues skip. Templates fill it in; a GitHub
 * issue form replaces the description with its own fields.
 *
 * - The draft is saved per tracker and project while you type, and cleared on
 *   create (`issueCreateDraft.ts`).
 * - Pictures pasted or dropped into the description upload to Linear at once,
 *   or go to GitHub with the issue through `gh --attach`.
 * - Similar open issues ADE already read show under the title, without a
 *   request, so a duplicate is caught before it is filed.
 * - An issue started from a chat gets a "Context" footer linking back to it.
 */

const MOD = () => (isMacRuntimeTarget() ? "⌘" : "Ctrl");

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

export function IssueCreateDialog({ request, onClose }: { request: IssueCreateRequest; onClose: () => void }) {
  const projectRoot = useActiveProjectRoot();
  const parent = request.prefill?.parent ?? null;
  // One read of the draft for the whole form, keyed to this project.
  const [initial] = useState(() => initialIssueForm(request, projectRoot));
  const [provider, setProvider] = useState<IssueProvider>(initial.provider);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [linear, setLinear] = useState<LinearFields>(initial.linear);
  const [github, setGitHub] = useState<GitHubFields>(initial.github);
  const [formAnswers, setFormAnswers] = useState<GitHubIssueFormAnswers>(initial.formAnswers);
  const draftRef = useRef<IssueDraft | null>(null);
  const providerRef = useRef(provider);
  providerRef.current = provider;
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
    rememberIssueProvider(provider);
  }, [provider]);
  useEffect(() => {
    draftRef.current = { title, body, linear, github, formAnswers };
    const timer = window.setTimeout(() => writeIssueDraft(provider, projectRoot, draftRef.current), 400);
    return () => window.clearTimeout(timer);
  }, [body, formAnswers, github, linear, projectRoot, provider, title]);
  // Closing inside the 400 ms window must not lose the last keystrokes. A
  // create clears `draftRef` first, so nothing is written back after it.
  useEffect(() => () => {
    if (draftRef.current) writeIssueDraft(providerRef.current, projectRoot, draftRef.current);
  }, [projectRoot]);

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
  // A sub-issue goes where its parent is, which need not be this project's repo.
  const { repo: projectRepo } = useProjectGitHubRepo();
  const parentRepo = useMemo(
    () => (parent?.provider === "github" ? { owner: parent.owner, name: parent.repo } : null),
    [parent],
  );
  const repo = parentRepo ?? projectRepo;
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
  const similar = useSimilarIssues(provider, repo, title);

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
    draftRef.current = null;
    writeIssueDraft(provider, projectRoot, null);
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
        const issue = await submitLinearIssue({ teamKey, title: trimmed, description: `${body}${contextFooter}`, fields: linear });
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
        const { issue, warnings } = await submitGitHubIssue({
          repo,
          title: trimmed,
          body,
          contextFooter,
          fields: github,
          template,
          templateRequired,
          formAnswers,
          attachments,
        });
        noteGitHubIssueCreated(projectRoot, issue);
        // A warning (not linked under the parent, fields not set) is worth reading.
        showToast({
          tone: warnings.length ? "warning" : "success",
          title: `Created #${issue.number}`,
          message: warnings.length ? warnings.join(" ") : issue.title,
          ...(warnings.length ? { durationMs: 18_000 } : {}),
          actions: [{ label: "Start lane", onClick: () => requestGitHubIssueLaunch(issue) }],
        });
        announceIssueCreated({ provider: "github", owner: issue.owner, repo: issue.repo, number: issue.number });
        if (!createMore && request.origin !== "pane") {
          openIssueRef({ ref: { provider: "github", owner: issue.owner, repo: issue.repo, number: issue.number, url: issue.url }, source: "issue-viewer" });
        }
      }
      if (createMore) reset();
      else {
        draftRef.current = null;
        writeIssueDraft(provider, projectRoot, null);
        onClose();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The issue was not created.");
    } finally {
      setBusy(false);
    }
  };

  const project = linearTeamProjects(catalog, teamKey).find((entry) => entry.id === linear.projectId) ?? null;
  const linearTemplate = createOptions?.templates.find((entry) => entry.id === linear.templateId) ?? null;

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
          {provider === "linear"
            ? <LinearCreateChips linear={linear} setLinear={setLinear} catalog={catalog} teamKey={teamKey} />
            : <GitHubCreateChips github={github} setGitHub={setGitHub} repoCatalog={repoCatalog} types={createCatalog.types} />}
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
              {provider === "linear" ? (
                <LinearMoreFields
                  linear={linear}
                  setLinear={setLinear}
                  hasProject={project != null}
                  milestones={milestones}
                  createOptions={createOptions}
                  parentLocked={parent?.provider === "linear"}
                />
              ) : (
                <GitHubMoreFields github={github} setGitHub={setGitHub} parentLocked={parent?.provider === "github"} />
              )}
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
