import SwiftUI

// MARK: - Agent list

/// The chats in one status across every project, as one card that fills the
/// room it is given and scrolls inside itself (a soft fade at the bottom while
/// more rows wait below). The filter row above names the status and its
/// count, so the card has no header of its own.
struct DuoAgentList: View {
  let filter: HubRosterFilter
  let items: [DuoNeedsYouItem]
  let onOpen: (DuoNeedsYouItem) -> Void

  var body: some View {
    return
    Group {
      if items.isEmpty {
        DuoHomeWidgetEmptyState(
          symbol: filter == .needsYou ? "checkmark.circle" : filter.systemImage,
          title: filter.emptyTitle,
          message: filter.emptyMessage,
          tint: filter == .needsYou ? ADEColor.success : (filter.tone.map(activityToneColor) ?? ADEColor.textMuted)
        )
      } else {
        DuoWidgetList {
          LazyVStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
              VStack(spacing: 0) {
                DuoWidgetChatRow(item: item) { onOpen(item) }
                if index < items.count - 1 {
                  Divider()
                    .padding(.leading, DuoWidgetRowMetrics.textInset)
                }
              }
            }
          }
          .padding(.top, 6)
        }
        // A new status starts at its top.
        .id(filter)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(ADEColor.cardBackground)
    .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
  }
}

/// A widget's scrolling body. While rows continue below the card's edge the
/// last visible one fades out instead of being cut mid-line; at the end of
/// the list (or when everything fits) nothing fades.
struct DuoWidgetList<Content: View>: View {
  @ViewBuilder var content: () -> Content
  @State private var hasMoreBelow = false

  var body: some View {
    ScrollView {
      content()
        .padding(.bottom, 6)
    }
    .scrollBounceBehavior(.basedOnSize)
    .scrollIndicators(.hidden)
    .onScrollGeometryChange(for: Bool.self) { geometry in
      geometry.contentOffset.y + geometry.containerSize.height < geometry.contentSize.height - 8
    } action: { _, more in
      hasMoreBelow = more
    }
    .mask {
      VStack(spacing: 0) {
        Rectangle()
        LinearGradient(
          colors: [.black, .black.opacity(hasMoreBelow ? 0 : 1)],
          startPoint: .top,
          endPoint: .bottom
        )
        .frame(height: 36)
      }
    }
  }
}

/// A widget with nothing to list: one calm line, centered in the card.
struct DuoHomeWidgetEmptyState: View {
  let symbol: String
  let title: String
  let message: String
  var tint: Color = ADEColor.success

  var body: some View {
    VStack(spacing: 6) {
      Image(systemName: symbol)
        .font(.title2)
        .foregroundStyle(tint)
      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Text(message)
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
    }
    .padding(.horizontal, 20)
    .padding(.bottom, 20)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .combine)
  }
}

// MARK: - Two pages

/// The Duo's page grammar for a screen with two parts: side by side held
/// landscape, stacked held portrait. A fold makes each part exactly one page;
/// flat, the parts split the screen evenly with a hairline seam.
struct DuoTwoPages<First: View, Second: View>: View {
  enum Arrangement {
    /// Side by side when wider than tall, stacked otherwise.
    case automatic
  }

  var fold: Arrangement = .automatic
  /// The share the first part takes when the screen is flat, 0…1.
  var flatShare: CGFloat = 0.5
  /// Keep the parts side by side when the screen is taller than wide, as long
  /// as it is not folded laptop or tent: upright and flat, the inner display
  /// (or an iPad) is the same two columns, just narrower.
  var sideBySideWhenUpright = false
  @ViewBuilder var first: () -> First
  @ViewBuilder var second: () -> Second

  var body: some View {
    DuoLocalFoldReader { fold, size, landscape in
      let sideBySide = landscape || (sideBySideWhenUpright && !fold.isStacked)
      switch fold {
      case .sideBySide(let rect) where sideBySide:
        let lead = max(0, min(rect.minX, size.width))
        HStack(spacing: 0) {
          first().frame(width: lead)
          DuoSeam(axis: .vertical, foldRect: rect)
            .ignoresSafeArea()
          second().frame(maxWidth: .infinity)
        }
      case .stacked(let rect) where !sideBySide:
        let top = max(0, min(rect.minY, size.height))
        VStack(spacing: 0) {
          first().frame(height: top)
          DuoSeam(axis: .horizontal, foldRect: rect)
            .ignoresSafeArea()
          second().frame(maxHeight: .infinity)
        }
      default:
        if sideBySide {
          HStack(spacing: 0) {
            first().frame(width: floor(size.width * flatShare))
            DuoSeam(axis: .vertical)
              .ignoresSafeArea()
            second().frame(maxWidth: .infinity)
          }
        } else {
          VStack(spacing: 0) {
            first().frame(height: floor(size.height * flatShare))
            DuoSeam(axis: .horizontal)
              .ignoresSafeArea()
            second().frame(maxHeight: .infinity)
          }
        }
      }
    }
  }
}

