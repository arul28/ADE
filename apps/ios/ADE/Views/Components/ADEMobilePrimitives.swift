import SwiftUI

/// A titled section in one kit card: semibold title, at most one hint line,
/// then the content. (Kept under its old name for the Work tool sheets.)
struct ADEGlassSection<Content: View>: View {
  let title: String
  let subtitle: String?
  let content: Content

  init(title: String, subtitle: String? = nil, @ViewBuilder content: () -> Content) {
    self.title = title
    self.subtitle = subtitle
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        if let subtitle {
          Text(subtitle)
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
        }
      }
      content
    }
    .adeKitCard()
  }
}

struct ADEGlassStatusBadge: View {
  let text: String
  let tint: Color

  var body: some View {
    // Flat, like the kit tag: a tinted label, no glass.
    Text(text)
      .font(.system(size: 11, weight: .semibold))
      .foregroundStyle(tint)
      .padding(.horizontal, 6)
      .frame(minHeight: 18)
      .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
      .lineLimit(1)
  }
}

struct ADEGlassChip: View {
  let icon: String
  let text: String?
  let tint: Color

  var body: some View {
    HStack(spacing: 3) {
      Image(systemName: icon)
        .font(.system(size: 8, weight: .semibold))
      if let text {
        Text(text)
          .font(.system(.caption2).weight(.medium))
      }
    }
    .foregroundStyle(tint)
    .padding(.horizontal, 6)
    .padding(.vertical, 3)
    .background(tint.opacity(0.1), in: Capsule())
  }
}

struct ADEGlassActionButton: View {
  let title: String
  let symbol: String
  let tint: Color
  let action: () -> Void

  init(title: String, symbol: String, tint: Color = ADEColor.textSecondary, action: @escaping () -> Void) {
    self.title = title
    self.symbol = symbol
    self.tint = tint
    self.action = action
  }

  var body: some View {
    Button(action: action) {
      HStack(spacing: 5) {
        Image(systemName: symbol)
          .font(.system(size: 11, weight: .semibold))
        Text(title)
          .font(.caption.weight(.medium))
      }
      .foregroundStyle(tint)
      .padding(.horizontal, 10)
      .frame(minHeight: 30)
      // The kit pill: a neutral track, or a light wash of a meaningful tint.
      .background(tint == ADEColor.textSecondary ? ADEKit.track : tint.opacity(0.12), in: Capsule())
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
  }
}

struct ADEOptionButton: View {
  let title: String
  var subtitle: String? = nil
  var systemImage: String? = nil
  let isSelected: Bool
  var tint: Color = ADEColor.accent
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(alignment: .center, spacing: 10) {
        if let systemImage {
          Image(systemName: systemImage)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(isSelected ? tint : ADEColor.textSecondary)
            .frame(width: 20)
        }
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)
            .multilineTextAlignment(.leading)
          if let subtitle, !subtitle.isEmpty {
            Text(subtitle)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(2)
              .multilineTextAlignment(.leading)
          }
        }
        Spacer(minLength: 0)
        if isSelected {
          Image(systemName: "checkmark.circle.fill")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(tint)
        }
      }
      .padding(12)
      .frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(isSelected ? tint.opacity(0.08) : Color.clear)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .strokeBorder(isSelected ? tint.opacity(0.45) : ADEKit.edge, lineWidth: 0.75)
      )
    }
    .buttonStyle(ADEScaleButtonStyle())
    .accessibilityLabel(subtitle.map { "\(title). \($0)" } ?? title)
    .accessibilityValue(isSelected ? "Selected" : "")
  }
}

struct ADEGlassHoldActionButton: View {
  let title: String
  let symbol: String
  let tint: Color
  let holdHint: String
  let minimumDuration: Double
  let action: () -> Void

  @State private var isPressing = false

  init(
    title: String,
    symbol: String,
    tint: Color = ADEColor.danger,
    holdHint: String = "Hold to confirm",
    minimumDuration: Double = 0.5,
    action: @escaping () -> Void
  ) {
    self.title = title
    self.symbol = symbol
    self.tint = tint
    self.holdHint = holdHint
    self.minimumDuration = minimumDuration
    self.action = action
  }

  var body: some View {
    HStack(spacing: 5) {
      Image(systemName: symbol)
        .font(.system(size: 11, weight: .semibold))
      Text(isPressing ? holdHint : title)
        .font(.caption.weight(.medium))
    }
    .foregroundStyle(tint)
    .padding(.horizontal, 10)
    .frame(minHeight: 30)
    .background((isPressing ? tint.opacity(0.2) : tint.opacity(0.12)), in: Capsule())
    .contentShape(Capsule())
    .onLongPressGesture(
      minimumDuration: minimumDuration,
      maximumDistance: 24,
      pressing: { pressing in
        withAnimation(.easeOut(duration: 0.15)) {
          isPressing = pressing
        }
      },
      perform: action
    )
    .accessibilityLabel("\(title). Hold to confirm.")
  }
}

struct ADEMatchedTransitionScope {
  enum Element: String {
    case container
    case icon
    case title
    case status
  }

  let namespace: Namespace.ID?
  let stem: String

  init(namespace: Namespace.ID?, stem: String) {
    self.namespace = namespace
    self.stem = stem
  }

  func id(_ element: Element) -> String? {
    guard namespace != nil else { return nil }
    return "\(stem)-\(element.rawValue)"
  }
}

extension View {
  func adeMatchedNavigationElement(_ element: ADEMatchedTransitionScope.Element, scope: ADEMatchedTransitionScope?) -> some View {
    adeMatchedGeometry(id: scope?.id(element), in: scope?.namespace)
  }

  func adeMatchedNavigationSource(scope: ADEMatchedTransitionScope?) -> some View {
    adeMatchedTransitionSource(id: scope?.id(.container), in: scope?.namespace)
  }

  func adeNavigationZoomTransition(scope: ADEMatchedTransitionScope?) -> some View {
    adeNavigationZoomTransition(id: scope?.id(.container), in: scope?.namespace)
  }
}

typealias GlassSection = ADEGlassSection
typealias LaneTypeBadge = ADEGlassStatusBadge
typealias LaneMicroChip = ADEGlassChip
typealias LaneActionButton = ADEGlassActionButton
typealias LaneHoldToConfirmButton = ADEGlassHoldActionButton
