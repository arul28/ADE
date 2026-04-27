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

func isRunOwnedSession(_ session: TerminalSessionSummary) -> Bool {
  session.toolType?
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased() == "run-shell"
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
  switch providerFamilyKey(provider) {
  case "codex": return "Codex"
  case "claude": return "Claude"
  case "opencode": return "OpenCode"
  case "cursor": return "Cursor"
  default: return provider.capitalized
  }
}

/// Compact sidebar label for a session's tool type: "Claude", "Codex", "Shell", "Run". Mirrors
/// the desktop `shortToolTypeLabel` helper so iOS rows read the same as the desktop sidebar.
func shortProviderLabel(_ toolType: String?) -> String {
  let raw = toolType?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
  if raw.isEmpty { return "Shell" }
  switch raw {
  case "shell": return "Shell"
  case "run-shell": return "Run"
  case "cursor": return "Cursor"
  case "aider": return "Aider"
  case "continue": return "Continue"
  default: break
  }
  if raw.hasPrefix("claude") { return "Claude" }
  if raw.hasPrefix("codex") { return "Codex" }
  if raw.hasPrefix("opencode") { return "OpenCode" }
  return raw.replacingOccurrences(of: "-", with: " ").capitalized
}

func providerIcon(_ provider: String) -> String {
  switch providerFamilyKey(provider) {
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

/// Returns the bundled branded-logo asset name for a provider family when one
/// exists, so the session row and chat header can render the real Claude /
/// Codex / Cursor / OpenCode mark instead of a generic SF Symbol. Matches the
/// desktop `ToolLogo` palette (LobeHub static SVGs copied into the iOS asset
/// catalog). Returns nil for unknown providers so callers can fall back to
/// `providerIcon(_:)`.
func providerAssetName(_ provider: String?) -> String? {
  guard let provider, !provider.isEmpty else { return nil }
  switch providerFamilyKey(provider) {
  case "claude":
    return "ProviderClaude"
  case "codex":
    return "ProviderCodex"
  case "cursor":
    return "ProviderCursor"
  case "opencode":
    return "ProviderOpenCode"
  default:
    return nil
  }
}

func providerTint(_ provider: String?) -> Color {
  guard let provider else { return ADEColor.accent }
  switch providerFamilyKey(provider) {
  case "claude":
    return .orange
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

func providerFamilyKey(_ provider: String) -> String {
  let raw = provider
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
  if raw == "anthropic" || raw.hasPrefix("claude") {
    return "claude"
  }
  if raw == "openai" || raw.hasPrefix("codex") {
    return "codex"
  }
  if raw.hasPrefix("opencode") {
    return "opencode"
  }
  if raw == "cursor" || raw.hasPrefix("cursor") {
    return "cursor"
  }
  return raw
}

func sessionSymbol(_ session: TerminalSessionSummary, provider: String?) -> String {
  if isChatSession(session) {
    return providerIcon(provider ?? session.toolType ?? "")
  }
  return "terminal.fill"
}

func normalizedWorkChatSessionStatus(session: TerminalSessionSummary?, summary: AgentChatSessionSummary?) -> String {
  let raw = rawWorkChatSessionStatus(session: session, summary: summary)
  // Stale-session guard: a chat that's been "awaiting-input", "active", or
  // "idle" but hasn't moved in over 7 days is almost certainly never going
  // to resume. Desktop drops these from its Work list; iOS now does too so
  // the two devices stay in agreement.
  if raw == "awaiting-input" || raw == "active" || raw == "idle" {
    let lastActivityRaw = summary?.lastActivityAt ?? session?.chatIdleSinceAt ?? session?.startedAt
    if let last = lastActivityRaw,
       let date = workChatLastActivityDate(last),
       Date().timeIntervalSince(date) > workChatStaleAfterSeconds {
      return "ended"
    }
  }
  return raw
}

private let workChatStaleAfterSeconds: TimeInterval = 7 * 24 * 60 * 60

private func workChatLastActivityDate(_ raw: String) -> Date? {
  let iso = ISO8601DateFormatter()
  iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let d = iso.date(from: raw) { return d }
  iso.formatOptions = [.withInternetDateTime]
  return iso.date(from: raw)
}

private func rawWorkChatSessionStatus(session: TerminalSessionSummary?, summary: AgentChatSessionSummary?) -> String {
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

/// Shared menu options for the access-mode pill in both the in-session composer and the
/// New Chat composer. Matches the desktop composer's per-provider set. Empty when the
/// provider has no runtime mode (e.g. cursor — which uses `cursorModeId` instead).
struct WorkRuntimeModeOption: Identifiable, Hashable {
  let id: String
  let title: String
}

func workRuntimeModeOptions(provider: String) -> [WorkRuntimeModeOption] {
  switch provider.lowercased() {
  case "claude":
    return [
      WorkRuntimeModeOption(id: "default", title: "Default"),
      WorkRuntimeModeOption(id: "plan", title: "Plan"),
      WorkRuntimeModeOption(id: "edit", title: "Auto edit"),
      WorkRuntimeModeOption(id: "full-auto", title: "Bypass"),
    ]
  case "codex":
    return [
      WorkRuntimeModeOption(id: "default", title: "Default permissions"),
      WorkRuntimeModeOption(id: "plan", title: "Plan mode"),
      WorkRuntimeModeOption(id: "full-auto", title: "Full access"),
      WorkRuntimeModeOption(id: "config-toml", title: "Custom (config.toml)"),
    ]
  case "opencode":
    return [
      WorkRuntimeModeOption(id: "plan", title: "Plan"),
      WorkRuntimeModeOption(id: "edit", title: "Edit"),
      WorkRuntimeModeOption(id: "full-auto", title: "Full auto"),
    ]
  default:
    return []
  }
}

func workRuntimeModeLabel(provider: String, mode: String) -> String {
  switch provider.lowercased() {
  case "claude":
    switch mode {
    case "plan": return "Plan"
    case "edit": return "Auto edit"
    case "full-auto": return "Bypass"
    default: return "Default"
    }
  case "codex":
    switch mode {
    case "plan": return "Plan mode"
    case "full-auto": return "Full access"
    case "config-toml": return "Custom"
    default: return "Default permissions"
    }
  case "opencode":
    return mode.isEmpty ? "Edit" : mode.capitalized
  default:
    return mode.isEmpty ? "Access" : mode.capitalized
  }
}

func workRuntimeModeTint(_ mode: String) -> Color {
  switch mode {
  case "full-auto": return ADEColor.danger
  case "edit": return ADEColor.warning
  case "plan": return ADEColor.accent
  default: return ADEColor.textSecondary
  }
}

/// Default runtime mode for a fresh chat given the provider. "default" for Claude/Codex,
/// "edit" for OpenCode (matches desktop's new-session defaults).
func workDefaultRuntimeMode(provider: String) -> String {
  switch provider.lowercased() {
  case "claude", "codex": return "default"
  case "opencode": return "edit"
  default: return ""
  }
}

/// Fields for a new `createChatSession` call derived from the user-picked runtime mode.
struct WorkRuntimeWireFields {
  var permissionMode: String?
  var interactionMode: String?
  var claudePermissionMode: String?
  var codexApprovalPolicy: String?
  var codexSandbox: String?
  var codexConfigSource: String?
  var opencodePermissionMode: String?
}

func workRuntimeWireFields(provider: String, mode: String) -> WorkRuntimeWireFields {
  var fields = WorkRuntimeWireFields()
  switch provider.lowercased() {
  case "claude":
    switch mode {
    case "plan":
      fields.interactionMode = "plan"
      fields.claudePermissionMode = "default"
      fields.permissionMode = "plan"
    case "edit":
      fields.interactionMode = "default"
      fields.claudePermissionMode = "acceptEdits"
      fields.permissionMode = "edit"
    case "full-auto":
      fields.interactionMode = "default"
      fields.claudePermissionMode = "bypassPermissions"
      fields.permissionMode = "full-auto"
    default:
      fields.interactionMode = "default"
      fields.claudePermissionMode = "default"
      fields.permissionMode = "default"
    }
  case "codex":
    switch mode {
    case "plan":
      fields.codexConfigSource = "flags"
      fields.codexApprovalPolicy = "on-request"
      fields.codexSandbox = "read-only"
      fields.permissionMode = "plan"
    case "full-auto":
      fields.codexConfigSource = "flags"
      fields.codexApprovalPolicy = "never"
      fields.codexSandbox = "danger-full-access"
      fields.permissionMode = "full-auto"
    case "config-toml":
      fields.codexConfigSource = "config-toml"
      fields.permissionMode = "config-toml"
    default:
      fields.codexConfigSource = "flags"
      fields.codexApprovalPolicy = "on-request"
      fields.codexSandbox = "workspace-write"
      fields.permissionMode = "default"
    }
  case "opencode":
    fields.opencodePermissionMode = mode
    fields.permissionMode = mode
  default:
    break
  }
  return fields
}

/// Does a model accept a `reasoningEffort` knob? Covers Codex GPT-5 and Anthropic
/// "thinking" / opus / sonnet variants. Used to gate the reasoning pill in the composer.
func modelSupportsReasoning(modelId: String, provider: String) -> Bool {
  let lower = modelId.lowercased()
  if lower.contains("thinking") { return true }
  if lower.contains("gpt-5") { return true }
  if lower.contains("opus") || lower.contains("sonnet") { return true }
  switch provider.lowercased() {
  case "codex": return true
  case "claude":
    return lower.contains("opus") || lower.contains("sonnet")
  default:
    return false
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
    if summary.codexConfigSource == "config-toml" || summary.permissionMode == "config-toml" {
      return "config-toml"
    }
    if (summary.codexApprovalPolicy == "on-request" || summary.codexApprovalPolicy == "untrusted") && summary.codexSandbox == "read-only" {
      return "plan"
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

private let workDateFormatterFractional: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter
}()

func workParsedDate(_ value: String?) -> Date? {
  guard let value, !value.isEmpty else { return nil }
  // Sync hosts emit timestamps with fractional seconds (`...095Z`); the default
  // ISO8601DateFormatter rejects those, leaving `relativeTimestamp` to fall back
  // to the raw ISO string and leaking it into the UI.
  return workDateFormatterFractional.date(from: value) ?? workDateFormatter.date(from: value)
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

/// Ultra-compact relative-time label for sidebar rows: "now", "12m", "3h", "2d". Mirrors
/// the desktop `relativeTimeCompact` (`apps/desktop/src/renderer/lib/format.ts`).
func relativeTimestampCompact(_ value: String) -> String {
  guard let date = workParsedDate(value) else { return value }
  let delta = max(0, Date().timeIntervalSince(date))
  let minutes = Int(delta / 60)
  if minutes < 1 { return "now" }
  if minutes < 60 { return "\(minutes)m" }
  let hours = minutes / 60
  if hours < 24 { return "\(hours)h" }
  return "\(hours / 24)d"
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
