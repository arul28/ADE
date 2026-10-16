/** How the Linear inbox and ADE's "needs you" line describe a notification type. */
const LINEAR_NOTIFICATION_VERBS: Record<string, string> = {
  issueMention: "mentioned you on",
  issueCommentMention: "mentioned you in a comment on",
  issueNewComment: "commented on",
  issueCommentReaction: "reacted to your comment on",
  issueAssignedToYou: "assigned you",
  issueUnassignedFromYou: "unassigned you from",
  issueStatusChanged: "changed the status of",
  issueCreated: "created",
  issueDue: "is due:",
  issueBlocking: "is blocked by your issue:",
  issueUnblocked: "unblocked",
  issueEmojiReaction: "reacted on",
  issuePriorityUrgent: "marked urgent",
  issueSubscribed: "subscribed you to",
};

export function linearNotificationVerb(type: string): string {
  return LINEAR_NOTIFICATION_VERBS[type]
    ?? (type.replace(/^issue/, "").replace(/([A-Z])/g, " $1").trim().toLowerCase() || "updated");
}

/** Notification types worth raising "needs you" on a lane. Reactions and subscriptions are not. */
export const LINEAR_ATTENTION_TYPES: ReadonlySet<string> = new Set([
  "issueMention",
  "issueCommentMention",
  "issueNewComment",
  "issueAssignedToYou",
  "issueStatusChanged",
  "issuePriorityUrgent",
]);
