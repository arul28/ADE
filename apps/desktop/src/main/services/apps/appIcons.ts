/**
 * An installed app's icon by the name the transcript knows it by ("Xcode",
 * "Notes", "Google Chrome"), for the computer-use rows that name the app an
 * agent drove.
 *
 * @module apps/appIcons
 */
import fs from "node:fs";
import path from "node:path";

import { macApplicationDirectories } from "../browsers/browserDetection";
import { browserIconDataUrl } from "../browsers/browserIcons";

const iconByName = new Map<string, string | null>();

/**
 * The app's icon as a data URL, or null.
 *
 * The name comes from agent output, so it is only ever joined onto the fixed
 * application folders as `<name>.app`: a name with a path separator, `..`, or
 * an unreasonable length is refused outright. macOS only — Windows has no
 * name-to-executable map this process can trust, and Linux has no per-app
 * icon — so other systems answer null and the row draws its glyph.
 */
export async function appIconDataUrlByName(rawName: string): Promise<string | null> {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name || name.length > 80 || /[\\/\u0000]/.test(name) || name.includes("..")) return null;
  if (process.platform !== "darwin") return null;
  const cacheKey = name.toLowerCase();
  if (iconByName.has(cacheKey)) return iconByName.get(cacheKey) ?? null;
  let url: string | null = null;
  for (const directory of appSearchDirectories()) {
    const candidate = path.join(directory, `${name}.app`);
    if (!fs.existsSync(candidate)) continue;
    url = await browserIconDataUrl(candidate, { platform: "darwin" });
    if (url) break;
  }
  iconByName.set(cacheKey, url);
  return url;
}

function appSearchDirectories(): string[] {
  return [...macApplicationDirectories(process.env), "/Applications/Utilities", "/System/Applications/Utilities"];
}
