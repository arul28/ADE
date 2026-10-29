import { randomUUID } from "node:crypto";
import type { PrSummary } from "../../../shared/types";
import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import { getErrorMessage, nowIso } from "../shared/utils";

/**
 * How many not-yet-reconciled agent stack attachments to remember. An entry
 * lives until the PR joins a GitHub stack, which for a non-stacked PR never
 * happens; without a cap a long-lived brain would grow one entry per
 * agent-created PR and re-run the parent-attach queries for all of them on
 * every reconcile. The cap drops the oldest, whose attach has already had its
 * best chance.
 */
const PENDING_STACK_ATTACH_CAP = 200;

export type PrChatLinkStore = ReturnType<typeof createPrChatLinkStore>;
export type LanePrChatOriginClaimResult =
  | { status: "linked" }
  | { status: "ignored" }
  | { status: "retry"; message: string };

/**
 * Owns the PR↔chat edge (`pull_request_chat_sessions`) and unlink-tombstone
 * (`pull_request_chat_session_dismissals`) tables: reading them onto summaries,
 * resolving a chat's canonical session id, linking/unlinking, and attaching a
 * new GitHub stack layer to the parent chats that linked an earlier layer.
 *
 * The PR rows themselves are the service's; this store only touches the edge
 * and tombstone tables plus the session/lane lookups those need.
 */
