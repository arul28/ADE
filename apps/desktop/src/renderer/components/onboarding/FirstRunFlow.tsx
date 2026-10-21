import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowsOut,
  Check,
  CircleNotch,
  Desktop,
  FolderSimple,
  Plus,
  X,
} from "@phosphor-icons/react";
import {
  EXTERNAL_SESSION_PROVIDER_LABELS,
  type ExternalSessionProvider,
  type OnboardingProjectCandidate,
  type OnboardingProjectDiscovery,
} from "../../../shared/types";
import { ADE_MOBILE_TESTFLIGHT_URL } from "../../../shared/productLinks";
import { relativeWhen } from "../../lib/format";
import { queueChatImports } from "../../onboarding/pendingChatImports";
import { useAppStore } from "../../state/appStore";
import { ProviderLogo } from "../shared/ProviderLogos";
import { AdeQrCode } from "../ui/AdeQrCode";
import { firstRunAgents } from "./firstRunAgentModel";
import "./firstRun.css";

/**
 * ADE's first run on a computer, after (or around) sign-in:
 *
 * 1. **Welcome**: the landing page's promise in one card and one button.
 * 2. **Connect your agents** (`FirstRunAgents.tsx`): which coding agents can
 *    run here, with sign-in for the ones that cannot.
 * 3. **Bring your projects in**: the git projects any coding agent ADE can
 *    import from (Claude Code, Codex, Cursor, OpenCode…) has worked in on this
 *    computer, already found and mostly ticked. Adding them adds them to
 *    Home's recent projects; the first open of each turns its worktrees into
 *    lanes. Each row with recent chats has its own "Import N chats?" toggle;
 *    the ones turned on bring their chats in on that first open
 *    (`useOnboardingChatImport`).
 *
 * Both cards sit on the launch gate's glass (`.ade-gate` tokens), so they read
 * as one flow with the sign-in card between them.
 */

/** Chats active in this window come in with their project. Matches the main-side count. */
export const FIRST_RUN_CHAT_WINDOW_MS = 30 * 24 * 3_600_000;

