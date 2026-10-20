import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  CircleNotch,
  Desktop,
  FolderSimple,
  Plus,
} from "@phosphor-icons/react";
import type { OnboardingProjectCandidate } from "../../../shared/types";
import { ADE_MOBILE_TESTFLIGHT_URL } from "../../../shared/productLinks";
import { relativeWhen } from "../../lib/format";
import { queueChatImports } from "../../onboarding/pendingChatImports";
import { useAppStore } from "../../state/appStore";
import { ProviderLogo } from "../shared/ProviderLogos";
import { AdeQrCode } from "../ui/AdeQrCode";
import "./firstRun.css";

/**
 * ADE's first run on a computer, after (or around) sign-in:
 *
 * 1. **Welcome**: the landing page's promise in one card and one button.
 * 2. **Bring your projects in**: the git projects Claude Code and Codex have
 *    worked in on this computer, already found and mostly ticked. Adding them
 *    adds their tabs; the first open of each turns its worktrees into lanes and
 *    brings its chats from the last 30 days in as ADE chats.
 *
 * Both cards sit on the launch gate's glass (`.ade-gate` tokens), so they read
 * as one flow with the sign-in card between them.
 */

/** Chats active in this window come in with their project. Matches the main-side count. */
export const FIRST_RUN_CHAT_WINDOW_MS = 30 * 24 * 3_600_000;

const WELCOME_PROVIDERS = ["claude", "codex", "cursor", "opencode", "gemini", "droid"] as const;

export function FirstRunWelcome({ onStart, onSkip }: { onStart: () => void; onSkip: () => void }) {
  return (
    <div className="ade-glass-card ade-fr-welcome" data-testid="first-run-welcome">
      <span className="ade-glass-mark">
        <img src="./logo.png" alt="ADE" draggable={false} />
      </span>
      <h1 className="ade-fr-headline">
        <em>Every</em> AI coding tool.
        <br />
        <em>One</em> app that runs <span className="ade-fr-everywhere">everywhere</span>.
      </h1>
      <p className="ade-fr-lede">
        Run Claude, Codex, Cursor and more side by side, each chat in its own lane, on every computer
        and phone you sign in to.
      </p>
      <div className="ade-fr-providers" aria-hidden="true">
        {WELCOME_PROVIDERS.map((family, index) => (
          <span key={family} className="ade-fr-provider" style={{ animationDelay: `${180 + index * 45}ms` }}>
            <ProviderLogo family={family} size={18} />
          </span>
        ))}
      </div>
      <div className="ade-fr-welcome-actions">
        <button type="button" className="ade-glass-primary ade-fr-cta" onClick={onStart} autoFocus>
          Get started
          <ArrowRight size={16} weight="bold" className="ade-glass-primary-arrow" />
        </button>
        <button type="button" className="ade-glass-link" onClick={onSkip}>
          Skip setup
        </button>
      </div>
    </div>
  );
}

type DiscoveryState =
  | { phase: "loading" }
  | { phase: "ready"; machineName: string; projects: OnboardingProjectCandidate[] }
  | { phase: "unavailable" };

