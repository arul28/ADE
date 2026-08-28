import { useEffect, useState } from "react";

import type { PrComment } from "../../../../shared/types";

export function usePrCommentEdit(args: {
  prId: string;
  commentId: number | null | undefined;
  source: PrComment["source"];
  initialBody: string | null | undefined;
  author?: string | null;
  viewerLogin?: string | null;
}) {
  const [body, setBody] = useState(args.initialBody ?? "");
  const [editValue, setEditValue] = useState(args.initialBody ?? "");
  const [editing, setEditing] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    setBody(args.initialBody ?? "");
    setEditValue(args.initialBody ?? "");
  }, [args.commentId, args.initialBody]);

  const beginEdit = () => {
    setEditValue(body);
    setEditError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditValue(body);
    setEditError(null);
  };

  const saveEdit = async (): Promise<boolean> => {
    const bridge = window.ade?.prs?.updateComment;
    const trimmed = editValue.trim();
    if (!bridge || args.commentId == null || !trimmed) return false;
    setEditBusy(true);
    setEditError(null);
    try {
      const updated = await bridge({
        prId: args.prId,
        commentId: String(args.commentId),
        body: trimmed,
        source: args.source,
      });
      setBody(updated.body ?? trimmed);
      setEditing(false);
      return true;
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setEditBusy(false);
    }
  };

  return {
    body,
    editing,
    editValue,
    setEditValue,
    editBusy,
    editError,
    beginEdit,
    cancelEdit,
    saveEdit,
    canEdit: Boolean(
      args.commentId
        && args.author
        && args.viewerLogin
        && args.author.toLowerCase() === args.viewerLogin.toLowerCase(),
    ),
  };
}
