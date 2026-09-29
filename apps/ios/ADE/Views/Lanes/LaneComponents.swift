import SwiftUI

// MARK: - Lane status indicator

struct LaneStatusIndicator: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  let bucket: String
  var size: CGFloat = 10

  @State private var isPulsing = false

  var body: some View {
    Circle()
      .fill(runtimeTint(bucket: bucket))
      .frame(width: size, height: size)
      .shadow(color: runtimeTint(bucket: bucket).opacity(isAnimating ? 0.5 : 0), radius: isAnimating ? 6 : 0)
      .scaleEffect(isPulsing && isAnimating ? 1.3 : 1.0)
      .animation(ADEMotion.pulse(reduceMotion: reduceMotion), value: isPulsing)
      .onAppear {
        if isAnimating {
          isPulsing = true
        }
      }
      .onChange(of: isAnimating) { _, animating in
        if !animating { isPulsing = false }
      }
  }

  private var isAnimating: Bool {
    (bucket == "running" || bucket == "awaiting-input") && !reduceMotion
  }
}

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
          .foregroundStyle(ADEColor.accent)
      }
    }
    .padding(EdgeInsets(top: 7, leading: 10, bottom: 7, trailing: 10))
    .background(laneTint.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .glassEffect(in: .rect(cornerRadius: 12))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(laneTint.border, lineWidth: 0.5)
    )
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
      .foregroundStyle(ADEColor.textPrimary)
      .padding(.horizontal, compact ? 7 : 9)
      .padding(.vertical, compact ? 4 : 7)
      .background(ADEColor.accent.opacity(0.10), in: RoundedRectangle(cornerRadius: compact ? 9 : 11, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: compact ? 9 : 11, style: .continuous)
          .stroke(ADEColor.accent.opacity(0.28), lineWidth: 0.7)
      )
    }
    .buttonStyle(.plain)
    .disabled(issue.url?.isEmpty ?? true)
    .accessibilityLabel("\(issue.identifier): \(issue.title)")
  }
}

// MARK: - Launch tile

struct LaneLaunchTile: View {
  let title: String
  let symbol: String
  let tint: Color
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(spacing: 8) {
        Image(systemName: symbol)
          .font(.system(size: 18, weight: .semibold))
          .symbolRenderingMode(.hierarchical)
        Text(title)
          .font(.caption.weight(.medium))
      }
      .foregroundStyle(tint)
      .frame(maxWidth: .infinity, minHeight: 88)
      .padding(14)
      .background(ADEColor.surfaceBackground.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .glassEffect(in: .rect(cornerRadius: 12))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(tint.opacity(0.14), lineWidth: 0.5)
      )
    }
    .buttonStyle(ADEScaleButtonStyle())
    .accessibilityLabel("Launch \(title)")
    .adeInspectable(
      "Lanes.LaunchTile",
      metadata: [
        "label": "Launch \(title)",
        "title": title,
        "role": "button"
      ]
    )
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

// MARK: - Session card

struct LaneSessionCard: View {
  let session: TerminalSessionSummary

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(session.title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer()
        LaneTypeBadge(text: session.status.uppercased(), tint: session.status == "running" ? ADEColor.success : ADEColor.textSecondary)
      }
      if let preview = session.lastOutputPreview {
        Text(preview)
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(2)
      }
    }
    .adeGlassCard(cornerRadius: 12, padding: 12)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(session.title), \(session.status)")
    .adeInspectable(
      "Lanes.SessionCard",
      metadata: [
        "label": "\(session.title), \(session.status)",
        "sessionId": session.id,
        "laneId": session.laneId,
        "laneName": session.laneName,
        "status": session.status,
        "role": "row"
      ]
    )
  }
}

// MARK: - Chat card

