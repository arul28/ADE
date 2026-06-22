import React from "react";
import {
  BookOpenText,
  FileZip as FileArchive,
  FileCss as FileBraces,
  GearSix as FileCog,
  FileTs as FileCode2,
  FileImage,
  FileText,
  Terminal as TerminalSquare,
  FileXls as FileSpreadsheet,
  FileDoc,
  FilePdf,
  FilePpt,
  MusicNotes,
  VideoCamera,
} from "@phosphor-icons/react";
import type { FileTreeNode } from "../../../shared/types";
import { COLORS } from "../lanes/laneDesignTokens";

const FILE_ICON_COLORS = {
  code: "#38BDF8",
  json: "#34D399",
  config: "#FB923C",
  markdown: "#FBBF24",
  style: "#818CF8",
  shell: "#2DD4BF",
  image: "#E879F9",
  audio: "#22D3EE",
  video: "#A78BFA",
  archive: "#FB7185",
  document: "#60A5FA",
  pdf: "#F87171",
  presentation: "#F97316",
  spreadsheet: "#4ADE80",
  default: COLORS.textMuted,
} as const;

export function getFileIcon(fileName: string): { icon: React.ComponentType<any>; color: string } {
  const lower = fileName.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";

  if (
    ext === ".ts" ||
    ext === ".tsx" ||
    ext === ".mts" ||
    ext === ".cts" ||
    ext === ".js" ||
    ext === ".jsx" ||
    ext === ".mjs" ||
    ext === ".cjs"
  ) {
    return { icon: FileCode2, color: FILE_ICON_COLORS.code };
  }
  if (ext === ".json" || ext === ".jsonc") {
    return { icon: FileBraces, color: FILE_ICON_COLORS.json };
  }
  if (ext === ".yml" || ext === ".yaml" || ext === ".toml" || ext === ".ini") {
    return { icon: FileCog, color: FILE_ICON_COLORS.config };
  }
  if (ext === ".md" || ext === ".mdx") {
    return { icon: BookOpenText, color: FILE_ICON_COLORS.markdown };
  }
  if (ext === ".css" || ext === ".scss" || ext === ".sass" || ext === ".less") {
    return { icon: FileCode2, color: FILE_ICON_COLORS.style };
  }
  if (ext === ".sh" || ext === ".bash" || ext === ".zsh" || ext === ".fish" || ext === ".ps1") {
    return { icon: TerminalSquare, color: FILE_ICON_COLORS.shell };
  }
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".gif" || ext === ".webp" || ext === ".svg" || ext === ".ico") {
    return { icon: FileImage, color: FILE_ICON_COLORS.image };
  }
  if (ext === ".mp3" || ext === ".m4a" || ext === ".aac" || ext === ".wav" || ext === ".flac" || ext === ".ogg" || ext === ".oga" || ext === ".opus") {
    return { icon: MusicNotes, color: FILE_ICON_COLORS.audio };
  }
  if (ext === ".mp4" || ext === ".m4v" || ext === ".mov" || ext === ".webm" || ext === ".ogv" || ext === ".avi" || ext === ".mkv") {
    return { icon: VideoCamera, color: FILE_ICON_COLORS.video };
  }
  if (ext === ".pdf") {
    return { icon: FilePdf, color: FILE_ICON_COLORS.pdf };
  }
  if (ext === ".doc" || ext === ".docx") {
    return { icon: FileDoc, color: FILE_ICON_COLORS.document };
  }
  if (ext === ".ppt" || ext === ".pptx") {
    return { icon: FilePpt, color: FILE_ICON_COLORS.presentation };
  }
  if (ext === ".zip" || ext === ".tar" || ext === ".gz" || ext === ".tgz" || ext === ".rar" || ext === ".7z") {
    return { icon: FileArchive, color: FILE_ICON_COLORS.archive };
  }
  if (ext === ".csv" || ext === ".tsv" || ext === ".xls" || ext === ".xlsx") {
    return { icon: FileSpreadsheet, color: FILE_ICON_COLORS.spreadsheet };
  }
  return { icon: FileText, color: FILE_ICON_COLORS.default };
}

