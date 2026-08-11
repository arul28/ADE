import SwiftUI

/// The row-badge socket: plugin badges appended to a row's existing trailing
/// cluster.
///
/// Placement is host-controlled and always AFTER the product's own signals —
/// a contribution never reorders or replaces core metadata, it only follows it.
/// Two badges show and the rest collapse into a count, which is what a dense
/// Lanes or PRs row can carry without pushing the branch pair off screen.
struct PluginRowBadgeCluster: View {
  let badges: PluginRowBadges

  init(_ badges: PluginRowBadges) {
    self.badges = badges
  }

  var body: some View {
    if !badges.isEmpty {
      HStack(spacing: 5) {
        ForEach(badges.visible) { contribution in
          if let badge = contribution.badge {
            badgeView(badge)
              .accessibilityLabel(badge.tooltip ?? badge.text)
          }
        }
        if badges.overflow > 0 {
          ADEGlassStatusBadge(text: "+\(badges.overflow)", tint: ADEColor.textMuted)
            .accessibilityLabel("\(badges.overflow) more plugin badges")
        }
      }
      .fixedSize(horizontal: true, vertical: false)
    }
  }

  @ViewBuilder
  private func badgeView(_ badge: PluginRowBadgePayload) -> some View {
    if let icon = badge.icon, PluginSymbol.exists(icon) {
      ADEGlassChip(icon: icon, text: badge.text, tint: badge.tone.color)
    } else {
      ADEGlassStatusBadge(text: badge.text, tint: badge.tone.color)
    }
  }
}

/// The row-menu-item socket: plugin entries appended to a row's context menu.
///
/// Placed after the row's own "go to" entries and before its destructive
/// section, which is deliberate — the deletes are fenced behind a divider
/// precisely so a mis-tap right after the menu opens cannot land on one, and a
/// plugin must not be able to push them back up under a moving finger.
///
/// `danger` styles the entry — SwiftUI paints a `.destructive` menu button in
/// the system's destructive colour, the same answer desktop gives it. It does
/// not move the entry into the fenced section below: the role changes how the
/// item reads, never where it sits, and where it sits stays the host's call.
///
/// The renderer owns gestures here, not the schema: menu entries only. A swipe
/// action would need a `List` (`.swipeActions` works nowhere else) and would
/// race the row's own long-press recognizer.
///
/// The section is drawn whole here — filter, empty guard and leading divider —
/// so a surface only has to say where the group goes. Left to the call sites,
/// Lanes and Work disagreed about the divider and about which contributions
/// count as menu items.
struct PluginRowMenuItems: View {
  let contributions: [PluginContribution]
  let isEnabled: Bool
  let onInvoke: (PluginContribution) -> Void

  var body: some View {
    let items = contributions.filter { $0.menuItem != nil }
    if !items.isEmpty {
      Divider()
      ForEach(items) { contribution in
        if let item = contribution.menuItem {
          Button(role: Self.role(for: item)) {
            onInvoke(contribution)
          } label: {
            if let icon = item.icon, PluginSymbol.exists(icon) {
              Label(item.label, systemImage: icon)
            } else {
              Text(item.label)
            }
          }
          .disabled(!isEnabled)
        }
      }
    }
  }

  /// A `danger` item asks for the product's destructive styling, which on a
  /// menu button is the role rather than a foreground colour — a `Menu` draws
  /// its own labels and ignores one.
  static func role(for item: PluginRowMenuItemPayload) -> ButtonRole? {
    item.danger ? .destructive : nil
  }
}

extension SyncService {
  /// Dispatch a row's plugin menu item. Fire-and-forget: a context menu has
  /// already dismissed by the time the call resolves, so there is nowhere to
  /// show a spinner and the outcome would land on a surface the user has left.
  func invokeRowContribution(_ contribution: PluginContribution) {
    guard let item = contribution.menuItem else { return }
    ADEHaptics.light()
    Task { [weak self] in
      try? await self?.invokePluginAction(
        pluginId: contribution.pluginId,
        actionId: item.actionId,
        payload: [
          "entityKind": contribution.entityKind.rawValue,
          "entityId": contribution.entityId,
        ]
      )
    }
  }
}
