import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowsOut,
  CaretDown,
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
import { ONBOARDING_CHAT_WINDOW_DAYS, ONBOARDING_CHAT_WINDOW_MS } from "../../../shared/onboardingChatWindow";
import { basenameCrossPlatform } from "../../../shared/pathDisplay";
import { ADE_MOBILE_TESTFLIGHT_URL } from "../../../shared/productLinks";
import { extractError, relativeWhen } from "../../lib/format";
import { arePathsEqual } from "../../lib/pathUtils";
import { RECENT_PROJECTS_CHANGED_EVENT } from "../../lib/recentProjectsEvents";
import { chatImportKey, queueChatImports } from "../../onboarding/pendingChatImports";
import { useAppStore } from "../../state/appStore";
import { ProviderLogo } from "../shared/ProviderLogos";
import { AdeQrCode } from "../ui/AdeQrCode";
import { Dialog } from "../ui/dialog";
import { Banner, noticeKindModel, type NoticeKind } from "../ui/notice";
import { PortalContainerContext } from "../ui/portalContainer";
import { FirstRunChatPicker, type ChatListState } from "./FirstRunChatPicker";
import { firstRunAgents } from "./firstRunAgentModel";
import "./firstRun.css";
import { isAdeAvailable } from "../../lib/adeAvailability";
import "./firstRunWelcome.css";
import "./firstRunProjects.css";
import "./firstRunDevices.css";

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
 *    lanes. Each row with recent chats has its own "Import N chats?" pill:
 *    its box turns the import on or off, its count opens a picker of those
 *    chats (`FirstRunChatPicker`) to leave some out. The ones turned on bring
 *    their chats in on that first open (`useOnboardingChatImport`).
 *
 * Both cards sit on the launch gate's glass (`.ade-gate` tokens), so they read
 * as one flow with the sign-in card between them.
 */

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
  // The hosted web client has no local folders to discover.
  if (!isAdeAvailable(discover)) return null;
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

function folderName(folder: string): string {
  return basenameCrossPlatform(folder) || folder;
}

/** A chosen folder as-is, where the app cannot resolve it to its project (the browser preview). */
function folderCandidate(rootPath: string): OnboardingProjectCandidate {
  return {
    rootPath,
    name: folderName(rootPath),
    repoLabel: null,
    chatCount: 0,
    recentChatCount: 0,
    lastActiveAt: null,
    providers: [],
    laneCount: 0,
    suggested: true,
    inAde: false,
  };
}

/** What setup added: every root, in the order shown. */
export type FirstRunResult = { rootPaths: string[] };

/**
 * Adds the chosen projects to this computer's recent projects and queues the
 * chats of the ones whose import pill is on for each one's next open, minus
 * the chats left out in the picker (`excludedByRoot`, `chatImportKey`s).
 * Projects already in ADE (`inAde`) are not added again; their chats can
 * still be queued.
 */
