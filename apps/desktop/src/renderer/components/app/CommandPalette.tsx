import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowRight,
  CircleNotch,
  Clock,
  Folder,
  FolderOpen,
  GitBranch,
  MagnifyingGlass,
  Stack,
  Warning,
} from "@phosphor-icons/react";
import { motion, AnimatePresence } from "motion/react";
import { useNavigate } from "react-router-dom";
import type { ProjectBrowseResult, ProjectDetail } from "../../../shared/types";
import { extractError } from "../../lib/format";
import { fadeScale } from "../../lib/motion";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";

export type CommandPaletteIntent = "default" | "project-browse";

type Command = {
  id: string;
  title: string;
  hint?: string;
  shortcut?: string;
  group?: string;
  closeOnRun?: boolean;
  run: () => void | Promise<void>;
};

type BrowseRow = {
  id: string;
  title: string;
  hint: string;
  path: string;
  kind: "parent" | "directory";
  isGitRepo: boolean;
};

function stripTrailingSeparator(input: string): string {
  if (input.length <= 1) return input;
  return input.endsWith("/") || input.endsWith("\\") ? input.slice(0, -1) : input;
}

function relativeFromNow(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

const LANGUAGE_SWATCHES: Record<string, string> = {
  TypeScript: "#3178C6",
  JavaScript: "#F7DF1E",
  Python: "#3776AB",
  Rust: "#DE6F1B",
  Go: "#00ADD8",
  Ruby: "#CC342D",
  Java: "#B07219",
  Kotlin: "#A97BFF",
  Swift: "#F05138",
  "Objective-C": "#438EFF",
  "Objective-C++": "#6866FB",
  C: "#555555",
  "C++": "#F34B7D",
  "C#": "#178600",
  PHP: "#4F5D95",
  Lua: "#000080",
  Shell: "#89E051",
  PowerShell: "#012456",
  SQL: "#E38C00",
  HTML: "#E34C26",
  CSS: "#563D7C",
  SCSS: "#C6538C",
  Less: "#1D365D",
  Vue: "#41B883",
  Svelte: "#FF3E00",
  Astro: "#FF5D01",
  JSON: "#8FB1D9",
  YAML: "#CB171E",
  TOML: "#9C4221",
  Markdown: "#A78BFA",
};

function withTrailingSeparator(input: string): string {
  if (input.endsWith("/") || input.endsWith("\\")) return input;
  return `${input}${input.includes("\\") ? "\\" : "/"}`;
}

function defaultBrowseInput(projectRoot: string | null | undefined): string {
  return projectRoot ? "../" : "~/";
}

function pathLabel(input: string | null | undefined): string {
  if (!input) return "";
  const segments = input.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? input;
}

export function CommandPalette({
  open,
  onOpenChange,
  intent = "default",
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  intent?: CommandPaletteIntent;
}) {
  const navigate = useNavigate();
  const lanes = useAppStore((s) => s.lanes);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const project = useAppStore((s) => s.project);
  const selectLane = useAppStore((s) => s.selectLane);
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);
  const hasActiveProject = Boolean(project?.rootPath);

  const [mode, setMode] = useState<CommandPaletteIntent>("default");
  const [q, setQ] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [browseInput, setBrowseInput] = useState(defaultBrowseInput(project?.rootPath));
  const [browseResult, setBrowseResult] = useState<ProjectBrowseResult | null>(null);
  const [browseSelectedIdx, setBrowseSelectedIdx] = useState(0);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [openProjectPending, setOpenProjectPending] = useState(false);
  const [systemPickerPending, setSystemPickerPending] = useState(false);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailPath, setDetailPath] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const listRef = useRef<HTMLUListElement>(null);
  const browseRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const dragCounterRef = useRef(0);

  const startProjectBrowse = useCallback(() => {
    setMode("project-browse");
    setQ("");
    setSelectedIdx(0);
    setBrowseInput(defaultBrowseInput(project?.rootPath));
    setBrowseResult(null);
    setBrowseError(null);
    setBrowseSelectedIdx(0);
  }, [project?.rootPath]);

  useEffect(() => {
    if (!open) {
      setMode("default");
      setQ("");
      setSelectedIdx(0);
      setBrowseError(null);
      setBrowseLoading(false);
      setOpenProjectPending(false);
      setSystemPickerPending(false);
      return;
    }

    if (intent === "project-browse") {
      startProjectBrowse();
      return;
    }

    setMode("default");
    setQ("");
    setSelectedIdx(0);
    setBrowseError(null);
  }, [intent, open, startProjectBrowse]);

  const commands: Command[] = useMemo(() => {
    const next: Command[] = [
      {
        id: "project-browse",
        title: hasActiveProject ? "Open another project" : "Open project",
        hint: "Browse folders in ADE before opening a repo",
        group: "Projects",
        closeOnRun: false,
        run: startProjectBrowse,
      },
      { id: "go-project", title: "Go to Run", shortcut: "G 1", group: "Navigation", run: () => navigate("/project") },
      { id: "go-lanes", title: "Go to Lanes", shortcut: "G L", group: "Navigation", run: () => navigate("/lanes") },
      { id: "go-files", title: "Go to Files", shortcut: "G F", group: "Navigation", run: () => navigate("/files") },
      { id: "go-work", title: "Go to Work", shortcut: "G T", group: "Navigation", run: () => navigate("/work") },
      { id: "go-graph", title: "Go to Graph", shortcut: "G G", group: "Navigation", run: () => navigate("/graph") },
      { id: "go-prs", title: "Go to PRs", shortcut: "G R", group: "Navigation", run: () => navigate("/prs") },
      { id: "go-history", title: "Go to History", shortcut: "G H", group: "Navigation", run: () => navigate("/history") },
      { id: "go-missions", title: "Go to Missions", shortcut: "G M", group: "Navigation", run: () => navigate("/missions") },
      { id: "go-automations", title: "Go to Automations", hint: "Automation rules and agent workflows", group: "Navigation", run: () => navigate("/automations") },
      { id: "go-settings", title: "Go to Settings", shortcut: "G S", group: "Navigation", run: () => navigate("/settings") },
      { id: "go-settings-general", title: "Go to General Settings", hint: "Setup reminder, app info", group: "Settings", run: () => navigate("/settings?tab=general") },
      { id: "go-settings-appearance", title: "Go to Appearance", hint: "Theme, chat font size, chat notifications", group: "Settings", run: () => navigate("/settings?tab=appearance") },
      { id: "go-settings-ai", title: "Go to AI Settings", hint: "Providers, models, AI defaults", group: "Settings", run: () => navigate("/settings?tab=ai") },
      { id: "go-settings-integrations", title: "Go to Integrations", hint: "GitHub, Linear, computer use", group: "Settings", run: () => navigate("/settings?tab=integrations") },
      { id: "go-settings-workspace", title: "Go to Workspace Settings", hint: "Project health and docs generation", group: "Settings", run: () => navigate("/settings?tab=workspace") },
      { id: "go-settings-usage", title: "Go to Usage", hint: "Token usage, cost breakdown", group: "Settings", run: () => navigate("/settings?tab=usage") },
      {
        id: "action-create-lane",
        title: "Create Lane",
        hint: "Create a new development lane",
        group: "Actions",
        run: () => navigate("/lanes"),
      },
      {
        id: "action-open-terminal",
        title: "Open Terminal",
        hint: "Switch to work / terminals view",
        group: "Actions",
        run: () => navigate("/work"),
      },
      {
        id: "action-refresh-packs",
        title: "Refresh Packs",
        hint: "Refresh AI context packs",
        group: "Actions",
        run: () => navigate("/lanes"),
      },
      {
        id: "action-open-graph",
        title: "Open Workspace Graph",
        hint: "Visual dependency graph",
        group: "Actions",
        run: () => navigate("/graph"),
      },
      {
        id: "lane-next",
        title: "Select Next Lane",
        shortcut: "]",
        group: "Lanes",
        run: () => {
          if (!lanes.length) return;
          const currentIdx = lanes.findIndex((lane) => lane.id === selectedLaneId);
          const nextLane = lanes[(currentIdx + 1 + lanes.length) % lanes.length];
          if (!nextLane) return;
          selectLane(nextLane.id);
          navigate(`/lanes?laneId=${encodeURIComponent(nextLane.id)}`);
        },
      },
      {
        id: "lane-prev",
        title: "Select Previous Lane",
        shortcut: "[",
        group: "Lanes",
        run: () => {
          if (!lanes.length) return;
          const currentIdx = lanes.findIndex((lane) => lane.id === selectedLaneId);
          const nextLane = lanes[(currentIdx - 1 + lanes.length) % lanes.length];
          if (!nextLane) return;
          selectLane(nextLane.id);
          navigate(`/lanes?laneId=${encodeURIComponent(nextLane.id)}`);
        },
      },
      {
        id: "lane-filter",
        title: "Focus Lane Filter",
        shortcut: "/",
        group: "Lanes",
        run: () => {
          navigate("/lanes");
          setTimeout(() => {
            const input = document.getElementById("lanes-filter-input");
            if (input instanceof HTMLInputElement) {
              input.focus();
              input.select();
            }
          }, 30);
        },
      },
      {
        id: "ping",
        title: "Ping preload bridge",
        hint: "Expect \"pong\"",
        group: "Debug",
        run: async () => {
          await window.ade.app.ping();
        },
      },
    ];

    if (!hasActiveProject) {
      return next.filter((command) => command.id === "project-browse" || command.id === "go-project" || command.id === "ping");
    }

    return next;
  }, [hasActiveProject, lanes, navigate, selectLane, selectedLaneId, startProjectBrowse]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) =>
      command.title.toLowerCase().includes(needle) || (command.hint ?? "").toLowerCase().includes(needle)
    );
  }, [commands, q]);

  const grouped = useMemo(() => {
    const groups: { label: string; items: Command[] }[] = [];
    const seen = new Map<string, number>();
    for (const command of filtered) {
      const label = command.group ?? "Other";
      if (seen.has(label)) {
        groups[seen.get(label)!]!.items.push(command);
      } else {
        seen.set(label, groups.length);
        groups.push({ label, items: [command] });
      }
    }
    return groups;
  }, [filtered]);

  const browseRows = useMemo<BrowseRow[]>(() => {
    if (!browseResult) return [];
    const rows: BrowseRow[] = [];
    if (browseResult.parentPath) {
      rows.push({
        id: `parent:${browseResult.parentPath}`,
        title: "Go up",
        hint: browseResult.parentPath,
        path: withTrailingSeparator(browseResult.parentPath),
        kind: "parent",
        isGitRepo: false,
      });
    }
    for (const entry of browseResult.entries) {
      rows.push({
        id: `dir:${entry.fullPath}`,
        title: entry.name,
        hint: entry.fullPath,
        path: withTrailingSeparator(entry.fullPath),
        kind: "directory",
        isGitRepo: entry.isGitRepo,
      });
    }
    return rows;
  }, [browseResult]);

  const openableProjectRoot = browseResult?.openableProjectRoot ?? null;
  const isCurrentProjectTarget = Boolean(openableProjectRoot && project?.rootPath === openableProjectRoot);
  const canOpenProject = Boolean(openableProjectRoot) && !isCurrentProjectTarget;
  const openProjectLabel = isCurrentProjectTarget ? "Already open" : "Open";

  const highlightedRow = browseSelectedIdx >= 0 ? (browseRows[browseSelectedIdx] ?? null) : null;
  const highlightedPath = useMemo(() => {
    if (highlightedRow && highlightedRow.kind === "directory") {
      return stripTrailingSeparator(highlightedRow.path);
    }
    if (openableProjectRoot) return openableProjectRoot;
    if (browseResult?.exactDirectoryPath) return browseResult.exactDirectoryPath;
    return null;
  }, [browseResult?.exactDirectoryPath, highlightedRow, openableProjectRoot]);

  const highlightedIsRepo = highlightedRow?.kind === "directory"
    ? highlightedRow.isGitRepo
    : Boolean(openableProjectRoot && highlightedPath && highlightedPath === openableProjectRoot);

  const detailTarget = highlightedPath;
  const openTarget = highlightedIsRepo && highlightedRow?.kind === "directory" && highlightedPath
    ? highlightedPath
    : openableProjectRoot;
  const openTargetLabel = openTarget ? pathLabel(openTarget) : null;
  const canOpenHighlighted = Boolean(openTarget) && openTarget !== project?.rootPath;
  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
  const openShortcutLabel = `${isMac ? "⌘" : "Ctrl"}↵`;

  useEffect(() => {
    if (!open || mode !== "project-browse") return;
    const requestId = ++browseRequestRef.current;
    setBrowseLoading(true);
    setBrowseError(null);
    void window.ade.project
      .browseDirectories({
        partialPath: browseInput,
        cwd: project?.rootPath ?? null,
        limit: 200,
      })
      .then((result) => {
        if (browseRequestRef.current !== requestId) return;
        setBrowseResult(result);
        setBrowseSelectedIdx(result.openableProjectRoot ? -1 : (result.parentPath || result.entries.length > 0 ? 0 : -1));
      })
      .catch((error) => {
        if (browseRequestRef.current !== requestId) return;
        setBrowseResult(null);
        setBrowseSelectedIdx(-1);
        setBrowseError(extractError(error));
      })
      .finally(() => {
        if (browseRequestRef.current !== requestId) return;
        setBrowseLoading(false);
      });
  }, [browseInput, mode, open, project?.rootPath]);

  useEffect(() => {
    if (mode !== "default") return;
    if (filtered.length === 0) {
      if (selectedIdx !== 0) setSelectedIdx(0);
      return;
    }
    if (selectedIdx >= filtered.length) {
      setSelectedIdx(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, mode, selectedIdx]);

  useEffect(() => {
    if (!open || mode !== "project-browse") {
      return;
    }
    if (!detailTarget) {
      setDetail(null);
      setDetailPath(null);
      setDetailLoading(false);
      return;
    }
    if (detail && detail.rootPath === detailTarget) {
      return;
    }
    const requestId = ++detailRequestRef.current;
    setDetailLoading(true);
    setDetailPath(detailTarget);
    const timeout = globalThis.setTimeout(() => {
      void window.ade.project
        .getDetail(detailTarget)
        .then((result) => {
          if (detailRequestRef.current !== requestId) return;
          setDetail(result);
        })
        .catch(() => {
          if (detailRequestRef.current !== requestId) return;
          setDetail(null);
        })
        .finally(() => {
          if (detailRequestRef.current !== requestId) return;
          setDetailLoading(false);
        });
    }, 140);
    return () => {
      globalThis.clearTimeout(timeout);
    };
  }, [detail, detailTarget, mode, open]);

  useEffect(() => {
    if (mode !== "project-browse") return;
    if (browseRows.length === 0 && !openableProjectRoot) {
      if (browseSelectedIdx !== -1) setBrowseSelectedIdx(-1);
      return;
    }
    if (openableProjectRoot && browseSelectedIdx < -1) {
      setBrowseSelectedIdx(-1);
      return;
    }
    if (!openableProjectRoot && browseSelectedIdx < 0 && browseRows.length > 0) {
      setBrowseSelectedIdx(0);
      return;
    }
    if (browseSelectedIdx >= browseRows.length) {
      setBrowseSelectedIdx(openableProjectRoot ? -1 : Math.max(0, browseRows.length - 1));
    }
  }, [browseRows.length, browseSelectedIdx, mode, openableProjectRoot]);

  const scrollToSelected = useCallback((idx: number) => {
    if (!listRef.current || idx < 0) return;
    const items = listRef.current.querySelectorAll("[data-cmd-item]");
    const target = items[idx];
    if (target instanceof HTMLElement && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "nearest" });
    }
  }, []);

  useEffect(() => {
    if (mode === "default") {
      scrollToSelected(selectedIdx);
      return;
    }
    scrollToSelected(browseSelectedIdx);
  }, [browseSelectedIdx, mode, scrollToSelected, selectedIdx]);

  const runCommand = useCallback(
    (command: Command) => {
      void Promise.resolve(command.run())
        .then(() => {
          if (command.closeOnRun === false) return;
          onOpenChange(false);
        })
        .catch((error) => {
          console.error("Command palette command failed", error);
        });
    },
    [onOpenChange]
  );

  const activateBrowseRow = useCallback((row: BrowseRow) => {
    setBrowseError(null);
    setBrowseInput(row.path);
  }, []);

  const handleOpenProject = useCallback(
    async (targetPath: string | null | undefined) => {
      const nextTarget = typeof targetPath === "string" ? targetPath.trim() : "";
      if (!nextTarget) return;
      setBrowseError(null);
      setOpenProjectPending(true);
      try {
        await switchProjectToPath(nextTarget);
        onOpenChange(false);
      } catch (error) {
        setBrowseError(extractError(error));
      } finally {
        setOpenProjectPending(false);
      }
    },
    [onOpenChange, switchProjectToPath]
  );

  const handleChooseInSystemPicker = useCallback(async () => {
    setBrowseError(null);
    setSystemPickerPending(true);
    try {
      const selected = await window.ade.project.chooseDirectory({
        title: "Open project",
        defaultPath: browseResult?.exactDirectoryPath ?? browseResult?.directoryPath ?? undefined,
      });
      if (!selected) return;
      await handleOpenProject(selected);
    } catch (error) {
      setBrowseError(extractError(error));
    } finally {
      setSystemPickerPending(false);
    }
  }, [browseResult?.directoryPath, browseResult?.exactDirectoryPath, handleOpenProject]);

  const handleDefaultKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        if (filtered.length === 0) return;
        event.preventDefault();
        setSelectedIdx((prev) => (prev + 1) % filtered.length);
        return;
      }
      if (event.key === "ArrowUp") {
        if (filtered.length === 0) return;
        event.preventDefault();
        setSelectedIdx((prev) => (prev - 1 + filtered.length) % filtered.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const command = filtered[selectedIdx];
        if (!command) return;
        runCommand(command);
      }
    },
    [filtered, runCommand, selectedIdx]
  );

  const handleBrowseKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        if (browseRows.length === 0) return;
        event.preventDefault();
        setBrowseSelectedIdx((prev) => {
          if (prev < 0) return 0;
          return (prev + 1) % browseRows.length;
        });
        return;
      }
      if (event.key === "ArrowUp") {
        if (browseRows.length === 0) return;
        event.preventDefault();
        setBrowseSelectedIdx((prev) => {
          if (prev < 0) return browseRows.length - 1;
          return (prev - 1 + browseRows.length) % browseRows.length;
        });
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const isOpenShortcut = event.metaKey || event.ctrlKey;
        if (isOpenShortcut && openTarget) {
          void handleOpenProject(openTarget);
          return;
        }
        if (browseSelectedIdx >= 0) {
          const row = browseRows[browseSelectedIdx];
          if (row) activateBrowseRow(row);
          return;
        }
        if (canOpenProject) {
          void handleOpenProject(openableProjectRoot);
        }
      }
    },
    [activateBrowseRow, browseRows, browseSelectedIdx, canOpenProject, handleOpenProject, openTarget, openableProjectRoot]
  );

  const handleDragEnter = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    dragCounterRef.current += 1;
    setIsDragging(true);
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      dragCounterRef.current = 0;
      setIsDragging(false);
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      const droppedPath = window.ade.project.getDroppedPath(file);
      if (!droppedPath) {
        setBrowseError("Could not read the dropped folder path.");
        return;
      }
      const nextBrowseInput = withTrailingSeparator(droppedPath);
      const requestId = ++browseRequestRef.current;
      setBrowseLoading(true);
      setBrowseError(null);
      void window.ade.project
        .browseDirectories({
          partialPath: nextBrowseInput,
          cwd: project?.rootPath ?? null,
          limit: 200,
        })
        .then((result) => {
          if (browseRequestRef.current !== requestId) return;
          const nextTarget =
            result.openableProjectRoot
            ?? result.exactDirectoryPath
            ?? result.directoryPath
            ?? droppedPath;
          if (nextTarget) {
            void handleOpenProject(nextTarget);
            return;
          }
          setBrowseInput(nextBrowseInput);
        })
        .catch((error) => {
          if (browseRequestRef.current !== requestId) return;
          setBrowseError(extractError(error));
        })
        .finally(() => {
          if (browseRequestRef.current !== requestId) return;
          setBrowseLoading(false);
        });
    },
    [handleOpenProject, project?.rootPath]
  );

  const isBrowsing = mode === "project-browse";
  const resultHeightClass = isBrowsing ? "h-[620px] max-h-[86vh]" : "max-h-[400px]";
  const widthClass = isBrowsing ? "w-[1080px]" : "w-[680px]";
  const positionClass = isBrowsing
    ? "fixed inset-0 z-[130] m-auto"
    : "fixed left-1/2 top-[12%] z-[130] -translate-x-1/2";
  const inputPlaceholder = isBrowsing
    ? "Paste a path, type to filter, or drop a folder anywhere…"
    : "Search commands...";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                className="fixed inset-0 z-[120] bg-black/70 backdrop-blur-2xl"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild onOpenAutoFocus={(event) => event.preventDefault()}>
              <motion.div
                className={cn(
                  positionClass,
                  widthClass,
                  "max-w-[96vw]",
                  resultHeightClass,
                  "overflow-hidden rounded-2xl",
                  "flex flex-col focus:outline-none"
                )}
                style={{
                  background:
                    "radial-gradient(120% 120% at 0% 0%, rgba(167,139,250,0.10), transparent 55%), " +
                    "radial-gradient(100% 100% at 100% 100%, rgba(82,56,175,0.10), transparent 60%), " +
                    "var(--color-popup-bg)",
                  border: "1px solid transparent",
                  backgroundClip: "padding-box",
                  boxShadow: isDragging
                    ? "0 48px 120px -36px rgba(0,0,0,0.88), 0 0 0 1px rgba(167,139,250,0.85), 0 24px 72px -28px rgba(167,139,250,0.55)"
                    : "0 36px 100px -28px rgba(0,0,0,0.88), 0 0 0 1px rgba(167,139,250,0.22), 0 18px 48px -24px rgba(167,139,250,0.28)",
                  transition: "box-shadow 160ms ease",
                }}
                variants={fadeScale}
                initial="initial"
                animate="animate"
                exit="exit"
                onDragEnter={isBrowsing ? handleDragEnter : undefined}
                onDragOver={isBrowsing ? handleDragOver : undefined}
                onDragLeave={isBrowsing ? handleDragLeave : undefined}
                onDrop={isBrowsing ? handleDrop : undefined}
              >
                {isBrowsing && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 rounded-2xl"
                    style={{
                      padding: 1,
                      background:
                        "linear-gradient(135deg, rgba(167,139,250,0.55), rgba(167,139,250,0.08) 55%, rgba(167,139,250,0.45))",
                      mask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
                      WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
                      maskComposite: "exclude",
                      WebkitMaskComposite: "xor",
                    }}
                  />
                )}
                <Dialog.Title className="sr-only">
                  {mode === "project-browse" ? "Project browser" : "Command palette"}
                </Dialog.Title>
                <Dialog.Description className="sr-only">
                  {mode === "project-browse"
                    ? "Browse folders in ADE and open a Git repository without leaving the app."
                    : "Search ADE commands and jump to actions quickly."}
                </Dialog.Description>

                <div
                  className="relative flex items-center gap-3 border-b px-4"
                  style={{
                    background: "color-mix(in srgb, var(--color-surface-recessed) 92%, rgba(167,139,250,0.08))",
                    borderColor: "color-mix(in srgb, var(--color-accent) 14%, var(--color-border))",
                  }}
                >
                  <MagnifyingGlass size={18} weight="regular" className="shrink-0 text-[var(--color-muted-fg)]" />
                  <input
                    value={isBrowsing ? browseInput : q}
                    onChange={(event) => {
                      if (isBrowsing) {
                        setBrowseInput(event.target.value);
                        setBrowseSelectedIdx(0);
                        return;
                      }
                      setQ(event.target.value);
                      setSelectedIdx(0);
                    }}
                    onKeyDown={isBrowsing ? handleBrowseKeyDown : handleDefaultKeyDown}
                    placeholder={inputPlaceholder}
                    className={cn(
                      "h-[56px] w-full bg-transparent text-[15px] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-muted-fg)]",
                      !isBrowsing && "font-mono"
                    )}
                    autoFocus
                  />
                  <span className="hidden shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[10px] font-mono text-[var(--color-muted-fg)] sm:inline-flex">
                    ESC
                  </span>
                </div>

                {isBrowsing ? (
                  <>
                    <div className="grid min-h-0 flex-1 grid-cols-[420px_minmax(0,1fr)]">
                      <div
                        className="min-h-0 overflow-auto"
                        style={{ borderRight: "1px solid var(--color-border)" }}
                      >
                        {browseLoading && !browseResult ? (
                          <div className="flex items-center gap-2 px-4 py-6 text-sm text-[var(--color-muted-fg)]">
                            <CircleNotch size={14} weight="bold" className="animate-spin" />
                            Scanning folders…
                          </div>
                        ) : browseRows.length === 0 ? (
                          <div className="px-4 py-6 text-sm text-[var(--color-muted-fg)]">
                            No folders here yet.
                          </div>
                        ) : (
                          <ul ref={listRef} className="py-2">
                            {browseRows.map((row, index) => {
                              const isSelected = index === browseSelectedIdx;
                              return (
                                <li key={row.id}>
                                  <button
                                    type="button"
                                    data-cmd-item
                                    className={cn(
                                      "mx-2 flex w-[calc(100%-1rem)] items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-all duration-150",
                                      isSelected
                                        ? "border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] -translate-y-[0.5px]"
                                        : "border-transparent hover:border-[color-mix(in_srgb,var(--color-accent)_20%,var(--color-border))] hover:bg-[color-mix(in_srgb,var(--color-accent)_5%,transparent)]"
                                    )}
                                    style={
                                      isSelected
                                        ? {
                                            boxShadow:
                                              "0 8px 24px -14px rgba(167,139,250,0.55), 0 0 0 1px rgba(167,139,250,0.35) inset",
                                          }
                                        : undefined
                                    }
                                    onMouseEnter={() => setBrowseSelectedIdx(index)}
                                    onClick={() => activateBrowseRow(row)}
                                  >
                                    <div className="flex min-w-0 items-center gap-2.5">
                                      {row.kind === "parent" ? (
                                        <ArrowRight
                                          size={14}
                                          weight="regular"
                                          className="shrink-0 rotate-180 text-[var(--color-muted-fg)]"
                                        />
                                      ) : row.isGitRepo ? (
                                        <span
                                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                                          style={{
                                            background:
                                              "linear-gradient(135deg, rgba(167,139,250,0.30), rgba(167,139,250,0.08))",
                                            boxShadow: "0 0 0 1px rgba(167,139,250,0.30) inset",
                                          }}
                                        >
                                          <GitBranch size={12} weight="bold" className="text-[var(--color-accent)]" />
                                        </span>
                                      ) : (
                                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)]">
                                          <Folder size={12} weight="regular" className="text-[var(--color-muted-fg)]" />
                                        </span>
                                      )}
                                      <div className="min-w-0">
                                        <div className="truncate text-sm font-medium text-[var(--color-fg)]">{row.title}</div>
                                        <div className="mt-0.5 truncate font-mono text-[11px] text-[var(--color-muted-fg)]">
                                          {row.hint}
                                        </div>
                                      </div>
                                    </div>
                                    <ArrowRight
                                      size={13}
                                      weight="regular"
                                      className={cn(
                                        "shrink-0 transition-opacity",
                                        isSelected ? "opacity-100 text-[var(--color-accent)]" : "opacity-40 text-[var(--color-muted-fg)]"
                                      )}
                                    />
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>

                      <BrowsePreview
                        detail={detail}
                        detailLoading={detailLoading}
                        detailPath={detailPath}
                        highlightedPath={highlightedPath}
                        highlightedIsRepo={highlightedIsRepo}
                        browseResult={browseResult}
                        activeProjectPath={project?.rootPath ?? null}
                      />
                    </div>

                    {isDragging && (
                      <div
                        className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl"
                        style={{
                          background:
                            "radial-gradient(80% 60% at 50% 50%, rgba(167,139,250,0.22), rgba(13,11,24,0.75))",
                        }}
                      >
                        <div className="flex items-center gap-3 rounded-full border border-[var(--color-accent)] bg-[var(--color-popup-bg)]/90 px-5 py-2.5 text-sm font-medium text-[var(--color-fg)] shadow-lg">
                          <FolderOpen size={18} weight="fill" className="text-[var(--color-accent)]" />
                          Drop to open
                        </div>
                      </div>
                    )}

                    <div
                      className="flex items-center gap-3 border-t px-4 py-3"
                      style={{
                        background:
                          "linear-gradient(180deg, color-mix(in srgb, var(--color-surface-recessed) 92%, rgba(167,139,250,0.06)), var(--color-surface-recessed))",
                        borderColor: "color-mix(in srgb, var(--color-accent) 12%, var(--color-border))",
                      }}
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-2 text-[11px] text-[var(--color-muted-fg)]">
                        {browseError ? (
                          <span className="flex items-center gap-1.5 text-[var(--color-danger,#F87171)]">
                            <Warning size={12} weight="fill" />
                            <span className="truncate">{browseError}</span>
                          </span>
                        ) : isCurrentProjectTarget ? (
                          <span>Already open.</span>
                        ) : (
                          <>
                            <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px]">↑↓</kbd>
                            <span>navigate</span>
                            <kbd className="ml-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px]">↵</kbd>
                            <span>step in</span>
                            <kbd className="ml-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px]">{openShortcutLabel}</kbd>
                            <span>open directory</span>
                          </>
                        )}
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] bg-transparent px-3 text-xs font-medium text-[var(--color-muted-fg)] transition-colors hover:bg-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={systemPickerPending || openProjectPending}
                          onClick={() => {
                            void handleChooseInSystemPicker();
                          }}
                        >
                          {systemPickerPending ? (
                            <CircleNotch size={14} weight="bold" className="animate-spin" />
                          ) : (
                            <FolderOpen size={14} weight="regular" />
                          )}
                          Open directory…
                        </button>
                        <button
                          type="button"
                          className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-transparent bg-[var(--color-accent)] px-4 text-xs font-semibold text-[var(--color-accent-fg)] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                          style={{
                            boxShadow:
                              canOpenHighlighted && !openProjectPending
                                ? "0 10px 24px -12px rgba(167,139,250,0.8), 0 0 0 1px rgba(167,139,250,0.35)"
                                : undefined,
                          }}
                          disabled={!canOpenHighlighted || openProjectPending || systemPickerPending}
                          onClick={() => {
                            void handleOpenProject(openTarget);
                          }}
                        >
                          {openProjectPending ? (
                            <CircleNotch size={14} weight="bold" className="animate-spin" />
                          ) : (
                            <ArrowRight size={14} weight="bold" />
                          )}
                          {openTargetLabel ? `${openProjectLabel} ${openTargetLabel}` : openProjectLabel}
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex-1 overflow-auto">
                    {filtered.length === 0 ? (
                      <div className="px-4 py-6 text-sm text-[var(--color-muted-fg)]">No matches.</div>
                    ) : (
                      <ul ref={listRef} className="py-2">
                        {(() => {
                          let flatIndex = 0;
                          return grouped.map((group) => (
                            <li key={group.label}>
                              <div className="px-4 py-1.5 text-[10px] font-mono font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-fg)]">
                                {group.label}
                              </div>
                              <ul>
                                {group.items.map((command) => {
                                  const index = flatIndex++;
                                  const isSelected = index === selectedIdx;
                                  return (
                                    <li key={command.id}>
                                      <button
                                        type="button"
                                        data-cmd-item
                                        className={cn(
                                          "mx-2 flex w-[calc(100%-1rem)] items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                                          isSelected
                                            ? "border-[var(--color-accent)] bg-[var(--color-accent-muted)]"
                                            : "border-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-muted)]"
                                        )}
                                        onMouseEnter={() => setSelectedIdx(index)}
                                        onClick={() => runCommand(command)}
                                      >
                                        <div className="min-w-0">
                                          <div className="truncate text-sm font-medium text-[var(--color-fg)]">
                                            {command.title}
                                          </div>
                                          {command.hint ? (
                                            <div className="mt-0.5 truncate text-xs text-[var(--color-muted-fg)]">{command.hint}</div>
                                          ) : null}
                                        </div>
                                        <div className="flex items-center gap-2">
                                          {command.shortcut ? (
                                            <span className="hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[10px] font-mono text-[var(--color-muted-fg)] sm:inline-flex">
                                              {command.shortcut}
                                            </span>
                                          ) : null}
                                          <ArrowRight size={14} weight="regular" className="text-[var(--color-muted-fg)]" />
                                        </div>
                                      </button>
                                    </li>
                                  );
                                })}
                              </ul>
                            </li>
                          ));
                        })()}
                      </ul>
                    )}
                  </div>
                )}
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

type BrowsePreviewProps = {
  detail: ProjectDetail | null;
  detailLoading: boolean;
  detailPath: string | null;
  highlightedPath: string | null;
  highlightedIsRepo: boolean;
  browseResult: ProjectBrowseResult | null;
  activeProjectPath: string | null;
};

function BrowsePreview({
  detail,
  detailLoading,
  detailPath,
  highlightedPath,
  highlightedIsRepo,
  browseResult,
  activeProjectPath,
}: BrowsePreviewProps) {
  const showingDetailForPath = detailPath === highlightedPath ? detail : null;
  const isLoading = detailLoading && detailPath === highlightedPath && !showingDetailForPath;

  if (!highlightedPath) {
    return (
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-8">
        <div className="max-w-[300px] text-center text-sm text-[var(--color-muted-fg)]">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]/60">
            <Folder size={24} weight="regular" className="text-[var(--color-muted-fg)]" />
          </div>
          <p>Pick a folder to see its repo details, or drop one here.</p>
        </div>
      </div>
    );
  }

  const displayName = pathLabel(highlightedPath) || highlightedPath;
  const isActiveProject = activeProjectPath === highlightedPath;

  return (
    <div className="relative min-h-0 overflow-auto">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-48"
        style={{
          background:
            "radial-gradient(70% 100% at 20% 0%, rgba(167,139,250,0.16), transparent 70%)",
        }}
      />

      <div className="relative space-y-5 p-6">
        <div className="space-y-2">
          <div className="flex items-center gap-2.5">
            {highlightedIsRepo ? (
              <span
                className="flex h-8 w-8 items-center justify-center rounded-lg"
                style={{
                  background:
                    "linear-gradient(135deg, rgba(167,139,250,0.35), rgba(167,139,250,0.10))",
                  boxShadow: "0 0 0 1px rgba(167,139,250,0.35) inset",
                }}
              >
                <GitBranch size={16} weight="bold" className="text-[var(--color-accent)]" />
              </span>
            ) : (
              <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--color-border)]">
                <Folder size={16} weight="regular" className="text-[var(--color-muted-fg)]" />
              </span>
            )}
            <h2 className="truncate text-xl font-semibold text-[var(--color-fg)]">{displayName}</h2>
            {isActiveProject && (
              <span className="ml-auto rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-accent)]">
                Open now
              </span>
            )}
          </div>
          <div className="truncate font-mono text-[11px] text-[var(--color-muted-fg)]">{highlightedPath}</div>
        </div>

        {isLoading ? (
          <PreviewSkeleton />
        ) : highlightedIsRepo && showingDetailForPath ? (
          <RepoDetailBlocks detail={showingDetailForPath} />
        ) : !highlightedIsRepo ? (
          <PlainDirectoryBlock
            browseResult={browseResult}
            highlightedPath={highlightedPath}
            detail={showingDetailForPath}
          />
        ) : null}
      </div>
    </div>
  );
}

