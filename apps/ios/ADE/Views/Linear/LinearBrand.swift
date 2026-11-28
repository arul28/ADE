import SwiftUI

// MARK: - Brand tokens

/// Linear brand colors + marks ported 1:1 from the desktop renderer
/// (`apps/desktop/src/renderer/components/lanes/linearBrand.tsx`) so the mobile
/// Linear pane reads with the same visual language as the desktop pane and
/// Linear itself.
enum LinearBrand {
  static let primary = linearColor(0x5E6AD2)
  static let primaryBright = linearColor(0x7B8AF0)
  static let primaryDeep = linearColor(0x4752B5)
  static let text = linearColor(0xC7CDF5)
  static var surface: Color { primary.opacity(0.10) }
  static var surfaceHover: Color { primary.opacity(0.16) }
  static var border: Color { primary.opacity(0.32) }
  static var borderSubtle: Color { primary.opacity(0.20) }
}

func linearColor(_ hex: UInt) -> Color {
  Color(
    red: Double((hex >> 16) & 0xFF) / 255,
    green: Double((hex >> 8) & 0xFF) / 255,
    blue: Double(hex & 0xFF) / 255
  )
}

// MARK: - Linear logo mark

/// The Linear logo, rendered from the exact SVG path the desktop `LinearMark`
/// uses (viewBox 0 0 24 24). Filled with the current foreground style so callers
/// tint it like an SF Symbol.
struct LinearMark: View {
  var size: CGFloat = 14

  var body: some View {
    LinearMarkShape()
      .frame(width: size, height: size)
  }
}

struct LinearMarkShape: Shape, @unchecked Sendable {
  // The four sub-paths of the Linear glyph (absolute + relative commands).
  private static let pathData =
    "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18Z"
    + "M1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65Z"
    + "M.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Z"
    + "M.152 14.025l9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"

  func path(in rect: CGRect) -> Path {
    let unit = parseSVGPath(Self.pathData)
    let scale = CGAffineTransform(scaleX: rect.width / 24, y: rect.height / 24)
      .concatenating(CGAffineTransform(translationX: rect.minX, y: rect.minY))
    return unit.applying(scale)
  }
}

// MARK: - Linear state icon

/// Workflow-state glyph, ported from the desktop `LinearStateIcon`.
/// `stateType` is Linear's state category: backlog / unstarted / started /
/// completed / canceled / triage.
struct LinearStateIcon: View {
  let stateType: String?
  var size: CGFloat = 14

  var body: some View {
    Canvas { context, canvasSize in
      let s = min(canvasSize.width, canvasSize.height)
      let type = linearNormalizedStateType(stateType)
      let color = linearStateColor(type)
      let stroke = max(1.4, s * 0.12)
      let inset = stroke / 2
      let r = s / 2 - inset
      let center = CGPoint(x: s / 2, y: s / 2)

      func ringPath(radius: CGFloat) -> Path {
        Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
      }

      switch type {
      case "backlog":
        context.stroke(
          ringPath(radius: r),
          with: .color(color),
          style: StrokeStyle(lineWidth: stroke, lineCap: .round, dash: [stroke * 1.7, stroke * 1.4])
        )
      case "started":
        context.stroke(ringPath(radius: r), with: .color(color), style: StrokeStyle(lineWidth: stroke))
        let innerR = r - stroke * 0.6
        var wedge = Path()
        wedge.move(to: center)
        wedge.addLine(to: CGPoint(x: center.x, y: center.y - innerR))
        wedge.addArc(
          center: center, radius: innerR,
          startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false
        )
        wedge.closeSubpath()
        context.fill(wedge, with: .color(color))
      case "completed":
        context.fill(ringPath(radius: r + inset), with: .color(color))
        var check = Path()
        check.move(to: CGPoint(x: center.x - r * 0.45, y: center.y))
        check.addLine(to: CGPoint(x: center.x - r * 0.1, y: center.y + r * 0.38))
        check.addLine(to: CGPoint(x: center.x + r * 0.55, y: center.y - r * 0.35))
        context.stroke(
          check,
          with: .color(linearColor(0x0C0B10)),
          style: StrokeStyle(lineWidth: stroke * 1.1, lineCap: .round, lineJoin: .round)
        )
      case "canceled":
        context.fill(ringPath(radius: r + inset), with: .color(color.opacity(0.9)))
        var x = Path()
        x.move(to: CGPoint(x: center.x - r * 0.45, y: center.y - r * 0.45))
        x.addLine(to: CGPoint(x: center.x + r * 0.45, y: center.y + r * 0.45))
        x.move(to: CGPoint(x: center.x - r * 0.45, y: center.y + r * 0.45))
        x.addLine(to: CGPoint(x: center.x + r * 0.45, y: center.y - r * 0.45))
        context.stroke(x, with: .color(linearColor(0x0C0B10)), style: StrokeStyle(lineWidth: stroke * 1.1, lineCap: .round))
      default: // unstarted / triage
        context.stroke(ringPath(radius: r), with: .color(color), style: StrokeStyle(lineWidth: stroke))
      }
    }
    .frame(width: size, height: size)
  }
}

