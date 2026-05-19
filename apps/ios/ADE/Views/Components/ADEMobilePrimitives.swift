import SwiftUI

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
      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        if let subtitle {
          Text(subtitle)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      content
    }
    .adeGlassCard(cornerRadius: 16, padding: 14)
  }
}

struct ADEGlassStatusBadge: View {
  let text: String
  let tint: Color

  var body: some View {
    Text(text)
      .font(.caption2.weight(.semibold))
      .foregroundStyle(tint)
      .padding(.horizontal, 7)
      .padding(.vertical, 3)
      .background(tint.opacity(0.12), in: Capsule())
      .glassEffect()
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
    .glassEffect()
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
      .padding(.vertical, 7)
      .background(tint.opacity(0.1), in: Capsule())
      .glassEffect()
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
          .fill(isSelected ? tint.opacity(0.13) : ADEColor.surfaceBackground.opacity(0.10))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(isSelected ? tint.opacity(0.55) : ADEColor.glassBorder, lineWidth: isSelected ? 1 : 0.5)
      )
      .glassEffect(in: .rect(cornerRadius: 12))
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
    .padding(.vertical, 7)
    .background((isPressing ? tint.opacity(0.18) : tint.opacity(0.1)), in: Capsule())
    .glassEffect()
    .overlay(
      Capsule()
        .stroke(tint.opacity(isPressing ? 0.36 : 0.14), lineWidth: 0.5)
    )
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

struct ADEQuickActionTile: View {
  let title: String
  let symbol: String
  let tint: Color
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(spacing: 4) {
        Image(systemName: symbol)
          .font(.system(size: 16, weight: .medium))
          .symbolRenderingMode(.hierarchical)
        Text(title)
          .font(.caption2.weight(.medium))
      }
      .foregroundStyle(tint)
      .frame(width: 64, height: 54)
      .background(ADEColor.surfaceBackground.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .glassEffect(in: .rect(cornerRadius: 12))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(ADEColor.border.opacity(0.16), lineWidth: 0.5)
      )
    }
    .buttonStyle(ADEScaleButtonStyle())
  }
}

struct ADEGlassMenuLabel: View {
  let title: String

  var body: some View {
    HStack(spacing: 4) {
      Text(title)
        .font(.caption.weight(.medium))
      Image(systemName: "chevron.down")
        .font(.system(size: 8, weight: .bold))
    }
    .foregroundStyle(ADEColor.textSecondary)
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .background(ADEColor.surfaceBackground.opacity(0.55), in: Capsule())
    .glassEffect()
    .overlay(
      Capsule()
        .stroke(ADEColor.border.opacity(0.16), lineWidth: 0.5)
    )
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
typealias LaneQuickAction = ADEQuickActionTile
typealias LaneMenuLabel = ADEGlassMenuLabel
