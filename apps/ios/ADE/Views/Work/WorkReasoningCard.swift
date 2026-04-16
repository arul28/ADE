import SwiftUI

/// A dedicated reasoning surface for the Work chat timeline.
///
/// Mirrors the desktop "Thinking…" collapsible: while the turn is live the
/// header pulses and the body stays open; once the turn settles the card
/// collapses behind a "Reasoning" label so it stops competing with the final
/// assistant message for attention. Tap the header to toggle manually.
struct WorkReasoningCard: View {
  let card: WorkEventCardModel
  let isLive: Bool

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  // Default collapsed — reasoning is the model's scratchpad, not the answer.
  // The live turn still auto-expands via the onChange(of: isLive) handler
  // below so users can watch thoughts stream in real time.
  @State private var isExpanded: Bool = false

  private var bodyText: String? {
    guard let body = card.body else { return nil }
    let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private var headerTitle: String {
    isLive ? "Thinking" : "Reasoning"
  }

  private var headerTint: Color {
    isLive ? ADEColor.purpleAccent : ADEColor.textSecondary
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Button {
        withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
          isExpanded.toggle()
        }
      } label: {
        HStack(alignment: .center, spacing: 10) {
          Image(systemName: "brain.head.profile")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(headerTint)
            .symbolEffect(
              .pulse,
              options: .repeating,
              isActive: isLive && !reduceMotion
            )
            .frame(width: 22, height: 22)

          HStack(spacing: 6) {
            Text(headerTitle)
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
            if isLive {
              WorkThinkingDots()
                .frame(height: 6)
            }
          }

          Spacer(minLength: 8)

          Image(systemName: "chevron.down")
            .font(.caption2.weight(.bold))
            .foregroundStyle(ADEColor.textMuted)
            .rotationEffect(isExpanded ? .degrees(0) : .degrees(-90))
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(isLive ? "Reasoning in progress." : "Reasoning.") Tap to \(isExpanded ? "collapse" : "expand").")

      if isExpanded, let bodyText {
        Text(bodyText)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)
          .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .background(ADEColor.surfaceBackground.opacity(0.32), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(ADEColor.border.opacity(0.12), lineWidth: 0.5)
    )
    .onAppear {
      // Auto-expand while the turn is still thinking so the user can see
      // tokens land as they arrive.
      if isLive { isExpanded = true }
    }
    .onChange(of: isLive) { _, nowLive in
      withAnimation(ADEMotion.standard(reduceMotion: reduceMotion)) {
        isExpanded = nowLive
      }
    }
  }
}

/// Floating pill that appears when new messages arrive while the user has
/// scrolled up. Tap to jump back to the latest message and clear the unread
/// count. Hides itself when the count is zero.
struct WorkJumpToLatestPill: View {
  let count: Int
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Image(systemName: "arrow.down")
          .font(.caption.weight(.bold))
        Text("\(count) new")
          .font(.caption.weight(.semibold))
      }
      .foregroundStyle(Color.white)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(ADEColor.accent, in: Capsule())
      .shadow(color: ADEColor.purpleGlow, radius: 10, y: 2)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(count) new message\(count == 1 ? "" : "s"). Tap to scroll to latest.")
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
