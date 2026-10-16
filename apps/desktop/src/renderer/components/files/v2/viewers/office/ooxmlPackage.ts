// Package plumbing both OOXML readers share: part-path resolution and the
// relationship maps (`_rels/*.rels`) that name every other part.
//
// It lives in one module on purpose. Two copies of "collapse `..`, strip the
// leading slash" is exactly the kind of untrusted-input handling where one copy
// gets a fix and the other keeps the bug.

import { elementsNS, parseXml } from "./ooxmlXml";

export type Relationship = { target: string; type: string };

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
 * Read a `.rels` part into `Id → { target, type }` with the target already
 * resolved. External relationships (a video linked from a share) name no
 * package part and are dropped.
 */
export function parseRelationships(relsXml: string | null, baseDir: string): Map<string, Relationship> {
  const rels = new Map<string, Relationship>();
  if (!relsXml) return rels;
  const doc = parseXml(relsXml);
  if (!doc) return rels;
  for (const rel of elementsNS(doc, "Relationship")) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (!id || !target) continue;
    if ((rel.getAttribute("TargetMode") ?? "").toLowerCase() === "external") continue;
    rels.set(id, { target: resolvePartPath(baseDir, target), type: rel.getAttribute("Type") ?? "" });
  }
  return rels;
}
