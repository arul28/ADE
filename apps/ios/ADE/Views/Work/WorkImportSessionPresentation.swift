import Foundation

/// Lane-filter bucket for sessions whose folder is not a live lane.
let workImportOtherFoldersFilter = "__other_folders__"

extension ExternalSessionSummary {
  var importIdentity: String {
    "\(provider):\(id)"
  }

  /// The row's lane label: the home lane's name, "Removed lane", or the last
  /// folder of a path outside every lane. Older hosts send no `home`.
  var laneDisplayName: String {
    switch home?.kind {
    case "lane":
      let name = home?.laneName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      return name.isEmpty ? "Lane" : name
    case "removed-lane":
      return "Removed lane"
    case "outside":
      return cwdLastPathSegment ?? "Other folder"
    default:
      return cwdLastPathSegment ?? cwdDisplayName
    }
  }

  /// Which lane-filter bucket the row belongs to: a live lane id, or "Other
  /// folders". Rows from hosts without `home` fall back to the folder match.
  func importLaneBucket(liveLaneIds: Set<String>, originLaneId: String) -> String {
    if let home {
      if home.kind == "lane", let laneId = home.laneId, liveLaneIds.contains(laneId) {
        return laneId
      }
      return workImportOtherFoldersFilter
    }
    return cwdMatchesRequestedLane == true ? originLaneId : workImportOtherFoldersFilter
  }

  /// The home lane when it is a live lane on this device, else nil.
  func defaultImportTargetLaneId(liveLaneIds: Set<String>) -> String? {
    guard home?.kind == "lane", let laneId = home?.laneId, liveLaneIds.contains(laneId) else { return nil }
    return laneId
  }

  var sizeDisplay: String? {
    guard let sizeBytes, sizeBytes.isFinite, sizeBytes >= 0, sizeBytes < 9e18 else { return nil }
    return ByteCountFormatter.string(fromByteCount: Int64(sizeBytes), countStyle: .file)
  }

  /// Mirrors desktop `sessionHeading`: the provider's title, else the opening
  /// prompt, else the first sampled user message, else "Untitled <Provider>
  /// chat". The row already shows the lane and the time, so a folder-and-time
  /// fallback would repeat both and name nothing.
  var rowHeading: String {
    if let realTitle { return realTitle }
    if let openingPromptHeading { return openingPromptHeading }
    let firstUser = (messages ?? []).first(where: { $0.role == "user" })?.text
    if let sampled = workImportHeadingText(firstUser) { return sampled }
    return "Untitled \(workExternalSessionProviderName(provider)) chat"
  }

  var hasRealTitle: Bool {
    realTitle != nil
  }

  var realTitle: String? {
    let trimmedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmedTitle.isEmpty ? nil : trimmedTitle
  }

  /// The opening ask, used as a heading when the provider persisted no title.
  var openingPromptHeading: String? {
    workImportHeadingText(previewSnippet)
  }

  var startedAnchorSnippet: String? {
    guard let openingPromptHeading,
          workImportHeadingText(openingPromptHeading) != workImportHeadingText(rowHeading) else {
      return nil
    }
    return openingPromptHeading
  }

  var latestAnchorMessage: ExternalSessionMessage? {
    guard let latest = conversationMessages.last else { return nil }
    // Normalize both sides before comparing, and check the started anchor too:
    // a titled single-message thread clears the heading check yet still repeats
    // the opening prompt, which reads as a rendering bug.
    let normalizedLatest = workImportHeadingText(latest.text)
    guard normalizedLatest != workImportHeadingText(rowHeading) else { return nil }
    if let started = startedAnchorSnippet, normalizedLatest == workImportHeadingText(started) {
      return nil
    }
    return latest
  }

  var hasConversationAnchorData: Bool {
    openingPromptHeading != nil || !conversationMessages.isEmpty
  }

  var conversationMessages: [ExternalSessionMessage] {
    (messages ?? []).compactMap { message in
      let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !text.isEmpty else { return nil }
      return ExternalSessionMessage(role: message.role, text: text, at: message.at)
    }
  }

  var previewSnippet: String? {
    let trimmedPreview = preview?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmedPreview.isEmpty ? nil : trimmedPreview
  }

  var previewDuplicatesHeading: Bool {
    guard let previewSnippet else { return false }
    return workImportHeadingText(previewSnippet) == workImportHeadingText(rowHeading)
  }

  var trimmedCwd: String? {
    let trimmed = cwd?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? nil : trimmed
  }

  /// The folder's last segment. Splits on slash and backslash so a Windows host's
  /// path reads as its folder name too (desktop `lastSegment`).
  var cwdLastPathSegment: String? {
    guard let trimmedCwd else { return nil }
    return trimmedCwd
      .split(whereSeparator: { $0 == "/" || $0 == "\\" })
      .last
      .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
      .flatMap { $0.isEmpty ? nil : $0 }
  }

  var cwdDisplayName: String {
    guard let cwd = trimmedCwd else { return "its original folder" }
    let home = NSHomeDirectory()
    var display = cwd
    if cwd == home { display = "~" }
    if cwd.hasPrefix(home + "/") {
      display = "~" + cwd.dropFirst(home.count)
    }
    let segments = display.split(separator: "/").map(String.init)
    guard segments.count > 3 else { return display }
    return "…/" + segments.suffix(3).joined(separator: "/")
  }

  var relativeUpdatedAt: String {
    guard let timestamp = updatedAt ?? createdAt, timestamp > 0 else { return "" }
    let seconds = timestamp > 10_000_000_000 ? timestamp / 1000 : timestamp
    return WorkImportSessionFormatters.relative.localizedString(for: Date(timeIntervalSince1970: seconds), relativeTo: Date())
  }
}

private func workImportHeadingText(_ value: String?) -> String? {
  let collapsed = value?
    .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  guard !collapsed.isEmpty else { return nil }
  guard collapsed.count > 72 else { return collapsed }
  return String(collapsed.prefix(71)).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
}

private enum WorkImportSessionFormatters {
  static let relative: RelativeDateTimeFormatter = {
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .short
    return formatter
  }()
}
