import fs from "node:fs";
import path from "node:path";

import {
  canonicalSourceProvider,
  isRouteProtocol,
  type RouteProbeVerdict,
  type RouteProtocol,
} from "../../../shared/harnessRoutes";

/**
 * What a live check learned about one (source, model): which protocols it
 * actually answered on. Written by the Test button (`ai.testHarnessRoute`),
 * read synchronously by every launch, so a model the catalog mislabels still
 * takes the route that works.
 *
 * Machine-local and secret-free: provider id, model id, and booleans.
 */

type ProbeFile = {
  version: 1;
  entries: Record<string, { verdict: RouteProbeVerdict; checkedAt: number }>;
};

const memo = new Map<string, { mtimeMs: number; file: ProbeFile }>();

export function routeProbeFilePath(adeHome: string): string {
  return path.join(adeHome, "cache", "harness-route-probes.json");
}

function keyFor(sourceProvider: string, modelId: string): string {
  return `${canonicalSourceProvider(sourceProvider)}/${modelId.trim()}`;
}

function readFile(adeHome: string): ProbeFile {
  const filePath = routeProbeFilePath(adeHome);
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    return { version: 1, entries: {} };
  }
  const cached = memo.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.file;
  let file: ProbeFile = { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ProbeFile>;
    if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
      file = { version: 1, entries: parsed.entries as ProbeFile["entries"] };
    }
  } catch {
    // A corrupt cache reads as empty; the next probe rewrites it.
  }
  memo.set(filePath, { mtimeMs, file });
  return file;
}

export function readRouteProbe(adeHome: string, sourceProvider: string, modelId: string): RouteProbeVerdict | null {
  const entry = readFile(adeHome).entries[keyFor(sourceProvider, modelId)];
  if (!entry?.verdict) return null;
  const verdict: RouteProbeVerdict = {};
  for (const [protocol, ok] of Object.entries(entry.verdict)) {
    if (isRouteProtocol(protocol) && typeof ok === "boolean") verdict[protocol] = ok;
  }
  return Object.keys(verdict).length ? verdict : null;
}

export function recordRouteProbe(
  adeHome: string,
  sourceProvider: string,
  modelId: string,
  protocol: RouteProtocol,
  ok: boolean,
  now: number = Date.now(),
): void {
  const filePath = routeProbeFilePath(adeHome);
  const file = readFile(adeHome);
  const key = keyFor(sourceProvider, modelId);
  const previous = file.entries[key]?.verdict ?? {};
  const next: ProbeFile = {
    version: 1,
    entries: { ...file.entries, [key]: { verdict: { ...previous, [protocol]: ok }, checkedAt: now } },
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), "utf8");
    fs.renameSync(tmp, filePath);
    memo.delete(filePath);
  } catch {
    // A probe that cannot be persisted still answered this one request.
  }
}
