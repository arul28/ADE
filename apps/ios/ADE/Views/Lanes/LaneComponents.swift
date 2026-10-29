import SwiftUI

// MARK: - Open chip

struct LaneOpenChip: View {
  let snapshot: LaneListSnapshot
  let isPinned: Bool

  var body: some View {
    let laneTint = laneSurfaceTint(forHex: snapshot.lane.color)
    let laneAccent = laneTint.text ?? ADEColor.textPrimary
    HStack(spacing: 6) {
      WorkLaneLogoMark(color: laneAccent, laneIcon: snapshot.lane.icon, emoji: snapshot.lane.emoji, size: 10)
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
      pullRequest: pullRequest,
      isSelectedTransitionSource: isSelectedTransitionSource,
      machine: showsMachineChip ? machine : machine.map { LaneMachineChip(name: "", isLive: $0.isLive, symbol: $0.symbol) }
    )
  }

  /// One row of the lanes list: the lane glyph in the lane's colour, the
  /// name (up to two lines), one quiet line of facts under it (its PR or
  /// branch, ahead/behind, uncommitted changes), and the lane's chats as one
  /// status mark on the trailing edge. Chips are kept out of the row so a
  /// narrow column still reads cleanly.
  var body: some View {
    let _ = ScrollDiagnostics.shared.count(.laneRowBody)
    HStack(alignment: .top, spacing: 11) {
      laneGlyphTile
        .padding(.top, 1)
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(snapshot.lane.name)
            .font(.system(size: 16, weight: .semibold))
            // The glyph carries the lane colour; the name stays readable (a
            // yellow or pale name on the light page failed contrast).
            .foregroundStyle(machine?.isLive == false ? ADEColor.textSecondary : ADEColor.textPrimary)
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
            .adeMatchedGeometry(id: isSelectedTransitionSource ? "lane-title-\(snapshot.lane.id)" : nil, in: transitionNamespace)
          if isPinned {
            Image(systemName: "pin.fill")
              .font(.system(size: 10, weight: .semibold))
              .foregroundStyle(ADEColor.textMuted)
              .accessibilityHidden(true)
          }
          Spacer(minLength: 4)
          runtimeMark
        }
        metaLine
      }
    }
    .padding(.leading, ADEKit.inset)
    .padding(.trailing, 12)
    .padding(.vertical, 10)
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
    WorkLaneLogoMark(color: laneLabelColor, laneIcon: snapshot.lane.icon, emoji: snapshot.lane.emoji, size: 15)
      .frame(width: 20, height: 20)
      .adeMatchedGeometry(id: isSelectedTransitionSource ? "lane-icon-\(snapshot.lane.id)" : nil, in: transitionNamespace)
  }

  /// The lane's chats as one mark: amber when one waits for you, the working
  /// ring with a count while chats run, nothing when the lane is quiet.
  @ViewBuilder
  private var runtimeMark: some View {
    if snapshot.runtime.awaitingInputCount > 0 {
      LaneRuntimePill(
        symbol: "hand.raised.fill",
        text: "\(snapshot.runtime.awaitingInputCount)",
        tint: ADEColor.warning
      )
      .accessibilityLabel("\(snapshot.runtime.awaitingInputCount) waiting for you")
    } else if snapshot.runtime.runningCount > 0 {
      LaneRuntimePill(
        symbol: "circle.dashed",
        text: "\(snapshot.runtime.runningCount)",
        tint: ADEColor.accent
      )
      .accessibilityLabel("\(snapshot.runtime.runningCount) chat\(snapshot.runtime.runningCount == 1 ? "" : "s") running")
    }
  }

  /// One line of muted facts, joined with dots: the machine (only where the
  /// list mixes machines and no section header names it), Archived/Primary,
  /// the PR ("Merged #1601", in its state's colour), ahead/behind, "edited"
  /// for uncommitted changes, and the branch when there is no PR. Truncates as
  /// one line, at the branch.
  private var metaLine: some View {
    let status = snapshot.lane.status
    var parts: [Text] = []
    if let machine, showsMachineChip {
      parts.append(Text(machine.isLive ? machine.name : "\(machine.name), not live"))
    }
    if snapshot.lane.archivedAt != nil {
      parts.append(Text("Archived"))
    } else if snapshot.lane.laneType == "primary",
              snapshot.lane.name.trimmingCharacters(in: .whitespaces).caseInsensitiveCompare("primary") != .orderedSame {
      parts.append(Text("Primary"))
    }
    if let pullRequest {
      parts.append(
        Text(verbatim: "\(pullRequest.state.capitalized) #\(String(pullRequest.githubPrNumber))")
          .foregroundStyle(lanePullRequestTint(pullRequest.state))
      )
    }
    if status.ahead > 0 || status.behind > 0 {
      var counts = Text("")
      if status.ahead > 0 { counts = counts + Text(verbatim: "↑\(String(status.ahead))") }
      if status.ahead > 0 && status.behind > 0 { counts = counts + Text(verbatim: " ") }
      if status.behind > 0 { counts = counts + Text(verbatim: "↓\(String(status.behind))") }
      parts.append(counts.monospacedDigit())
    }
    if status.dirty {
      parts.append(Text("edited").foregroundStyle(ADEColor.warning))
    }
    // The branch goes last: it is the long part, and the line truncates at
    // its end rather than losing the counts.
    if pullRequest == nil {
      parts.append(Text(verbatim: normalizedPrBranchName(snapshot.lane.branchRef)))
    }
    var line = Text("")
    for (index, part) in parts.enumerated() {
      line = index == 0 ? part : line + Text("  ·  ") + part
    }
    return line
      .font(.footnote)
      .foregroundStyle(ADEColor.textMuted)
      .lineLimit(1)
      .truncationMode(.tail)
  }

  private var laneTint: LaneSurfaceTint {
    laneSurfaceTint(forHex: snapshot.lane.color)
  }

  private var laneLabelColor: Color {
    laneTint.text ?? ADEColor.textPrimary
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
  hasher.combine(lane.emoji)
  hasher.combine(lane.laneType)
  hasher.combine(lane.archivedAt)
  hasher.combine(lane.branchRef)
  hasher.combine(lane.status.dirty)
  hasher.combine(lane.status.ahead)
  hasher.combine(lane.status.behind)
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
  hasher.combine(isSelectedTransitionSource)
  if let pullRequest {
    hasher.combine(pullRequest.githubPrNumber)
    hasher.combine(pullRequest.state)
  } else {
    hasher.combine(0)
  }
  return hasher.finalize()
}