struct LaneChatCard: View {
  let chat: AgentChatSessionSummary

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(chat.title ?? chat.provider.uppercased())
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer()
        LaneTypeBadge(text: chat.status.uppercased(), tint: chat.status == "active" ? ADEColor.success : ADEColor.textSecondary)
      }
      Text(chat.model)
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(ADEColor.textSecondary)
      if let preview = chat.lastOutputPreview {
        Text(preview)
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(2)
      }
    }
    .adeGlassCard(cornerRadius: 12, padding: 12)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(chat.title ?? chat.provider) chat, \(chat.status)")
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
      .padding(12)
      .frame(minHeight: 44, maxHeight: 56, alignment: .center)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.recessedBackground.opacity(0.78), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 0.5)
      )
      .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
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

// MARK: - Lane list row

struct LaneListRow: View, Equatable {
  let snapshot: LaneListSnapshot
  let isPinned: Bool
  let isOpen: Bool

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      LaneStatusIndicator(bucket: snapshot.runtime.bucket, size: 9)
        .padding(.top, 5)

      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(snapshot.lane.name)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          laneTypeBadge
          Spacer(minLength: 0)
        }

        HStack(spacing: 6) {
          Text(snapshot.lane.branchRef)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
          if let activity = laneActivitySummary(snapshot) {
            Circle()
              .fill(ADEColor.border.opacity(0.6))
              .frame(width: 3, height: 3)
            Text(activity)
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          }
          Spacer(minLength: 0)
        }

        LazyVGrid(columns: [GridItem(.adaptive(minimum: 58), spacing: 6, alignment: .leading)], alignment: .leading, spacing: 6) {
          if snapshot.lane.status.dirty {
            LaneMicroChip(icon: "circle.fill", text: "dirty", tint: ADEColor.warning)
          }
          if snapshot.lane.status.ahead > 0 {
            LaneMicroChip(icon: "arrow.up", text: "\(snapshot.lane.status.ahead)", tint: ADEColor.success)
          }
          if snapshot.lane.status.behind > 0 {
            LaneMicroChip(icon: "arrow.down", text: "\(snapshot.lane.status.behind)", tint: ADEColor.warning)
          }
          if snapshot.runtime.sessionCount > 0 {
            LaneMicroChip(
              icon: runtimeSymbol(snapshot.runtime.bucket),
              text: "\(snapshot.runtime.sessionCount)",
              tint: runtimeTint(bucket: snapshot.runtime.bucket)
            )
          }
          if snapshot.lane.childCount > 0 {
            LaneMicroChip(icon: "square.stack.3d.up", text: "\(snapshot.lane.childCount)", tint: ADEColor.textMuted)
          }
          if let issue = primaryLaneLinearIssue(for: snapshot.lane) {
            LaneMicroChip(icon: "link", text: issue.identifier, tint: ADEColor.accent)
          } else if laneLinearIssueLinkCount(for: snapshot.lane) > 0 {
            LaneMicroChip(icon: "link", text: "\(laneLinearIssueLinkCount(for: snapshot.lane))", tint: ADEColor.accent)
          }
          if isPinned {
            LaneMicroChip(icon: "pin.fill", text: nil, tint: ADEColor.accent)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }

      Spacer(minLength: 8)

      VStack(alignment: .trailing, spacing: 6) {
        lanePriorityBadge(snapshot: snapshot)
        if isOpen {
          LaneMicroChip(icon: "rectangle.portrait.and.arrow.right", text: "open", tint: ADEColor.accent)
        }
      }

      Image(systemName: "chevron.right")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .adeGlassCard(cornerRadius: 14, padding: 12)
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(isOpen ? ADEColor.accent.opacity(0.35) : ADEColor.border.opacity(0.14), lineWidth: isOpen ? 1 : 0.75)
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel(laneRowAccessibilityLabel)
    .adeInspectable(
      "Lanes.Row",
      metadata: [
        "label": laneRowAccessibilityLabel,
        "laneId": snapshot.lane.id,
        "laneName": snapshot.lane.name,
        "branchRef": snapshot.lane.branchRef,
        "role": "row"
      ]
    )
  }

  @ViewBuilder
  private var laneTypeBadge: some View {
    if snapshot.lane.laneType == "primary" {
      LaneTypeBadge(text: "Primary", tint: ADEColor.accent)
    } else if snapshot.lane.archivedAt != nil {
      LaneTypeBadge(text: "Archived", tint: ADEColor.textMuted)
    } else {
      EmptyView()
    }
  }

  private var laneRowAccessibilityLabel: String {
    var parts = [snapshot.lane.name, snapshot.lane.branchRef]
    if snapshot.lane.laneType == "primary" { parts.append("primary") }
    if snapshot.lane.archivedAt != nil { parts.append("archived") }
    if snapshot.runtime.bucket == "running" { parts.append("running") }
    if snapshot.runtime.bucket == "awaiting-input" { parts.append("awaiting input") }
    if snapshot.lane.status.dirty { parts.append("dirty") }
    if isPinned { parts.append("pinned") }
    if isOpen { parts.append("open") }
    if snapshot.lane.status.ahead > 0 { parts.append("\(snapshot.lane.status.ahead) ahead") }
    if snapshot.lane.status.behind > 0 { parts.append("\(snapshot.lane.status.behind) behind") }
    return parts.joined(separator: ", ")
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
    .padding(.horizontal, 7)
    .padding(.vertical, 4)
    .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 7, style: .continuous)
        .stroke(tint.opacity(0.28), lineWidth: 0.6)
    )
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

  /// Drawn like the Work list's rows (flat on the page, text first), with a
  /// lane's own marks: the lane glyph tile in the lane's color, the lane name
  /// in that color, the branch line below, and the lane's live chats as one
  /// status mark on the trailing edge (the desktop lane sidebar row).
  var body: some View {
    HStack(alignment: .center, spacing: 11) {
      laneGlyphTile
      VStack(alignment: .leading, spacing: 4) {
        HStack(alignment: .center, spacing: 6) {
          Text(snapshot.lane.name)
            .font(.subheadline.weight(.semibold))
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
              .foregroundStyle(ADEColor.accent)
              .accessibilityLabel("Open on \(devices.count) other device\(devices.count == 1 ? "" : "s")")
          }
          runtimeMark
        }
        detailLine
      }
    }
    .padding(.leading, isOpen ? 9 : 6)
    .padding(.trailing, 8)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 13, style: .continuous)
        .fill(isOpen ? laneTint.accentBar.opacity(0.07) : Color.clear)
    )
    .overlay(alignment: .leading) {
      // An open lane (in the tray above) keeps a thin bar in its color.
      if isOpen {
        Capsule()
          .fill(laneTint.accentBar)
          .frame(width: 3)
          .padding(.vertical, 8)
      }
    }
    .contentShape(Rectangle())
    .adeMatchedTransitionSource(id: isSelectedTransitionSource ? "lane-container-\(snapshot.lane.id)" : nil, in: transitionNamespace)
    .opacity(machine?.isLive == false ? 0.5 : 1)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(stackCardAccessibilityLabel)
  }

  private var laneGlyphTile: some View {
    WorkLaneLogoMark(color: laneLabelColor, laneIcon: snapshot.lane.icon, size: 14)
      .frame(width: 32, height: 32)
      .background(laneLabelColor.opacity(0.13), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 9, style: .continuous)
          .stroke(laneLabelColor.opacity(0.22), lineWidth: 0.6)
      )
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
        .background(ADEColor.textSecondary.opacity(0.1), in: Capsule(style: .continuous))
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
            .foregroundStyle(ADEColor.accent)
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
      LaneTypeBadge(text: "Archived", tint: ADEColor.textMuted)
    } else if snapshot.lane.laneType == "primary",
              snapshot.lane.name.trimmingCharacters(in: .whitespaces).caseInsensitiveCompare("primary") != .orderedSame {
      // A primary lane named "Primary" already says so.
      LaneTypeBadge(text: "Primary", tint: ADEColor.accent)
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
