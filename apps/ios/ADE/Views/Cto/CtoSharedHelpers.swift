import SwiftUI

// MARK: - Status tint

/// Map a raw worker/session status string to a foreground tint. Centralized so
/// the CTO shell, Team grid, and Worker detail screen all agree on color.
func ctoStatusTint(_ status: String) -> Color {
  switch status.lowercased() {
  case "running":
    return ctoStatusRunningBlue
  case "active", "ready":
    return ADEColor.success
  case "idle":
    return ADEColor.textMuted
  case "paused", "waiting", "awaiting-input", "queued":
    return ADEColor.warning
  case "failed", "error":
    return ADEColor.danger
  default:
    return ADEColor.textMuted
  }
}

/// Running status blue (#60A5FA) — the mockups use a distinct blue for "running"
/// separate from the green "active" success tint. Kept local to avoid touching
/// ADEDesignSystem.swift (owned by the wiring phase).
let ctoStatusRunningBlue = Color(red: 0x60 / 255.0, green: 0xA5 / 255.0, blue: 0xFA / 255.0)

// MARK: - Avatar palette

let ctoAvatarPalette: [Color] = [
  ADEColor.ctoAccent,
  ADEColor.tintMissions,
  ADEColor.tintLanes,
  ADEColor.tintWork,
  ADEColor.tintHistory,
  ADEColor.tintAutomations,
  ADEColor.tintGraph,
]

/// Deterministic palette index for a worker's seed/name. Uses FNV-1a over the
/// basis' unicode scalars so the same input always maps to the same color —
/// `String.hashValue` is randomized per-process and would drift between launches.
func ctoAvatarPaletteIndex(for basis: String, paletteSize: Int) -> Int {
  guard paletteSize > 0 else { return 0 }
  var hash: UInt32 = 2166136261
  for scalar in basis.unicodeScalars {
    hash ^= scalar.value
    hash = hash &* 16777619
  }
  return Int(hash % UInt32(paletteSize))
}

/// Resolve the avatar tint for a name / optional seed pair using the shared palette.
func ctoAvatarTint(name: String, seed: String?) -> Color {
  let basis = (seed?.isEmpty == false ? seed! : name)
  let trimmed = basis.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return ADEColor.textMuted }
  return ctoAvatarPalette[ctoAvatarPaletteIndex(for: trimmed, paletteSize: ctoAvatarPalette.count)]
}

/// First-letter glyph for a name, uppercased; returns "?" when the name is empty.
func ctoAvatarInitial(for name: String) -> String {
  let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
  guard let scalar = trimmed.first else { return "?" }
  return String(scalar).uppercased()
}

// MARK: - Avatar view

/// Circular initial-avatar used by the Chat agent pills and the worker rows.
struct CtoWorkerAvatar: View {
  let name: String
  let seed: String?

  var body: some View {
    let tint = ctoAvatarTint(name: name, seed: seed)
    ZStack {
      Circle()
        .fill(tint.opacity(0.18))
      Circle()
        .stroke(tint.opacity(0.35), lineWidth: 0.8)
      Text(ctoAvatarInitial(for: name))
        .font(.subheadline.weight(.bold))
        .foregroundStyle(tint)
    }
    .frame(width: 40, height: 40)
    .accessibilityHidden(true)
  }
}

// MARK: - Currency helpers

/// Format integer cents as `$X.XX`. Used widely by Team/Worker-detail budget UI.
func ctoFormatCents(_ cents: Int) -> String {
  let dollars = Double(cents) / 100.0
  return String(format: "$%.2f", dollars)
}

/// Percent of spent/cap as an Int in [0, 100], clamped. Returns nil when cap is
/// nil or non-positive — callers should hide the bar in that case.
func ctoBudgetPercent(spentCents: Int, capCents: Int?) -> Int? {
  guard let cap = capCents, cap > 0 else { return nil }
  let pct = Double(spentCents) / Double(cap) * 100.0
  return Int(max(0, min(100, pct.rounded())))
}

// MARK: - Relative time

/// Convert an ISO-8601 timestamp to a short relative string ("2m", "1h", "3d",
/// "now") matching the mockups. Returns an em-dash when parsing fails.
func ctoRelativeAgo(from iso: String, now: Date = Date()) -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  var parsed = formatter.date(from: iso)
  if parsed == nil {
    formatter.formatOptions = [.withInternetDateTime]
    parsed = formatter.date(from: iso)
  }
  guard let past = parsed else { return "—" }
  let seconds = max(0, now.timeIntervalSince(past))
  if seconds < 45 { return "now" }
  if seconds < 3600 { return "\(Int(seconds / 60))m" }
  if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
  if seconds < 86_400 * 14 { return "\(Int(seconds / 86_400))d" }
  if seconds < 86_400 * 60 { return "\(Int(seconds / (86_400 * 7)))w" }
  return "\(Int(seconds / (86_400 * 30)))mo"
}

// MARK: - Section header

/// Small section header ("ACTIVITY · last 7 days") used across CTO surfaces.
struct CtoSectionHeader: View {
  let title: String
  var trailing: String? = nil

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(title)
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
        .textCase(.uppercase)
        .tracking(0.4)
      Spacer(minLength: 0)
      if let trailing, !trailing.isEmpty {
        Text(trailing)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(.horizontal, 4)
  }
}