// Extension → Monaco language id. Far broader than the server's languageIdFromPath
// so the editor highlights real-world files instead of falling back to plaintext.
const EXT_TO_MONACO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", json5: "json",
  yml: "yaml", yaml: "yaml",
  md: "markdown", mdx: "markdown", markdown: "markdown",
  py: "python", pyi: "python",
  rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", swift: "swift", m: "objective-c", mm: "objective-c",
  rb: "ruby", php: "php", pl: "perl", lua: "lua", r: "r", scala: "scala",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ps1: "powershell",
  css: "css", scss: "scss", sass: "scss", less: "less",
  html: "html", htm: "html", xml: "xml", svg: "xml", vue: "html",
  sql: "sql", graphql: "graphql", gql: "graphql",
  toml: "ini", ini: "ini", cfg: "ini", conf: "ini", env: "ini", properties: "ini",
  dockerfile: "dockerfile", makefile: "makefile",
  proto: "proto", tf: "hcl", hcl: "hcl",
  txt: "plaintext", log: "plaintext", csv: "plaintext", tsv: "plaintext",
};

// Filename (lowercased, no directory) → Monaco language id, for files where the
// name matters more than the extension.
const FILENAME_TO_MONACO_LANGUAGE: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  "gnumakefile": "makefile",
  "cmakelists.txt": "cmake",
  ".gitignore": "ignore",
  ".gitattributes": "ignore",
  ".npmignore": "ignore",
  ".dockerignore": "ignore",
  ".env": "ini",
  "go.mod": "go-mod",
  "go.sum": "plaintext",
};

/**
 * Resolve the Monaco language id for a file. Prefers a meaningful server-provided
 * id, then a filename special-case (Dockerfile, Makefile, .env…), then the
 * extension map, and only then falls back to plaintext. This replaces the old
 * `languageId || "plaintext"` that left most files unhighlighted.
 */
export function resolveLanguageId(fileName: string, serverLanguageId?: string | null): string {
  if (serverLanguageId && serverLanguageId !== "plaintext" && serverLanguageId !== "image") {
    return serverLanguageId;
  }
  const base = fileName.toLowerCase().split(/[\\/]/).pop() ?? fileName.toLowerCase();
  const byName = FILENAME_TO_MONACO_LANGUAGE[base];
  if (byName) return byName;
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : base;
  return EXT_TO_MONACO_LANGUAGE[ext] ?? "plaintext";
}

export function changeStatusColor(changeStatus: FileTreeNode["changeStatus"]): string {
  if (changeStatus === "added" || changeStatus === "untracked" || changeStatus === "A") return COLORS.success;
  if (changeStatus === "deleted" || changeStatus === "D") return COLORS.danger;
  if (changeStatus === "renamed") return COLORS.info;
  if (changeStatus === "modified" || changeStatus === "M") return COLORS.warning;
  if (changeStatus === "ignored") return COLORS.textDim;
  return COLORS.textDim;
}

export function changeStatusLabel(changeStatus: FileTreeNode["changeStatus"]): string | null {
  if (!changeStatus) return null;
  switch (changeStatus) {
    case "A":
    case "added":
      return "A";
    case "D":
    case "deleted":
      return "D";
    case "M":
    case "modified":
      return "M";
    case "renamed":
      return "R";
    case "untracked":
      return "U";
    case "ignored":
      return "I";
    default:
      return "?";
  }
}

export function changeStatusTitle(changeStatus: FileTreeNode["changeStatus"]): string | undefined {
  if (!changeStatus) return undefined;
  switch (changeStatus) {
    case "A":
    case "added":
      return "Added";
    case "D":
    case "deleted":
      return "Deleted";
    case "M":
    case "modified":
      return "Modified";
    case "renamed":
      return "Renamed";
    case "untracked":
      return "Untracked";
    case "ignored":
      return "Ignored";
    default:
      return "Changed";
  }
}
