import SwiftUI

// MARK: - Element card

/// The small card beside a selected element: its name, role and source, one
/// "Add to chat", and the details behind "More".
struct LiveInspectElementCard: View {
  @ObservedObject var model: LiveInspectMarkupModel
  let element: LiveInspectElement

  @State private var showsMore = false

  var body: some View {
    let added = model.isAdded(element)
    VStack(alignment: .leading, spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text(element.displayTitle)
          .font(.headline)
          .lineLimit(2)
        if !element.displaySubtitle.isEmpty {
          Text(element.displaySubtitle)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        if let source = element.sourceLabel {
          Label {
            Text(source)
              .lineLimit(1)
              .truncationMode(.middle)
          } icon: {
            Image(systemName: "chevron.left.forwardslash.chevron.right")
          }
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.accentBright)
          .padding(.top, 3)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .combine)

      if showsMore {
        details
          .transition(.opacity)
      }

      HStack(spacing: 8) {
        Button {
          model.addSelectionToChat()
        } label: {
          ZStack {
            Label(added ? "Added" : "Add to chat", systemImage: added ? "checkmark" : "plus.bubble")
              .fontWeight(.semibold)
              .opacity(model.handingOff && !added ? 0 : 1)
            if model.handingOff && !added {
              ProgressView()
                .controlSize(.small)
            }
          }
          .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glassProminent)
        .disabled(added || model.handingOff)
        .accessibilityHint(added ? "" : "Puts this element and the picture into the chat's draft")
        .accessibilityIdentifier("LiveInspect.AddToChat")

        Button {
          withAnimation(.snappy(duration: 0.2)) { showsMore.toggle() }
        } label: {
          Image(systemName: "chevron.down")
            .rotationEffect(.degrees(showsMore ? 180 : 0))
            .frame(width: 18, height: 18)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .accessibilityLabel(showsMore ? "Fewer details" : "More details")
        .accessibilityIdentifier("LiveInspect.More")
      }
    }
    .padding(14)
    .glassEffect(LiveInspectLayout.overlayGlass, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("LiveInspect.Card")
  }

  private var details: some View {
    Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 6) {
      let frame = element.pointFrame ?? element.frame
      detailRow("Frame", "\(number(frame.x)), \(number(frame.y)) · \(number(frame.width)) × \(number(frame.height))")
      let ancestors = LiveInspectGeometry.ancestors(of: element, in: model.elements)
      if !ancestors.isEmpty {
        detailRow("Path", ancestors.prefix(3).map(\.displayTitle).reversed().joined(separator: " › "))
      }
      if let identifier = element.identifier?.liveInspectTrimmed {
        detailRow("ID", identifier)
      }
      if let component = element.componentId?.liveInspectTrimmed, component != element.identifier {
        detailRow("Component", component)
      }
      if element.sourceLabel != nil || element.sourceConfidence != nil {
        detailRow("Source", sourceConfidenceText)
      }
      if element.enabled == false {
        detailRow("State", "Disabled")
      }
    }
    .font(.caption)
  }

  private var sourceConfidenceText: String {
    switch element.sourceConfidence {
    case "exact": return "Exact match"
    case "candidate": return "Best guess"
    case .some(let other) where other != "none": return other.capitalized
    default: return element.sourceLabel == nil ? "No source match" : "Exact match"
    }
  }

  private func detailRow(_ title: String, _ value: String) -> some View {
    GridRow {
      Text(title)
        .foregroundStyle(.secondary)
        .gridColumnAlignment(.leading)
      Text(value)
        .monospacedDigit()
        .lineLimit(2)
        .truncationMode(.head)
    }
  }

  private func number(_ value: Double) -> String {
    value.formatted(.number.precision(.fractionLength(0...1)))
  }
}
