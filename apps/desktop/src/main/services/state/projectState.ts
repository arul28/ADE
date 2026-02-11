import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { ProjectInfo } from "../../../shared/types";

export type AdePaths = {
  adeDir: string;
  logsDir: string;
  processLogsDir: string;
  testLogsDir: string;
  transcriptsDir: string;
  worktreesDir: string;
  packsDir: string;
  dbPath: string;
};

function resolveProjectRoot(): string {
  const envRoot = process.env.ADE_PROJECT_ROOT;
  if (envRoot && envRoot.trim().length > 0) {
    return path.resolve(envRoot);
  }

  // Dev default: this assumes `electron .` is run from `apps/desktop`.
  if (process.env.VITE_DEV_SERVER_URL) {
    return path.resolve(process.cwd(), "..", "..");
  }

  // Packaged fallback: keep state somewhere writable until onboarding picks a repo.
  return path.resolve(app.getPath("userData"), "ade-project");
}

export function getProjectInfo(): ProjectInfo {
  const rootPath = resolveProjectRoot();
  return {
    rootPath,
    displayName: path.basename(rootPath),
    baseRef: "main"
  };
}

export function ensureAdeDirs(projectRoot: string): AdePaths {
  const adeDir = path.join(projectRoot, ".ade");
  const logsDir = path.join(adeDir, "logs");
  const processLogsDir = path.join(logsDir, "processes");
  const testLogsDir = path.join(logsDir, "tests");
  const transcriptsDir = path.join(adeDir, "transcripts");
  const worktreesDir = path.join(adeDir, "worktrees");
  const packsDir = path.join(adeDir, "packs");
  const dbPath = path.join(adeDir, "ade.db");

  fs.mkdirSync(processLogsDir, { recursive: true });
  fs.mkdirSync(testLogsDir, { recursive: true });
  fs.mkdirSync(transcriptsDir, { recursive: true });
  fs.mkdirSync(worktreesDir, { recursive: true });
  fs.mkdirSync(packsDir, { recursive: true });

  // A small marker helps debugging state location quickly.
  try {
    const markerPath = path.join(adeDir, "README.txt");
    if (!fs.existsSync(markerPath)) {
      fs.writeFileSync(
        markerPath,
        "ADE local state. Safe to delete. This folder is intended to be git-ignored.\n",
        "utf8"
      );
    }
  } catch {
    // Ignore marker failures.
  }

  return { adeDir, logsDir, processLogsDir, testLogsDir, transcriptsDir, worktreesDir, packsDir, dbPath };
}
