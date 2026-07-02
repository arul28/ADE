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

func isStoppableRuntimeSession(_ session: TerminalSessionSummary, summary: AgentChatSessionSummary? = nil) -> Bool {
  guard !isChatSession(session) else { return false }
  let status = normalizedWorkChatSessionStatus(session: session, summary: summary)
  return isStoppableRuntimeStatus(session, status: status)
}

func isStoppableRuntimeStatus(_ session: TerminalSessionSummary, status: String) -> Bool {
  guard !isChatSession(session) else { return false }
  return status == "active" || status == "awaiting-input" || status == "idle"
}

func workSessionDeepLink(sessionId: String, laneId: String?) -> String {
  let pathAllowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#[]@!$&'()*+,;="))
  let queryAllowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "#&="))
  let encodedSessionId = sessionId.addingPercentEncoding(withAllowedCharacters: pathAllowed) ?? sessionId
  let trimmedLaneId = laneId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  guard !trimmedLaneId.isEmpty else {
    return "ade://session/\(encodedSessionId)"
  }
  let encodedLaneId = trimmedLaneId.addingPercentEncoding(withAllowedCharacters: queryAllowed) ?? trimmedLaneId
  return "ade://session/\(encodedSessionId)?lane=\(encodedLaneId)"
}

func workChatComposerBlocksFreeformInput(pendingInputCount: Int, sessionStatus: String) -> Bool {
  pendingInputCount > 0 || sessionStatus == "awaiting-input"
}

func workChatAwaitingPromptDetailsMissing(pendingInputCount: Int, sessionStatus: String) -> Bool {
  pendingInputCount == 0 && sessionStatus == "awaiting-input"
}

func workChatComposerPlaceholder(pendingInputCount: Int, sessionStatus: String) -> String {
  if workChatAwaitingPromptDetailsMissing(pendingInputCount: pendingInputCount, sessionStatus: sessionStatus) {
    return "Waiting for prompt details..."
  }
  if workChatComposerBlocksFreeformInput(pendingInputCount: pendingInputCount, sessionStatus: sessionStatus) {
    return "Answer the prompt above..."
  }
  return "Type to vibecode..."
}

func workChatComposerPlaceholder(pendingInputs: [WorkPendingInputItem], sessionStatus: String) -> String {
  if workChatAwaitingPromptDetailsMissing(pendingInputCount: pendingInputs.count, sessionStatus: sessionStatus) {
    return "Waiting for prompt details..."
  }
  if pendingInputs.count == 1,
     case .planApproval = pendingInputs[0] {
    return "Review the plan above..."
  }
  if workChatComposerBlocksFreeformInput(pendingInputCount: pendingInputs.count, sessionStatus: sessionStatus) {
    return "Answer the prompt above..."
  }
  return "Type to vibecode..."
}

func workMobileShowsToolCardInTimeline(_ card: WorkToolCardModel) -> Bool {
  isQuestionInputToolName(card.toolName)
}

struct WorkToolActivityPresentation: Equatable {
  let label: String
  let detail: String?
}

struct WorkSubagentCapability: Equatable {
  let canList: Bool
  let canViewFullTranscript: Bool

  static let none = WorkSubagentCapability(canList: false, canViewFullTranscript: false)
}

func workResolveSubagentCapability(provider: String?) -> WorkSubagentCapability {
  switch providerFamilyKey(provider ?? "") {
  case "codex", "claude", "opencode":
    return WorkSubagentCapability(canList: true, canViewFullTranscript: true)
  case "cursor", "droid", "factory":
    return WorkSubagentCapability(canList: true, canViewFullTranscript: false)
  default:
    return .none
  }
}

func workSubagentRunningCount(_ snapshots: [WorkSubagentSnapshot]) -> Int {
  snapshots.filter { $0.status == .running }.count
}

func workSubagentMeaningfulName(_ snapshot: WorkSubagentSnapshot) -> String {
  let genericAgentTypes: Set<String> = ["opencode-subagent", "subagent"]
  let agentType = snapshot.agentType?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  if !agentType.isEmpty, !genericAgentTypes.contains(agentType.lowercased()) {
    return agentType
  }
  let description = snapshot.description.trimmingCharacters(in: .whitespacesAndNewlines)
  if !description.isEmpty, description.lowercased() != "subagent" {
    return description
  }
  if let agentId = snapshot.agentId?.trimmingCharacters(in: .whitespacesAndNewlines),
     !agentId.isEmpty {
    return agentId
  }
  return snapshot.taskId
}