/// A lane's live chats on its row: a tinted capsule with a glyph and count.
struct LaneRuntimePill: View {
  let symbol: String
  let text: String
  let tint: Color

  var body: some View {
    HStack(spacing: 3) {
      Image(systemName: symbol)
        .font(.system(size: 9.5, weight: .bold))
      Text(text)
        .font(.caption2.weight(.semibold).monospacedDigit())
    }
    .foregroundStyle(tint)
    .padding(.horizontal, 7)
    .frame(height: 20)
    .background(tint.opacity(0.13), in: Capsule(style: .continuous))
    .fixedSize()
  }
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

// MARK: - Duo: lane dashboard and the two-page detail

/// One lane's detail on the Duo's inner display (and an iPad): ONE column,
/// since there is no room for desktop's three. A clear header (the lane's
/// name, branch and machine, and its state), then a segmented control between
/// the lane's Overview (the dashboard) and Git (the phone's lane detail: its
/// changes, branch, stashes and history, with the commit and sync actions).
/// The column's controls are toolbar items, so held landscape they ride the
/// edge bar.
struct LaneDuoDetailLayout<Dashboard: View, Git: View>: View {
  enum Section: String, CaseIterable, Identifiable {
    case overview = "Overview"
    case git = "Git"
    var id: String { rawValue }
  }

  let snapshot: LaneListSnapshot
  let machineName: String?
  /// The lane's open (else latest) pull request.
  let pullRequest: PullRequestListItem?
  let canCreatePullRequest: Bool
  let onOpenPullRequest: (PullRequestListItem) -> Void
  let onCreatePullRequest: () -> Void
  let onRefresh: () -> Void
  let onOpenFiles: () -> Void
  let onManage: () -> Void
  let onCopyLaneLink: () -> Void
  let onCopyBranchLink: () -> Void
  /// Set when something in the lane asks for Git (a diff opening).
  var forcesGit = false
  @ViewBuilder let dashboard: () -> Dashboard
  @ViewBuilder let git: () -> Git

  @Environment(\.duoSplit) private var split
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @State private var section: Section = .overview

  @Environment(\.dismiss) private var dismiss

  /// A pushed lane in a short window (the Duo's outer display or an iPhone
  /// held landscape). Any trailing toolbar item there joins the outer
  /// display's rail, and the rail then folds its five tabs down to the
  /// current one. So the way back is the top bar's leading item and the
  /// lane's actions are one ⋯ in the header, and the rail keeps the tabs.
  private var isShort: Bool { verticalSizeClass == .compact && split == nil }