export async function addFirstRunProjects(
  projects: OnboardingProjectCandidate[],
  importRoots: ReadonlySet<string>,
  excludedByRoot: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): Promise<FirstRunResult> {
  const add = window.ade.app.addOnboardingProjects;
  // Without the bridge (the hosted web client) nothing is added, so nothing
  // is reported as added.
  const added = isAdeAvailable(add) ? projects.filter((project) => !project.inAde) : [];
  if (added.length && isAdeAvailable(add)) {
    await add(added.map((project) => project.rootPath));
    window.dispatchEvent(new Event(RECENT_PROJECTS_CHANGED_EVENT));
  }
  queueChatImports(
    projects
      .filter((project) => project.recentChatCount > 0 && importRoots.has(project.rootPath))
      .map((project) => ({ rootPath: project.rootPath, excludedKeys: excludedByRoot.get(project.rootPath) })),
    Date.now() - ONBOARDING_CHAT_WINDOW_MS,
  );
  return { rootPaths: added.map((project) => project.rootPath) };
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
    ...result.rootPaths.filter((rootPath) => !current.some((open) => arePathsEqual(open, rootPath))),
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
  /** Per project whose import is on: the chats left out in its picker (`chatImportKey`s). */
  const [excluded, setExcluded] = useState<Map<string, Set<string>>>(new Map());
  /** Each project's chat list, read the first time its picker opens and kept for the card's life. */
  const [chatLists, setChatLists] = useState<Record<string, ChatListState>>({});
  const [pickerRoot, setPickerRoot] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  /** The gate root: the picker portals there so it keeps the gate's glass tokens and escapes the scrolling rows. */
  const [gateEl, setGateEl] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);

  const [error, setError] = useState<{ message: string; kind: NoticeKind } | null>(null);
  const [discoveryRetry, setDiscoveryRetry] = useState(0);

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
        setSelected(
          new Set(
            result.projects
              .filter((project) => project.suggested && !project.inAde)
              .map((project) => project.rootPath),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) {
          console.warn("[onboarding] project discovery failed");
          setDiscovery({ phase: "unavailable" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [discoveryRetry]);

  const projects = discovery.phase === "ready" ? discovery.projects : [];
  const machineName = discovery.phase === "ready" ? discovery.machineName : null;
  /** Projects setup can add; the rest are already in ADE. */
  const addable = useMemo(() => projects.filter((project) => !project.inAde), [projects]);
  const inAdeCount = projects.length - addable.length;
  const chosen = useMemo(
    () => addable.filter((project) => selected.has(project.rootPath)),
    [addable, selected],
  );
  /** Projects already in ADE whose chats are to come in. */
  const importingInAde = useMemo(
    () => projects.filter((project) => project.inAde && importing.has(project.rootPath)),
    [importing, projects],
  );

  const toggle = useCallback((rootPath: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(rootPath)) next.delete(rootPath);
      else next.add(rootPath);
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    setGateEl(cardRef.current?.closest<HTMLElement>(".ade-gate") ?? null);
  }, []);

  /**
   * A project's import choice: `null` is off, a set is on with those chats
   * left out (empty: all of them). The pill's box only ever says all or
   * nothing, so turning it on clears what the picker left out; the picker
   * narrows from there. Importing a new project's chats means adding the
   * project too.
   */
  const setChatSelection = useCallback((rootPath: string, inAde: boolean, leftOut: ReadonlySet<string> | null) => {
    setImporting((current) => {
      if (current.has(rootPath) === (leftOut !== null)) return current;
      const next = new Set(current);
      if (leftOut) next.add(rootPath);
      else next.delete(rootPath);
      return next;
    });
    setExcluded((current) => {
      if (!current.has(rootPath) && !leftOut?.size) return current;
      const next = new Map(current);
      if (leftOut?.size) next.set(rootPath, new Set(leftOut));
      else next.delete(rootPath);
      return next;
    });
    if (leftOut && !inAde) setSelected((picked) => (picked.has(rootPath) ? picked : new Set(picked).add(rootPath)));
  }, []);
  const setImport = useCallback(
    (rootPath: string, on: boolean, inAde: boolean) => setChatSelection(rootPath, inAde, on ? new Set() : null),
    [setChatSelection],
  );

  const chatListsRef = useRef(chatLists);
  chatListsRef.current = chatLists;
  const loadChats = useCallback((rootPath: string) => {
    const existing = chatListsRef.current[rootPath];
    if (existing && existing.phase !== "error") return;
    const setList = (state: ChatListState) => {
      chatListsRef.current = { ...chatListsRef.current, [rootPath]: state };
      setChatLists((current) => ({ ...current, [rootPath]: state }));
    };
    const list = window.ade.app.listOnboardingProjectChats;
    if (!isAdeAvailable(list)) {
      setList({ phase: "error" });
      return;
    }
    setList({ phase: "loading" });
    void list(rootPath).then(
      (chats) => setList({ phase: "ready", chats }),
      () => setList({ phase: "error" }),
    );
  }, []);
  const togglePicker = useCallback((rootPath: string) => {
    setPickerRoot((current) => (current === rootPath ? null : rootPath));
    loadChats(rootPath);
  }, [loadChats]);
  const closePicker = useCallback(() => setPickerRoot(null), []);
  const [qrOpen, setQrOpen] = useState(false);
  const openQr = useCallback(() => setQrOpen(true), []);
  const closeQr = useCallback(() => setQrOpen(false), []);

  const allSelected = addable.length > 0 && chosen.length === addable.length;
  const toggleAll = useCallback(() => {
    setSelected(allSelected ? new Set() : new Set(addable.map((project) => project.rootPath)));
  }, [addable, allSelected]);

  const addFolder = useCallback(async () => {
    const folder = await window.ade.project.chooseDirectory({ title: "Add a project" }).catch(() => null);
    if (!folder) return;
    setError(null);
    // The project the folder belongs to: a subfolder adds its checkout, a lane
    // or worktree its project. Main adds only git checkouts, so a folder
    // outside one is refused here rather than shown ticked and then skipped.
    const resolve = window.ade.app.resolveOnboardingFolder;
    let candidate: OnboardingProjectCandidate | null;
    try {
      candidate = isAdeAvailable(resolve) ? await resolve(folder) : folderCandidate(folder);
    } catch (cause) {
      setError({ message: extractError(cause), kind: "failure" });
      return;
    }
    if (!candidate) {
      setError({ message: `${folderName(folder)} isn't in a git project. Choose the folder of a git checkout.`, kind: "status" });
      return;
    }
    const isCandidate = (project: OnboardingProjectCandidate) => arePathsEqual(project.rootPath, candidate.rootPath);
    const target = (discovery.phase === "ready" ? discovery.projects.find(isCandidate) : undefined) ?? candidate;
    setDiscovery((current) => (
      current.phase !== "ready" || current.projects.some(isCandidate)
        ? current
        : { ...current, projects: [...current.projects, candidate] }
    ));
    // A project already in ADE is listed, never added again.
    if (!target.inAde) setSelected((current) => new Set(current).add(target.rootPath));
  }, [discovery]);

  const finish = useCallback(async () => {
    if (!chosen.length && !importingInAde.length) {
      onDone({ rootPaths: [] });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onDone(await addFirstRunProjects([...chosen, ...importingInAde], importing, excluded));
    } catch (cause) {
      setError({ message: extractError(cause), kind: "failure" });
      setBusy(false);
    }
  }, [chosen, excluded, importing, importingInAde, onDone]);

  const chatTotal = [...chosen, ...importingInAde].reduce(
    (sum, project) => sum + (importing.has(project.rootPath)
      ? importCounts(project, chatLists[project.rootPath], excluded.get(project.rootPath)).included
      : 0),
    0,
  );
  const laneTotal = chosen.reduce((sum, project) => sum + project.laneCount, 0);

  return (
    <div ref={cardRef} className="ade-glass-card ade-fr-projects" data-testid="first-run-projects">
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
          <span>{listHeadline(discovery.phase === "loading", projects.length, addable.length, inAdeCount)}</span>
          {addable.length > 1 ? (
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
                  checked={project.inAde || selected.has(project.rootPath)}
                  importing={importing.has(project.rootPath)}
                  excluded={excluded.get(project.rootPath)}
                  chatList={chatLists[project.rootPath]}
                  pickerOpen={pickerRoot === project.rootPath}
                  gateEl={gateEl}
                  onToggle={toggle}
                  onSetImport={setImport}
                  onSetChatSelection={setChatSelection}
                  onTogglePicker={togglePicker}
                  onClosePicker={closePicker}
                  index={index}
                />
              ))}
          {discovery.phase === "unavailable" ? (
            <div className="ade-fr-empty">
              <span>Couldn't load projects from this computer.</span>
              <button type="button" className="ade-fr-text-btn" onClick={() => setDiscoveryRetry((value) => value + 1)}>
                Try again
              </button>
            </div>
          ) : null}
          {discovery.phase === "ready" && !projects.length ? (
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

      {error ? (
        <Banner
          layout="inline"
          style={{ marginTop: 14 }}
          model={{
            id: "first-run-projects-error",
            ...noticeKindModel(error.kind, error.kind === "failure" ? { surface: "first_run_projects" } : undefined),
            title: error.message,
            dismiss: { onDismiss: () => setError(null) },
          }}
        />
      ) : null}

      <footer className="ade-fr-foot">
        <button type="button" className="ade-glass-link" onClick={onSkip} disabled={busy}>
          Skip
        </button>
        <span className="ade-fr-summary" aria-live="polite">
          {[
            chosen.length ? pluralize(chosen.length, "project", "projects") : null,
            laneTotal ? pluralize(laneTotal, "lane", "lanes") : null,
            chatTotal ? `${pluralize(chatTotal, "chat", "chats")} to import` : null,
          ].filter(Boolean).join(" · ") || null}
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

      <PhoneQrLightbox open={qrOpen} onClose={closeQr} container={gateEl} />
    </div>
  );
}

/** The line over the projects list: still looking, none, all already in ADE, or how many are new. */
function listHeadline(loading: boolean, found: number, addable: number, inAde: number): string {
  if (loading) return "Looking for your projects…";
  if (!found) return "No projects found yet";
  if (!addable) return inAde === 1 ? "Your project is already in ADE" : `All ${inAde} of your projects are already in ADE`;
  const parts = [`${pluralize(addable, "new project", "new projects")} found`];
  if (inAde) parts.push(`${inAde} already in ADE`);
  return parts.join(" · ");
}

/**
 * How many of a project's chats the pill counts. Until its picker has read
 * the list, discovery's count stands in; once read, the list is the truth
 * (it drops empty and ADE-made sessions discovery's quick count includes).
 */
function importCounts(
  project: OnboardingProjectCandidate,
  chatList: ChatListState | undefined,
  excluded: ReadonlySet<string> | undefined,
): { total: number; included: number } {
  if (chatList?.phase === "ready" && chatList.chats.length) {
    const total = chatList.chats.length;
    const left = excluded?.size
      ? chatList.chats.filter((chat) => excluded.has(chatImportKey(chat.provider, chat.id))).length
      : 0;
    return { total, included: total - left };
  }
  return { total: project.recentChatCount, included: project.recentChatCount - (excluded?.size ?? 0) };
}

function ProjectRow({
  project,
  checked,
  importing,
  excluded,
  chatList,
  pickerOpen,
  gateEl,
  onToggle,
  onSetImport,
  onSetChatSelection,
  onTogglePicker,
  onClosePicker,
  index,
}: {
  project: OnboardingProjectCandidate;
  checked: boolean;
  importing: boolean;
  excluded: ReadonlySet<string> | undefined;
  chatList: ChatListState | undefined;
  pickerOpen: boolean;
  gateEl: HTMLElement | null;
  onToggle: (rootPath: string) => void;
  onSetImport: (rootPath: string, on: boolean, inAde: boolean) => void;
  onSetChatSelection: (rootPath: string, inAde: boolean, leftOut: ReadonlySet<string> | null) => void;
  onTogglePicker: (rootPath: string) => void;
  onClosePicker: () => void;
  index: number;
}) {
  const icon = useProjectIcon(project.rootPath);
  const pillRef = useRef<HTMLSpanElement | null>(null);
  const pickRef = useRef<HTMLButtonElement | null>(null);
  const meta = [
    project.laneCount ? pluralize(project.laneCount, "lane", "lanes") : null,
    project.lastActiveAt ? relativeWhen(new Date(project.lastActiveAt).toISOString()) : null,
  ].filter(Boolean);
  // A project left out brings no chats, whatever its toggle said before.
  // (One already in ADE is never left out.)
  const importOn = importing && checked;
  const { total, included } = importCounts(project, chatList, importOn ? excluded : undefined);
  const chatsLabel = pluralize(total, "chat", "chats");
  const narrowed = importOn && included < total;
  const onSelectionChange = useCallback(
    (leftOut: ReadonlySet<string> | null) => onSetChatSelection(project.rootPath, project.inAde, leftOut),
    [onSetChatSelection, project.inAde, project.rootPath],
  );
  return (
    <div
      className="ade-fr-row"
      data-checked={checked ? "true" : undefined}
      data-in-ade={project.inAde ? "true" : undefined}
      style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
    >
      <button
        type="button"
        className="ade-fr-row-main"
        aria-pressed={project.inAde ? undefined : checked}
        aria-disabled={project.inAde || undefined}
        onClick={project.inAde ? undefined : () => onToggle(project.rootPath)}
        title={project.inAde ? `${project.rootPath} is already in ADE` : project.rootPath}
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
        {project.inAde ? (
          <span className="ade-fr-in-ade">In ADE</span>
        ) : meta.length ? (
          <span className="ade-fr-meta">{meta.join(" · ")}</span>
        ) : null}
      </button>
      {project.recentChatCount > 0 ? (
        // Two targets in one pill. The box (with the provider marks) is a
        // yes/no choice, not an action: it reads as a question while off and
        // as a ticked "Importing" while on, and nothing imports until Add.
        // The count opens the picker to leave single chats out.
        <span
          ref={pillRef}
          className="ade-fr-import"
          data-on={importOn ? "true" : undefined}
          data-open={pickerOpen ? "true" : undefined}
        >
          <button
            type="button"
            role="checkbox"
            className="ade-fr-import-toggle"
            aria-checked={importOn ? (narrowed ? "mixed" : true) : false}
            aria-label={`Import ${pluralize(total, "recent chat", "recent chats")} from ${providerList(project.providers)}`}
            title={
              importOn
                ? "These chats come in when the project first opens. Click to leave them all out."
                : `Bring the last ${ONBOARDING_CHAT_WINDOW_DAYS} days of chats in when the project first opens, each in the lane it ran in.`
            }
            onClick={() => onSetImport(project.rootPath, !importOn, project.inAde)}
          >
            <span className="ade-fr-import-box" aria-hidden="true">
              {narrowed ? <span className="ade-fr-import-dash" /> : <Check size={10} weight="bold" />}
            </span>
            <span className="ade-fr-import-marks" aria-hidden="true">
              {project.providers.slice(0, MAX_ROW_MARKS).map((provider) => (
                <ProviderLogo key={provider} family={provider} size={13} />
              ))}
              {project.providers.length > MAX_ROW_MARKS ? (
                <span className="ade-fr-marks-more">+{project.providers.length - MAX_ROW_MARKS}</span>
              ) : null}
            </span>
          </button>
          <button
            ref={pickRef}
            type="button"
            className="ade-fr-import-pick"
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            aria-label={`Choose which of ${project.name}'s ${chatsLabel} to import`}
            title="See these chats and choose which come in"
            onClick={() => onTogglePicker(project.rootPath)}
          >
            <span className="ade-fr-import-label">
              {importOn
                ? narrowed
                  ? `Importing ${included} of ${chatsLabel}`
                  : `Importing ${chatsLabel}`
                : `Import ${chatsLabel}?`}
            </span>
            <CaretDown size={10} weight="bold" className="ade-fr-import-caret" aria-hidden="true" />
          </button>
        </span>
      ) : null}
      {pickerOpen ? (
        <PortalContainerContext.Provider value={gateEl}>
          <FirstRunChatPicker
            projectName={project.name}
            rootPath={project.rootPath}
            anchorRef={pillRef}
            returnFocusRef={pickRef}
            chatList={chatList}
            importOn={importOn}
            excluded={importOn ? excluded : undefined}
            onChange={onSelectionChange}
            onClose={onClosePicker}
          />
        </PortalContainerContext.Provider>
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
 * The phone QR, big enough to scan from across a desk, in a pane of the
 * gate's own glass. The shared `Dialog` (portalled into the gate, so it draws
 * over the card with the gate's tokens) owns the scrim, the focus trap and
 * Escape; setup's Escape-to-skip leaves keys from an open dialog alone.
 */
function PhoneQrLightbox({
  open,
  onClose,
  container,
}: {
  open: boolean;
  onClose: () => void;
  /** The gate root. */
  container: HTMLElement | null;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="ADE for iPhone"
      hideHeader
      hideClose
      container={container}
      initialFocusRef={closeRef}
      width={292}
      bodyPadding={false}
      scrollBody={false}
      panelClassName="ade-fr-qr-panel"
      // The gate's glass pane (`firstRunDevices.css`) instead of the dialog's card material.
      material="none"
      panelStyle={{ overflow: "visible" }}
      bodyStyle={{ overflow: "visible" }}
    >
      <div className="ade-fr-qr-content">
        <button ref={closeRef} type="button" className="ade-fr-qr-close" aria-label="Close" onClick={onClose}>
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
    </Dialog>
  );
}
