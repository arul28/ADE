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
    let laneAccent = LaneColorPalette.color(forHex: snapshot.lane.color)
    HStack(spacing: 6) {
      Circle()
        .fill(runtimeTint(bucket: snapshot.runtime.bucket))
        .frame(width: 6, height: 6)
      if let laneAccent {
        Circle()
          .fill(laneAccent)
          .frame(width: 7, height: 7)
      }
      Text(snapshot.lane.name)
        .font(.caption.weight(.medium))
        .foregroundStyle(laneAccent ?? ADEColor.textPrimary)
        .lineLimit(1)
      if isPinned {
        Image(systemName: "pin.fill")
          .font(.system(size: 8))
          .foregroundStyle(ADEColor.accent)
      }
    }
    .padding(EdgeInsets(top: 7, leading: 10, bottom: 7, trailing: 10))
    .background(ADEColor.surfaceBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .glassEffect(in: .rect(cornerRadius: 12))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke((laneAccent ?? ADEColor.border).opacity(laneAccent == nil ? 0.16 : 0.45), lineWidth: 0.5)
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
    } else if snapshot.lane.laneType == "attached" {
      LaneTypeBadge(text: "Attached", tint: ADEColor.textMuted)
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

// MARK: - Inline rebase warning (rendered inside lane cards)

enum LaneCardRebaseWarningPresentation: Equatable {
  case suggestion(behindCount: Int, hasPr: Bool)
  case autoRebase(state: String, message: String?)

  var icon: String {
    switch self {
    case .suggestion: return "arrow.triangle.2.circlepath"
    case .autoRebase(let state, _):
      return state == "rebaseConflict" ? "exclamationmark.triangle.fill" : "exclamationmark.arrow.triangle.2.circlepath"
    }
  }

  var tint: Color {
    switch self {
    case .suggestion: return ADEColor.warning
    case .autoRebase(let state, _):
      return (state == "rebaseConflict" || state == "rebaseFailed") ? ADEColor.danger : ADEColor.warning
    }
  }

  var title: String {
    switch self {
    case .suggestion: return "Rebase suggested"
    case .autoRebase(let state, _):
      switch state {
      case "rebaseConflict": return "Auto-rebase conflict"
      case "rebaseFailed": return "Auto-rebase failed"
      default: return "Auto-rebase needs attention"
      }
    }
  }

  var detail: String? {
    switch self {
    case .suggestion(let behindCount, let hasPr):
      let noun = behindCount == 1 ? "commit" : "commits"
      let base = "\(behindCount) \(noun) behind"
      return hasPr ? "\(base) · PR open" : base
    case .autoRebase(_, let message):
      return message
    }
  }

  var accessibilitySummary: String {
    [title, detail].compactMap { part in
      guard let part, !part.isEmpty else { return nil }
      return part
    }.joined(separator: ". ")
  }
}

func laneCardRebaseWarningPresentation(for snapshot: LaneListSnapshot) -> LaneCardRebaseWarningPresentation? {
  if let status = snapshot.autoRebaseStatus, status.state != "autoRebased" {
    return .autoRebase(state: status.state, message: status.message)
  }
  if let suggestion = snapshot.rebaseSuggestion, suggestion.dismissedAt == nil {
    return .suggestion(behindCount: suggestion.behindCount, hasPr: suggestion.hasPr)
  }
  return nil
}

func laneStackCardAccessibilityLabel(
  snapshot: LaneListSnapshot,
  isPinned: Bool,
  isOpen: Bool,
  rebaseWarning: LaneCardRebaseWarningPresentation?
) -> String {
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
  if snapshot.runtime.sessionCount > 0 { parts.append("\(snapshot.runtime.sessionCount) sessions") }
  if let warning = rebaseWarning { parts.append(warning.accessibilitySummary) }
  return parts.joined(separator: ", ")
}

struct LaneCardRebaseWarning: View {
  let presentation: LaneCardRebaseWarningPresentation

  var body: some View {
    HStack(alignment: .center, spacing: 8) {
      Image(systemName: presentation.icon)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(presentation.tint)
      VStack(alignment: .leading, spacing: 1) {
        Text(presentation.title)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        if let detail = presentation.detail, !detail.isEmpty {
          Text(detail)
            .font(.caption2)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, 8)
    .padding(.horizontal, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(presentation.tint.opacity(0.10), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(presentation.tint.opacity(0.28), lineWidth: 0.5)
    )
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(presentation.accessibilitySummary)
  }
}

// MARK: - Stack card

struct LaneStackCard: View, Equatable {
  let snapshot: LaneListSnapshot
  let isPinned: Bool
  let isOpen: Bool
  let depth: Int
  var transitionNamespace: Namespace.ID? = nil
  var isSelectedTransitionSource = false

  static func == (lhs: LaneStackCard, rhs: LaneStackCard) -> Bool {
    lhs.snapshot == rhs.snapshot
      && lhs.isPinned == rhs.isPinned
      && lhs.isOpen == rhs.isOpen
      && lhs.depth == rhs.depth
      && lhs.isSelectedTransitionSource == rhs.isSelectedTransitionSource
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .center, spacing: 10) {
        LaneStatusIndicator(bucket: snapshot.runtime.bucket, size: 10)
          .adeMatchedGeometry(id: isSelectedTransitionSource ? "lane-icon-\(snapshot.lane.id)" : nil, in: transitionNamespace)

        if let laneAccent = LaneColorPalette.color(forHex: snapshot.lane.color) {
          Circle()
            .fill(laneAccent)
            .frame(width: 7, height: 7)
        }
        Text(snapshot.lane.name)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(LaneColorPalette.color(forHex: snapshot.lane.color) ?? ADEColor.textPrimary)
          .lineLimit(1)
          .adeMatchedGeometry(id: isSelectedTransitionSource ? "lane-title-\(snapshot.lane.id)" : nil, in: transitionNamespace)

        laneTypeBadge

        Spacer(minLength: 4)

        if let devices = snapshot.lane.devicesOpen, !devices.isEmpty {
          Image(systemName: devicePresenceSymbol(for: devices))
            .font(.caption2.weight(.semibold))
            .foregroundStyle(ADEColor.accent)
            .accessibilityLabel("Open on \(devices.count) other device\(devices.count == 1 ? "" : "s")")
        }

        Image(systemName: "chevron.right")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
      }

      HStack(spacing: 5) {
        Image(systemName: "arrow.triangle.branch")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
        Text(snapshot.lane.branchRef)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.middle)
      }

      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
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
              text: "\(snapshot.runtime.sessionCount) running",
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
      }
      .scrollClipDisabled()

      if let activity = laneActivitySummary(snapshot) {
        Text(activity)
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }

      if let warning = rebaseWarning {
        LaneCardRebaseWarning(presentation: warning)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(cardBackgroundTint.opacity(isPrimary ? 0.12 : 0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .glassEffect(in: .rect(cornerRadius: 14))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(cardStrokeTint, lineWidth: isOpen ? 1.5 : (isPrimary ? 1.0 : 0.75))
    )
    .shadow(color: isOpen ? ADEColor.accent.opacity(0.08) : .clear, radius: 8, y: 2)
    .adeMatchedTransitionSource(id: isSelectedTransitionSource ? "lane-container-\(snapshot.lane.id)" : nil, in: transitionNamespace)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(stackCardAccessibilityLabel)
  }

  private var isPrimary: Bool {
    snapshot.lane.laneType == "primary"
  }

  private var rebaseWarning: LaneCardRebaseWarningPresentation? {
    laneCardRebaseWarningPresentation(for: snapshot)
  }

  private var cardBackgroundTint: Color {
    isPrimary ? ADEColor.accent : ADEColor.surfaceBackground
  }

  private var cardStrokeTint: Color {
    if isOpen { return ADEColor.accent.opacity(0.4) }
    if isPrimary { return ADEColor.accent.opacity(0.32) }
    return ADEColor.border.opacity(0.18)
  }

  @ViewBuilder
  private var laneTypeBadge: some View {
    if snapshot.lane.laneType == "attached" {
      LaneTypeBadge(text: "Attached", tint: ADEColor.textMuted)
    } else if snapshot.lane.archivedAt != nil {
      LaneTypeBadge(text: "Archived", tint: ADEColor.textMuted)
    } else {
      EmptyView()
    }
  }

  private var stackCardAccessibilityLabel: String {
    laneStackCardAccessibilityLabel(
      snapshot: snapshot,
      isPinned: isPinned,
      isOpen: isOpen,
      rebaseWarning: rebaseWarning
    )
  }
}