  var body: some View {
    withToolbar(
      VStack(spacing: 0) {
        // 16pt sides, the git pane's and the dashboard's, so the header, the
        // segmented control and the cards share one left and right edge.
        header
          .padding(.horizontal, 16)
          .padding(.top, 6)
        Picker("Section", selection: $section) {
          ForEach(Section.allCases) { option in
            Text(option.rawValue).tag(option)
          }
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 8)
        Group {
          switch section {
          case .overview: dashboard()
          case .git: git()
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      }
    )
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
    .adeScreenBackground()
    .onChange(of: forcesGit, initial: true) { _, forces in
      if forces { section = .git }
    }
  }

  /// The lane's glyph and name, its branch and machine, and one line of state:
  /// its PR, ahead/behind, uncommitted changes.
  private var header: some View {
    let lane = snapshot.lane
    let tint = laneSurfaceTint(forHex: lane.color).text ?? ADEColor.accent
    return HStack(alignment: .top, spacing: 12) {
      WorkLaneLogoMark(color: tint, laneIcon: lane.icon, emoji: lane.emoji, size: 20)
        .frame(width: 28, height: 28)
      VStack(alignment: .leading, spacing: 4) {
        Text(lane.name)
          .font(.title3.weight(.bold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
          .accessibilityAddTraits(.isHeader)
        (Text(verbatim: lane.branchRef).font(.subheadline.monospaced())
          + Text(verbatim: machineName.map { $0.isEmpty ? "" : "  ·  \($0)" } ?? "").font(.subheadline))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.middle)
        stateLine
      }
      Spacer(minLength: 0)
      if isShort {
        Menu {
          pullRequestButton
          Button("Open in Files", systemImage: "folder", action: onOpenFiles)
          Button("Manage lane", systemImage: "slider.horizontal.3", action: onManage)
          Divider()
          overflowItems
        } label: {
          Image(systemName: "ellipsis")
            .font(.body.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("Lane options")
      }
    }
  }

  private var stateLine: some View {
    let status = snapshot.lane.status
    var parts: [Text] = []
    if let pullRequest {
      parts.append(
        Text(verbatim: "PR #\(String(pullRequest.githubPrNumber)) · \(pullRequest.state.capitalized)")
          .foregroundStyle(lanePullRequestTint(pullRequest.state))
      )
    }
    if status.ahead == 0 && status.behind == 0 {
      parts.append(Text("Up to date with base"))
    } else {
      parts.append(Text([
        status.ahead > 0 ? "\(status.ahead) ahead" : nil,
        status.behind > 0 ? "\(status.behind) behind" : nil,
      ].compactMap { $0 }.joined(separator: ", ")))
    }
    parts.append(status.dirty
      ? Text("Uncommitted changes").foregroundStyle(ADEColor.warning)
      : Text("Clean"))
    var line = Text("")
    for (index, part) in parts.enumerated() {
      line = index == 0 ? part : line + Text("  ·  ") + part
    }
    return line
      .font(.footnote)
      .foregroundStyle(ADEColor.textMuted)
      .lineLimit(2)
  }

  @ViewBuilder
  private func withToolbar<Content: View>(_ content: Content) -> some View {
    if isShort {
      content
        .navigationBarBackButtonHidden(true)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            Button("Back", systemImage: "chevron.left") { dismiss() }
              .accessibilityLabel("Back to lanes")
          }
        }
    } else {
      #if compiler(>=6.4)
      if #available(iOS 27.0, *) {
        content.toolbar {
          DuoSplitListToggle(split: split)
          ToolbarItem(placement: .topBarPinnedTrailing) { pullRequestButton }
            .visibilityPriority(.high)
          commonItems
          ToolbarOverflowMenu { overflowItems }
        }
      } else {
        content.toolbar {
          DuoSplitListToggle(split: split)
          ToolbarItem(placement: .topBarTrailing) { pullRequestButton }
          commonItems
          ToolbarItem(placement: .topBarTrailing) {
            Menu { overflowItems } label: { Image(systemName: "ellipsis") }
              .accessibilityLabel("Lane options")
          }
        }
      }
      #else
      content.toolbar {
        DuoSplitListToggle(split: split)
        ToolbarItem(placement: .topBarTrailing) { pullRequestButton }
        commonItems
        ToolbarItem(placement: .topBarTrailing) {
          Menu { overflowItems } label: { Image(systemName: "ellipsis") }
            .accessibilityLabel("Lane options")
        }
      }
      #endif
    }
  }

  @ViewBuilder
  private var pullRequestButton: some View {
    if let pullRequest {
      Button("PR #\(pullRequest.githubPrNumber)", systemImage: "arrow.triangle.pull") {
        onOpenPullRequest(pullRequest)
      }
    } else {
      Button("Create pull request", systemImage: "plus.square.on.square", action: onCreatePullRequest)
        .disabled(!canCreatePullRequest)
    }
  }

  /// Files and Manage on the bar; Refresh (pull to refresh does it too) and
  /// the links in ⋯.
  @ToolbarContentBuilder
  private var commonItems: some ToolbarContent {
    ToolbarItem(placement: .topBarTrailing) {
      Button("Open in Files", systemImage: "folder", action: onOpenFiles)
    }
    ToolbarItem(placement: .topBarTrailing) {
      Button("Manage lane", systemImage: "slider.horizontal.3", action: onManage)
    }
  }

  @ViewBuilder
  private var overflowItems: some View {
    Button("Refresh", systemImage: "arrow.clockwise", action: onRefresh)
    Divider()
    Button("Copy ADE lane link", systemImage: "link", action: onCopyLaneLink)
    Button("Copy branch link", systemImage: "arrow.triangle.branch", action: onCopyBranchLink)
  }
}

/// Desktop's lane dashboard: who the lane is, its pull request, the chats and
/// CLIs working in it, its changes and its history, as inset
/// grouped sections. Rows open their targets (a chat opens in Work).
struct LaneDuoDashboard: View {
  let snapshot: LaneListSnapshot
  let detail: LaneDetailPayload?
  let machineName: String?
  let pullRequests: [PullRequestListItem]
  let canCreatePullRequest: Bool
  let onOpenPullRequest: (PullRequestListItem) -> Void
  let onCreatePullRequest: () -> Void
  let onOpenChat: (AgentChatSessionSummary) -> Void

  private var lane: LaneSummary { snapshot.lane }

  var body: some View {
    List {
      identitySection
      pullRequestSection
      sessionsSection
      changesSection
      historySection
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(ADEColor.pageBackground)
    .listSectionSpacing(.compact)
    // Right under the column's segmented control: no grouped-list gap above.
    .contentMargins(.top, 4, for: .scrollContent)
    .contentMargins(.bottom, 24, for: .scrollContent)
    // The same 16pt sides as the header and the segmented control above
    // (the grouped list's own margins ran its cards ~14pt further right),
    // and clear of the edge bar held landscape.
    .duoInsetGroupedMargins()
  }

  // MARK: Identity

  private var identitySection: some View {
    Section {
      // The column's header already names the lane and its branch.
      if let machineName, !machineName.isEmpty {
        LabeledContent("Machine", value: machineName)
      }
      LabeledContent("Base") {
        Text(verbatim: lane.baseRef).font(.adeMono(13))
      }
      LabeledContent("Upstream", value: upstreamText)
      LabeledContent("Working tree", value: lane.status.dirty ? "Uncommitted changes" : "Clean")
      if snapshot.runtime.sessionCount > 0 {
        LabeledContent("Sessions", value: runtimeText)
      }
    }
    .font(.subheadline)
  }

  private var upstreamText: String {
    if let sync = detail?.syncStatus, !sync.hasUpstream { return "Not pushed" }
    let ahead = detail?.syncStatus?.ahead ?? lane.status.ahead
    let behind = detail?.syncStatus?.behind ?? lane.status.behind
    if ahead == 0 && behind == 0 { return "Up to date" }
    return [ahead > 0 ? "\(ahead) ahead" : nil, behind > 0 ? "\(behind) behind" : nil]
      .compactMap { $0 }
      .joined(separator: " · ")
  }

  private var runtimeText: String {
    let runtime = snapshot.runtime
    var parts: [String] = []
    if runtime.runningCount > 0 { parts.append("\(runtime.runningCount) running") }
    if runtime.awaitingInputCount > 0 { parts.append("\(runtime.awaitingInputCount) waiting") }
    if parts.isEmpty { parts.append("\(runtime.sessionCount) idle") }
    return parts.joined(separator: " · ")
  }

  // MARK: Pull request

  @ViewBuilder
  private var pullRequestSection: some View {
    Section("Pull request") {
      if pullRequests.isEmpty {
        Button(action: onCreatePullRequest) {
          Label("Create pull request", systemImage: "plus.square.on.square")
        }
        .disabled(!canCreatePullRequest)
      } else {
        ForEach(pullRequests.prefix(3)) { pr in
          Button {
            onOpenPullRequest(pr)
          } label: {
            PrRowCard(pr: pr)
          }
          .buttonStyle(.plain)
        }
      }
    }
  }

  // MARK: Sessions

  @ViewBuilder
  private var sessionsSection: some View {
    let chats = (detail?.chatSessions ?? [])
      .sorted { $0.lastActivityAt > $1.lastActivityAt }
    let terminals = (detail?.sessions ?? [])
      .filter { $0.status == "running" }
    if !chats.isEmpty || !terminals.isEmpty {
      Section {
        ForEach(chats.prefix(8)) { chat in
          Button {
            onOpenChat(chat)
          } label: {
            HStack(spacing: 10) {
              Circle()
                .fill(sessionTint(chat.status))
                .frame(width: 8, height: 8)
              VStack(alignment: .leading, spacing: 2) {
                Text(chat.title?.isEmpty == false ? chat.title! : "Chat")
                  .font(.subheadline)
                  .foregroundStyle(ADEColor.textPrimary)
                  .lineLimit(1)
                Text(verbatim: chat.model.isEmpty ? chat.provider : chat.model)
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)
                  .lineLimit(1)
              }
              Spacer(minLength: 8)
              Text(prCompactRelativeTime(chat.lastActivityAt))
                .font(.adeMono(11))
                .foregroundStyle(ADEColor.textMuted)
            }
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
        }
        ForEach(terminals.prefix(4)) { terminal in
          HStack(spacing: 10) {
            Image(systemName: "terminal")
              .font(.system(size: 12, weight: .semibold))
              .foregroundStyle(ADEColor.textSecondary)
              .frame(width: 8)
            Text(terminal.title)
              .font(.subheadline)
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            Spacer(minLength: 8)
            Text(terminal.toolType ?? "shell")
              .font(.caption)
              .foregroundStyle(ADEColor.textMuted)
          }
        }
      } header: {
        Text("Chats and CLIs")
      }
    }
  }

  private func sessionTint(_ status: String) -> Color {
    switch status.lowercased() {
    case "running", "active", "working": return ADEColor.success
    case "awaiting_input", "waiting", "needs_input": return ADEColor.warning
    case "error", "failed": return ADEColor.danger
    default: return ADEColor.textMuted
    }
  }

  // MARK: Changes

  @ViewBuilder
  private var changesSection: some View {
    let staged = detail?.diffChanges?.staged ?? []
    let unstaged = detail?.diffChanges?.unstaged ?? []
    let all = staged + unstaged
    let additions = all.reduce(0) { $0 + ($1.additions ?? 0) }
    let deletions = all.reduce(0) { $0 + ($1.deletions ?? 0) }
    Section {
      // The font on the rows, not the section: on the section it shrank the
      // "Changes" header below the other sections' headers.
      Group {
        if all.isEmpty {
          Text("No uncommitted changes")
            .foregroundStyle(ADEColor.textSecondary)
        } else {
          LabeledContent("Staged", value: fileCount(staged.count))
          LabeledContent("Unstaged", value: fileCount(unstaged.count))
          LabeledContent("Lines") {
            PrDiffStat(additions: additions, deletions: deletions, size: 12)
          }
        }
      }
      .font(.subheadline)
    } header: {
      Text("Changes")
    }
  }

  private func fileCount(_ count: Int) -> String {
    "\(count) file\(count == 1 ? "" : "s")"
  }

  // MARK: History

  @ViewBuilder
  private var historySection: some View {
    let commits = detail?.recentCommits ?? []
    if !commits.isEmpty {
      Section("History") {
        ForEach(commits.prefix(8)) { commit in
          VStack(alignment: .leading, spacing: 3) {
            Text(commit.subject)
              .font(.subheadline)
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(2)
            HStack(spacing: 6) {
              Text(verbatim: commit.shortSha)
                .font(.adeMono(11))
                .foregroundStyle(ADEColor.accent)
              Text("\(commit.authorName) · \(prCompactRelativeTime(commit.authoredAt))")
                .font(.caption)
                .foregroundStyle(ADEColor.textMuted)
              if !commit.pushed {
                Text("not pushed")
                  .font(.caption)
                  .foregroundStyle(ADEColor.warning)
              }
            }
          }
        }
      }
    }
  }
}
