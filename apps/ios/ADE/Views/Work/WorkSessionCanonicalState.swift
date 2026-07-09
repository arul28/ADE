import SwiftUI

/// The ONE vocabulary for "what state is this session in", mirrored from the
/// desktop `apps/desktop/src/shared/sessionCanonicalState.ts` so a session's
/// Work-row capsule, its Live Activity phase, and any push notification always
/// tell the same story. This is a VIEW-layer vocabulary: the existing awaiting
/// derivation in `SyncService`/`normalizedWorkChatSessionStatus` is untouched.
///
/// Mapping to the Live Activity wire phases (names unchanged on the push side):
///   needs_you  ⇔ waiting_for_approval | waiting_for_input
///   failed     ⇔ failed
///   stale      ⇔ stale
///   starting/running ⇔ starting/running
///   ready/idle/stopped/ended have no LA row (terminal or chat-resting states).
enum CanonicalSessionPhase: Equatable {
  case starting
  case running
  case needsYou
  case failed
  case stale
  case ready
  case idle
  case stopped
  case ended
}

/// The three attention states that earn a capsule. Calm phases get no badge.
enum SessionBadgeKind: Equatable {
  case needsYou
  case failed
  case stale
}

struct SessionBadge: Equatable {
  let kind: SessionBadgeKind
  /// Short capsule copy; calm states get no badge at all.
  let label: String
}

struct CanonicalSessionState: Equatable {
  let phase: CanonicalSessionPhase
  /// Non-nil ONLY for attention states — capsules never render for calm ones.
  let badge: SessionBadge?
}

/// A session still marked running that has produced no output for this long is
/// "stale" — running but silent. Distinct from the push relay's APNs TTLs and
/// the Live Activity 10-minute lock-screen dimming: this is the human-facing
/// "is anything actually happening" bar. Exactly mirrors the desktop
/// `SESSION_STALE_AFTER_MS` (3 hours); do not reuse other stale semantics
/// (e.g. the 7-day chat reclassification in `normalizedWorkChatSessionStatus`).
let sessionStaleAfterSeconds: TimeInterval = 3 * 60 * 60

private let badgeByKind: [SessionBadgeKind: SessionBadge] = [
  .needsYou: SessionBadge(kind: .needsYou, label: "Needs you"),
  .failed: SessionBadge(kind: .failed, label: "Failed"),
  .stale: SessionBadge(kind: .stale, label: "Stale"),
]

private func isSilentPast(_ lastActivityAt: String?, now: Date, thresholdSeconds: TimeInterval) -> Bool {
  guard let at = workParsedDate(lastActivityAt) else { return false }
  return now.timeIntervalSince(at) >= thresholdSeconds
}

/// Whether a tool type is a chat provider (vs a raw terminal/CLI session).
/// Mirrors desktop `isChatToolType` — explicit chat tools plus `*-chat`
/// providers. `isChatSession(_:)` delegates here so both agree.
func isWorkChatToolType(_ toolType: String?) -> Bool {
  let raw = toolType?
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased() ?? ""
  guard !raw.isEmpty else { return false }
  if raw == "codex-chat" || raw == "claude-chat" || raw == "opencode-chat" || raw == "cursor" {
    return true
  }
  return raw.hasSuffix("-chat")
}