// MARK: - Overview list pieces (the CTO overview uses these too)

/// A section header in the overview's inset-grouped lists: the title, its
/// count, and one trailing text action, the way Apple's own lists do it.
struct DuoOverviewSectionHeader: View {
  let title: String
  var count: Int?
  var actionTitle: String?
  var action: () -> Void = {}

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text(title)
      if let count {
        Text("\(count)")
          .monospacedDigit()
          .foregroundStyle(.tertiary)
      }
      Spacer(minLength: 8)
      if let actionTitle {
        Button(actionTitle, action: action)
          .font(.subheadline)
          .textCase(nil)
          .buttonStyle(.borderless)
      }
    }
  }
}

struct DuoOverviewQuietRow: View {
  let symbol: String
  let title: String
  let detail: String

  var body: some View {
    Label {
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .foregroundStyle(ADEColor.textPrimary)
        Text(detail)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
      }
    } icon: {
      Image(systemName: symbol)
        .foregroundStyle(ADEColor.success)
    }
    .accessibilityElement(children: .combine)
  }
}

// MARK: - Widget rows (dense)

enum DuoWidgetRowMetrics {
  /// Where a row's text starts: the divider's leading inset.
  static let textInset: CGFloat = 44
}

/// One chat in the Needs you widget: the state glyph, the title (up to two lines),
/// project · lane under it, and how long ago. The glyph carries the state (a
/// red triangle is a failure); the row speaks the word. Taps open the chat.
struct DuoWidgetChatRow: View {
  let item: DuoNeedsYouItem
  let action: () -> Void

  private var context: String {
    let project = item.project.displayName
    guard let lane = item.lane?.name.trimmingCharacters(in: .whitespacesAndNewlines),
          !lane.isEmpty else { return project }
    return "\(project) · \(lane)"
  }

  var body: some View {
    Button(action: action) {
      HStack(spacing: 0) {
        HubStateGlyph(state: item.boardState, size: 12)
          .frame(width: DuoWidgetRowMetrics.textInset - 16, alignment: .center)
        VStack(alignment: .leading, spacing: 1) {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            // Two lines before it truncates: the column is narrow beside the
            // project grid (an iPad held portrait), and one line cut most
            // titles to a few words.
            Text(item.row.title)
              .font(.subheadline)
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(2)
              .frame(maxWidth: .infinity, alignment: .leading)
            if let activity = item.row.activityLabel {
              Text(activity)
                .font(.caption.monospacedDigit())
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(1)
                .fixedSize()
            }
          }
          Text(context)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
        }
      }
      .padding(.leading, 16)
      .padding(.trailing, 16)
      .padding(.vertical, 6)
      .contentShape(Rectangle())
    }
    .buttonStyle(DuoWidgetRowButtonStyle())
    .accessibilityLabel("\(item.row.title), \(item.stateLabel ?? "Needs you"), \(context)")
    .accessibilityHint("Opens the chat.")
  }
}

/// One machine in the Machines widget, on one line: its glyph and name, then
/// a status dot and either how many agents run there or its state word. This phone's machine
/// carries the checkmark. The full summary (projects too) is spoken.
struct DuoWidgetMachineRow: View {
  let machine: DuoHomeMachine
  let action: () -> Void

  /// The dot's colour already says the machine is up, so a machine with
  /// agents running says how many; otherwise its state word.
  private var shortStatus: String {
    machine.workingCount > 0 ? "\(machine.workingCount) working" : machine.statusWord
  }

  var body: some View {
    Button(action: action) {
      HStack(spacing: 0) {
        Image(systemName: machineSymbol(machineKey: machine.isFocused ? nil : machine.id, name: machine.name))
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(width: DuoWidgetRowMetrics.textInset - 16, alignment: .center)
        Text(machine.name)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        Spacer(minLength: 10)
        // A few words at most: it keeps its width and the name gives way.
        HStack(spacing: 5) {
          ADEKitDot(tone: machine.tone, size: 6)
          Text(shortStatus)
            .lineLimit(1)
        }
        .fixedSize()
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        Image(systemName: "checkmark")
          .font(.caption.weight(.bold))
          .foregroundStyle(ADEColor.accent)
          .frame(width: 22, alignment: .trailing)
          .opacity(machine.isFocused ? 1 : 0)
          .accessibilityHidden(true)
      }
      .padding(.horizontal, 16)
      .frame(minHeight: 40)
      .contentShape(Rectangle())
    }
    .buttonStyle(DuoWidgetRowButtonStyle())
    .accessibilityLabel(
      machine.isFocused
        ? "\(machine.name), this phone's machine, \(machine.summary)"
        : "\(machine.name), \(machine.summary)"
    )
    .accessibilityHint("Opens connection settings.")
  }
}

/// A widget row's pressed state: the row's own band, briefly tinted.
private struct DuoWidgetRowButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .background(Color.primary.opacity(configuration.isPressed ? 0.06 : 0))
  }
}