func workSubagentSelection(from snapshot: WorkSubagentSnapshot) -> WorkSubagentSelection {
  WorkSubagentSelection(
    taskId: snapshot.taskId,
    agentId: snapshot.agentId,
    name: workSubagentMeaningfulName(snapshot),
    status: snapshot.status,
    background: snapshot.background
  )
}

func workToolActivityPresentation(tool: String, argsText: String?) -> WorkToolActivityPresentation {
  let normalized = tool.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  let label: String
  if normalized.contains("grep") || normalized.contains("search") {
    label = "Grepping"
  } else if normalized.contains("read") {
    label = "Reading"
  } else if normalized.contains("write") {
    label = "Writing"
  } else if normalized.contains("edit") {
    label = "Editing"
  } else if normalized.contains("bash") || normalized.contains("shell") || normalized.contains("command") {
    label = "Running command"
  } else if normalized.contains("web") || normalized.contains("browser") {
    label = "Browsing"
  } else if normalized.contains("list") || normalized.contains("ls") {
    label = "Listing"
  } else {
    let display = toolDisplayName(tool).trimmingCharacters(in: .whitespacesAndNewlines)
    label = display.isEmpty || display == "Tool" ? "Working" : display
  }
  return WorkToolActivityPresentation(
    label: label,
    detail: workToolArgPreview(tool: tool, argsText: argsText)
  )
}

func workToolArgPreview(tool: String, argsText: String?) -> String? {
  guard let argsText else { return nil }
  let trimmed = argsText.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return nil }

  if let object = workJSONObject(from: trimmed) {
    let keys = ["file_path", "path", "pattern", "query", "command", "cmd", "url"]
    for key in keys {
      if let value = object[key] as? String,
         let text = nonEmptyWorkToolArgPreview(value) {
        return text
      }
    }
  }

  let firstLine = trimmed.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? trimmed
  return nonEmptyWorkToolArgPreview(firstLine)
}

private func nonEmptyWorkToolArgPreview(_ value: String) -> String? {
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return nil }
  if trimmed.count <= 72 { return trimmed }
  return "...\(trimmed.suffix(69))"
}

func terminalSessionHasResumeTarget(_ session: TerminalSessionSummary) -> Bool {
  if session.resumeMetadata != nil {
    return true
  }
  return session.resumeCommand?
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .isEmpty == false
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
  case "openai": return "OpenAI"
  case "claude": return "Claude"
  case "anthropic": return "Anthropic"
  case "opencode": return "OpenCode"
  case "cursor": return "Cursor Composer"
  case "droid", "factory": return "Droid"
  case "google": return "Google"
  case "ollama": return "Ollama"
  case "lmstudio": return "LM Studio"
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
  case "codex", "openai":
    return "sparkle"
  case "opencode":
    return "hammer.fill"
  case "cursor":
    return "cursorarrow"
  case "droid", "factory":
    return "cpu"
  case "ollama":
    return "hare.fill"
  case "lmstudio":
    return "desktopcomputer"
  case "google":
    return "g.circle.fill"
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
  case "anthropic":
    return "ProviderAnthropic"
  case "codex":
    return "ProviderCodex"
  case "openai":
    return "ProviderOpenAI"
  case "cursor":
    return "ProviderCursor"
  case "opencode":
    return "ProviderOpenCode"
  case "droid", "factory":
    return "ProviderDroid"
  default:
    return nil
  }
}

/// Provider key for the model-picker rail icons. Mirrors desktop
/// `ProviderLogo` family marks (Anthropic/OpenAI company logos for Claude/Codex
/// groups, not the product marks used on model rows).
func workRailLogoProvider(for catalogGroupKey: String) -> String {
  switch catalogGroupKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
  case "claude", "anthropic":
    return "anthropic"
  case "codex", "openai":
    return "openai"
  case "cursor":
    return "cursor"
  case "droid", "factory":
    return "droid"
  case "opencode":
    return "opencode"
  case "ollama":
    return "ollama"
  case "lmstudio":
    return "lmstudio"
  default:
    return catalogGroupKey
  }
}

