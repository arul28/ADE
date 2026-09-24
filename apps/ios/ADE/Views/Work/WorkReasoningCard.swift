import SwiftUI

/// A dedicated reasoning surface for the Work chat timeline.
///
/// Collapsed state mirrors desktop's compact "Thought" pill: caret + label only,
/// with the reasoning body hidden until the user expands. While the turn is
/// live the header reads "Thinking"; once finished it reads "Thought".
struct WorkReasoningCard: View {
  let card: WorkEventCardModel
  let isLive: Bool
  // Default collapsed — reasoning is the model's scratchpad, not the answer.
  // We no longer auto-expand while live: thoughts should not fill the view
  // unless the user explicitly opts in by tapping the pill. Expansion is owned
  // by the session's central set so it survives list recycling.
  let isExpanded: Bool
  let onToggle: () -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var bodyText: String? {
    guard let body = card.body else { return nil }
    let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private var headerTitle: String {
    isLive ? "Thinking" : "Thought"
  }

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      VStack(alignment: .leading, spacing: 6) {
        compactPill
        if isExpanded, let bodyText {
          Text(bodyText)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(ADEColor.recessedBackground.opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(ADEColor.glassBorder, lineWidth: 1)
            )
            .transition(.opacity.combined(with: .move(edge: .top)))
        }
      }
      Spacer(minLength: 0)
    }
  }

  /// Single collapsed one-liner: caret + "Thinking"/"Thought" only. The body
  /// stays hidden until expand — no preview line, no brain icon.
  private var compactPill: some View {
    Button {
      withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
        onToggle()
      }
    } label: {
      HStack(spacing: 6) {
        Image(systemName: "chevron.right")
          .font(.system(size: 11, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
          .rotationEffect(isExpanded ? .degrees(90) : .degrees(0))
        Text(headerTitle)
          .font(.caption.weight(.medium))
          .foregroundStyle(isLive ? ADEColor.textSecondary : ADEColor.textMuted)
      }
      .padding(.vertical, 2)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(isLive ? "Reasoning in progress." : "Reasoning.") Tap to \(isExpanded ? "collapse" : "expand").")
  }
}

/// Floating pill that appears when new messages arrive while the user has
/// scrolled up. Tap to jump back to the latest message and clear the unread
/// count. Hides itself when the count is zero.
/// Round glass "jump to latest" button: a down arrow and nothing else. It sits
/// at the right end of the badge-chip line, just above the composer. New
/// messages below the reader add a small accent dot, and the count goes to
/// VoiceOver.
struct WorkJumpToLatestPill: View {
  let count: Int
  let action: () -> Void

  static let diameter: CGFloat = workChatComposerChipRowHeight

  var body: some View {
    Button(action: action) {
      WorkChatGlassCircleLabel(
        systemName: "arrow.down",
        size: Self.diameter,
        glyphSize: 13,
        tint: ADEColor.textPrimary
      )
      .overlay(alignment: .topTrailing) {
        if count > 0 {
          Circle()
            .fill(ADEColor.accent)
            .frame(width: 8, height: 8)
            .offset(x: -1, y: 1)
        }
      }
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("Work.Chat.JumpToLatest")
    .accessibilityLabel(count > 0
      ? "\(count) new message\(count == 1 ? "" : "s"). Tap to scroll to latest."
      : "Jump to latest message.")
  }
}

/// Three staggered pulsing dots used next to the "Thinking" label when a turn
/// is actively streaming. Falls back to three static dots under reduce-motion.
struct WorkThinkingDots: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var phase: Int = 0

  var body: some View {
    HStack(spacing: 4) {
      ForEach(0..<3, id: \.self) { index in
        Circle()
          .fill(ADEColor.purpleAccent)
          .frame(width: 5, height: 5)
          .opacity(reduceMotion ? 0.85 : (phase == index ? 1.0 : 0.35))
          .scaleEffect(reduceMotion ? 1.0 : (phase == index ? 1.15 : 1.0))
      }
    }
    .animation(.easeInOut(duration: 0.25), value: phase)
    .task {
      guard !reduceMotion else { return }
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 260_000_000)
        phase = (phase + 1) % 3
      }
    }
    .accessibilityHidden(true)
  }
}
