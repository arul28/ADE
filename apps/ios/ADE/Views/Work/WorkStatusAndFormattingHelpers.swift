import SwiftUI
import UIKit
import AVKit

func isChatSession(_ session: TerminalSessionSummary) -> Bool {
  let raw = session.toolType?
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased() ?? ""
  guard !raw.isEmpty else { return false }
  // Must match desktop `isChatToolType` (`apps/desktop/src/renderer/lib/sessions.ts`) — explicit chat tools plus `*-chat` providers.
  if raw == "codex-chat" || raw == "claude-chat" || raw == "opencode-chat" || raw == "cursor" {
    return true
  }
  return raw.hasSuffix("-chat")
}

func defaultWorkChatTitle(provider: String) -> String {
  switch provider.lowercased() {
  case "codex":
    return "Codex chat"
  case "opencode":
    return "OpenCode chat"
  case "cursor":
    return "Cursor chat"
  default:
    return "Claude chat"
  }
}

func toolTypeForProvider(_ provider: String) -> String {
  switch provider.lowercased() {
  case "codex": return "codex-chat"
  case "opencode": return "opencode-chat"
  case "cursor": return "cursor"
  default: return "claude-chat"
  }
}

func providerLabel(_ provider: String) -> String {
  switch provider.lowercased() {
  case "codex": return "Codex"
  case "claude": return "Claude"
  case "opencode": return "OpenCode"
  case "cursor": return "Cursor"
  default: return provider.capitalized
  }
}

func providerIcon(_ provider: String) -> String {
  switch provider.lowercased() {
  case "codex":
    return "sparkle"
  case "opencode":
    return "hammer.fill"
  case "cursor":
    return "cursorarrow"
  default:
    return "brain.head.profile"
  }
}

func providerTint(_ provider: String?) -> Color {
  guard let provider else { return ADEColor.accent }
  switch provider.lowercased() {
  case "codex":
    return .blue
  case "opencode":
    return .teal
  case "cursor":
    return .indigo
  default:
    return ADEColor.accent
  }
}

func sessionSymbol(_ session: TerminalSessionSummary, provider: String?) -> String {
  if isChatSession(session) {
    return providerIcon(provider ?? session.toolType ?? "")
  }
  return "terminal.fill"
}

func normalizedWorkChatSessionStatus(session: TerminalSessionSummary?, summary: AgentChatSessionSummary?) -> String {
  if summary?.awaitingInput == true {
    return "awaiting-input"
  }
  if let status = summary?.status.lowercased() {
    switch status {
    case "active", "running":
      return "active"
    case "idle", "paused":
      return "idle"
    case "ended", "completed", "failed", "interrupted":
      return "ended"
    default:
      break
    }
  }

  guard let session else { return "ended" }
  switch session.runtimeState.lowercased() {
  case "waiting-input":
    return "awaiting-input"
  case "idle":
    return "idle"
  case "running":
    return "active"
  default:
    return session.status == "running" ? "active" : "ended"
  }
}

func normalizedRuntimeState(for summary: AgentChatSessionSummary) -> String {
  if summary.awaitingInput == true {
    return "waiting-input"
  }
  switch summary.status.lowercased() {
  case "idle", "paused":
    return "idle"
  case "ended", "completed", "failed", "interrupted":
    return "exited"
  default:
    return "running"
  }
}

func workChatStatusSortRank(_ status: String) -> Int {
  switch status {
  case "awaiting-input": return 0
  case "active": return 1
  case "idle": return 2
  default: return 3
  }
}

func workChatStatusTint(_ status: String) -> Color {
  switch status {
  case "awaiting-input": return ADEColor.warning
  case "active": return ADEColor.success
  case "idle": return ADEColor.accent
  default: return ADEColor.textSecondary
  }
}

func workChatStatusIcon(_ status: String) -> String {
  switch status {
  case "awaiting-input": return "exclamationmark.bubble.fill"
  case "active": return "waveform.path.ecg"
  case "idle": return "pause.circle"
  default: return "checkmark.circle"
  }
}

func workInitialRuntimeMode(_ summary: AgentChatSessionSummary) -> String {
  switch summary.provider {
  case "claude":
    if summary.interactionMode == "plan" || summary.permissionMode == "plan" {
      return "plan"
    }
    if summary.claudePermissionMode == "bypassPermissions" || summary.permissionMode == "full-auto" {
      return "full-auto"
    }
    if summary.claudePermissionMode == "acceptEdits" || summary.permissionMode == "edit" {
      return "edit"
    }
    return "default"
  case "codex":
    if summary.codexApprovalPolicy == "untrusted" && summary.codexSandbox == "read-only" {
      return "plan"
    }
    if summary.codexApprovalPolicy == "on-failure" && summary.codexSandbox == "workspace-write" {
      return "edit"
    }
    if summary.codexApprovalPolicy == "never" && summary.codexSandbox == "danger-full-access" {
      return "full-auto"
    }
    return "default"
  case "opencode":
    return summary.opencodePermissionMode ?? summary.permissionMode ?? "edit"
  default:
    return ""
  }
}

func workInitialCursorModeId(_ summary: AgentChatSessionSummary) -> String {
  summary.cursorModeId ?? workCursorCurrentModeId(summary.cursorModeSnapshot) ?? "agent"
}

func workCursorModeIds(_ snapshot: RemoteJSONValue?, fallback: String) -> [String] {
  if case .object(let object) = snapshot,
     case .array(let entries)? = object["availableModeIds"] {
    let ids = entries.compactMap { value -> String? in
      guard case .string(let string) = value else { return nil }
      let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? nil : trimmed
    }
    if !ids.isEmpty {
      return ids
    }
  }
  return [fallback]
}

