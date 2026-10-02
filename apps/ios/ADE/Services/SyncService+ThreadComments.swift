import Foundation

// Thread comments: the user's pending notes on parts of an agent reply. The
// chat's host owns them; the phone lists, toggles, edits and deletes them,
// and mirrors every `session_meta_updated.threadComments` the host publishes.

extension SyncService {
  /// Whether this chat's host has thread comments: list, edit and delete ship
  /// together, so all three are required. An older brain omits the optional
  /// commands, and the phone then shows nothing new. Personal chats map to a
  /// `personalChats.` action no host registers, so they read false too.
  func supportsThreadComments(sessionId: String) -> Bool {
    ["chat.listThreadComments", "chat.updateThreadComment", "chat.deleteThreadComment"]
      .allSatisfy { supportsChatRemoteAction($0, sessionId: sessionId) }
  }

  func threadComments(sessionId: String) -> [ChatThreadComment] {
    threadCommentsBySession[sessionId] ?? []
  }

  /// Lossy list decode: a comment with an anchor kind this build does not know
  /// is skipped instead of failing the whole list.
  func decodeThreadComments(_ raw: Any) -> [ChatThreadComment] {
    guard let items = raw as? [Any] else { return [] }
    return items.compactMap { try? decode($0, as: ChatThreadComment.self) }
  }

  func setThreadComments(_ comments: [ChatThreadComment], sessionId: String) {
    if comments.isEmpty {
      guard threadCommentsBySession[sessionId] != nil else { return }
      threadCommentsBySession.removeValue(forKey: sessionId)
    } else {
      guard threadCommentsBySession[sessionId] != comments else { return }
      threadCommentsBySession[sessionId] = comments
    }
    threadCommentsWriteVersion[sessionId, default: 0] += 1
  }

  func refreshThreadComments(sessionId: String) async throws {
    let action = chatActionName("chat.listThreadComments", sessionId: sessionId)
    guard supportsThreadComments(sessionId: sessionId) else { return }
    let scope = chatCommandScope(for: sessionId)
    let startedAt = threadCommentsWriteVersion[sessionId, default: 0]
    let response = try await sendCommand(
      action: action,
      args: ["sessionId": sessionId],
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.rootPath
    )
    if let payload = response as? [String: Any], payload["queued"] as? Bool == true {
      throw QueuedRemoteCommandError(action: action)
    }
    // A live update landed while the list was out; it is newer.
    guard threadCommentsWriteVersion[sessionId, default: 0] == startedAt else { return }
    setThreadComments(decodeThreadComments(response), sessionId: sessionId)
  }

  /// Edits a comment's note and/or its send-with-next-message flag. Applied
  /// locally first so the toggle answers the tap; a failure puts the old
  /// comment back.
  func updateThreadComment(
    sessionId: String,
    commentId: String,
    body: String? = nil,
    includeInNextSend: Bool? = nil
  ) async throws {
    let action = chatActionName("chat.updateThreadComment", sessionId: sessionId)
    guard supportsThreadComments(sessionId: sessionId) else {
      throw NSError(
        domain: "ADE",
        code: 15,
        userInfo: [NSLocalizedDescriptionKey: "This computer’s ADE cannot edit comments. Update it to edit them here."]
      )
    }
    let previous = threadComments(sessionId: sessionId).first { $0.id == commentId }
    if var optimistic = previous {
      if let body { optimistic.body = body }
      if let includeInNextSend { optimistic.includeInNextSend = includeInNextSend }
      replaceThreadComment(optimistic, sessionId: sessionId)
    }
    // Snapshot after the optimistic apply: if this changes while the command is
    // out, a live update or another caller rewrote the list, and neither this
    // response nor our rollback snapshot is authoritative any more.
    let startedAt = threadCommentsWriteVersion[sessionId, default: 0]
    var args: [String: Any] = ["sessionId": sessionId, "commentId": commentId]
    if let body { args["body"] = body }
    if let includeInNextSend { args["includeInNextSend"] = includeInNextSend }
    let scope = chatCommandScope(for: sessionId)
    do {
      let updated = try await sendDecodableCommand(
        action: action,
        args: args,
        targetProjectId: scope.projectId,
        targetProjectRootPath: scope.rootPath,
        as: ChatThreadComment.self
      )
      if threadCommentsWriteVersion[sessionId, default: 0] == startedAt {
        replaceThreadComment(updated, sessionId: sessionId)
      } else {
        try? await refreshThreadComments(sessionId: sessionId)
      }
    } catch {
      if threadCommentsWriteVersion[sessionId, default: 0] == startedAt {
        if let previous { replaceThreadComment(previous, sessionId: sessionId) }
      } else {
        try? await refreshThreadComments(sessionId: sessionId)
      }
      throw error
    }
  }

  /// Removes the comment from the phone at once, then from the host. A failed
  /// delete puts it back where it was.
  func deleteThreadComment(sessionId: String, commentId: String) async throws {
    let action = chatActionName("chat.deleteThreadComment", sessionId: sessionId)
    guard supportsThreadComments(sessionId: sessionId) else {
      throw NSError(
        domain: "ADE",
        code: 15,
        userInfo: [NSLocalizedDescriptionKey: "This computer’s ADE cannot delete comments. Update it to delete them here."]
      )
    }
    let before = threadComments(sessionId: sessionId)
    setThreadComments(before.filter { $0.id != commentId }, sessionId: sessionId)
    // Snapshot after the optimistic delete; see `updateThreadComment`.
    let startedAt = threadCommentsWriteVersion[sessionId, default: 0]
    let scope = chatCommandScope(for: sessionId)
    do {
      let response = try await sendCommand(
        action: action,
        args: ["sessionId": sessionId, "commentId": commentId],
        targetProjectId: scope.projectId,
        targetProjectRootPath: scope.rootPath
      )
      if let payload = response as? [String: Any], payload["queued"] as? Bool == true {
        throw QueuedRemoteCommandError(action: action)
      }
    } catch {
      if threadCommentsWriteVersion[sessionId, default: 0] != startedAt {
        // A live update landed while the delete was out; it is newer than our
        // snapshot, so reconcile with the host instead of restoring it.
        try? await refreshThreadComments(sessionId: sessionId)
      } else if let removed = before.first(where: { $0.id == commentId }),
                !threadComments(sessionId: sessionId).contains(where: { $0.id == commentId }) {
        // Only restore while the list still lacks it: a live update that landed
        // meanwhile is newer than our snapshot.
        var restored = threadComments(sessionId: sessionId)
        let index = before.firstIndex(where: { $0.id == commentId }) ?? restored.count
        restored.insert(removed, at: min(index, restored.count))
        setThreadComments(restored, sessionId: sessionId)
      }
      throw error
    }
  }

  private func replaceThreadComment(_ comment: ChatThreadComment, sessionId: String) {
    var list = threadComments(sessionId: sessionId)
    guard let index = list.firstIndex(where: { $0.id == comment.id }) else { return }
    list[index] = comment
    setThreadComments(list, sessionId: sessionId)
  }
}