/// Maps a lowercased model id to its upstream brand logo key by substring,
/// or nil when the id doesn't name a known upstream vendor model.
func workUpstreamBrand(modelId: String) -> String? {
  if modelId.contains("gemini") {
    return "google"
  }
  if modelId.contains("claude") || modelId.contains("fable") || modelId.contains("sonnet")
    || modelId.contains("opus") || modelId.contains("haiku") {
    return "claude"
  }
  if modelId.contains("gpt") || modelId.contains("codex") {
    return "codex"
  }
  return nil
}

/// Per-model row logo key. Mirrors desktop `ModelRowLogo` so Cursor/Droid/OpenCode
/// rows show the upstream brand (Claude, OpenAI, Gemini, etc.) instead of the
/// runtime group logo.
func workModelRowLogoProvider(for model: WorkModelOption, catalogGroupKey: String?) -> String {
  let modelId = model.id.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  let group = catalogGroupKey?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""

  if group == "cursor" || modelId.contains("cursor/") || modelId.contains("composer") {
    if modelId == "auto" || modelId.contains("composer") {
      return "cursor"
    }
    if let brand = workUpstreamBrand(modelId: modelId) {
      return brand
    }
    if modelId.contains("grok") {
      return "xai"
    }
    return "cursor"
  }

  if group == "droid" || group == "factory" || modelId.hasPrefix("droid/") {
    if let brand = workUpstreamBrand(modelId: modelId) {
      return brand
    }
    if modelId.hasPrefix("glm-") || modelId.hasPrefix("kimi-") || modelId.hasPrefix("minimax-")
      || modelId.hasPrefix("custom:") {
      return "factory"
    }
    return "droid"
  }

  if group == "opencode" || modelId.hasPrefix("opencode/") {
    if modelId.hasPrefix("opencode/") {
      let parts = modelId.split(separator: "/", omittingEmptySubsequences: true)
      if parts.count >= 3 {
        switch String(parts[1]) {
        case "anthropic":
          return "claude"
        case "openai":
          return "codex"
        case "google":
          return "google"
        case "xai":
          return "xai"
        case "deepseek":
          return "deepseek"
        default:
          return String(parts[1])
        }
      }
    }
    return "opencode"
  }

  return model.provider
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
  case "droid":
    return .gray
  case "ollama":
    return .green
  case "lmstudio":
    return .orange
  case "google":
    return .yellow
  case "factory":
    return .gray
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
  if raw == "droid" || raw == "factory" || raw.hasPrefix("droid") {
    return "droid"
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
  // Stale-session guard: a chat that's been "active" or "idle" but hasn't
  // moved in over 7 days is almost certainly never going to resume. Keep
  // explicit awaiting-input sessions visible until they are resolved or closed.
  if raw == "active" || raw == "idle" {
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
  workParsedDate(raw)
}

private func rawWorkChatSessionStatus(session: TerminalSessionSummary?, summary: AgentChatSessionSummary?) -> String {
  if summary?.awaitingInput == true {
    return "awaiting-input"
  }
  if let session {
    let sessionStatus = session.status.lowercased()
    let runtimeState = session.runtimeState.lowercased()
    if sessionStatus == "awaiting-input" || sessionStatus == "awaiting_input" || runtimeState == "waiting-input" {
      return "awaiting-input"
    }
    switch runtimeState {
    case "idle":
      return "idle"
    case "running":
      return "active"
    case "stopped", "exited", "completed", "failed", "interrupted":
      return "ended"
    default:
      if sessionStatus == "running" {
        return "active"
      }
      if sessionStatus == "idle" || sessionStatus == "paused" {
        return "idle"
      }
      if sessionStatus == "ended" || sessionStatus == "completed" || sessionStatus == "failed" || sessionStatus == "interrupted" || sessionStatus == "exited" {
        return "ended"
      }
    }
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
  return session.status.lowercased() == "running" ? "active" : "ended"
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
  // Match desktop, where idle/needs-attention chats render as amber. Previously
  // idle was rendered with the purple accent, which read as "running" and
  // diverged from the desktop status-dot semantics.
  case "idle": return ADEColor.warning
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
/// New Chat composer. Matches the desktop composer's per-provider set.
struct WorkRuntimeModeOption: Identifiable, Hashable {
  let id: String
  let title: String
}

func workRuntimeModeOptions(provider: String) -> [WorkRuntimeModeOption] {
  switch provider.lowercased() {
  case "claude":
    return [
      WorkRuntimeModeOption(id: "default", title: "Default"),
      WorkRuntimeModeOption(id: "auto", title: "Auto"),
      WorkRuntimeModeOption(id: "edit", title: "Accept Edits"),
      WorkRuntimeModeOption(id: "plan", title: "Plan"),
      WorkRuntimeModeOption(id: "full-auto", title: "Bypass"),
    ]
  case "codex":
    return [
      WorkRuntimeModeOption(id: "default", title: "Default permissions"),
      WorkRuntimeModeOption(id: "edit", title: "Edit mode"),
      WorkRuntimeModeOption(id: "plan", title: "Plan mode"),
      WorkRuntimeModeOption(id: "full-auto", title: "Full access"),
      WorkRuntimeModeOption(id: "config-toml", title: "Custom (config.toml)"),
    ]
  case "opencode":
    return [
      WorkRuntimeModeOption(id: "plan", title: "Plan"),
      WorkRuntimeModeOption(id: "edit", title: "Edit"),
      WorkRuntimeModeOption(id: "full-auto", title: "Allow"),
      WorkRuntimeModeOption(id: "config-toml", title: "Config"),
    ]
  case "cursor":
    return [
      WorkRuntimeModeOption(id: "default", title: "Agent"),
      WorkRuntimeModeOption(id: "plan", title: "Plan"),
      WorkRuntimeModeOption(id: "edit", title: "Ask"),
      WorkRuntimeModeOption(id: "full-auto", title: "Full auto"),
    ]
  case "droid", "factory":
    return [
      WorkRuntimeModeOption(id: "read-only", title: "Read-only"),
      WorkRuntimeModeOption(id: "auto-low", title: "Auto low"),
      WorkRuntimeModeOption(id: "auto-medium", title: "Auto medium"),
      WorkRuntimeModeOption(id: "auto-high", title: "Auto high"),
      WorkRuntimeModeOption(id: "agi", title: "AGI"),
    ]
  default:
    return []
  }
}

func workRuntimeModeLabel(provider: String, mode: String) -> String {
  switch provider.lowercased() {
  case "claude":
    switch mode {
    case "auto": return "Auto"
    case "plan": return "Plan"
    case "edit": return "Accept Edits"
    case "full-auto": return "Bypass"
    default: return "Default"
    }
  case "codex":
    switch mode {
    case "edit": return "Edit mode"
    case "plan": return "Plan mode"
    case "full-auto": return "Full access"
    case "config-toml": return "Custom"
    default: return "Default permissions"
    }
  case "opencode":
    switch mode {
    case "plan": return "Plan"
    case "edit": return "Edit"
    case "full-auto": return "Allow"
    case "config-toml": return "Config"
    default: return "Edit"
    }
  case "cursor":
    switch mode {
    case "plan": return "Plan"
    case "edit", "ask": return "Ask"
    case "full-auto": return "Full auto"
    default: return "Agent"
    }
  case "droid", "factory":
    switch mode {
    case "plan", "read-only": return "Read-only"
    case "edit", "auto-low": return "Auto low"
    case "default", "auto-medium": return "Auto medium"
    case "full-auto", "auto-high": return "Auto high"
    case "agi": return "AGI"
    default: return "Auto low"
    }
  default:
    return mode.isEmpty ? "Access" : mode.capitalized
  }
}

func workRuntimeModeTint(_ mode: String) -> Color {
  switch mode {
  case "full-auto", "auto-high": return ADEColor.danger
  case "edit", "auto", "ask", "auto-low", "auto-medium", "default": return ADEColor.warning
  case "agi": return ADEColor.purpleAccent
  case "plan", "read-only": return ADEColor.accent
  default: return ADEColor.textSecondary
  }
}

/// Default runtime mode for a fresh chat given the provider. Mirrors the
/// desktop/TUI defaults: Default for Claude/Codex, Edit for OpenCode, Agent
/// for Cursor, and Auto low for Droid.
func workDefaultRuntimeMode(provider: String) -> String {
  switch provider.lowercased() {
  case "claude", "codex": return "default"
  case "opencode": return "edit"
  case "cursor": return "default"
  case "droid", "factory": return "auto-low"
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
  var droidPermissionMode: String?
  var cursorModeId: String?
}

func workRuntimeWireFields(provider: String, mode: String) -> WorkRuntimeWireFields {
  var fields = WorkRuntimeWireFields()
  switch provider.lowercased() {
  case "claude":
    switch mode {
    case "auto":
      fields.interactionMode = "default"
      fields.claudePermissionMode = "auto"
      fields.permissionMode = "auto"
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
    case "edit":
      fields.codexConfigSource = "flags"
      fields.codexApprovalPolicy = "untrusted"
      fields.codexSandbox = "workspace-write"
      fields.permissionMode = "edit"
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
    let normalizedMode = workNormalizedOpenCodeRuntimeMode(mode)
    fields.opencodePermissionMode = normalizedMode
    fields.permissionMode = normalizedMode
  case "cursor":
    let normalizedMode = mode.isEmpty ? "default" : mode
    switch normalizedMode {
    case "plan":
      fields.cursorModeId = "plan"
      fields.permissionMode = "plan"
    case "edit":
      fields.cursorModeId = "ask"
      fields.permissionMode = "edit"
    case "full-auto":
      fields.cursorModeId = "full-auto"
      fields.permissionMode = "full-auto"
    default:
      fields.cursorModeId = "agent"
      fields.permissionMode = "default"
    }
  case "droid", "factory":
    let normalizedMode = mode.isEmpty ? "auto-low" : mode
    switch normalizedMode {
    case "read-only", "plan":
      fields.droidPermissionMode = "read-only"
      fields.permissionMode = "plan"
    case "auto-low", "edit":
      fields.droidPermissionMode = "auto-low"
      fields.permissionMode = "edit"
    case "auto-medium", "default":
      fields.droidPermissionMode = "auto-medium"
      fields.permissionMode = "default"
    case "auto-high", "full-auto":
      fields.droidPermissionMode = "auto-high"
      fields.permissionMode = "full-auto"
    case "agi":
      fields.droidPermissionMode = "agi"
      fields.permissionMode = "plan"
    default:
      fields.droidPermissionMode = "auto-low"
      fields.permissionMode = "edit"
    }
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
    if summary.claudePermissionMode == "auto" || summary.permissionMode == "auto" {
      return "auto"
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
    if summary.codexApprovalPolicy == "untrusted" && summary.codexSandbox == "workspace-write" {
      return "edit"
    }
    if summary.codexApprovalPolicy == "never" && summary.codexSandbox == "danger-full-access" {
      return "full-auto"
    }
    return "default"
  case "opencode":
    return workNormalizedOpenCodeRuntimeMode(summary.opencodePermissionMode ?? summary.permissionMode)
  case "cursor":
    switch summary.cursorModeId ?? workCursorCurrentModeId(summary.cursorModeSnapshot) {
    case "plan": return "plan"
    case "ask": return "edit"
    case "full-auto": return "full-auto"
    default: return "default"
    }
  case "droid", "factory":
    return workDroidRuntimeMode(
      droidPermissionMode: summary.droidPermissionMode,
      permissionMode: summary.permissionMode
    ) ?? "auto-low"
  default:
    return ""
  }
}

func workNormalizedOpenCodeRuntimeMode(_ mode: String?) -> String {
  switch mode {
  case "plan", "edit", "full-auto", "config-toml":
    return mode ?? "edit"
  default:
    return "edit"
  }
}

func workDroidModeFromPermissionMode(_ permissionMode: String?) -> String? {
  switch permissionMode {
  case "plan": return "read-only"
  case "edit": return "auto-low"
  case "default": return "auto-medium"
  case "full-auto": return "auto-high"
  default: return nil
  }
}

func workDroidRuntimeMode(droidPermissionMode: String?, permissionMode: String?) -> String? {
  switch droidPermissionMode {
  case "read-only", "auto-low", "auto-medium", "auto-high", "agi": return droidPermissionMode
  default: return workDroidModeFromPermissionMode(permissionMode)
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

private final class WorkParsedDateCacheBox: NSObject {
  let date: Date

  init(_ date: Date) {
    self.date = date
  }
}

private let workParsedDateCache: NSCache<NSString, WorkParsedDateCacheBox> = {
  let cache = NSCache<NSString, WorkParsedDateCacheBox>()
  cache.countLimit = 2_048
  return cache
}()

func workParsedDate(_ value: String?) -> Date? {
  guard let value, !value.isEmpty else { return nil }
  let cacheKey = value as NSString
  if let cached = workParsedDateCache.object(forKey: cacheKey) {
    return cached.date
  }
  // Sync hosts emit timestamps with fractional seconds (`...095Z`); the default
  // ISO8601DateFormatter rejects those, leaving `relativeTimestamp` to fall back
  // to the raw ISO string and leaking it into the UI.
  guard let date = workDateFormatterFractional.date(from: value) ?? workDateFormatter.date(from: value) else {
    return nil
  }
  workParsedDateCache.setObject(WorkParsedDateCacheBox(date), forKey: cacheKey)
  return date
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
  case "provider_health": return "waveform.path.ecg"
  case "thread_error": return "exclamationmark.bubble"
  default: return "info.circle"
  }
}

func noticeTint(for kind: String) -> ColorToken {
  switch kind {
  case "auth", "thread_error": return .danger
  case "rate_limit", "hook": return .warning
  case "provider_health": return .secondary
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

/// Collapses whitespace and truncates long inline tool/command previews.
/// Mirrors desktop `summarizeInlineText` in chatTranscriptRows.ts.
func workSummarizeInlineText(_ value: String, maxChars: Int = 120) -> String {
  let collapsed = value
    .replacingOccurrences(of: "\n", with: " ")
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
  guard collapsed.count > maxChars else { return collapsed }
  return String(collapsed.prefix(max(1, maxChars - 1))) + "…"
}

/// Extracts the human-readable target from tool args JSON — file path, shell
/// command, search pattern, etc. Avoids leaking raw `{` from pretty-printed
/// JSON in collapsed work-log rows (desktop `entryArgText` parity).
func workToolArgPreview(toolName: String, argsText: String?) -> String? {
  guard let object = workJSONObject(from: argsText) else {
    guard let argsText else { return nil }
    let trimmed = argsText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    let preview = workSummarizeInlineText(trimmed, maxChars: 140)
    return preview.isEmpty ? nil : preview
  }

  func stringValue(_ key: String) -> String? {
    guard let value = object[key] as? String else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  let suffix = toolDisplayName(toolName).lowercased()
  let target: String? = {
    switch suffix {
    case "read", "readfile":
      return stringValue("file_path") ?? stringValue("path")
    case "grep", "glob":
      return stringValue("pattern") ?? stringValue("path")
    case "ls", "listdir":
      return stringValue("path")
    case "write", "edit", "multiedit", "editfile", "writefile":
      return stringValue("file_path") ?? stringValue("path")
    case "notebookedit":
      return stringValue("notebook_path")
    case "bash", "exec_command", "shell":
      return stringValue("command") ?? stringValue("cmd")
    case "websearch":
      return stringValue("query")
    case "webfetch":
      return stringValue("url")
    case "gitdiff":
      return stringValue("path") ?? stringValue("ref")
    case "gitlog":
      return stringValue("ref")
    case "askuser":
      return stringValue("question")
    case "delegate_parallel":
      if let tasks = object["tasks"] as? [Any] {
        return "\(tasks.count) task(s)"
      }
      return "0 task(s)"
    default:
      for key in ["file_path", "path", "command", "cmd", "query", "url", "pattern", "name"] {
        if let value = stringValue(key) { return value }
      }
      return nil
    }
  }()

  guard let target else { return nil }
  let preview = workSummarizeInlineText(target, maxChars: 140)
  return preview.isEmpty ? nil : preview
}

private func toolNameSuffix(_ tool: String) -> String {
  let normalized = tool.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  if let last = normalized.split(separator: ".").last { return String(last) }
  return normalized
}

/// Tools that mutate the workspace. Used to partition adjacent tool/file
/// events between the read-only "Tool calls" panel and the "Files changed"
/// panel on the timeline.
func isCodeChangeToolName(_ tool: String) -> Bool {
  let suffix = toolNameSuffix(tool)
  let writeNames: Set<String> = [
    "edit", "multiedit", "write", "notebookedit",
    "applypatch", "apply_patch",
    "str_replace", "str_replace_based_edit_tool",
    "write_file", "edit_file", "create_file",
    "writefile", "editfile",
  ]
  return writeNames.contains(suffix)
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
