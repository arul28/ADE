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
    HStack(spacing: 6) {
      Circle()
        .fill(runtimeTint(bucket: snapshot.runtime.bucket))
        .frame(width: 6, height: 6)
      Text(snapshot.lane.name)
        .font(.caption.weight(.medium))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      if isPinned {
        Image(systemName: "pin.fill")
          .font(.system(size: 8))
          .foregroundStyle(ADEColor.accent)
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .background(ADEColor.surfaceBackground.opacity(0.55), in: Capsule())
    .glassEffect()
    .overlay(
      Capsule()
        .stroke(ADEColor.border.opacity(0.16), lineWidth: 0.5)
    )
    .accessibilityLabel("\(snapshot.lane.name)\(isPinned ? ", pinned" : "")")
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
      .frame(maxWidth: .infinity)
      .padding(.vertical, 14)
      .background(ADEColor.surfaceBackground.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .glassEffect(in: .rect(cornerRadius: 12))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(tint.opacity(0.14), lineWidth: 0.5)
      )
    }
    .buttonStyle(ADEScaleButtonStyle())
    .accessibilityLabel("Launch \(title)")
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
    TextField(title, text: $text, axis: .vertical)
      .textFieldStyle(.plain)
      .foregroundStyle(ADEColor.textPrimary)
      .adeInsetField()
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
          laneRoleBadge
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
              text: "\(snapshot.runtime.sessionCount)",
              tint: runtimeTint(bucket: snapshot.runtime.bucket)
            )
          }
          if snapshot.lane.childCount > 0 {
            LaneMicroChip(icon: "square.stack.3d.up", text: "\(snapshot.lane.childCount)", tint: ADEColor.textMuted)
          }
          if isPinned {
            LaneMicroChip(icon: "pin.fill", text: nil, tint: ADEColor.accent)
          }
        }
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
  }

  @ViewBuilder
  private var laneRoleBadge: some View {
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
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 10) {
        LaneStatusIndicator(bucket: snapshot.runtime.bucket, size: 10)
          .padding(.top, 4)
          .adeMatchedGeometry(id: isSelectedTransitionSource ? "lane-icon-\(snapshot.lane.id)" : nil, in: transitionNamespace)

        VStack(alignment: .leading, spacing: 4) {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(snapshot.lane.name)
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
              .adeMatchedGeometry(id: isSelectedTransitionSource ? "lane-title-\(snapshot.lane.id)" : nil, in: transitionNamespace)
            laneRoleBadge
            Spacer(minLength: 0)
            lanePriorityBadge(snapshot: snapshot)
              .adeMatchedGeometry(id: isSelectedTransitionSource ? "lane-status-\(snapshot.lane.id)" : nil, in: transitionNamespace)
          }

          Text(snapshot.lane.branchRef)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
        }

        if let devices = snapshot.lane.devicesOpen, !devices.isEmpty {
          Image(systemName: devicePresenceSymbol(for: devices))
            .font(.caption2.weight(.semibold))
            .foregroundStyle(ADEColor.accent)
            .padding(.top, 4)
            .accessibilityLabel("Open on \(devices.count) other device\(devices.count == 1 ? "" : "s")")
        }

        Image(systemName: "chevron.right")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
          .padding(.top, 4)
      }

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
        if isPinned {
          LaneMicroChip(icon: "pin.fill", text: nil, tint: ADEColor.accent)
        }
        Spacer(minLength: 0)
      }

      if let activity = laneActivitySummary(snapshot) {
        Text(activity)
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ADEColor.surfaceBackground.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .glassEffect(in: .rect(cornerRadius: 14))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(isOpen ? ADEColor.accent.opacity(0.4) : ADEColor.border.opacity(0.18), lineWidth: isOpen ? 1.5 : 0.75)
    )
    .shadow(color: isOpen ? ADEColor.accent.opacity(0.08) : .clear, radius: 8, y: 2)
    .adeMatchedTransitionSource(id: isSelectedTransitionSource ? "lane-container-\(snapshot.lane.id)" : nil, in: transitionNamespace)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(stackCardAccessibilityLabel)
  }

  @ViewBuilder
  private var laneRoleBadge: some View {
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

  private var stackCardAccessibilityLabel: String {
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
    return parts.joined(separator: ", ")
  }
}

