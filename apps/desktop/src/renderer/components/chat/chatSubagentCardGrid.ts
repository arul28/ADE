import { isUsageLimitFailureText } from "../../../shared/usageLimitResumePresentation";
import { deriveSubagentCardName, isInlineCardSpawnNotice, isSubagentPlaceholderSummary } from "../../../shared/chatSubagents";
import { collectConsecutiveRun, sameRunMembers } from "./chatTranscriptRunCollector";
import type {
  ChatTranscriptGroupedEnvelope,
  SubagentCardGridMember,
  SubagentResultCardRenderEvent,
  SubagentSpawnAnchorRenderEvent,
  SubagentStoppedGroupCause,
  SubagentStoppedGroupEvent,
  SubagentStoppedGroupItem,
} from "./chatTranscriptRows";

export const SUBAGENT_CARD_GRID_MAX_COLUMNS = 3;
export const SUBAGENT_CARD_MIN_WIDTH_PX = 232;
export const SUBAGENT_CARD_GRID_GAP_PX = 8;
export const SUBAGENT_CARD_GRID_TRACKS = 6;

export function subagentCardGridColumns(count: number, widthPx: number): number {
  const fit = Math.floor((widthPx + SUBAGENT_CARD_GRID_GAP_PX) / (SUBAGENT_CARD_MIN_WIDTH_PX + SUBAGENT_CARD_GRID_GAP_PX));
  return Math.max(1, Math.min(count, SUBAGENT_CARD_GRID_MAX_COLUMNS, fit));
}

export function subagentCardGridSpan(index: number, count: number, columns: number): number {
  const perRow = Math.max(1, Math.min(columns, SUBAGENT_CARD_GRID_MAX_COLUMNS));
  const remainder = count % perRow;
  const inShortLastRow = remainder > 0 && index >= count - remainder;
  return SUBAGENT_CARD_GRID_TRACKS / (inShortLastRow ? remainder : perRow);
}

export function subagentSpawnKey(agentKey: string): string {
  return `subagent-spawn:${agentKey}`;
}

export function subagentResultKey(agentKey: string): string {
  return `subagent-result:${agentKey}`;
}

export function subagentCardRowKeyCandidates(key: string): string[] {
  if (key.startsWith("subagent-result:")) {
    const agentKey = key.slice("subagent-result:".length);
    return [key, subagentSpawnKey(agentKey)];
  }
  if (key.startsWith("subagent-spawn:")) {
    const agentKey = key.slice("subagent-spawn:".length);
    return [key, subagentResultKey(agentKey)];
  }
  return [key];
}

export function meaningfulStoppedSummary(
  event: Pick<SubagentResultCardRenderEvent, "summaryPreview">,
): string | null {
  const summary = event.summaryPreview?.trim();
  if (!summary || isSubagentPlaceholderSummary(summary) || SUBAGENT_STOP_SENTENCE.test(summary)) return null;
  return summary;
}

const SUBAGENT_STOP_SENTENCE = /^(interrupted(\s+by\b.*)?|stopped(\s*[:—-].*)?|agent (stopped|interrupted))[.!]*$/is;

type SubagentResultCardRow = ChatTranscriptGroupedEnvelope & { event: SubagentResultCardRenderEvent };
type SubagentCardRow = ChatTranscriptGroupedEnvelope & {
  event: SubagentSpawnAnchorRenderEvent | SubagentResultCardRenderEvent;
};

function stoppedGroupCauseOf(event: SubagentResultCardRenderEvent): SubagentStoppedGroupCause | null {
  if (event.status === "stopped") {
    return event.resultLanded || meaningfulStoppedSummary(event) ? null : "interrupt";
  }
  const reason = event.error?.trim() || event.summaryPreview?.trim() || null;
  return event.status === "failed" && isUsageLimitFailureText(reason) ? "usage_limit" : null;
}

function isFoldableStoppedCard(row: ChatTranscriptGroupedEnvelope): row is SubagentResultCardRow {
  return row.event.type === "subagent_result_card" && stoppedGroupCauseOf(row.event) !== null;
}

function stopSourceOf(event: SubagentResultCardRenderEvent): SubagentStoppedGroupEvent["stopSource"] {
  if (event.status === "failed") return "provider";
  return event.stopSource ?? "unknown";
}

function stopReasonOf(event: SubagentResultCardRenderEvent): string | null {
  return event.stopReason?.trim() || null;
}

function isHiddenBetweenStoppedCards(row: ChatTranscriptGroupedEnvelope): boolean {
  return row.event.type === "work_log_group" || isInlineCardSpawnNotice(row.event);
}