// MARK: - Linear priority icon

/// Priority glyph, ported from the desktop `LinearPriorityIcon`.
/// Linear priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low.
struct LinearPriorityIcon: View {
  let priority: Int?
  var size: CGFloat = 14

  var body: some View {
    Canvas { context, canvasSize in
      let s = min(canvasSize.width, canvasSize.height)
      let dim = linearColor(0x94A3B8).opacity(0.4)
      // Adaptive so the filled bars read on a light page too.
      let strong = ADEColor.textSecondary
      let p = priority ?? 0

      func roundedRect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ radius: CGFloat) -> Path {
        Path(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerRadius: radius)
      }

      if p == 1 {
        context.fill(roundedRect(s * 0.12, s * 0.12, s * 0.76, s * 0.76, s * 0.18), with: .color(linearColor(0xEB5757)))
        context.fill(roundedRect(s * 0.45, s * 0.28, s * 0.10, s * 0.32, s * 0.05), with: .color(.white))
        context.fill(roundedRect(s * 0.45, s * 0.65, s * 0.10, s * 0.10, s * 0.05), with: .color(.white))
        return
      }
      if p == 0 {
        context.fill(roundedRect(s * 0.18, s * 0.46, s * 0.64, s * 0.10, s * 0.05), with: .color(dim))
        return
      }
      // 2 = high (3 bars), 3 = medium (2 bars), 4 = low (1 bar)
      let filledBars = p == 2 ? 3 : (p == 3 ? 2 : 1)
      let barWidth = s * 0.18
      let barGap = s * 0.10
      let totalWidth = barWidth * 3 + barGap * 2
      let startX = (s - totalWidth) / 2
      let heights = [s * 0.32, s * 0.55, s * 0.78]
      for i in 0..<3 {
        let h = heights[i]
        let filled = i < filledBars
        context.fill(
          roundedRect(startX + CGFloat(i) * (barWidth + barGap), s - h - s * 0.12, barWidth, h, s * 0.04),
          with: .color(filled ? strong : dim)
        )
      }
    }
    .frame(width: size, height: size)
  }
}

// MARK: - Display helpers

func linearNormalizedStateType(_ raw: String?) -> String {
  let value = raw?.lowercased() ?? ""
  switch value {
  case "backlog", "unstarted", "started", "completed", "canceled", "triage":
    return value
  default:
    return "unstarted"
  }
}

/// Solid state color used for badges/dots (ported STATE_COLORS).
func linearStateColor(_ stateType: String?) -> Color {
  switch linearNormalizedStateType(stateType) {
  case "started": return linearColor(0xF2C94C)
  case "completed": return linearColor(0x5E6AD2)
  case "triage": return linearColor(0xF2994A)
  default: return linearColor(0x94A3B8) // backlog / unstarted / canceled
  }
}

