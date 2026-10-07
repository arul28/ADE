import SwiftUI

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
