import Foundation

// Proof (computer-use artifacts) of a chat whose project is not the phone's
// replica: a chat of another project on the focused machine, or of any project
// on another machine. Those are asked of the host that holds them.

/// Pictures a generated scene left behind are not proof; every proof list
/// leaves them out (desktop `PROOF_LISTING_ARTIFACT_FILTER`).
let workProofExcludedMetadataKind = "scene_still"

/// Whether a replica proof row is one every proof list leaves out.
func workProofIsExcludedFromLists(_ artifact: ComputerUseArtifactSummary) -> Bool {
  guard let json = artifact.metadataJson, json.contains(workProofExcludedMetadataKind),
        let data = json.data(using: .utf8),
        let metadata = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  else { return false }
  return metadata["kind"] as? String == workProofExcludedMetadataKind
}

extension SyncService {
  /// Rows one remote proof list asks for; the broker allows up to 2,000.
  static let remoteChatProofPageSize = 500

  /// The proof a chat of another project or another machine filed, asked of
  /// the host that holds it. The phone's replica holds the focused machine's
  /// active project only, so these chats used to list no proof at all and every
  /// picture their answers cited failed. Nil when that host predates
  /// `computerUse.listArtifacts`.
  func fetchRemoteChatComputerUseArtifacts(sessionId: String) async throws -> [ComputerUseArtifactSummary]? {
    let action = "computerUse.listArtifacts"
    guard supportsChatRemoteAction(action, sessionId: sessionId) else { return nil }
    let scope = chatCommandScope(for: sessionId)
    let response = try await sendCommand(
      action: action,
      args: [
        "ownerKind": "chat_session",
        "ownerId": sessionId,
        "excludeMetadataKind": workProofExcludedMetadataKind,
        // The broker's default page is 50; the phone's own replica read has no
        // cap, so a long chat's older proof would be missing only here.
        "limit": Self.remoteChatProofPageSize,
      ],
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.rootPath,
      fallbackToActiveProjectScope: false
    )
    let rows = (response as? [[String: Any]]) ?? []
    return rows.compactMap { computerUseArtifactSummary(fromHostView: $0, ownerId: sessionId) }
      .sorted { $0.createdAt < $1.createdAt }
  }

  /// One cited proof by id, from the host that holds the chat's project. An
  /// answer can cite proof another chat there filed, or proof older than the
  /// chat's list page. Nil when the host predates the read or has no such id.
  func fetchRemoteChatComputerUseArtifact(sessionId: String, artifactId: String) async throws -> ComputerUseArtifactSummary? {
    let action = "computerUse.listArtifacts"
    guard supportsChatRemoteAction(action, sessionId: sessionId) else { return nil }
    let scope = chatCommandScope(for: sessionId)
    let response = try await sendCommand(
      action: action,
      args: ["artifactId": artifactId, "limit": 1, "excludeMetadataKind": workProofExcludedMetadataKind],
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.rootPath,
      fallbackToActiveProjectScope: false
    )
    return ((response as? [[String: Any]]) ?? [])
      .compactMap { computerUseArtifactSummary(fromHostView: $0, ownerId: sessionId) }
      .first { $0.id == artifactId }
  }

  /// One `ComputerUseArtifactView` as the host's broker returns it, in the
  /// shape the replica's rows take.
  fileprivate func computerUseArtifactSummary(fromHostView row: [String: Any], ownerId: String) -> ComputerUseArtifactSummary? {
    guard let id = row["id"] as? String, !id.isEmpty,
          let uri = row["uri"] as? String
    else { return nil }
    let links = (row["links"] as? [[String: Any]]) ?? []
    let link = links.first { ($0["ownerKind"] as? String) == "chat_session" && ($0["ownerId"] as? String) == ownerId }
    var metadataJson: String?
    if let metadata = row["metadata"], JSONSerialization.isValidJSONObject(metadata),
       let data = try? JSONSerialization.data(withJSONObject: metadata) {
      metadataJson = String(data: data, encoding: .utf8)
    }
    return ComputerUseArtifactSummary(
      id: id,
      artifactKind: row["kind"] as? String ?? "screenshot",
      backendStyle: row["backendStyle"] as? String ?? "external_cli",
      backendName: row["backendName"] as? String ?? "",
      sourceToolName: row["sourceToolName"] as? String,
      originalType: row["originalType"] as? String,
      title: row["title"] as? String ?? "",
      description: row["description"] as? String,
      uri: uri,
      storageKind: row["storageKind"] as? String ?? "file",
      mimeType: row["mimeType"] as? String,
      metadataJson: metadataJson,
      laneId: row["laneId"] as? String,
      createdAt: row["createdAt"] as? String ?? "",
      ownerKind: "chat_session",
      ownerId: ownerId,
      relation: link?["relation"] as? String ?? "attached_to",
      reviewState: row["reviewState"] as? String,
      workflowState: row["workflowState"] as? String,
      reviewNote: row["reviewNote"] as? String
    )
  }
}