export function FirstRunWelcome({ onStart, onSkip }: { onStart: () => void; onSkip: () => void }) {
  const agents = useMemo(() => firstRunAgents(), []);
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
      <ul className="ade-fr-providers" aria-label="Coding agents ADE runs">
        {agents.map((agent, index) => (
          <li
            key={agent.id}
            className="ade-fr-provider"
            data-logo={agent.logo}
            title={agent.label}
            aria-label={agent.label}
            style={{ animationDelay: `${180 + index * 30}ms` }}
          >
            <ProviderLogo family={agent.logo} size={16} />
          </li>
        ))}
      </ul>
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

/**
 * One discovery per setup run, started as early as the flow knows it will
 * need it (the agents step), so "Bring your projects in" usually opens with
 * its list already there. `fresh` starts over (a replay from the help menu).
 */
let discoveryPromise: Promise<OnboardingProjectDiscovery> | null = null;

export function prefetchOnboardingDiscovery(options: { fresh?: boolean } = {}): Promise<OnboardingProjectDiscovery> | null {
  const discover = window.ade.app.discoverOnboardingProjects;
  if (!discover) return null;
  if (options.fresh || !discoveryPromise) {
    discoveryPromise = discover().catch((error: unknown) => {
      discoveryPromise = null;
      throw error;
    });
  }
  return discoveryPromise;
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

/** What setup added: every root, in the order shown. */
export type FirstRunResult = { rootPaths: string[] };

/**
 * Adds the chosen projects to this computer's recent projects and queues the
 * chats of the ones whose import pill is on for each one's first open.
 */
export async function addFirstRunProjects(
  projects: OnboardingProjectCandidate[],
  importRoots: ReadonlySet<string>,
): Promise<FirstRunResult> {
  const add = window.ade.app.addOnboardingProjects;
  if (!projects.length || !add) return { rootPaths: [] };
  await add(projects.map((project) => project.rootPath));
  queueChatImports(
    projects
      .filter((project) => project.recentChatCount > 0 && importRoots.has(project.rootPath))
      .map((project) => project.rootPath),
    Date.now() - FIRST_RUN_CHAT_WINDOW_MS,
  );
  return { rootPaths: projects.map((project) => project.rootPath) };
}

/**
 * Where setup lands: ADE's own start, never a project. With no project open
 * (a first run) that is Home, whose recent projects already list what setup
 * added, so nothing more happens here. A replay over an open project keeps it
 * open and adds the new ones as tabs beside it, unopened.
 */
export function showFirstRunProjects(result: FirstRunResult): void {
  if (!result.rootPaths.length) return;
  const store = useAppStore.getState();
  if (!store.project) return;
  store.setOpenProjectTabRoots((current) => [
    ...current,
    ...result.rootPaths.filter((rootPath) => !current.includes(rootPath)),
  ]);
}

export function FirstRunProjects({
  onDone,
  onSkip,
}: {
  /** Setup is finished; `result` names what it added (possibly nothing). */
  onDone: (result: FirstRunResult) => void;
  /** "Skip": add nothing and go on. */
  onSkip: () => void;
}) {
  const [discovery, setDiscovery] = useState<DiscoveryState>({ phase: "loading" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Projects whose import pill is on: their recent chats come in on first open. */
  const [importing, setImporting] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const discovery = prefetchOnboardingDiscovery();
    if (!discovery) {
      setDiscovery({ phase: "unavailable" });
      return;
    }
    void discovery
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

  // Importing a project's chats means adding the project too.
  const setImport = useCallback((rootPath: string, on: boolean) => {
    setImporting((current) => {
      const next = new Set(current);
      if (on) next.add(rootPath);
      else next.delete(rootPath);
      return next;
    });
    if (on) setSelected((picked) => (picked.has(rootPath) ? picked : new Set(picked).add(rootPath)));
  }, []);
  const [qrOpen, setQrOpen] = useState(false);
  const openQr = useCallback(() => setQrOpen(true), []);
  const closeQr = useCallback(() => setQrOpen(false), []);

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
      onDone(await addFirstRunProjects(chosen, importing));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }, [chosen, importing, onDone]);

  const chatTotal = chosen.reduce(
    (sum, project) => sum + (importing.has(project.rootPath) ? project.recentChatCount : 0),
    0,
  );
  const laneTotal = chosen.reduce((sum, project) => sum + project.laneCount, 0);

  return (
    <div className="ade-glass-card ade-fr-projects" data-testid="first-run-projects">
      <header className="ade-fr-head">
        <span className="ade-fr-eyebrow">{machineName ? `Set up ${machineName}` : "Set up this computer"}</span>
        <h1 className="ade-fr-title">Bring your projects in</h1>
        <p className="ade-fr-sub">
          Projects your coding agents have worked in. Their worktrees open as lanes, and you can bring their
          recent chats along when each one opens.
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
                  importing={importing.has(project.rootPath)}
                  onToggle={toggle}
                  onSetImport={setImport}
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

      <DevicesStrip onExpandQr={openQr} />

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
                chatTotal ? `${pluralize(chatTotal, "chat", "chats")} to import` : null,
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

      {qrOpen ? <PhoneQrLightbox onClose={closeQr} /> : null}
    </div>
  );
}

function ProjectRow({
  project,
  checked,
  importing,
  onToggle,
  onSetImport,
  index,
}: {
  project: OnboardingProjectCandidate;
  checked: boolean;
  importing: boolean;
  onToggle: (rootPath: string) => void;
  onSetImport: (rootPath: string, on: boolean) => void;
  index: number;
}) {
  const icon = useProjectIcon(project.rootPath);
  const meta = [
    project.laneCount ? pluralize(project.laneCount, "lane", "lanes") : null,
    project.lastActiveAt ? relativeWhen(new Date(project.lastActiveAt).toISOString()) : null,
  ].filter(Boolean);
  const chats = project.recentChatCount;
  const chatsLabel = pluralize(chats, "chat", "chats");
  // A project left out brings no chats, whatever its toggle said before.
  const importOn = importing && checked;
  return (
    <div
      className="ade-fr-row"
      data-checked={checked ? "true" : undefined}
      style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
    >
      <button
        type="button"
        className="ade-fr-row-main"
        aria-pressed={checked}
        onClick={() => onToggle(project.rootPath)}
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
        {meta.length ? <span className="ade-fr-meta">{meta.join(" · ")}</span> : null}
      </button>
      {chats > 0 ? (
        // A yes/no choice, not an action: it reads as a question while off and
        // as a ticked "Importing" while on, and nothing imports until Add.
        <button
          type="button"
          role="checkbox"
          className="ade-fr-import"
          data-on={importOn ? "true" : undefined}
          aria-checked={importOn}
          aria-label={
            `Import ${pluralize(chats, "recent chat", "recent chats")} from ${providerList(project.providers)}`
          }
          title={
            importOn
              ? "These chats come in when the project first opens. Click to leave them out."
              : "Bring the last 30 days of chats in when the project first opens, each in the lane it ran in."
          }
          onClick={() => onSetImport(project.rootPath, !importOn)}
        >
          <span className="ade-fr-import-box" aria-hidden="true">
            <Check size={10} weight="bold" />
          </span>
          <span className="ade-fr-import-marks" aria-hidden="true">
            {project.providers.slice(0, MAX_ROW_MARKS).map((provider) => (
              <ProviderLogo key={provider} family={provider} size={13} />
            ))}
            {project.providers.length > MAX_ROW_MARKS ? (
              <span className="ade-fr-marks-more">+{project.providers.length - MAX_ROW_MARKS}</span>
            ) : null}
          </span>
          <span className="ade-fr-import-label">
            {importOn ? `Importing ${chatsLabel}` : `Import ${chatsLabel}?`}
          </span>
        </button>
      ) : null}
    </div>
  );
}

/** Provider marks a row shows before folding the rest into "+N". */
const MAX_ROW_MARKS = 3;

function providerList(providers: readonly ExternalSessionProvider[]): string {
  const labels = providers.map((provider) => EXTERNAL_SESSION_PROVIDER_LABELS[provider]);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
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

const PHONE_QR_TITLE = "Install ADE on your iPhone";

/**
 * The cross-machine half of tier one, shown to everyone: ADE is the same on
 * every device you sign in to. A QR for the phone (click for a bigger one),
 * one line for a computer.
 */
function DevicesStrip({ onExpandQr }: { onExpandQr: () => void }) {
  return (
    <section className="ade-fr-devices" aria-label="Your other devices">
      <div className="ade-fr-device">
        <button
          type="button"
          className="ade-fr-qr"
          aria-label="Show a larger QR code for ADE on iPhone"
          title="Show larger"
          onClick={onExpandQr}
        >
          <AdeQrCode value={ADE_MOBILE_TESTFLIGHT_URL} title={PHONE_QR_TITLE} size={58} />
          <span className="ade-fr-qr-zoom" aria-hidden="true">
            <ArrowsOut size={11} weight="bold" />
          </span>
        </button>
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

/**
 * The phone QR, big enough to scan from across a desk, over the projects card's
 * own glass. Escape, the close button or a click outside the code closes it.
 * Escape is caught before setup's own Escape-to-skip (`OnboardingBootstrap`)
 * sees it, so closing the code never skips setup.
 */
function PhoneQrLightbox({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    // Capture on window runs before setup's bubble-phase listener on window.
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      opener?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="ade-fr-qr-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="ADE for iPhone"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="ade-fr-qr-panel">
        <button
          ref={closeRef}
          type="button"
          className="ade-fr-qr-close"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={13} weight="bold" />
        </button>
        <span className="ade-fr-qr-big">
          <AdeQrCode value={ADE_MOBILE_TESTFLIGHT_URL} title={PHONE_QR_TITLE} size={196} />
        </span>
        <span className="ade-fr-qr-caption">
          <span className="ade-fr-device-title">ADE for iPhone</span>
          <span className="ade-fr-device-sub">Point your iPhone camera at the code to install it.</span>
        </span>
      </div>
    </div>
  );
}