function RepoDetailBlocks({ detail }: { detail: ProjectDetail }) {
  const lastCommitRelative = detail.lastCommit ? relativeFromNow(detail.lastCommit.isoDate) : null;
  const lastOpenedRelative = relativeFromNow(detail.lastOpenedAt);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {detail.branchName && (
          <StatusChip icon={<GitBranch size={11} weight="bold" />} tone="accent">
            {detail.branchName}
          </StatusChip>
        )}
        {detail.aheadBehind && (detail.aheadBehind.ahead > 0 || detail.aheadBehind.behind > 0) && (
          <StatusChip tone="muted">
            {detail.aheadBehind.ahead > 0 ? `↑${detail.aheadBehind.ahead} ` : ""}
            {detail.aheadBehind.behind > 0 ? `↓${detail.aheadBehind.behind}` : ""}
          </StatusChip>
        )}
        {typeof detail.dirtyCount === "number" && detail.dirtyCount > 0 && (
          <StatusChip tone="warn">{detail.dirtyCount} uncommitted</StatusChip>
        )}
        {typeof detail.dirtyCount === "number" && detail.dirtyCount === 0 && detail.branchName && (
          <StatusChip tone="muted">clean</StatusChip>
        )}
        {typeof detail.laneCount === "number" && detail.laneCount > 0 && (
          <StatusChip icon={<Stack size={11} weight="bold" />} tone="muted">
            {detail.laneCount} lane{detail.laneCount === 1 ? "" : "s"}
          </StatusChip>
        )}
        {lastOpenedRelative && (
          <StatusChip icon={<Clock size={11} weight="bold" />} tone="muted">
            opened {lastOpenedRelative}
          </StatusChip>
        )}
      </div>

      {detail.lastCommit && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]/50 p-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-muted-fg)]">
            Last commit
          </div>
          <div className="truncate text-sm text-[var(--color-fg)]">{detail.lastCommit.subject}</div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--color-muted-fg)]">
            <span className="font-mono">{detail.lastCommit.shortSha}</span>
            {lastCommitRelative && <span>· {lastCommitRelative}</span>}
          </div>
        </div>
      )}

      {detail.readmeExcerpt && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]/50 p-4">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-muted-fg)]">
            Readme
          </div>
          <ReadmeMarkdown content={detail.readmeExcerpt} />
        </div>
      )}

      {detail.languages.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-muted-fg)]">
            Languages
          </div>
          <div className="flex items-center gap-2">
            {detail.languages.map((lang) => {
              const color = LANGUAGE_SWATCHES[lang.name] ?? "var(--color-accent)";
              return (
                <span
                  key={lang.name}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)]/50 px-2.5 py-1 text-[11px] text-[var(--color-fg)]"
                >
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                  {lang.name}
                  <span className="text-[var(--color-muted-fg)]">
                    {Math.round(lang.fraction * 100)}%
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

function PlainDirectoryBlock({
  browseResult,
  highlightedPath,
  detail,
}: {
  browseResult: ProjectBrowseResult | null;
  highlightedPath: string;
  detail: ProjectDetail | null;
}) {
  const subCount = detail?.subdirectoryCount ?? (browseResult?.exactDirectoryPath === highlightedPath
    ? browseResult.entries.length
    : null);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone="muted">Plain folder</StatusChip>
        {typeof subCount === "number" && (
          <StatusChip tone="muted">{subCount} subfolder{subCount === 1 ? "" : "s"}</StatusChip>
        )}
      </div>
      <p className="text-[13px] leading-relaxed text-[var(--color-muted-fg)]">
        No git repository here. Step into a subfolder, paste a path, or drop a folder to force-open.
      </p>
    </div>
  );
}

const README_COMPONENTS: Components = {
  h1: ({ children }) => (
    <h3 className="mt-3 mb-1.5 text-[13px] font-semibold text-[var(--color-fg)] first:mt-0">{children}</h3>
  ),
  h2: ({ children }) => (
    <h4 className="mt-3 mb-1.5 text-[12px] font-semibold text-[var(--color-fg)] first:mt-0">{children}</h4>
  ),
  h3: ({ children }) => (
    <h5 className="mt-2.5 mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted-fg)] first:mt-0">{children}</h5>
  ),
  h4: ({ children }) => (
    <h6 className="mt-2 mb-1 text-[11px] font-semibold text-[var(--color-muted-fg)] first:mt-0">{children}</h6>
  ),
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 list-disc pl-5 last:mb-0 marker:text-[var(--color-muted-fg)]">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal pl-5 last:mb-0 marker:text-[var(--color-muted-fg)]">{children}</ol>,
  li: ({ children }) => <li className="mb-0.5">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (href) void window.ade?.app?.openExternal?.(href).catch(() => {});
      }}
      className="text-[var(--color-accent)] underline decoration-[var(--color-accent)]/40 underline-offset-2 hover:decoration-[var(--color-accent)]"
    >
      {children}
    </a>
  ),
  code: ({ children, className }) => {
    if (className && /language-/.test(className)) {
      return <code className={className}>{children}</code>;
    }
    return (
      <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-[11px] text-[var(--color-accent)]/90">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded-lg border border-[var(--color-border)] bg-black/40 p-2.5 font-mono text-[11px] leading-relaxed last:mb-0">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-[var(--color-accent)]/40 pl-3 text-[var(--color-muted-fg)] last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-t border-[var(--color-border)]" />,
  table: ({ children }) => (
    <div className="mb-2 overflow-x-auto rounded-md border border-[var(--color-border)] last:mb-0">
      <table className="w-full text-left text-[12px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-[var(--color-border)] bg-black/20 px-2 py-1 font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-[var(--color-border)] px-2 py-1 align-top">{children}</td>,
  img: () => null,
};

function ReadmeMarkdown({ content }: { content: string }) {
  return (
    <div className="text-[13px] leading-relaxed text-[var(--color-fg)]/90">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={README_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

function PreviewSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="flex gap-2">
        <div className="h-5 w-20 animate-pulse rounded-full bg-[var(--color-muted)]/60" />
        <div className="h-5 w-16 animate-pulse rounded-full bg-[var(--color-muted)]/50" />
        <div className="h-5 w-24 animate-pulse rounded-full bg-[var(--color-muted)]/40" />
      </div>
      <div className="h-24 animate-pulse rounded-xl bg-[var(--color-muted)]/40" />
      <div className="space-y-1.5">
        <div className="h-3 w-full animate-pulse rounded bg-[var(--color-muted)]/40" />
        <div className="h-3 w-5/6 animate-pulse rounded bg-[var(--color-muted)]/30" />
        <div className="h-3 w-4/6 animate-pulse rounded bg-[var(--color-muted)]/25" />
      </div>
    </div>
  );
}

function StatusChip({
  children,
  icon,
  tone,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
  tone: "accent" | "muted" | "warn";
}) {
  const toneStyle =
    tone === "accent"
      ? {
          background: "color-mix(in srgb, var(--color-accent) 14%, transparent)",
          borderColor: "color-mix(in srgb, var(--color-accent) 40%, var(--color-border))",
          color: "var(--color-accent)",
        }
      : tone === "warn"
        ? {
            background: "rgba(248, 113, 113, 0.12)",
            borderColor: "rgba(248, 113, 113, 0.45)",
            color: "#FCA5A5",
          }
        : {
            background: "var(--color-surface)",
            borderColor: "var(--color-border)",
            color: "var(--color-muted-fg)",
          };
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium"
      style={toneStyle}
    >
      {icon}
      {children}
    </span>
  );
}