/// "Urgent" / "High" / … label for a Linear priority int.
func linearPriorityLabel(_ priority: Int?) -> String? {
  switch priority {
  case 1: return "Urgent"
  case 2: return "High"
  case 3: return "Medium"
  case 4: return "Low"
  default: return nil
  }
}

/// A Linear hex color (`#5e6ad2` or `5e6ad2`), or nil when it does not parse.
func linearHexColor(_ raw: String?) -> Color? {
  guard var hex = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !hex.isEmpty else { return nil }
  if hex.hasPrefix("#") { hex.removeFirst() }
  if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
  guard hex.count == 6, let value = UInt(hex, radix: 16) else { return nil }
  return linearColor(value)
}

// MARK: - Sub-issue progress ring

/// Linear's sub-issue progress: a small ring filling as sub-issues close, with
/// `done/total` beside it.
struct LinearProgressRing: View {
  let progress: LinearSubIssueProgress
  @ScaledMetric(relativeTo: .caption2) private var ringSize: CGFloat = 11

  private var fraction: Double {
    progress.total == 0 ? 0 : min(1, Double(progress.done) / Double(progress.total))
  }

  private var complete: Bool { progress.total > 0 && progress.done >= progress.total }

  var body: some View {
    HStack(spacing: 4) {
      ZStack {
        Circle()
          .stroke(ADEColor.textMuted.opacity(0.35), lineWidth: max(1.5, ringSize * 0.16))
        Circle()
          .trim(from: 0, to: fraction)
          .stroke(
            complete ? linearStateColor("completed") : LinearBrand.primaryBright,
            style: StrokeStyle(lineWidth: max(1.5, ringSize * 0.16), lineCap: .round)
          )
          .rotationEffect(.degrees(-90))
      }
      .frame(width: ringSize, height: ringSize)
      Text(verbatim: "\(progress.done)/\(progress.total)\(progress.capped ? "+" : "")")
        .font(.caption2.weight(.medium).monospacedDigit())
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize()
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(linearProgressAccessibilityLabel(progress))
  }
}

func linearProgressAccessibilityLabel(_ progress: LinearSubIssueProgress) -> String {
  let total = progress.capped ? "at least \(progress.total)" : "\(progress.total)"
  return "Sub-issues: \(progress.done) of \(total) done"
}

// MARK: - Pull request chip

/// The pull requests Linear linked to an issue: `#123` colored by its state,
/// or `3 PRs`. Tapping opens the pull request (a menu when there are several).
struct LinearPrChip: View {
  let pullRequests: [LinearIssuePullRequest]
  /// False where the row itself is the button (attach mode): a plain label.
  var interactive = true
  @Environment(\.openURL) private var openURL

  /// Pull requests that carry a link the phone can open.
  static func visible(_ pullRequests: [LinearIssuePullRequest]?) -> [LinearIssuePullRequest] {
    (pullRequests ?? []).filter { pr in
      guard let url = pr.url, !url.isEmpty else { return false }
      return URL(string: url) != nil
    }
  }

