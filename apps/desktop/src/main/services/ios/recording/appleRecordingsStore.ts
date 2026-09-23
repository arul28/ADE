import fs from "node:fs";
import path from "node:path";
import type { SimRecording } from "./simRecordingService";

/**
 * Where Apple device recordings live on disk:
 * `<projectRoot>/.ade/artifacts/apple-recordings/<laneId>/<id>.mp4`, each with
 * an `<id>.json` sidecar holding its `SimRecording`. Everything that walks
 * this layout goes through here.
 */
export function appleRecordingsRoot(projectRoot: string): string {
  return path.join(projectRoot, ".ade", "artifacts", "apple-recordings");
}

/** The directory a lane's recordings live in. Lane delete removes it whole. */
export function appleRecordingsDirectory(projectRoot: string, laneId: string): string {
  return path.join(appleRecordingsRoot(projectRoot), laneId);
}

export type AppleRecordingFile = {
  laneId: string;
  id: string;
  /** The `.mp4`. */
  filePath: string;
  /** The `.json` sidecar next to it, which may be missing. */
  sidecarPath: string;
};

/** Every recording movie on disk, with or without a sidecar. */
export function listAppleRecordingFiles(projectRoot: string): AppleRecordingFile[] {
  const root = appleRecordingsRoot(projectRoot);
  let laneIds: string[];
  try {
    laneIds = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: AppleRecordingFile[] = [];
  for (const laneId of laneIds) {
    const laneDir = path.join(root, laneId);
    let names: string[];
    try {
      names = fs.readdirSync(laneDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".mp4")) continue;
      const id = name.slice(0, -".mp4".length);
      out.push({
        laneId,
        id,
        filePath: path.join(laneDir, name),
        sidecarPath: path.join(laneDir, `${id}.json`),
      });
    }
  }
  return out;
}

/** A sidecar, or null when it is missing or half-written. */
export function readAppleRecordingSidecar(sidecarPath: string): SimRecording | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as SimRecording;
    return parsed && typeof parsed.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}
