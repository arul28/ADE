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
  archive: "#FB7185",
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
  if (ext === ".zip" || ext === ".tar" || ext === ".gz" || ext === ".tgz" || ext === ".rar" || ext === ".7z") {
    return { icon: FileArchive, color: FILE_ICON_COLORS.archive };
  }
  if (ext === ".csv" || ext === ".tsv" || ext === ".xls" || ext === ".xlsx") {
    return { icon: FileSpreadsheet, color: FILE_ICON_COLORS.spreadsheet };
  }
  return { icon: FileText, color: FILE_ICON_COLORS.default };
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