  var body: some View {
    let prs = Self.visible(pullRequests)
    if prs.count == 1, let pr = prs.first {
      if interactive, let url = pr.url.flatMap(URL.init(string:)) {
        Button { openURL(url) } label: { chipLabel(for: prs) }
          .buttonStyle(.borderless)
          .accessibilityLabel(linearPrAccessibilityLabel(prs))
          .accessibilityHint("Opens the pull request")
      } else {
        chipLabel(for: prs)
          .accessibilityElement(children: .ignore)
          .accessibilityLabel(linearPrAccessibilityLabel(prs))
      }
    } else if prs.count > 1 {
      if interactive {
        Menu {
          ForEach(Array(prs.enumerated()), id: \.offset) { _, pr in
            if let url = pr.url.flatMap(URL.init(string:)) {
              Button {
                openURL(url)
              } label: {
                // A menu row reads a Label then a Text as title and subtitle.
                Label(linearPrMenuTitle(pr), systemImage: prStateSymbol(linearPrState(pr)))
                Text(linearPrMenuSubtitle(pr))
              }
            }
          }
        } label: {
          chipLabel(for: prs)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(linearPrAccessibilityLabel(prs))
        .accessibilityHint("Shows the pull requests")
      } else {
        chipLabel(for: prs)
          .accessibilityElement(children: .ignore)
          .accessibilityLabel(linearPrAccessibilityLabel(prs))
      }
    }
  }

  private func chipLabel(for prs: [LinearIssuePullRequest]) -> some View {
    let state = prs.count == 1 ? linearPrState(prs[0]) : linearPrCombinedState(prs)
    let tint = (state == "draft" || state == "unknown") ? ADEColor.textSecondary : prStateColor(state)
    let title = prs.count == 1 ? (prs[0].number.map { "#\($0)" } ?? "PR") : "\(prs.count) PRs"
    return HStack(spacing: 3) {
      Image(systemName: prStateSymbol(state))
        .font(.caption2.weight(.semibold))
      Text(title)
        .font(.caption2.weight(.semibold).monospacedDigit())
        .lineLimit(1)
    }
    .foregroundStyle(tint)
    .padding(.horizontal, 6)
    .padding(.vertical, 2)
    .background(tint.opacity(0.12), in: Capsule())
    .fixedSize()
    .contentShape(Capsule())
  }
}

/// "open" | "draft" | "merged" | "closed" | "unknown".
func linearPrState(_ pr: LinearIssuePullRequest) -> String {
  let raw = pr.status?.lowercased() ?? "unknown"
  return ["open", "draft", "merged", "closed"].contains(raw) ? raw : "unknown"
}

/// One state for several PRs: open work wins, then drafts, then merged.
func linearPrCombinedState(_ prs: [LinearIssuePullRequest]) -> String {
  let states = Set(prs.map { linearPrState($0) })
  for state in ["open", "draft", "merged", "closed"] where states.contains(state) {
    return state
  }
  return "unknown"
}

/// `#2588 Keep the thread`.
func linearPrMenuTitle(_ pr: LinearIssuePullRequest) -> String {
  let number = pr.number.map { "#\($0)" } ?? "PR"
  guard let title = pr.title, !title.isEmpty else { return number }
  return "\(number) \(title)"
}

/// `Open · arul28/ADE`.
func linearPrMenuSubtitle(_ pr: LinearIssuePullRequest) -> String {
  var parts: [String] = []
  let state = linearPrState(pr)
  if state != "unknown" { parts.append(state.capitalized) }
  if let repo = pr.repo, !repo.isEmpty { parts.append(repo) }
  return parts.joined(separator: " \u{00B7} ")
}

func linearPrAccessibilityLabel(_ prs: [LinearIssuePullRequest]) -> String {
  if prs.count == 1, let pr = prs.first {
    let number = pr.number.map { "Pull request \($0)" } ?? "Pull request"
    let state = linearPrState(pr)
    return state == "unknown" ? number : "\(number), \(state)"
  }
  return "\(prs.count) pull requests"
}

// MARK: - Avatars

/// A Linear person or agent: their picture, or initials on a tinted circle
/// while it loads or when there is none.
struct LinearAvatar: View {
  let name: String?
  let avatarUrl: String?
  var size: CGFloat = 20

  var body: some View {
    Group {
      if let url = avatarUrl.flatMap(URL.init(string:)) {
        AsyncImage(url: url) { phase in
          if let image = phase.image {
            image.resizable().scaledToFill()
          } else {
            initials
          }
        }
      } else {
        initials
      }
    }
    .frame(width: size, height: size)
    .clipShape(Circle())
    .overlay(Circle().stroke(ADEColor.border.opacity(0.6), lineWidth: 0.5))
  }

