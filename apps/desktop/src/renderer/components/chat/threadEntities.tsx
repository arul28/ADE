// Draw the ADE entities an agent names in its replies as live chips.
//
// `shared/threadEntities.ts` decides WHAT a span names; this file does the two
// renderer jobs around it:
//
//   1. `ThreadEntityProvider` builds the lookup from the CHAT's machine (its
//      lanes and sessions, never the project tab's), plus the chat's slash
//      commands. The lookup is keyed on a signature of ids and names, so a lane
//      status tick does not re-parse every message in the transcript.
//   2. `remarkThreadEntities` rewrites the markdown tree: matched inline code
//      and prose spans become `ade-entity` nodes, which `ThreadEntityNode`
//      renders. Code blocks and existing links are never touched.

import { createContext, useContext, useMemo, type ReactNode } from "react";

import {
  buildThreadEntityLookup,
  EMPTY_THREAD_ENTITY_LOOKUP,
  findProseEntities,
  matchInlineCodeEntity,
  threadEntityKey,
  type ThreadEntity,
  type ThreadEntityBlockContext,
  type ThreadEntityLookup,
} from "../../../shared/threadEntities";
import { useLanesForPin, useSessionsForPin } from "../../state/crossMachineLanes";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { TranscriptChip } from "./ChipText";

const ThreadEntityLookupContext = createContext<ThreadEntityLookup>(EMPTY_THREAD_ENTITY_LOOKUP);

export function useThreadEntityLookup(): ThreadEntityLookup {
  return useContext(ThreadEntityLookupContext);
}

const LINEAR_KEY_RE = /^([A-Za-z][A-Za-z0-9]{0,9})-\d+$/;

export function ThreadEntityProvider({
  skillNames,
  children,
}: {
  skillNames?: readonly string[];
  children: ReactNode;
}) {
  const scope = useChatRuntimeScope();
  const lanes = useLanesForPin(scope.binding);
  const sessions = useSessionsForPin(scope.binding);

  // Lane status refreshes replace these arrays every few seconds. Matching only
  // needs ids, names and keys, so reduce to a signature first and rebuild the
  // lookup (and re-parse the transcript) only when that string changes.
  const signature = useMemo(() => {
    const laneParts = (lanes ?? []).map((lane) => `${lane.id}\u0001${lane.name}`);
    const keys = new Set<string>();
    for (const lane of lanes ?? []) {
      const identifiers = [lane.linearIssue?.identifier, ...(lane.linearIssueLinks ?? []).map((link) => link.issue?.identifier)];
      for (const identifier of identifiers) {
        const key = identifier ? LINEAR_KEY_RE.exec(identifier)?.[1] : null;
        if (key) keys.add(key.toUpperCase());
      }
    }
    const sessionPart = (sessions ?? []).map((session) => session.id).join("\u0002");
    return [
      laneParts.join("\u0002"),
      sessionPart,
      [...keys].sort().join(","),
      [...(skillNames ?? [])].sort().join(","),
    ].join("\u0003");
  }, [lanes, sessions, skillNames]);

  const lookup = useMemo(() => {
    const [laneBlob = "", sessionBlob = "", keyBlob = "", skillBlob = ""] = signature.split("\u0003");
    return buildThreadEntityLookup({
      lanes: laneBlob ? laneBlob.split("\u0002").map((part) => {
        const [id = "", name = ""] = part.split("\u0001");
        return { id, name };
      }) : [],
      sessions: sessionBlob ? sessionBlob.split("\u0002").map((id) => ({ id })) : [],
      linearTeamKeys: keyBlob ? keyBlob.split(",") : [],
      skillNames: skillBlob ? skillBlob.split(",") : [],
    });
  }, [signature]);

  return <ThreadEntityLookupContext.Provider value={lookup}>{children}</ThreadEntityLookupContext.Provider>;
}

/* ── remark plugin ── */

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
};

// A new block resets the "last file" context: a line range in one bullet must
// not open the file named in the bullet above it.
const BLOCK_TYPES = new Set(["paragraph", "heading", "tableCell", "listItem", "blockquote"]);
// Never rewrite inside these: a link already goes somewhere, and code is code.
const OPAQUE_TYPES = new Set(["link", "linkReference", "code", "html", "image", "imageReference", "definition"]);

export const THREAD_ENTITY_TAG = "ade-entity";

function entityNode(entity: ThreadEntity, raw: string, fromCode: boolean): MdNode {
  return {
    type: "adeEntity",
    data: {
      hName: THREAD_ENTITY_TAG,
      hProperties: { dataEntity: JSON.stringify(entity), dataCode: fromCode ? "1" : "0" },
      hChildren: [{ type: "text", value: raw }],
    },
  };
}

function nodeEntity(node: MdNode | undefined): ThreadEntity | null {
  if (node?.type !== "adeEntity") return null;
  const props = (node.data?.hProperties ?? {}) as { dataEntity?: string };
  return props.dataEntity ? (JSON.parse(props.dataEntity) as ThreadEntity) : null;
}