function pluralize(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function folderCandidate(rootPath: string): OnboardingProjectCandidate {
  return {
    rootPath,
    name: rootPath.split(/[\\/]/).filter(Boolean).pop() ?? rootPath,
    repoLabel: null,
    chatCount: 0,
    recentChatCount: 0,
    lastActiveAt: null,
    providers: [],
    laneCount: 0,
    suggested: true,
  };
}

/** What setup added: every root, in the order shown, the first being the one to open. */
export type FirstRunResult = { rootPaths: string[] };

/**
 * Adds the chosen projects to this computer's recent projects and leaves their
 * chats queued for each one's first open.
 */
export async function addFirstRunProjects(projects: OnboardingProjectCandidate[]): Promise<FirstRunResult> {
  const add = window.ade.app.addOnboardingProjects;
  if (!projects.length || !add) return { rootPaths: [] };
  await add(projects.map((project) => project.rootPath));
  queueChatImports(
    projects.filter((project) => project.recentChatCount > 0).map((project) => project.rootPath),
    Date.now() - FIRST_RUN_CHAT_WINDOW_MS,
  );
  return { rootPaths: projects.map((project) => project.rootPath) };
}

/**
 * Shows the added projects as tabs in this window and opens the first one,
 * unless a project is already open (a replay from the help menu), which stays.
 */
export function openFirstRunProjects(result: FirstRunResult): void {
  const [first] = result.rootPaths;
  if (!first) return;
  const store = useAppStore.getState();
  store.setOpenProjectTabRoots((current) => [
    ...current,
    ...result.rootPaths.filter((rootPath) => !current.includes(rootPath)),
  ]);
  if (!store.project) void window.ade.project.switchToPath(first).catch(() => undefined);
}

export function FirstRunProjects({
  onDone,
  onSkip,
}: {
  /** Setup is finished; `result` names what it added (possibly nothing). */
  onDone: (result: FirstRunResult) => void;
  onSkip: () => void;
}) {
  const [discovery, setDiscovery] = useState<DiscoveryState>({ phase: "loading" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const discover = window.ade.app.discoverOnboardingProjects;
    if (!discover) {
      setDiscovery({ phase: "unavailable" });
      return;
    }
    void discover()
      .then((result) => {
        if (cancelled) return;
        setDiscovery({ phase: "ready", machineName: result.machineName, projects: result.projects });
        setSelected(new Set(result.projects.filter((project) => project.suggested).map((project) => project.rootPath)));
      })
      .catch(() => {
        if (!cancelled) setDiscovery({ phase: "ready", machineName: "this computer", projects: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const projects = discovery.phase === "ready" ? discovery.projects : [];
  const machineName = discovery.phase === "ready" ? discovery.machineName : null;
  const chosen = useMemo(
    () => projects.filter((project) => selected.has(project.rootPath)),
    [projects, selected],
  );

  const toggle = useCallback((rootPath: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(rootPath)) next.delete(rootPath);
      else next.add(rootPath);
      return next;
    });
  }, []);

  const allSelected = projects.length > 0 && chosen.length === projects.length;
  const toggleAll = useCallback(() => {
    setSelected(allSelected ? new Set() : new Set(projects.map((project) => project.rootPath)));
  }, [allSelected, projects]);

  const addFolder = useCallback(async () => {
    const rootPath = await window.ade.project.chooseDirectory({ title: "Add a project" }).catch(() => null);
    if (!rootPath) return;
    setDiscovery((current) => {
      if (current.phase !== "ready") return current;
      if (current.projects.some((project) => project.rootPath === rootPath)) return current;
      return { ...current, projects: [...current.projects, folderCandidate(rootPath)] };
    });
    setSelected((current) => new Set(current).add(rootPath));
  }, []);

  const finish = useCallback(async () => {
    if (!chosen.length) {
      onDone({ rootPaths: [] });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onDone(await addFirstRunProjects(chosen));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }, [chosen, onDone]);

  const chatTotal = chosen.reduce((sum, project) => sum + project.recentChatCount, 0);
  const laneTotal = chosen.reduce((sum, project) => sum + project.laneCount, 0);

  return (
    <div className="ade-glass-card ade-fr-projects" data-testid="first-run-projects">
      <header className="ade-fr-head">
        <span className="ade-fr-eyebrow">{machineName ? `Set up ${machineName}` : "Set up this computer"}</span>
        <h1 className="ade-fr-title">Bring your projects in</h1>
        <p className="ade-fr-sub">
          Projects you've worked on with Claude Code and Codex. Their worktrees open as lanes, and chats from
          the last 30 days come with them.
        </p>
      </header>

      <section className="ade-fr-list" aria-label="Projects found on this computer">
        <div className="ade-fr-list-head">
          <span>
            {discovery.phase === "loading"
              ? "Looking for your projects…"
              : projects.length
                ? `${pluralize(projects.length, "project", "projects")} found`
                : "No projects found yet"}
          </span>
          {projects.length > 1 ? (
            <button type="button" className="ade-fr-text-btn" onClick={toggleAll}>
              {allSelected ? "Select none" : "Select all"}
            </button>
          ) : null}
        </div>

        <div className="ade-fr-rows" role="group" aria-label="Projects to add">
          {discovery.phase === "loading"
            ? [0, 1, 2].map((index) => <div key={index} className="ade-fr-row ade-fr-row--skeleton" aria-hidden="true" />)
            : projects.map((project, index) => (
                <ProjectRow
                  key={project.rootPath}
                  project={project}
                  checked={selected.has(project.rootPath)}
                  onToggle={toggle}
                  index={index}
                />
              ))}
          {discovery.phase !== "loading" && !projects.length ? (
            <div className="ade-fr-empty">
              <FolderSimple size={18} />
              <span>Choose a folder with a git repository to start.</span>
            </div>
          ) : null}
        </div>

        <button type="button" className="ade-fr-add" onClick={() => void addFolder()} disabled={busy}>
          <Plus size={13} weight="bold" />
          Add another folder
        </button>
      </section>

      <DevicesStrip />

      {error ? <div className="ade-glass-error">{error}</div> : null}

      <footer className="ade-fr-foot">
        <button type="button" className="ade-glass-link" onClick={onSkip} disabled={busy}>
          Skip
        </button>
        <span className="ade-fr-summary" aria-live="polite">
          {chosen.length
            ? [
                pluralize(chosen.length, "project", "projects"),
                laneTotal ? pluralize(laneTotal, "lane", "lanes") : null,
                chatTotal ? pluralize(chatTotal, "chat", "chats") : null,
              ].filter(Boolean).join(" · ")
            : null}
        </span>
        <button
          type="button"
          className="ade-glass-primary ade-fr-cta"
          onClick={() => void finish()}
          disabled={busy || discovery.phase === "loading"}
        >
          {busy ? <CircleNotch size={15} weight="bold" className="animate-spin" /> : null}
          {chosen.length ? `Add ${pluralize(chosen.length, "project", "projects")}` : "Open ADE"}
          {busy ? null : <ArrowRight size={16} weight="bold" className="ade-glass-primary-arrow" />}
        </button>
      </footer>
    </div>
  );
}

function ProjectRow({
  project,
  checked,
  onToggle,
  index,
}: {
  project: OnboardingProjectCandidate;
  checked: boolean;
  onToggle: (rootPath: string) => void;
  index: number;
}) {
  const icon = useProjectIcon(project.rootPath);
  const meta = [
    project.recentChatCount ? pluralize(project.recentChatCount, "recent chat", "recent chats") : null,
    project.laneCount ? pluralize(project.laneCount, "lane", "lanes") : null,
    project.lastActiveAt ? relativeWhen(new Date(project.lastActiveAt).toISOString()) : null,
  ].filter(Boolean);
  return (
    <button
      type="button"
      className="ade-fr-row"
      data-checked={checked ? "true" : undefined}
      aria-pressed={checked}
      onClick={() => onToggle(project.rootPath)}
      style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
      title={project.rootPath}
    >
      <span className="ade-fr-check" aria-hidden="true">
        {checked ? <Check size={11} weight="bold" /> : null}
      </span>
      <span className="ade-fr-icon" aria-hidden="true">
        {icon ? <img src={icon} alt="" draggable={false} /> : <FolderSimple size={16} weight="duotone" />}
      </span>
      <span className="ade-fr-name">
        <span className="ade-fr-name-main">{project.name}</span>
        <span className="ade-fr-name-sub">{project.repoLabel ?? project.rootPath}</span>
      </span>
      <span className="ade-fr-meta">
        {project.providers.length ? (
          <span className="ade-fr-marks" aria-label={`Chats from ${project.providers.join(" and ")}`}>
            {project.providers.map((provider) => (
              <ProviderLogo key={provider} family={provider} size={13} />
            ))}
          </span>
        ) : null}
        {meta.length ? <span>{meta.join(" · ")}</span> : null}
      </span>
    </button>
  );
}

function useProjectIcon(rootPath: string): string | null {
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.ade.project
      .resolveIcon(rootPath)
      .then((result) => {
        if (!cancelled) setIcon(result.dataUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [rootPath]);
  return icon;
}

/**
 * The cross-machine half of tier one, shown to everyone: ADE is the same on
 * every device you sign in to. A QR for the phone, one line for a computer.
 */
function DevicesStrip() {
  return (
    <section className="ade-fr-devices" aria-label="Your other devices">
      <div className="ade-fr-device">
        <span className="ade-fr-qr">
          <AdeQrCode value={ADE_MOBILE_TESTFLIGHT_URL} title="Install ADE on your iPhone" size={58} />
        </span>
        <span className="ade-fr-device-text">
          <span className="ade-fr-device-title">Your phone</span>
          <span className="ade-fr-device-sub">Scan to get ADE for iPhone.</span>
        </span>
      </div>
      <div className="ade-fr-device">
        <span className="ade-fr-device-glyph">
          <Desktop size={20} weight="duotone" />
        </span>
        <span className="ade-fr-device-text">
          <span className="ade-fr-device-title">Another computer</span>
          <span className="ade-fr-device-sub">Sign in to ADE there. Its chats and lanes show up here.</span>
        </span>
      </div>
    </section>
  );
}
