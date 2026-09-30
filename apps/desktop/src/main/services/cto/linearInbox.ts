import type { LinearInboxNotification } from "../../../shared/types";
import { isRecord, toOptionalString as asString, asArray } from "../shared/utils";
import type { LinearRequest } from "./linearClientShared";

/** Linear inbox notifications and project updates. */
export function createLinearInbox({ request }: { request: LinearRequest }) {
  const listNotifications = async (params?: { first?: number; includeRead?: boolean }): Promise<LinearInboxNotification[]> => {
    const first = Math.min(100, Math.max(1, Math.floor(params?.first ?? 50)));
    const data = await request<{ notifications?: { nodes?: Array<Record<string, unknown>> } }>({
      query: `
        query InboxNotifications($first: Int!) {
          notifications(first: $first, orderBy: createdAt) {
            nodes {
              id
              type
              createdAt
              readAt
              snoozedUntilAt
              archivedAt
              title
              subtitle
              url
              actorAvatarUrl
              actorInitials
              isLinearActor
              actor { id name displayName avatarUrl }
              botActor { name }
              ... on IssueNotification {
                issue { id identifier title url state { name type } }
                comment { id body }
              }
            }
          }
        }
      `,
      variables: { first },
      maxRetries: 2,
    });
    return asArray(data.notifications?.nodes)
      .filter(isRecord)
      .map((node): LinearInboxNotification | null => {
        const id = asString(node.id);
        const type = asString(node.type);
        if (!id || !type) return null;
        const issue = isRecord(node.issue) ? node.issue : null;
        const state = issue && isRecord(issue.state) ? issue.state : null;
        const actor = isRecord(node.actor) ? node.actor : null;
        const botActor = isRecord(node.botActor) ? node.botActor : null;
        const comment = isRecord(node.comment) ? node.comment : null;
        return {
          id,
          type,
          createdAt: asString(node.createdAt) ?? new Date().toISOString(),
          readAt: asString(node.readAt),
          snoozedUntilAt: asString(node.snoozedUntilAt),
          actorName: (actor ? (asString(actor.displayName) ?? asString(actor.name)) : null)
            ?? (botActor ? asString(botActor.name) : null)
            ?? (node.isLinearActor === true ? "Linear" : null),
          actorAvatarUrl: asString(node.actorAvatarUrl) ?? (actor ? asString(actor.avatarUrl) : null),
          actorInitials: asString(node.actorInitials),
          title: asString(node.title),
          subtitle: asString(node.subtitle),
          url: asString(node.url),
          issueId: issue ? asString(issue.id) : null,
          issueIdentifier: issue ? asString(issue.identifier) : null,
          issueTitle: issue ? asString(issue.title) : null,
          issueUrl: issue ? asString(issue.url) : null,
          issueStateName: state ? asString(state.name) : null,
          issueStateType: state ? asString(state.type) : null,
          commentId: comment ? asString(comment.id) : null,
          commentBody: comment ? asString(comment.body) : null,
        };
      })
      .filter((entry): entry is LinearInboxNotification => entry != null)
      .filter((entry) => params?.includeRead === true || !entry.readAt);
  };

  const markNotification = async (notificationId: string, action: "read" | "archive"): Promise<void> => {
    await request({
      query: action === "archive"
        ? `mutation ArchiveNotification($id: String!) { notificationArchive(id: $id) { success } }`
        : `mutation ReadNotification($id: String!, $readAt: DateTime!) { notificationUpdate(id: $id, input: { readAt: $readAt }) { success } }`,
      variables: action === "archive" ? { id: notificationId } : { id: notificationId, readAt: new Date().toISOString() },
      maxRetries: 1,
    });
  };

  const createProjectUpdate = async (params: {
    projectId: string;
    body: string;
    health?: "onTrack" | "atRisk" | "offTrack" | null;
  }): Promise<{ id: string; url: string | null }> => {
    const input: Record<string, unknown> = { projectId: params.projectId, body: params.body };
    if (params.health) input.health = params.health;
    const data = await request<{ projectUpdateCreate?: { success?: boolean; projectUpdate?: { id?: string; url?: string } } }>({
      query: `
        mutation CreateProjectUpdate($input: ProjectUpdateCreateInput!) {
          projectUpdateCreate(input: $input) { success projectUpdate { id url } }
        }
      `,
      variables: { input },
      maxRetries: 1,
    });
    const id = asString(data.projectUpdateCreate?.projectUpdate?.id);
    if (!data.projectUpdateCreate?.success || !id) throw new Error("Linear projectUpdateCreate failed.");
    return { id, url: asString(data.projectUpdateCreate?.projectUpdate?.url) };
  };

  return { listNotifications, markNotification, createProjectUpdate };
}