export function createPrChatLinkStore(args: {
  db: AdeDb;
  projectId: string;
  logger: Logger;
  /** Live stack membership for a PR, or null. Late-bound to the stack store. */
  knownStackNumberForPr: (repo: { owner: string; name: string }, prNumber: number) => number | null;
}) {
  const { db, projectId, logger, knownStackNumberForPr } = args;

  /** `cross_lane` is 1 when the linked chat lives on another lane than the PR. */
  type EdgeRow = { pr_id: string; session_id: string; cross_lane?: number | null };

  /** Stay well under SQLite's bound-variable limit on a large project. */
  const EDGE_ID_CHUNK_SIZE = 900;

  const readEdges = (
    prIds: string[],
    failureEvent: string,
    sqlFor: (placeholders: string) => string,
  ): EdgeRow[] => {
    const ids = [...new Set(prIds.map((id) => String(id ?? "").trim()).filter(Boolean))];
    const rows: EdgeRow[] = [];
    try {
      for (let offset = 0; offset < ids.length; offset += EDGE_ID_CHUNK_SIZE) {
        const chunk = ids.slice(offset, offset + EDGE_ID_CHUNK_SIZE);
        rows.push(...db.all<EdgeRow>(sqlFor(chunk.map(() => "?").join(", ")), [projectId, ...chunk]));
      }
    } catch (error) {
      logger.warn(failureEvent, { error: getErrorMessage(error) });
    }
    return rows;
  };

  const groupSessionIds = (rows: EdgeRow[], include: (row: EdgeRow) => boolean = () => true): Map<string, string[]> => {
    const result = new Map<string, string[]>();
    for (const row of rows) {
      const sessionId = String(row.session_id ?? "").trim();
      if (!sessionId || !include(row)) continue;
      const current = result.get(row.pr_id) ?? [];
      if (!current.includes(sessionId)) current.push(sessionId);
      result.set(row.pr_id, current);
    }
    return result;
  };

  /**
   * Chat links, each marked when the chat lives on a lane other than the PR's
   * own. The edge's `lane_id` is the PR's lane, so the chat's lane comes from
   * its session row; a chat whose lane is unknown is not marked and keeps
   * counting as a claim.
   */
  const readLinkEdges = (prIds: string[]): EdgeRow[] =>
    readEdges(prIds, "prs.chat_session_links_read_failed", (placeholders) => `
      select pcs.pr_id, pcs.session_id,
             (ts.lane_id is not null and pr.lane_id is not null and ts.lane_id <> pr.lane_id) as cross_lane
        from pull_request_chat_sessions pcs
        left join pull_requests pr
          on pr.id = pcs.pr_id and pr.project_id = pcs.project_id
        left join terminal_sessions ts
          on ts.id = pcs.session_id
       where pcs.project_id = ?
         and pcs.pr_id in (${placeholders})
       order by pcs.created_at asc, pcs.id asc
    `);

  const chatSessionIdsByPrId = (prIds: string[]): Map<string, string[]> => groupSessionIds(readLinkEdges(prIds));

  const dismissedChatSessionIdsByPrId = (prIds: string[]): Map<string, string[]> =>
    groupSessionIds(readEdges(prIds, "prs.chat_session_dismissals_read_failed", (placeholders) => `
      select pr_id, session_id
        from pull_request_chat_session_dismissals
       where project_id = ?
         and pr_id in (${placeholders})
       order by created_at asc, id asc
    `));

  const withChatSessionLinks = (summaries: PrSummary[]): PrSummary[] => {
    const prIds = summaries.map((summary) => summary.id);
    const linkEdges = readLinkEdges(prIds);
    const links = groupSessionIds(linkEdges);
    const crossLane = groupSessionIds(linkEdges, (row) => Boolean(row.cross_lane));
    const dismissals = dismissedChatSessionIdsByPrId(prIds);
    return summaries.map((summary) => {
      const sessionIds = links.get(summary.id);
      const crossLaneIds = crossLane.get(summary.id);
      const dismissed = dismissals.get(summary.id);
      return {
        ...summary,
        ...(sessionIds?.length ? { chatSessionIds: sessionIds } : {}),
        ...(crossLaneIds?.length ? { crossLaneChatSessionIds: crossLaneIds } : {}),
        ...(dismissed?.length ? { dismissedChatSessionIds: dismissed } : {}),
      };
    });
  };

  const resolveCanonicalChatSessionId = (sessionId: string): string | null => {
    const trimmed = String(sessionId ?? "").trim();
    if (!trimmed) return null;
    try {
      const session = db.get<{ id: string }>(
        `
          select id
            from terminal_sessions
           where id = ?
          union all
          select chat_session_id as id
            from claude_sessions
           where session_id = ? and chat_session_id is not null
           limit 1
        `,
        [trimmed, trimmed],
      );
      return String(session?.id ?? "").trim() || null;
    } catch {
      return null;
    }
  };

  const hasChatSessionDismissal = (prId: string, sessionId: string): boolean => {
    try {
      const row = db.get<{ id: string }>(
        `
          select id
            from pull_request_chat_session_dismissals
           where project_id = ? and pr_id = ? and session_id = ?
           limit 1
        `,
        [projectId, prId, sessionId],
      );
      return Boolean(row?.id);
    } catch {
      return false;
    }
  };

  const clearChatSessionDismissal = (prId: string, sessionId: string): void => {
    try {
      db.run(
        `delete from pull_request_chat_session_dismissals
          where project_id = ? and pr_id = ? and session_id = ?`,
        [projectId, prId, sessionId],
      );
    } catch {
      // Older test/embedded databases may predate the tombstone table.
    }
  };

  const writeChatSessionDismissal = (prId: string, sessionId: string): void => {
    try {
      const existing = db.get<{ id: string }>(
        `
          select id
            from pull_request_chat_session_dismissals
           where project_id = ? and pr_id = ? and session_id = ?
           limit 1
        `,
        [projectId, prId, sessionId],
      );
      const now = nowIso();
      if (existing) {
        db.run(
          "update pull_request_chat_session_dismissals set updated_at = ? where id = ? and project_id = ?",
          [now, existing.id, projectId],
        );
        return;
      }
      db.run(
        `
          insert into pull_request_chat_session_dismissals(
            id, project_id, pr_id, session_id, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?)
        `,
        [randomUUID(), projectId, prId, sessionId, now, now],
      );
    } catch (error) {
      // A database that predates the tombstone table still unlinks (the PR just
      // falls back to the branch rule); any other write failure must roll the
      // unlink back so the tombstone and the edge stay consistent.
      if (/no such table/i.test(String((error as Error)?.message ?? error))) return;
      throw error;
    }
  };

  const linkPrToChatSession = (linkArgs: {
    prId: string;
    laneId: string;
    sessionId?: string | null;
    allowCrossLane?: boolean;
  }): boolean => {
    const sessionId = String(linkArgs.sessionId ?? "").trim();
    if (!sessionId) return false;

    try {
      // The row only has to EXIST in this project. It deliberately does not
      // have to belong to `linkArgs.laneId`: a chat may reference a pull request
      // another lane opened ("Link a PR by number or URL"), and `linkToLane`
      // leaves that row's ownership with the opening lane on purpose. Requiring
      // equality here made every cross-lane link a silent no-op — the call
      // reported success, no edge was written, and the PR vanished from the
      // chat on the next read (`selectPrsForChatInLane` finds a foreign PR only
      // through this edge).
      const pr = db.get<{
        id: string;
        lane_id: string;
        repo_owner: string;
        repo_name: string;
        github_pr_number: number;
      }>(
        "select id, lane_id, repo_owner, repo_name, github_pr_number from pull_requests where id = ? and project_id = ? limit 1",
        [linkArgs.prId, projectId],
      );
      if (!pr) return false;
      const canonicalSessionId = resolveCanonicalChatSessionId(sessionId);
      if (!canonicalSessionId) {
        logger.warn("prs.chat_session_link_session_missing", {
          prId: linkArgs.prId,
          laneId: linkArgs.laneId,
          sessionId,
        });
        return false;
      }
      const sessionLane = db.get<{ lane_id: string | null }>(
        `
          select lane_id from terminal_sessions where id = ?
          union all
          select lane_id from claude_sessions where chat_session_id = ? and lane_id is not null
          limit 1
        `,
        [canonicalSessionId, canonicalSessionId],
      );
      const sessionLaneId = String(sessionLane?.lane_id ?? "").trim();
      const crossLane = Boolean(sessionLaneId) && sessionLaneId !== pr.lane_id;
      // Cross-lane links are allowed for GitHub stack members or an explicit
      // pick; the lane-scoped session guard is enforced by the caller.
      if (crossLane && !linkArgs.allowCrossLane) {
        if (knownStackNumberForPr({ owner: pr.repo_owner, name: pr.repo_name }, Number(pr.github_pr_number)) == null) {
          return false;
        }
      }
      const now = nowIso();
      const existing = db.get<{ id: string }>(
        `
          select id
            from pull_request_chat_sessions
           where project_id = ? and pr_id = ? and session_id = ?
           limit 1
        `,
        [projectId, linkArgs.prId, canonicalSessionId],
      );
      if (existing) {
        db.run(
          "update pull_request_chat_sessions set lane_id = ?, updated_at = ? where id = ? and project_id = ?",
          [pr.lane_id, now, existing.id, projectId],
        );
      } else {
        db.run(
          `
            insert into pull_request_chat_sessions(
              id, project_id, pr_id, lane_id, session_id, created_at, updated_at
            ) values (?, ?, ?, ?, ?, ?, ?)
          `,
          [randomUUID(), projectId, linkArgs.prId, pr.lane_id, canonicalSessionId, now, now],
        );
      }
      clearChatSessionDismissal(linkArgs.prId, canonicalSessionId);
      return true;
    } catch (error) {
      logger.warn("prs.chat_session_link_write_failed", {
        prId: linkArgs.prId,
        laneId: linkArgs.laneId,
        sessionId,
        error: getErrorMessage(error),
      });
      return false;
    }
  };

  const unlinkPrFromChatSession = (unlinkArgs: {
    prId: string;
    sessionId: string;
    dismiss?: boolean;
  }): boolean => {
    const sessionId = resolveCanonicalChatSessionId(unlinkArgs.sessionId);
    if (!sessionId) return false;
    try {
      db.run("begin immediate");
      try {
        db.run(
          `delete from pull_request_chat_sessions
            where project_id = ? and pr_id = ? and session_id = ?`,
          [projectId, unlinkArgs.prId, sessionId],
        );
        if (unlinkArgs.dismiss !== false) writeChatSessionDismissal(unlinkArgs.prId, sessionId);
        db.run(
          `update pull_request_lane_chat_origins
              set merge_followup_pending = 0
            where project_id = ? and pr_id = ? and claimed_session_id = ?`,
          [projectId, unlinkArgs.prId, sessionId],
        );
        db.run("commit");
      } catch (error) {
        try {
          db.run("rollback");
        } catch {
          // Preserve the original unlink error.
        }
        throw error;
      }
      return true;
    } catch (error) {
      logger.warn("prs.chat_session_unlink_failed", {
        prId: unlinkArgs.prId,
        sessionId,
        error: getErrorMessage(error),
      });
      return false;
    }
  };

  /**
   * Remember the explicit origin of a lane imported from a PR. The marker is
   * one-shot: the first agent chat created on that lane consumes it, whether
   * or not it can safely become the PR's chat. This prevents unrelated later
   * chats from inheriting the lane's PR forever.
   */
  const rememberLanePrChatOrigin = (origin: { prId: string; laneId: string }): boolean => {
    try {
      const pr = db.get<{ lane_id: string; detached_at: string | null }>(
        `select lane_id, detached_at from pull_requests
          where id = ? and project_id = ? limit 1`,
        [origin.prId, projectId],
      );
      if (!pr || pr.lane_id !== origin.laneId || pr.detached_at != null) return false;
      db.run(
        `insert or replace into pull_request_lane_chat_origins(project_id, lane_id, pr_id, created_at)
         values (?, ?, ?, ?)`,
        [projectId, origin.laneId, origin.prId, nowIso()],
      );
      return true;
    } catch (error) {
      logger.warn("prs.lane_chat_origin_write_failed", {
        prId: origin.prId,
        laneId: origin.laneId,
        error: getErrorMessage(error),
      });
      return false;
    }
  };

  /**
   * Consume a lane's explicit PR origin for the first chat created there.
   * Refuses cross-lane sessions, explicit unlinks, and chats
   * already claimed by another PR. The transaction makes competing chat
   * launches deterministic and consumes an ambiguous origin only once.
   */
  const claimLanePrChatOrigin = (claim: { laneId: string; sessionId: string }): LanePrChatOriginClaimResult => {
    const requestedSessionId = String(claim.sessionId ?? "").trim();
    if (!requestedSessionId) {
      return { status: "retry", message: "The new chat has no session id for its PR link." };
    }
    let sessionId = requestedSessionId;
    try {
      db.run("begin immediate");
      try {
        const origin = db.get<{ pr_id: string }>(
          `select pr_id from pull_request_lane_chat_origins
            where project_id = ? and lane_id = ? and claimed_session_id is null limit 1`,
          [projectId, claim.laneId],
        );
        if (!origin) {
          db.run("commit");
          return { status: "ignored" };
        }
        sessionId = resolveCanonicalChatSessionId(requestedSessionId) ?? "";
        if (!sessionId) {
          db.run("commit");
          return { status: "retry", message: "The new chat is not persisted yet; retry its PR link." };
        }
        const pr = db.get<{ lane_id: string; state: string; detached_at: string | null }>(
          `select lane_id, state, detached_at from pull_requests
            where id = ? and project_id = ? limit 1`,
          [origin.pr_id, projectId],
        );
        const session = db.get<{ lane_id: string | null; project_id: string | null }>(
          `select ts.lane_id, lane.project_id
             from terminal_sessions ts
             left join lanes lane on lane.id = ts.lane_id
            where ts.id = ? limit 1`,
          [sessionId],
        );
        // A mismatched or incomplete caller must not burn the origin: another
        // correctly scoped create can still claim it. This also keeps a session
        // from another project from matching a coincidentally equal lane id.
        if (
          !session
          || session.project_id !== projectId
          || String(session.lane_id ?? "").trim() !== claim.laneId
        ) {
          db.run("commit");
          return { status: "retry", message: "The new chat does not belong to this PR lane and project." };
        }

        // An explicit unlink wins over this automatic origin. Leave the marker
        // available for a later deliberate chat on the imported lane.
        const dismissed = db.get<{ id: string }>(
          `select id from pull_request_chat_session_dismissals
            where project_id = ? and pr_id = ? and session_id = ? limit 1`,
          [projectId, origin.pr_id, sessionId],
        );
        if (dismissed) {
          db.run("commit");
          return { status: "ignored" };
        }

        if (!pr || pr.lane_id !== claim.laneId || pr.detached_at != null) {
          db.run(
            `delete from pull_request_lane_chat_origins
              where project_id = ? and lane_id = ? and pr_id = ?`,
            [projectId, claim.laneId, origin.pr_id],
          );
          db.run("commit");
          return { status: "ignored" };
        }

        const existing = db.all<{ pr_id: string }>(
          `select pr_id from pull_request_chat_sessions
            where project_id = ? and session_id = ?`,
          [projectId, sessionId],
        );
        if (existing.length > 0) {
          db.run(
            `delete from pull_request_lane_chat_origins
              where project_id = ? and lane_id = ? and pr_id = ?`,
            [projectId, claim.laneId, origin.pr_id],
          );
          db.run("commit");
          return { status: "ignored" };
        }

        const now = nowIso();
        db.run(
          `insert into pull_request_chat_sessions(
             id, project_id, pr_id, lane_id, session_id, created_at, updated_at
           ) values (?, ?, ?, ?, ?, ?, ?)`,
          [randomUUID(), projectId, origin.pr_id, claim.laneId, sessionId, now, now],
        );
        db.run(
          `update pull_request_lane_chat_origins
              set claimed_session_id = ?, claimed_at = ?, merge_followup_pending = 1
            where project_id = ? and lane_id = ? and pr_id = ? and claimed_session_id is null`,
          [sessionId, now, projectId, claim.laneId, origin.pr_id],
        );
        db.run("commit");
        return { status: "linked" };
      } catch (error) {
        try {
          db.run("rollback");
        } catch {
          // Preserve the original claim error.
        }
        throw error;
      }
    } catch (error) {
      logger.warn("prs.lane_chat_origin_claim_failed", {
        laneId: claim.laneId,
        sessionId,
        error: getErrorMessage(error),
      });
      return { status: "retry", message: "Could not save the PR link for this new chat. Retry the chat launch." };
    }
  };

  const pendingAgentStackAttaches = new Map<string, { prId: string; laneId: string }>();

  const rememberPendingAttach = (entry: { prId: string; laneId: string }): void => {
    pendingAgentStackAttaches.delete(entry.prId);
    pendingAgentStackAttaches.set(entry.prId, entry);
    while (pendingAgentStackAttaches.size > PENDING_STACK_ATTACH_CAP) {
      const oldest = pendingAgentStackAttaches.keys().next().value;
      if (oldest == null) break;
      pendingAgentStackAttaches.delete(oldest);
    }
  };

  const attachNewStackLayerToParentChats = (attachArgs: { prId: string; laneId: string }): void => {
    try {
      const pr = db.get<{ repo_owner: string; repo_name: string; github_pr_number: number; base_branch: string | null }>(
        "select repo_owner, repo_name, github_pr_number, base_branch from pull_requests where id = ? and project_id = ? limit 1",
        [attachArgs.prId, projectId],
      );
      if (!pr) return;
      // The layer below is the PR whose head branch this PR targets; its
      // lane's chats are the ones that get the new layer.
      const lower = db.get<{ lane_id: string | null }>(
        `
          select lane_id
            from pull_requests
           where project_id = ?
             and id <> ?
             and lower(repo_owner) = lower(?)
             and lower(repo_name) = lower(?)
             and head_branch = ?
             and detached_at is null
           order by updated_at desc
           limit 1
        `,
        [projectId, attachArgs.prId, pr.repo_owner, pr.repo_name, String(pr.base_branch ?? "").trim()],
      );
      const parentLaneId = String(lower?.lane_id ?? "").trim();
      if (!parentLaneId || parentLaneId === attachArgs.laneId) return;
      const knownStackNumber = db.get<{ github_stack_number: number }>(
        `
          select github_stack_number
            from github_pr_stack_entries
           where project_id = ?
             and lower(repo_owner) = lower(?)
             and lower(repo_name) = lower(?)
             and github_pr_number = ?
           limit 1
        `,
        [projectId, pr.repo_owner, pr.repo_name, Number(pr.github_pr_number)],
      );
      const inferredParentStack = db.get<{ github_stack_number: number }>(
        `
          select entry.github_stack_number as github_stack_number
            from pull_requests sibling
            join github_pr_stack_entries entry
              on entry.project_id = sibling.project_id
             and lower(entry.repo_owner) = lower(sibling.repo_owner)
             and lower(entry.repo_name) = lower(sibling.repo_name)
             and entry.github_pr_number = sibling.github_pr_number
           where sibling.project_id = ?
             and sibling.lane_id = ?
             and lower(sibling.repo_owner) = lower(?)
             and lower(sibling.repo_name) = lower(?)
           group by entry.github_stack_number
           limit 1
        `,
        [projectId, parentLaneId, pr.repo_owner, pr.repo_name],
      );
      const stackNumber = knownStackNumber
        ? Number(knownStackNumber.github_stack_number)
        : (inferredParentStack ? Number(inferredParentStack.github_stack_number) : null);
      if (stackNumber == null) return;
      const parentSessions = db.all<{ session_id: string }>(
        `
          select distinct pcs.session_id as session_id
            from pull_request_chat_sessions pcs
            join pull_requests sibling
              on sibling.id = pcs.pr_id
             and sibling.project_id = pcs.project_id
            join github_pr_stack_entries entry
              on entry.project_id = pcs.project_id
             and lower(entry.repo_owner) = lower(sibling.repo_owner)
             and lower(entry.repo_name) = lower(sibling.repo_name)
             and entry.github_pr_number = sibling.github_pr_number
           where pcs.project_id = ?
             and pcs.lane_id = ?
             and entry.github_stack_number = ?
             and pcs.pr_id <> ?
        `,
        [projectId, parentLaneId, stackNumber, attachArgs.prId],
      );
      for (const row of parentSessions) {
        linkPrToChatSession({
          prId: attachArgs.prId,
          laneId: attachArgs.laneId,
          sessionId: row.session_id,
          allowCrossLane: true,
        });
      }
    } catch (error) {
      logger.warn("prs.stack_parent_chat_attach_failed", {
        prId: attachArgs.prId,
        laneId: attachArgs.laneId,
        error: getErrorMessage(error),
      });
    }
  };

  return {
    chatSessionIdsByPrId,
    dismissedChatSessionIdsByPrId,
    withChatSessionLinks,
    resolveCanonicalChatSessionId,
    hasChatSessionDismissal,
    clearChatSessionDismissal,
    writeChatSessionDismissal,
    linkPrToChatSession,
    unlinkPrFromChatSession,
    rememberLanePrChatOrigin,
    claimLanePrChatOrigin,
    pendingAgentStackAttaches,
    rememberPendingAttach,
    attachNewStackLayerToParentChats,
  };
}
