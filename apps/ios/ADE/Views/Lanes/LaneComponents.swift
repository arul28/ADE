import SwiftUI

// MARK: - Open chip

struct LaneOpenChip: View {
  let snapshot: LaneListSnapshot
  let isPinned: Bool

  var body: some View {
    let laneTint = laneSurfaceTint(forHex: snapshot.lane.color)
    let laneAccent = laneTint.text ?? ADEColor.textPrimary
    HStack(spacing: 6) {
      WorkLaneLogoMark(color: laneAccent, laneIcon: snapshot.lane.icon, size: 10)
      Text(snapshot.lane.name)
        .font(.caption.weight(.medium))
        .foregroundStyle(laneAccent)
        .lineLimit(1)
      if isPinned {
        Image(systemName: "pin.fill")
          .font(.system(size: 8))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(.horizontal, 11)
    .frame(minHeight: 32)
    // A quiet kit pill: the lane's colour stays on its mark and name.
    .adeKitPill()
    .accessibilityLabel("\(snapshot.lane.name)\(isPinned ? ", pinned" : "")")
  }
}

// MARK: - Linear issue

struct LaneLinearIssueBadge: View {
  @Environment(\.openURL) private var openURL

  let issue: LaneLinearIssue
  var compact = false

  var body: some View {
    Button {
      if let urlString = issue.url,
         let url = URL(string: urlString),
         url.scheme == "http" || url.scheme == "https" {
        openURL(url)
      }
    } label: {
      HStack(spacing: 6) {
        Image(systemName: "link")
          .font(.system(size: compact ? 9 : 11, weight: .bold))
        Text(issue.identifier)
          .font(.caption2.monospaced().weight(.bold))
          .lineLimit(1)
        if !compact {
          Text(issue.title)
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .truncationMode(.tail)
        }
        if let state = issue.stateName, !state.isEmpty, !compact {
          Text(state)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
      }
      .foregroundStyle(ADEColor.textSecondary)
      .padding(.horizontal, compact ? 6 : 9)
      .frame(minHeight: compact ? 18 : 28)
      .background(ADEKit.track, in: RoundedRectangle(cornerRadius: compact ? 5 : 8, style: .continuous))
    }
    .buttonStyle(.plain)
    .disabled(issue.url?.isEmpty ?? true)
    .accessibilityLabel("\(issue.identifier): \(issue.title)")
  }
}

// MARK: - Option button

struct LaneOptionButton: View {
  let title: String
  var subtitle: String? = nil
  var systemImage: String? = nil
  let isSelected: Bool
  var tint: Color = ADEColor.accent
  let action: () -> Void

  var body: some View {
    ADEOptionButton(
      title: title,
      subtitle: subtitle,
      systemImage: systemImage,
      isSelected: isSelected,
      tint: tint,
      action: action
    )
  }
}

// MARK: - Info row

struct LaneInfoRow: View {
  let label: String
  let value: String
  var isMonospaced = false

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Text(label)
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
        .frame(width: 54, alignment: .leading)
      Text(value)
        .font(isMonospaced ? .system(.caption, design: .monospaced) : .subheadline)
        .foregroundStyle(ADEColor.textPrimary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

// MARK: - Text field

struct LaneTextField: View {
  let title: String
  @Binding var text: String

  init(_ title: String, text: Binding<String>) {
    self.title = title
    self._text = text
  }

  var body: some View {
    TextField(title, text: $text)
      .textFieldStyle(.plain)
      .foregroundStyle(ADEColor.textPrimary)
      .textInputAutocapitalization(title.localizedCaseInsensitiveContains("path") ? .never : .sentences)
      .autocorrectionDisabled(title.localizedCaseInsensitiveContains("path"))
      .submitLabel(.done)
      .padding(.horizontal, 12)
      .frame(minHeight: 44, maxHeight: 56, alignment: .center)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
      .accessibilityLabel(title)
  }
}

// MARK: - Scale button style

struct ADEScaleButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed ? 0.97 : 1.0)
      .opacity(configuration.isPressed ? 0.85 : 1.0)
      .animation(.snappy(duration: 0.2), value: configuration.isPressed)
  }
}

func laneStackCardAccessibilityLabel(
  snapshot: LaneListSnapshot,
  isPinned: Bool,
  isOpen: Bool,
  pullRequest: LanePrTag? = nil
) -> String {
  var parts = [snapshot.lane.name, normalizedPrBranchName(snapshot.lane.branchRef)]
  if snapshot.lane.laneType == "primary" { parts.append("primary") }
  if snapshot.lane.archivedAt != nil { parts.append("archived") }
  if snapshot.lane.status.dirty { parts.append("dirty") }
  if isPinned { parts.append("pinned") }
  if isOpen { parts.append("open") }
  if snapshot.lane.status.ahead > 0 { parts.append("\(snapshot.lane.status.ahead) ahead") }
  if snapshot.lane.status.behind > 0 { parts.append("\(snapshot.lane.status.behind) behind") }
  if let pullRequest { parts.append(formatLanePrBadgeLabel(pullRequest)) }
  return parts.joined(separator: ", ")
}

// MARK: - PR tag

struct LanePrTagChip: View {
  let tag: LanePrTag

  var body: some View {
    let tint = lanePullRequestTint(tag.state)
    HStack(spacing: 4) {
      Image(systemName: "arrow.triangle.pull")
        .font(.system(size: 9, weight: .bold))
      Text(formatLanePrBadgeLabel(tag))
        .font(.caption2.monospaced().weight(.bold))
        .lineLimit(1)
      if let stack = tag.stack {
        GitHubStackPositionBadge(stack: stack, compact: true)
      }
    }
    .foregroundStyle(tint)
    .padding(.horizontal, 6)
    .frame(minHeight: 18)
    .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
    .accessibilityLabel(
      tag.stack.map {
        "\(formatLanePrBadgeLabel(tag)), GitHub Stack \($0.position) of \($0.size)"
      } ?? formatLanePrBadgeLabel(tag)
    )
  }
}

// MARK: - Stack card

/// The machine a lane lives on, shown on its row when the list spans more
/// than one machine (the desktop's rule: chips only with two or more).
struct LaneMachineChip: Equatable {
  let name: String
  /// False for a machine the phone has no live link to: its rows are the last
  /// roster it sent, dimmed, with no actions.
  let isLive: Bool
  /// SF Symbol from `machineSymbol(machineKey:name:)`.
  var symbol: String = "desktopcomputer"
}

/// The chip of every lane in a list that spans machines, by lane id.
struct LaneMachineChips: Equatable {
  var focused: LaneMachineChip?
  var byMachineKey: [String: LaneMachineChip] = [:]

  static let none = LaneMachineChips(focused: nil)

  /// Nil when the list shows one machine only.
  func chip(forLaneId laneId: String) -> LaneMachineChip? {
    guard !byMachineKey.isEmpty else { return nil }
    if let remote = workParseRemoteLaneId(laneId) { return byMachineKey[remote.machineKey] }
    return focused
  }
}

struct LaneStackCard: View, Equatable {
  let snapshot: LaneListSnapshot
  let isPinned: Bool
  let isOpen: Bool
  let depth: Int
  var pullRequest: LanePrTag? = nil
  var transitionNamespace: Namespace.ID? = nil
  var isSelectedTransitionSource = false
  var machine: LaneMachineChip? = nil
  /// The machine chip in the detail line. The machine still dims a row that
  /// is not live when the chip is hidden.
  var showsMachineChip = true

  static func == (lhs: LaneStackCard, rhs: LaneStackCard) -> Bool {
    lhs.renderSignature == rhs.renderSignature
  }

  /// Cheap render-relevant equality key (mirrors the Hub row-signature pattern in
  /// `HubComponents.swift`): hashes only the fields this card actually draws, so a
  /// legitimate lanes update re-renders only rows whose visible state changed, and
  /// the `.equatable()` diff is one `Int` compare instead of a deep
  /// `LaneListSnapshot` compare that also over-invalidates on non-rendered fields.
  fileprivate var renderSignature: Int {
    laneStackCardRenderSignature(
      snapshot: snapshot,
      isPinned: isPinned,
      isOpen: isOpen,
      depth: depth,
      pullRequest: pullRequest,
      isSelectedTransitionSource: isSelectedTransitionSource,
      machine: showsMachineChip ? machine : machine.map { LaneMachineChip(name: "", isLive: $0.isLive, symbol: $0.symbol) }
    )
  }

  /// One row of the lanes panel (`.kit-row`), text first, with a lane's own
  /// marks: the lane glyph and name in the lane's colour, the branch line
  /// below, and the lane's live chats as one status mark on the trailing edge
  /// (the desktop lane sidebar row).
  var body: some View {
    HStack(alignment: .center, spacing: 11) {
      laneGlyphTile
      VStack(alignment: .leading, spacing: 4) {
        HStack(alignment: .center, spacing: 6) {
          Text(snapshot.lane.name)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(laneLabelColor)
            .lineLimit(1)
            .truncationMode(.tail)
            .adeMatchedGeometry(id: isSelectedTransitionSource ? "lane-title-\(snapshot.lane.id)" : nil, in: transitionNamespace)
          laneTypeBadge
          if isPinned {
            Image(systemName: "pin.fill")
              .font(.system(size: 9, weight: .semibold))
              .foregroundStyle(ADEColor.textMuted)
          }
          Spacer(minLength: 4)
          if let devices = snapshot.lane.devicesOpen, !devices.isEmpty {
            Image(systemName: devicePresenceSymbol(for: devices))
              .font(.caption2.weight(.semibold))
              .foregroundStyle(ADEColor.textMuted)
              .accessibilityLabel("Open on \(devices.count) other device\(devices.count == 1 ? "" : "s")")
          }
          runtimeMark
        }
        detailLine
      }
    }
    .padding(.leading, ADEKit.inset)
    .padding(.trailing, 12)
    .padding(.vertical, 11)
    .frame(maxWidth: .infinity, alignment: .leading)
    .overlay(alignment: .leading) {
      // An open lane (in the tray above) keeps a thin bar in its colour.
      if isOpen {
        Capsule()
          .fill(laneTint.accentBar)
          .frame(width: 3)
          .padding(.vertical, 10)
          .padding(.leading, 4)
      }
    }
    .contentShape(Rectangle())
    .adeMatchedTransitionSource(id: isSelectedTransitionSource ? "lane-container-\(snapshot.lane.id)" : nil, in: transitionNamespace)
    .opacity(machine?.isLive == false ? 0.5 : 1)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(stackCardAccessibilityLabel)
  }

  private var laneGlyphTile: some View {
    WorkLaneLogoMark(color: laneLabelColor, laneIcon: snapshot.lane.icon, size: 15)
      .frame(width: 20, height: 20)
      .adeMatchedGeometry(id: isSelectedTransitionSource ? "lane-icon-\(snapshot.lane.id)" : nil, in: transitionNamespace)
  }

  /// The lane's chats as one mark: amber when one waits for you, the working
  /// ring with a count while chats run, nothing when the lane is quiet.
  @ViewBuilder
  private var runtimeMark: some View {
    if snapshot.runtime.awaitingInputCount > 0 {
      HStack(spacing: 3) {
        Circle()
          .fill(ADEColor.warning)
          .frame(width: 7, height: 7)
        Text("\(snapshot.runtime.awaitingInputCount)")
          .font(.caption2.weight(.semibold).monospacedDigit())
          .foregroundStyle(ADEColor.warning)
      }
      .accessibilityLabel("\(snapshot.runtime.awaitingInputCount) waiting for you")
    } else if snapshot.runtime.runningCount > 0 {
      HStack(spacing: 3) {
        Image(systemName: "circle.dashed")
          .font(.system(size: 11, weight: .bold))
          .foregroundStyle(Color.cyan)
        Text("\(snapshot.runtime.runningCount)")
          .font(.caption2.weight(.semibold).monospacedDigit())
          .foregroundStyle(ADEColor.textSecondary)
      }
      .accessibilityLabel("\(snapshot.runtime.runningCount) running")
    }
  }

  /// Muted facts about the lane: where it lives, its branch, its PR and git
  /// state. Nothing is drawn for a clean, level lane.
  private var detailLine: some View {
    HStack(spacing: 6) {
      if let machine, showsMachineChip {
        HStack(spacing: 3) {
          Image(systemName: machine.symbol)
            .font(.system(size: 9, weight: .semibold))
          Text(machine.isLive ? machine.name : "\(machine.name) · Not live")
            .font(.caption2.weight(.semibold))
            .lineLimit(1)
        }
        .foregroundStyle(ADEColor.textSecondary)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(ADEKit.track, in: Capsule(style: .continuous))
        .fixedSize()
      }
      HStack(spacing: 3) {
        Image(systemName: "arrow.triangle.branch")
          .font(.system(size: 9, weight: .regular))
          .foregroundStyle(ADEColor.textMuted.opacity(0.8))
        Text(normalizedPrBranchName(snapshot.lane.branchRef))
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      .frame(minWidth: 0, alignment: .leading)
      .layoutPriority(-1)
      if let pullRequest {
        LanePrTagChip(tag: pullRequest)
          .fixedSize()
      }
      gitState
    }
  }

  @ViewBuilder
  private var gitState: some View {
    let status = snapshot.lane.status
    let linkedIssue = primaryLaneLinearIssue(for: snapshot.lane)?.identifier
    if status.dirty || status.ahead > 0 || status.behind > 0 || snapshot.lane.childCount > 0 || linkedIssue != nil {
      HStack(spacing: 5) {
        if status.dirty {
          Circle()
            .fill(ADEColor.warning.opacity(0.85))
            .frame(width: 5, height: 5)
        }
        if status.ahead > 0 {
          laneCount(symbol: "arrow.up", count: status.ahead)
        }
        if status.behind > 0 {
          laneCount(symbol: "arrow.down", count: status.behind)
        }
        if snapshot.lane.childCount > 0 {
          laneCount(symbol: "square.stack.3d.up", count: snapshot.lane.childCount)
        }
        if let linkedIssue {
          Text(linkedIssue)
            .font(.caption2.monospaced().weight(.semibold))
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      .foregroundStyle(ADEColor.textMuted)
      .fixedSize()
    }
  }

  private func laneCount(symbol: String, count: Int) -> some View {
    HStack(spacing: 1) {
      Image(systemName: symbol)
        .font(.caption2.weight(.bold))
      Text("\(count)")
        .font(.caption2.monospacedDigit())
    }
  }

  private var laneTint: LaneSurfaceTint {
    laneSurfaceTint(forHex: snapshot.lane.color)
  }

  private var laneLabelColor: Color {
    laneTint.text ?? ADEColor.textPrimary
  }

  @ViewBuilder
  private var laneTypeBadge: some View {
    if snapshot.lane.archivedAt != nil {
      ADEKitTag(text: "Archived")
    } else if snapshot.lane.laneType == "primary",
              snapshot.lane.name.trimmingCharacters(in: .whitespaces).caseInsensitiveCompare("primary") != .orderedSame {
      // A primary lane named "Primary" already says so.
      ADEKitTag(text: "Primary")
    } else {
      EmptyView()
    }
  }

  private var stackCardAccessibilityLabel: String {
    let label = laneStackCardAccessibilityLabel(
      snapshot: snapshot,
      isPinned: isPinned,
      isOpen: isOpen,
      pullRequest: pullRequest
    )
    guard let machine else { return label }
    return "\(label), on \(machine.name)\(machine.isLive ? "" : ", not live")"
  }
}

/// Render-relevant signature for a `LaneStackCard` row. Combine only the fields
/// the card draws; adding a field here is required whenever the card starts
/// rendering something new, or that change will not trigger a re-render.
func laneStackCardRenderSignature(
  snapshot: LaneListSnapshot,
  isPinned: Bool,
  isOpen: Bool,
  depth: Int,
  pullRequest: LanePrTag?,
  isSelectedTransitionSource: Bool,
  machine: LaneMachineChip? = nil
) -> Int {
  var hasher = Hasher()
  hasher.combine(machine?.name)
  hasher.combine(machine?.isLive)
  let lane = snapshot.lane
  hasher.combine(lane.id)
  hasher.combine(lane.name)
  hasher.combine(lane.color)
  hasher.combine(lane.icon?.rawValue)
  hasher.combine(lane.laneType)
  hasher.combine(lane.archivedAt)
  hasher.combine(lane.branchRef)
  hasher.combine(lane.status.dirty)
  hasher.combine(lane.status.ahead)
  hasher.combine(lane.status.behind)
  hasher.combine(lane.childCount)
  // The trailing status mark reads the lane's live chats.
  hasher.combine(snapshot.runtime.awaitingInputCount)
  hasher.combine(snapshot.runtime.runningCount)
  // The card's presence icon derives from device PLATFORMS, not just how many
  // devices are open — hash the sorted platform list so swapping a mac peer
  // for an iPhone (same count) still re-renders the row.
  hasher.combine((lane.devicesOpen ?? []).map(\.platform).sorted())
  hasher.combine(primaryLaneLinearIssue(for: lane)?.identifier)
  hasher.combine(laneLinearIssueLinkCount(for: lane))
  hasher.combine(isPinned)
  hasher.combine(isOpen)
  hasher.combine(depth)
  hasher.combine(isSelectedTransitionSource)
  if let pullRequest {
    hasher.combine(pullRequest.githubPrNumber)
    hasher.combine(pullRequest.state)
  } else {
    hasher.combine(0)
  }
  return hasher.finalize()
}

// MARK: - Form section

/// A section of a Lanes sheet: the kit section title and one hint line, then
/// its controls on one kit card (desktop `ModernSection` over a `.kit-card`).
struct LaneFormSection<Content: View>: View {
  let title: String
  var subtitle: String?
  @ViewBuilder var content: () -> Content

  init(title: String, subtitle: String? = nil, @ViewBuilder content: @escaping () -> Content) {
    self.title = title
    self.subtitle = subtitle
    self.content = content
  }

  var body: some View {
    ADESettingsSection(title, hint: subtitle) {
      VStack(alignment: .leading, spacing: 10) {
        content()
      }
      .adeKitCard(padding: 12)
    }
  }
}

// MARK: - Choice rows

/// One pickable row inside a Lanes form card: neutral icon, title, an
/// optional mono detail, and the accent checkmark on the selected one.
struct LaneChoiceRow: View {
  let title: String
  var subtitle: String?
  var systemImage: String?
  /// Mono for refs and paths; prose details pass false.
  var monoSubtitle = true
  let isSelected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        if let systemImage {
          Image(systemName: systemImage)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 18)
        }
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.system(size: 14.5, weight: isSelected ? .semibold : .regular))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
            .truncationMode(.middle)
          if let subtitle, !subtitle.isEmpty {
            Text(subtitle)
              .font(monoSubtitle ? .adeMono(11) : .system(size: 12.5))
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(monoSubtitle ? 1 : 2)
              .truncationMode(.middle)
          }
        }
        Spacer(minLength: 8)
        if isSelected {
          Image(systemName: "checkmark")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.accent)
        }
      }
      .padding(.vertical, 9)
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(isSelected ? .isSelected : [])
  }
}

/// Rows separated by kit hairlines, for a list inside a form card.
struct LaneChoiceList<Item: Identifiable, Row: View>: View {
  let items: [Item]
  @ViewBuilder var row: (Item) -> Row

  var body: some View {
    LazyVStack(spacing: 0) {
      ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
        if index > 0 {
          Rectangle().fill(ADEKit.rule).frame(height: 0.75)
        }
        row(item)
      }
    }
  }
}