/// Canonical precedence (highest first), identical to the desktop module:
///   1. deterministic needs-input — a pending input item or a "waiting-input"
///      runtime (never outvoted by anything below),
///   2. stopped — user/system-disposed PTY,
///   3. failed — non-zero exit / killed,
///   4. stale — status running but silent ≥ `sessionStaleAfterSeconds`,
///   5. running (incl. the preview heuristic's needs_you upgrade, consulted LAST),
///   6. resting states — ready (idle chat), idle, ended.
func workCanonicalSessionState(
  status: String,
  runtimeState: String? = nil,
  toolType: String? = nil,
  pendingInputItemId: String? = nil,
  lastOutputPreview: String? = nil,
  lastActivityAt: String? = nil,
  exitCode: Int? = nil,
  now: Date = Date(),
  previewSuggestsNeedsInput: (String?) -> Bool = workSessionPreviewSuggestsNeedsInput,
  isChatTool: (String?) -> Bool = isWorkChatToolType
) -> CanonicalSessionState {
  let chat = isChatTool(toolType)
  let runtimeLower = runtimeState?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  let pending = pendingInputItemId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

  // 1. Deterministic attention beats everything — including the failure and
  // stale checks below (an agent explicitly asking is actionable regardless).
  if !pending.isEmpty || runtimeLower == "waiting-input" {
    return CanonicalSessionState(phase: .needsYou, badge: badgeByKind[.needsYou])
  }

  let ended = status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() != "running"
  if ended {
    // 2. Stopped: an explicitly disposed PTY is resumable/closed, not a task
    // failure. Check before exit/runtime failures because disposed sessions are
    // currently persisted with runtimeState "killed" and often exitCode 130.
    if status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "disposed" {
      return CanonicalSessionState(phase: .stopped, badge: nil)
    }

    // 3. Failure: a non-clean exit, an explicit "failed" persisted status
    // (spawn/setup failures that die before an exit code), or a killed runtime
    // — all deterministic "failed" signals a terminal-backed session reports.
    if let exitCode, exitCode != 0 {
      return CanonicalSessionState(phase: .failed, badge: badgeByKind[.failed])
    }
    if status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "failed" {
      return CanonicalSessionState(phase: .failed, badge: badgeByKind[.failed])
    }
    if runtimeLower == "killed" {
      return CanonicalSessionState(phase: .failed, badge: badgeByKind[.failed])
    }
    // Chats never "end" like PTYs — they rest between turns, ready for input.
    if chat { return CanonicalSessionState(phase: .ready, badge: nil) }
    return CanonicalSessionState(phase: .ended, badge: nil)
  }

  // 4. Stale: running but silent past the threshold.
  if isSilentPast(lastActivityAt, now: now, thresholdSeconds: sessionStaleAfterSeconds) {
    return CanonicalSessionState(phase: .stale, badge: badgeByKind[.stale])
  }

  // Idle chats between turns are ready (calm); idle agent CLIs stay calm here —
  // there is no deterministic ask.
  if runtimeLower == "idle" {
    return chat
      ? CanonicalSessionState(phase: .ready, badge: nil)
      : CanonicalSessionState(phase: .idle, badge: nil)
  }

  // 5. Preview heuristic LAST: it may only upgrade running → needs_you.
  if previewSuggestsNeedsInput(lastOutputPreview) {
    return CanonicalSessionState(phase: .needsYou, badge: badgeByKind[.needsYou])
  }

  return CanonicalSessionState(phase: .running, badge: nil)
}

// MARK: - Preview-text heuristic (mirrors desktop `runningSessionNeedsAttention`)

private let workNeedsInputPatterns: [NSRegularExpression] = {
  let specs: [(String, Bool)] = [
    ("\\b(?:waiting|awaiting)\\b.{0,28}\\b(?:input|confirmation|response|prompt)\\b", true),
    ("\\b(?:press|hit)\\b.{0,14}\\b(?:enter|return|any key)\\b", true),
    ("\\b(?:select|choose|pick)\\b.{0,28}\\b(?:option|number|profile|item)\\b", true),
    ("\\b(?:confirm|continue|proceed|retry)\\b.{0,24}\\?", true),
    ("\\((?:y/n|yes/no)\\)", true),
    ("\\[(?:y/n|yes/no)\\]", true),
    ("\\b(?:enter|type)\\b.{0,24}:\\s*$", true),
    // Claude Code tool-approval / plan-mode prompts: "(Y)es / (N)o".
    ("\\([Yy]\\)\\w*\\s*.{0,12}\\([Nn]\\)\\w*", false),
    ("\\ballow\\b.{0,40}\\?\\s", true),
  ]
  return specs.compactMap { pattern, caseInsensitive in
    let options: NSRegularExpression.Options = caseInsensitive ? [.caseInsensitive] : []
    return try? NSRegularExpression(pattern: pattern, options: options)
  }
}()

// ESC-introduced control sequences (OSC/CSI) plus a two-char escape sweep so a
// raw terminal-tail preview reads as plain text before pattern matching.
private let workAnsiEscapeRegexes: [NSRegularExpression] = {
  // ICU escape syntax (\uHHHH) — not Swift/JS \u{..}. Matches ESC-introduced OSC/CSI sequences plus a two-char escape sweep.
  [
    "\\u001B\\][^\\u0007]*(?:\\u0007|\\u001B\\\\)",
    "\\u001B\\[[0-?]*[ -/]*[@-~]",
    "\\u001B(?:[@-Z\\\\-_]|[0-9=>])",
  ].compactMap { try? NSRegularExpression(pattern: $0) }
}()

