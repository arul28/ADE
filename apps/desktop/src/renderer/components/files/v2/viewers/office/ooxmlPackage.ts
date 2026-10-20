// Package plumbing both OOXML readers share: part-path resolution and the
// relationship maps (`_rels/*.rels`) that name every other part.
//
// It lives in one module on purpose. Two copies of "collapse `..`, strip the
// leading slash" is exactly the kind of untrusted-input handling where one copy
// gets a fix and the other keeps the bug.

import { elementsNS, parseXml } from "./ooxmlXml";

/** `external` is only ever true when the caller asked to keep external targets. */
export type Relationship = { target: string; type: string; external: boolean };

/**
 * Resolve an OOXML relationship Target against the part's directory.
 *
 * Targets are package paths, always `/`-separated: `worksheets/sheet1.xml`,
 * `/xl/worksheets/sheet1.xml`, or `../media/image1.png`. Never a filesystem
 * path, so no platform branch belongs here.
 */
function resolvePartPath(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const segments = baseDir.split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

/**
 * Read a `.rels` part into `Id → { target, type, external }` with internal
 * targets already resolved. External relationships (a video linked from a
 * share, a hyperlink) name no package part and are dropped unless
 * `keepExternal` is set; then their target is kept verbatim and marked
 * `external`, so a caller can never mistake it for a package path.
 */
export function parseRelationships(
  relsXml: string | null,
  baseDir: string,
  options: { keepExternal?: boolean } = {},
): Map<string, Relationship> {
  const rels = new Map<string, Relationship>();
  if (!relsXml) return rels;
  const doc = parseXml(relsXml);
  if (!doc) return rels;
  for (const rel of elementsNS(doc, "Relationship")) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (!id || !target) continue;
    const type = rel.getAttribute("Type") ?? "";
    if ((rel.getAttribute("TargetMode") ?? "").toLowerCase() === "external") {
      if (options.keepExternal) rels.set(id, { target, type, external: true });
      continue;
    }
    rels.set(id, { target: resolvePartPath(baseDir, target), type, external: false });
  }
  return rels;
}