  private var tint: Color {
    let palette: [UInt] = [0x5E6AD2, 0x26B5CE, 0x4CB782, 0xF2994A, 0xEB5757, 0xBB87FC, 0xF2C94C]
    let seed = (name ?? "").unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }
    return linearColor(palette[seed % palette.count])
  }

  private var initials: some View {
    let parts = (name ?? "").split(separator: " ").prefix(2)
    let letters = parts.compactMap { $0.first.map { String($0) } }.joined().uppercased()
    return ZStack {
      Circle().fill(tint.opacity(0.22))
      Text(letters.isEmpty ? "?" : letters)
        .font(.system(size: size * (letters.count > 1 ? 0.38 : 0.48), weight: .semibold, design: .rounded))
        .foregroundStyle(tint)
        .minimumScaleFactor(0.5)
    }
  }
}

/// The row's people: the assignee (a dashed circle when unassigned) and, when
/// the issue is delegated, the agent with a small sparkle badge.
struct LinearAssigneeStack: View {
  let issue: NormalizedLinearIssue
  /// False when the list is grouped by assignee: the header already names them.
  var showsAssignee = true
  @ScaledMetric(relativeTo: .caption) private var scaledSize: CGFloat = 20
  /// Grows with text size, but stays a small mark at the accessibility sizes.
  private var size: CGFloat { min(scaledSize, 28) }

  private var assigneeName: String? {
    guard let name = issue.assigneeName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return nil }
    return name
  }

  private var delegateName: String? {
    guard let name = issue.delegateName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return nil }
    return name
  }

  var body: some View {
    HStack(spacing: -size * 0.3) {
      if !showsAssignee {
        EmptyView()
      } else if let assigneeName {
        LinearAvatar(name: assigneeName, avatarUrl: issue.assigneeAvatarUrl, size: size)
      } else if delegateName == nil {
        Image(systemName: "person.crop.circle.dashed")
          .font(.system(size: size * 0.9))
          .foregroundStyle(ADEColor.textMuted.opacity(0.7))
          .frame(width: size, height: size)
      }
      if let delegateName {
        LinearAvatar(name: delegateName, avatarUrl: issue.delegateAvatarUrl, size: size)
          .background(Circle().fill(ADEColor.pageBackground).padding(-1.5))
          .overlay(alignment: .bottomTrailing) {
            Image(systemName: "sparkle")
              .font(.system(size: size * 0.32, weight: .bold))
              .foregroundStyle(.white)
              .padding(size * 0.06)
              .background(LinearBrand.primary, in: Circle())
              .offset(x: size * 0.12, y: size * 0.12)
          }
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityText)
  }

  private var accessibilityText: String {
    var parts: [String] = [assigneeName.map { "Assigned to \($0)" } ?? "Unassigned"]
    if let delegateName { parts.append("delegated to \(delegateName)") }
    return parts.joined(separator: ", ")
  }
}

// MARK: - Labels

/// The first label as Linear draws it (colored dot, name) and `+N` for the rest.
struct LinearLabelSummary: View {
  let issue: NormalizedLinearIssue

  private var names: [String] { (issue.labels ?? []).filter { !$0.isEmpty } }

  var body: some View {
    let names = self.names
    if let first = names.first {
      HStack(spacing: 4) {
        Circle()
          .fill(linearHexColor(issue.labelColors?.first { $0.name == first }?.color) ?? ADEColor.textMuted)
          .frame(width: 7, height: 7)
        // A long label name is cut here so the chip keeps a steady width.
        Text(first.count > 18 ? String(first.prefix(17)) + "\u{2026}" : first)
          .font(.caption2.weight(.medium))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
        if names.count > 1 {
          Text("+\(names.count - 1)")
            .font(.caption2.weight(.medium).monospacedDigit())
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .padding(.horizontal, 6)
      .padding(.vertical, 2)
      .overlay(Capsule().stroke(ADEColor.border.opacity(0.8), lineWidth: 0.5))
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(names.count == 1 ? "Label \(first)" : "Labels \(names.joined(separator: ", "))")
    }
  }
}
