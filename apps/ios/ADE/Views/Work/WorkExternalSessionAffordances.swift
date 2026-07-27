import SwiftUI

struct WorkExternalSessionAction: Identifiable {
  let id: String
  let title: String
  let detail: String
  let systemImage: String
  let tint: Color
  let target: String
  let mode: String
  var isPrimary = false
  var enabled = true
  let importedSessionRef: ExternalSessionImportedRef?

  init(
    id: String,
    title: String,
    detail: String,
    systemImage: String,
    tint: Color,
    target: String,
    mode: String,
    isPrimary: Bool = false,
    enabled: Bool = true,
    importedSessionRef: ExternalSessionImportedRef? = nil
  ) {
    self.id = id
    self.title = title
    self.detail = detail
    self.systemImage = systemImage
    self.tint = tint
    self.target = target
    self.mode = mode
    self.isPrimary = isPrimary
    self.enabled = enabled
    self.importedSessionRef = importedSessionRef
  }
}

func workNormalizedImportedSessionKind(_ kind: String) -> String? {
  switch kind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
  case "chat", "cli": return kind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  default: return nil
  }
}

func workImportedSessionRef(for session: ExternalSessionSummary) -> ExternalSessionImportedRef? {
  guard session.alreadyImported, let ref = session.importedSessionRef else { return nil }
  guard let kind = workNormalizedImportedSessionKind(ref.kind) else { return nil }
  let sessionId = ref.sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !sessionId.isEmpty else { return nil }
  return ExternalSessionImportedRef(kind: kind, sessionId: sessionId)
}

func workExternalSessionActions(for session: ExternalSessionSummary) -> [WorkExternalSessionAction] {
  var result: [WorkExternalSessionAction] = []
  let caps = session.capabilities
  let cwdMatchesLane = session.cwdMatchesRequestedLane == true
  let provider = workExternalSessionProviderName(session.provider)
  let continueCliDetail = "Continue the same CLI session in this lane. This takes over the session — don't run it elsewhere at the same time."

  if caps.importToChat {
    if cwdMatchesLane || caps.resumeInDifferentCwd {
      result.append(WorkExternalSessionAction(
        id: "open-as-chat",
        title: "Continue as ADE chat",
        detail: "Continue the original provider session with its imported history in ADE.",
        systemImage: "bubble.left.and.bubble.right.fill",
        tint: ADEColor.accent,
        target: "chat",
        mode: "resume",
        isPrimary: true
      ))
    }
    if (cwdMatchesLane && caps.fork) || (!cwdMatchesLane && caps.forkIntoDifferentCwd) {
      result.append(WorkExternalSessionAction(
        id: "fork-as-chat",
        title: "Copy as ADE chat",
        detail: "Create a provider-backed copy in this lane. The original stays untouched.",
        systemImage: "arrow.triangle.branch",
        tint: ADEColor.textPrimary,
        target: "chat",
        mode: "fork"
      ))
    }
  }

  if cwdMatchesLane {
    if caps.resumeInPlace {
      result.append(WorkExternalSessionAction(
        id: "resume-here",
        title: "Continue as CLI",
        detail: continueCliDetail,
        systemImage: "terminal.fill",
        tint: ADEColor.textPrimary,
        target: "cli",
        mode: "resume"
      ))
    }
    if caps.fork {
      result.append(WorkExternalSessionAction(
        id: "fork-into-lane",
        title: "Copy as CLI",
        detail: "Start a CLI copy in this lane. The original stays untouched.",
        systemImage: "arrow.triangle.branch",
        tint: ADEColor.textPrimary,
        target: "cli",
        mode: "fork"
      ))
    }
  } else if caps.resumeInDifferentCwd {
    result.append(WorkExternalSessionAction(
      id: "resume-here",
      title: "Continue as CLI",
      detail: continueCliDetail,
      systemImage: "terminal.fill",
      tint: ADEColor.textPrimary,
      target: "cli",
      mode: "resume"
    ))
    if caps.forkIntoDifferentCwd {
      result.append(WorkExternalSessionAction(
        id: "fork-into-lane",
        title: "Copy as CLI",
        detail: "Start a CLI copy in this lane. The original stays untouched.",
        systemImage: "arrow.triangle.branch",
        tint: ADEColor.textPrimary,
        target: "cli",
        mode: "fork"
      ))
    }
  } else {
    if caps.forkIntoDifferentCwd {
      result.append(WorkExternalSessionAction(
        id: "fork-into-lane",
        title: "Copy as CLI",
        detail: "Copy this cross-folder session into the selected lane.",
        systemImage: "arrow.triangle.branch",
        tint: ADEColor.textPrimary,
        target: "cli",
        mode: "fork"
      ))
    }
    if caps.resumeInPlace {
      result.append(WorkExternalSessionAction(
        id: "resume-in-place",
        title: "Continue in original folder",
        detail: "Continue in \(session.cwdDisplayName), not the selected lane.",
        systemImage: "terminal.fill",
        tint: ADEColor.textPrimary,
        target: "cli",
        mode: "resume"
      ))
    }
    if !caps.forkIntoDifferentCwd && !caps.resumeInPlace {
      result.append(WorkExternalSessionAction(
        id: "resume-here",
        title: "Continue as CLI",
        detail: session.cwd == nil
          ? "The original folder could not be recovered, so \(provider) cannot safely continue this session."
          : "This session lives in another folder, and \(provider) can't resume across folders.",
        systemImage: "terminal.fill",
        tint: ADEColor.textMuted,
        target: "cli",
        mode: "resume",
        enabled: false
      ))
    }
  }

  if let importedRef = workImportedSessionRef(for: session) {
    result = result.filter { $0.mode == "fork" }
    result.insert(WorkExternalSessionAction(
      id: "open-existing",
      title: "Open in ADE",
      detail: "Open the ADE session that was already imported.",
      systemImage: "arrow.right.circle.fill",
      tint: ADEColor.accent,
      target: "existing",
      mode: "open",
      isPrimary: true,
      importedSessionRef: importedRef
    ), at: 0)
    return result
  }

  if !result.contains(where: { $0.isPrimary }), let index = result.firstIndex(where: { $0.enabled }) {
    result[index].isPrimary = true
  }
  return result
}

/// One provider-label map for the import feature. This file and
/// `WorkImportSessionScreen` each had their own, five identical cases apart —
/// and iOS already carries two more elsewhere. Consumers use this one.
func workExternalSessionProviderName(_ provider: String) -> String {
  switch provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
  case "claude": return "Claude"
  case "codex": return "Codex"
  case "cursor": return "Cursor"
  case "droid", "factory": return "Droid"
  case "opencode": return "OpenCode"
  default:
    let trimmed = provider.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? "Unknown" : trimmed
  }
}
