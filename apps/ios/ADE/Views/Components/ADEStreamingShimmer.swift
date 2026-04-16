import SwiftUI

/// A subtle one-direction gradient sweep used to mark a "this is live" card
/// (e.g. the assistant bubble during a streaming turn). The sweep is an
/// overlay — call sites do not need to know its geometry, just what shape
/// to mask against. Guarded against Reduce Motion: when `reduceMotion` is
/// true, the modifier becomes a no-op so the underlying glow alone signals
/// liveness.
///
/// Port of the desktop `.ade-streaming-shimmer` treatment
/// (apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx:1228).
struct ADEStreamingShimmer: ViewModifier {
  let isActive: Bool
  let cornerRadius: CGFloat
  let tint: Color

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var sweepOffset: CGFloat = -1.1

  init(isActive: Bool, cornerRadius: CGFloat = 18, tint: Color = ADEColor.accent) {
    self.isActive = isActive
    self.cornerRadius = cornerRadius
    self.tint = tint
  }

  func body(content: Content) -> some View {
    content
      .overlay {
        if isActive && !reduceMotion {
          GeometryReader { proxy in
            LinearGradient(
              colors: [
                .clear,
                tint.opacity(0.22),
                .clear,
              ],
              startPoint: .leading,
              endPoint: .trailing
            )
            .frame(width: proxy.size.width * 0.7)
            .offset(x: proxy.size.width * sweepOffset)
            .blendMode(.plusLighter)
            .allowsHitTesting(false)
          }
          .mask(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
              .fill(.white)
          )
          .onAppear {
            withAnimation(.linear(duration: 2.1).repeatForever(autoreverses: false)) {
              sweepOffset = 1.1
            }
          }
        }
      }
      .overlay(
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .stroke(isActive ? tint.opacity(0.35) : Color.clear, lineWidth: isActive ? 0.9 : 0)
      )
      .shadow(color: isActive ? tint.opacity(0.22) : .clear, radius: isActive ? 12 : 0, y: 4)
  }
}

extension View {
  /// Applies the ADE streaming shimmer + accent glow overlay to this view.
  /// Intended for the active assistant bubble and the reasoning card's live
  /// state. Pass `isActive: false` to get a zero-cost no-op.
  func adeStreamingShimmer(
    isActive: Bool,
    cornerRadius: CGFloat = 18,
    tint: Color = ADEColor.accent
  ) -> some View {
    modifier(ADEStreamingShimmer(isActive: isActive, cornerRadius: cornerRadius, tint: tint))
  }
}