/**
 * "`opencode-harness-audit` (`4c90a638-…`)" names one lane twice. The chip
 * already carries the id in its hover, so drop the parenthesised echo.
 */
function collapseEchoes(children: MdNode[]): MdNode[] {
  const out = [...children];
  for (let index = 0; index + 3 < out.length; index += 1) {
    const key = (() => {
      const entity = nodeEntity(out[index]);
      return entity ? threadEntityKey(entity) : null;
    })();
    if (!key) continue;
    const open = out[index + 1]!;
    const echo = nodeEntity(out[index + 2]);
    const close = out[index + 3]!;
    if (open.type !== "text" || !/^\s*\($/.test(open.value ?? "")) continue;
    if (!echo || threadEntityKey(echo) !== key) continue;
    if (close.type !== "text" || !(close.value ?? "").startsWith(")")) continue;
    close.value = close.value!.slice(1);
    out.splice(index + 1, 2);
  }
  return out.filter((node) => node.type !== "text" || (node.value ?? "").length > 0);
}

function splitProse(node: MdNode, lookup: ThreadEntityLookup): MdNode[] {
  const text = node.value ?? "";
  const matches = findProseEntities(text, lookup);
  if (matches.length === 0) return [node];
  const out: MdNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) out.push({ type: "text", value: text.slice(cursor, match.start) });
    out.push(entityNode(match.entity, text.slice(match.start, match.end), false));
    cursor = match.end;
  }
  if (cursor < text.length) out.push({ type: "text", value: text.slice(cursor) });
  return out;
}

function rewrite(
  node: MdNode,
  context: ThreadEntityBlockContext,
  lookup: ThreadEntityLookup,
  filePathOf: (code: string) => string | null,
): void {
  if (!node.children?.length) return;
  const blockContext = BLOCK_TYPES.has(node.type) ? { lastFilePath: null } : context;
  const next: MdNode[] = [];
  let changed = false;
  for (const child of node.children) {
    if (child.type === "inlineCode") {
      const value = child.value ?? "";
      const path = filePathOf(value);
      if (path) {
        blockContext.lastFilePath = path;
        next.push(child);
        continue;
      }
      const entity = matchInlineCodeEntity(value, lookup, blockContext);
      if (entity) {
        next.push(entityNode(entity, value, true));
        changed = true;
      } else {
        next.push(child);
      }
      continue;
    }
    if (child.type === "text") {
      const parts = splitProse(child, lookup);
      if (parts.length !== 1 || parts[0] !== child) changed = true;
      next.push(...parts);
      continue;
    }
    if (!OPAQUE_TYPES.has(child.type)) rewrite(child, blockContext, lookup, filePathOf);
    next.push(child);
  }
  if (changed) node.children = collapseEchoes(next);
}

/**
 * The remark plugin. `filePathOf` is the renderer's own "is this code span a
 * workspace file" test, so file chips and line follow-ups agree on what a file
 * is.
 */
export function remarkThreadEntities(options: {
  lookup: ThreadEntityLookup;
  filePathOf: (code: string) => string | null;
}) {
  return (tree: MdNode) => {
    rewrite(tree, { lastFilePath: null }, options.lookup, options.filePathOf);
  };
}

/* ── node view ── */

const TIME_FORMAT_SAME_DAY = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
const TIME_FORMAT_OTHER_DAY = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const TIME_FORMAT_RANGE = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * A zoned timestamp (or same-day range) in the reader's local time: "1:20:04 AM"
 * today, "Sep 30, 10:24 PM" on another day, "Sep 30, 9:52 – 10:24 PM" for a range.
 */
export function formatThreadTimestamp(epochMs: number, endEpochMs: number | null = null, now: number = Date.now()): string {
  const date = new Date(epochMs);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  if (endEpochMs != null) {
    const range = TIME_FORMAT_RANGE.formatRange(date, new Date(endEpochMs));
    return sameDay ? range : `${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)}, ${range}`;
  }
  return sameDay ? TIME_FORMAT_SAME_DAY.format(date) : TIME_FORMAT_OTHER_DAY.format(date);
}

export function ThreadEntityNode({
  node,
  renderFileLine,
  fallback,
}: {
  node: unknown;
  renderFileLine: (entity: Extract<ThreadEntity, { type: "file_line" }>) => ReactNode;
  fallback: ReactNode;
}) {
  const props = ((node as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}) as {
    dataEntity?: string;
  };
  const entity = useMemo(() => {
    try {
      return props.dataEntity ? (JSON.parse(props.dataEntity) as ThreadEntity) : null;
    } catch {
      return null;
    }
  }, [props.dataEntity]);
  if (!entity) return <>{fallback}</>;
  if (entity.type === "chip") return <TranscriptChip chip={entity.chip} />;
  if (entity.type === "file_line") return <>{renderFileLine(entity)}</>;
  return (
    <time
      dateTime={entity.iso}
      title={entity.raw}
      className="cursor-help underline decoration-dotted decoration-current/35 underline-offset-2"
    >
      {formatThreadTimestamp(entity.epochMs, entity.endEpochMs)}
    </time>
  );
}