/** Collapse only adjacent stopped/limit casualties with the same cause and attribution. */
export function groupStoppedSubagentResultCards(
  rows: ChatTranscriptGroupedEnvelope[],
  previousRows: readonly ChatTranscriptGroupedEnvelope[] = [],
): ChatTranscriptGroupedEnvelope[] {
  const previousByKey = new Map(previousRows.map((row) => [row.key, row]));
  let result: ChatTranscriptGroupedEnvelope[] | null = null;
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    const run = collectConsecutiveRun(rows, index, {
      isMember: isFoldableStoppedCard,
      isIgnorable: isHiddenBetweenStoppedCards,
      canJoin: (first, candidate) => (
        stoppedGroupCauseOf(first.event) === stoppedGroupCauseOf(candidate.event)
        && stopSourceOf(first.event) === stopSourceOf(candidate.event)
        && stopReasonOf(first.event) === stopReasonOf(candidate.event)
      ),
    });
    if (!run) {
      result?.push(row);
      index += 1;
      continue;
    }

    if (!result) result = rows.slice(0, index);
    index = run.nextIndex;
    if (run.members.length <= SUBAGENT_CARD_GRID_MAX_COLUMNS) {
      result.push(...rows.slice(index - run.members.length - run.skipped.length, index));
      continue;
    }

    const first = run.members[0]!;
    const last = run.members[run.members.length - 1]!;
    const cause = stoppedGroupCauseOf(first.event)!;
    const stopSource = stopSourceOf(first.event);
    const stopReason = stopReasonOf(first.event);
    const items: SubagentStoppedGroupItem[] = run.members.map(({ event }) => ({
      agentKey: event.agentKey,
      title: deriveSubagentCardName(event),
      lastActivity: event.lastActivity?.trim() || null,
      resultLanded: event.resultLanded === true,
    }));
    result.push(...run.skipped);
    const key = `subagent-stopped-group:${cause}:${stopSource}:${stopReason ?? "unknown"}:${first.event.agentKey}`;
    const timestamp = last.timestamp;
    const memberKeys = run.members.map((member) => member.key);
    const previous = previousByKey.get(key);
    if (
      previous?.event.type === "subagent_stopped_group"
      && previous.timestamp === timestamp
      && previous.event.cause === cause
      && previous.event.stopSource === stopSource
      && previous.event.stopReason === stopReason
      && sameRunMembers(previous.event.memberKeys, memberKeys)
      && previous.event.items.length === items.length
      && previous.event.items.every((item, itemIndex) => {
        const next = items[itemIndex]!;
        return item.agentKey === next.agentKey
          && item.title === next.title
          && item.lastActivity === next.lastActivity
          && item.resultLanded === next.resultLanded;
      })
    ) {
      result.push(previous);
      continue;
    }
    result.push({
      key,
      timestamp,
      event: {
        type: "subagent_stopped_group",
        cause,
        stopSource,
        stopReason,
        count: run.members.length,
        items,
        memberKeys: run.members.map((member) => member.key),
      },
    });
  }
  return result ?? rows;
}

function isSubagentCardRow(row: ChatTranscriptGroupedEnvelope): row is SubagentCardRow {
  return row.event.type === "subagent_spawn_anchor" || row.event.type === "subagent_result_card";
}

function isInvisibleBetweenSubagentCards(row: ChatTranscriptGroupedEnvelope): boolean {
  return isInlineCardSpawnNotice(row.event);
}

/** Fold adjacent running/result cards into a grid row; preserve the input when nothing groups. */
export function groupSubagentCardGrids(
  rows: ChatTranscriptGroupedEnvelope[],
  previousRows: readonly ChatTranscriptGroupedEnvelope[] = [],
): ChatTranscriptGroupedEnvelope[] {
  const previousByKey = new Map(previousRows.map((row) => [row.key, row]));
  let result: ChatTranscriptGroupedEnvelope[] | null = null;
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    const run = collectConsecutiveRun(rows, index, {
      isMember: isSubagentCardRow,
      isIgnorable: isInvisibleBetweenSubagentCards,
    });
    if (!run) {
      result?.push(row);
      index += 1;
      continue;
    }
    if (!result) result = rows.slice(0, index);
    const members: SubagentCardGridMember[] = run.members;
    result.push(...run.skipped);
    const timestamp = members[members.length - 1]!.timestamp;
    const memberKeys = members.map((member) => member.key);
    const previous = previousByKey.get(row.key);
    if (
      previous?.event.type === "subagent_card_grid"
      && previous.timestamp === timestamp
      && sameRunMembers(previous.event.members, members)
      && sameRunMembers(previous.event.memberKeys, memberKeys)
    ) {
      result.push(previous);
      index = run.nextIndex;
      continue;
    }
    result.push({
      key: row.key,
      timestamp,
      event: { type: "subagent_card_grid", members, memberKeys },
    });
    index = run.nextIndex;
  }
  return result ?? rows;
}

export function subagentCardGridKeyByMemberKey(
  rows: readonly ChatTranscriptGroupedEnvelope[],
): Map<string, string> {
  const byMember = new Map<string, string>();
  const byAlias = new Map<string, string>();
  const add = (cardKey: string, rowKey: string) => {
    byMember.set(cardKey, rowKey);
    for (const alias of subagentCardRowKeyCandidates(cardKey).slice(1)) byAlias.set(alias, rowKey);
  };
  for (const row of rows) {
    if (row.event.type === "subagent_card_grid" || row.event.type === "subagent_stopped_group") {
      for (const memberKey of row.event.memberKeys) add(memberKey, row.key);
    } else if (isSubagentCardRow(row)) {
      add(row.key, row.key);
    }
  }
  for (const [alias, rowKey] of byAlias) {
    if (!byMember.has(alias)) byMember.set(alias, rowKey);
  }
  return byMember;
}