/// The preview-text needs-input heuristic, ported from the desktop
/// `runningSessionNeedsAttention`. Consulted LAST by `workCanonicalSessionState`
/// and can only upgrade a plain running session to needs_you.
func workSessionPreviewSuggestsNeedsInput(_ preview: String?) -> Bool {
  guard var text = preview, !text.isEmpty else { return false }
  let fullRange = { NSRange(text.startIndex..<text.endIndex, in: text) }
  for regex in workAnsiEscapeRegexes {
    text = regex.stringByReplacingMatches(in: text, range: fullRange(), withTemplate: "")
  }
  // Drop remaining control characters, collapse whitespace, and cap length to
  // match the desktop sanitizer's 280-char window.
  let stripped = String(text.unicodeScalars.filter { scalar in
    scalar == " " || scalar == "\n" || scalar == "\t" || !(scalar.properties.generalCategory == .control)
  })
  let normalized = stripped
    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  guard !normalized.isEmpty else { return false }
  let capped = normalized.count <= 280 ? normalized : String(normalized.prefix(280))
  let range = NSRange(capped.startIndex..<capped.endIndex, in: capped)
  return workNeedsInputPatterns.contains { $0.firstMatch(in: capped, range: range) != nil }
}

// MARK: - Row capsule wiring

/// The one-word attention capsule for a Work session row, backed by the shared
/// canonical state so the capsule, the Live Activity phase, and notifications
/// always agree. Returns nil for every calm state — rows must not shift layout
/// when no capsule renders.
///
/// This maps iOS's awaiting derivation (chat summary `awaitingInput`, plus
/// `awaiting_input` session statuses) onto the canonical "waiting-input" runtime
/// so a chat blocked on a question/plan/approval reads as needs_you exactly like
/// `SyncService.isAwaiting`, without touching that derivation.
func workSessionCapsuleBadge(
  session: TerminalSessionSummary,
  summary: AgentChatSessionSummary?,
  now: Date = Date()
) -> SessionBadge? {
  let statusLower = session.status.lowercased()
  let runtimeLower = session.runtimeState.lowercased()
  let isAwaiting = summary?.awaitingInput == true
    || runtimeLower == "waiting-input"
    || statusLower == "awaiting-input"
    || statusLower == "awaiting_input"
  let effectiveRuntime = isAwaiting ? "waiting-input" : session.runtimeState
  return workCanonicalSessionState(
    status: session.status,
    runtimeState: effectiveRuntime,
    toolType: session.toolType,
    pendingInputItemId: session.pendingInputItemId,
    lastOutputPreview: session.lastOutputPreview,
    lastActivityAt: workSessionStaleActivityTimestamp(session: session, summary: summary),
    exitCode: session.exitCode,
    now: now
  ).badge
}

/// The genuine last-activity timestamp used ONLY to drive the stale check.
/// Unlike `workSessionActivityTimestamp` (which feeds display/sort and falls
/// back to `session.startedAt`), this returns nil when no real activity signal
/// exists — the iOS `TerminalSessionSummary` carries no desktop-style
/// `lastActivityAt`, so a plain terminal has no output timestamp. Falling back
/// to `startedAt` would flag any terminal open >3h as Stale even with output
/// seconds ago; nil disables the check, mirroring the desktop caller which
/// passes the real `lastActivityAt` or null (never `startedAt`).
private func workSessionStaleActivityTimestamp(
  session: TerminalSessionSummary,
  summary: AgentChatSessionSummary?
) -> String? {
  summary?.lastActivityAt ?? session.chatIdleSinceAt
}

/// Small attention capsule shown next to a Work row title. Amber for needs_you
/// (matching the app's existing amber chip language), red for failed, and an
/// outlined muted capsule with a clock glyph for stale. Calm states render
/// nothing, so callers gate on a non-nil badge to avoid any layout shift.
struct WorkSessionStatusCapsule: View {
  let badge: SessionBadge

  var body: some View {
    HStack(spacing: 3) {
      if badge.kind == .stale {
        Image(systemName: "clock")
          .font(.system(size: 8, weight: .semibold))
      }
      Text(badge.label)
        .font(.caption2.weight(.semibold))
    }
    .foregroundStyle(tint)
    .padding(.horizontal, 7)
    .padding(.vertical, 2)
    .background(fill, in: Capsule())
    .overlay(Capsule().stroke(stroke, lineWidth: 0.5))
    .fixedSize()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel)
  }

  private var tint: Color {
    switch badge.kind {
    case .needsYou: return ADEColor.warning
    case .failed: return ADEColor.danger
    case .stale: return ADEColor.textMuted
    }
  }

  private var fill: Color {
    badge.kind == .stale ? Color.clear : tint.opacity(0.14)
  }

  private var stroke: Color {
    badge.kind == .stale ? tint.opacity(0.4) : tint.opacity(0.3)
  }

  private var accessibilityLabel: String {
    switch badge.kind {
    case .needsYou: return "Needs your input"
    case .failed: return "Failed"
    case .stale: return "Stale, no recent activity"
    }
  }
}