func workCursorCurrentModeId(_ snapshot: RemoteJSONValue?) -> String? {
  guard case .object(let object)? = snapshot,
        case .string(let currentModeId)? = object["currentModeId"]
  else {
    return nil
  }
  let trimmed = currentModeId.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? nil : trimmed
}

func workCursorModeLabel(_ modeId: String) -> String {
  let normalized = modeId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  if normalized.isEmpty { return "Agent" }
  switch normalized {
  case "agent": return "Agent"
  case "ask": return "Ask"
  case "manual": return "Manual"
  default:
    return normalized
      .split(whereSeparator: { $0 == "-" || $0 == "_" || $0 == "/" })
      .map { part in
        let word = String(part)
        return word.prefix(1).uppercased() + word.dropFirst()
      }
      .joined(separator: " ")
  }
}

func sessionStatusLabel(_ session: TerminalSessionSummary, summary: AgentChatSessionSummary? = nil) -> String {
  sessionStatusLabel(for: normalizedWorkChatSessionStatus(session: session, summary: summary))
}

func sessionStatusLabel(for status: String) -> String {
  switch status {
  case "awaiting-input": return "NEEDS INPUT"
  case "active": return "RUNNING"
  case "idle": return "IDLE"
  default: return "ENDED"
  }
}

func workParsedDate(_ value: String?) -> Date? {
  guard let value, !value.isEmpty else { return nil }
  return workDateFormatter.date(from: value)
}

func formattedSessionDuration(startedAt: String, endedAt: String?) -> String {
  guard let start = workParsedDate(startedAt) else { return "—" }
  let end = workParsedDate(endedAt) ?? Date()
  let interval = max(0, Int(end.timeIntervalSince(start)))
  let hours = interval / 3600
  let minutes = (interval % 3600) / 60
  let seconds = interval % 60
  if hours > 0 {
    return String(format: "%dh %02dm", hours, minutes)
  }
  if minutes > 0 {
    return String(format: "%dm %02ds", minutes, seconds)
  }
  return "\(seconds)s"
}

func relativeTimestamp(_ value: String) -> String {
  guard let date = workParsedDate(value) else { return value }
  return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
}

func activityTitle(for kind: String) -> String {
  switch kind {
  case "thinking": return "Thinking"
  case "working": return "Working"
  case "editing_file": return "Editing file"
  case "running_command": return "Running command"
  case "searching": return "Searching"
  case "reading": return "Reading"
  case "tool_calling": return "Calling tool"
  case "web_searching": return "Searching the web"
  case "spawning_agent": return "Spawning agent"
  default: return kind.replacingOccurrences(of: "_", with: " ").capitalized
  }
}

func pendingInputResolutionLabel(for resolution: String) -> String {
  switch resolution {
  case "accepted": return "Accepted"
  case "declined": return "Declined"
  case "cancelled": return "Cancelled"
  default: return resolution.replacingOccurrences(of: "_", with: " ").capitalized
  }
}

func pendingInputResolutionIcon(for resolution: String) -> String {
  switch resolution {
  case "accepted": return "checkmark.circle.fill"
  case "declined": return "xmark.circle.fill"
  case "cancelled": return "minus.circle.fill"
  default: return "checkmark.circle"
  }
}

func pendingInputResolutionTint(for resolution: String) -> ColorToken {
  switch resolution {
  case "accepted": return .success
  case "declined": return .danger
  case "cancelled": return .secondary
  default: return .accent
  }
}

func noticeTitle(for kind: String) -> String {
  switch kind {
  case "auth": return "Authentication notice"
  case "rate_limit": return "Rate limit notice"
  case "hook": return "Hook notice"
  case "file_persist": return "File persistence"
  case "memory": return "Memory notice"
  case "provider_health": return "Provider health"
  case "thread_error": return "Thread notice"
  default: return "System notice"
  }
}

func noticeIcon(for kind: String) -> String {
  switch kind {
  case "auth": return "lock.trianglebadge.exclamationmark"
  case "rate_limit": return "speedometer"
  case "hook": return "bolt.badge.clock"
  case "file_persist": return "externaldrive.badge.checkmark"
  case "memory": return "brain.head.profile"
  case "provider_health": return "waveform.path.ecg"
  case "thread_error": return "exclamationmark.bubble"
  default: return "info.circle"
  }
}

func noticeTint(for kind: String) -> ColorToken {
  switch kind {
  case "auth", "thread_error": return .danger
  case "rate_limit", "hook": return .warning
  case "provider_health", "memory": return .secondary
  default: return .accent
  }
}

func toolDisplayName(_ tool: String) -> String {
  let trimmed = tool.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return "Tool" }
  if trimmed.hasPrefix("functions.") {
    return String(trimmed.split(separator: ".").last ?? Substring(trimmed))
  }
  if trimmed.hasPrefix("mcp__") {
    return trimmed.replacingOccurrences(of: "mcp__", with: "").replacingOccurrences(of: "__", with: " · ")
  }
  return trimmed
}

func fileExtension(for mimeType: String?, fallback: String) -> String {
  guard let mimeType else { return fallback }
  if mimeType.contains("png") { return "png" }
  if mimeType.contains("jpeg") || mimeType.contains("jpg") { return "jpg" }
  if mimeType.contains("gif") { return "gif" }
  if mimeType.contains("webp") { return "webp" }
  if mimeType.contains("mov") { return "mov" }
  if mimeType.contains("mp4") { return "mp4" }
  return fallback
}

extension Font {
  func bold() -> Font {
    self.weight(.bold)
  }
}
