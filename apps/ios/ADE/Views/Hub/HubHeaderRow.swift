import SwiftUI

/// The Hub's header as a row of its own: the title (the ADE mark with the
/// machines) on the left, then Activity, Chats and Settings in one glass group
/// and Add on its own — the same items, glyphs and grouping as `HubToolbar`.
/// Used wherever the Hub's header is not an edge-bar toolbar, so it can sit
/// under the status bar and span the screen instead of sharing the status
/// bar's row: the phone, the Duo's outer display, the inner display held
/// upright, an iPad.
struct HubHeaderRow<Title: View>: View {
  let actions: HubToolbarActions
  @ViewBuilder var title: () -> Title
  @EnvironmentObject private var drawer: ActivityDrawerModel
  @Environment(\.hubHeaderInline) private var inline

  var body: some View {
    if inline {
      // Beside the clock the band is as wide as the status block leaves it:
      // a call, a timer or a recording widens the block and narrows the band.
      // Each step gives up a little more, and every control stays in the row.
      ViewThatFits(in: .horizontal) {
        row(.inlineBrand)
        row(.inline)
        row(.inlineGrouped)
        row(.inlineTight)
        row(.inlineTightest)
      }
    } else {
      row(.full)
    }
  }

  @ViewBuilder
  private func row(_ tier: HubHeaderTier) -> some View {
    GlassEffectContainer(spacing: tier.spacing) {
      HStack(spacing: tier.spacing) {
        if tier.titleSharesCapsule {
          // The tightest bands: the machines and the icons in one capsule.
          HStack(spacing: 0) {
            titleView(tier)
              .padding(.leading, 4)
            icons(tier)
          }
          .padding(.trailing, 2)
          .glassEffect(.regular.interactive(), in: .capsule)
        } else {
          // On a narrow phone the machine's name truncates; the icons have
          // fixed frames and keep theirs.
          titleView(tier)
            .padding(.horizontal, tier.titlePadding)
            .glassEffect(.regular.interactive(), in: .capsule)
            .layoutPriority(tier.titlePriority)
          Spacer(minLength: 0)
          HStack(spacing: 0) {
            icons(tier)
            if tier.addPlacement == .group { addButton(tier) }
          }
          .padding(.horizontal, tier.iconGroupPadding)
          .glassEffect(.regular.interactive(), in: .capsule)
          .layoutPriority(tier.iconsPriority)
          if tier.addPlacement == .own {
            addButton(tier)
              .glassEffect(.regular.interactive(), in: .circle)
              .layoutPriority(tier.iconsPriority)
          }
        }
      }
    }
    .frame(height: tier.height)
  }

  private func titleView(_ tier: HubHeaderTier) -> some View {
    title()
      .frame(height: tier.height)
      .environment(\.hubHeaderTier, tier)
      // With no room for its own button, Add is in the machines menu.
      .environment(\.hubHeaderMenuAdd, tier.addPlacement == .menu ? actions.onAdd : nil)
  }

  @ViewBuilder
  private func icons(_ tier: HubHeaderTier) -> some View {
    icon("bell", tier: tier, badge: drawer.unreadCount, action: actions.onOpenActivity)
      .accessibilityLabel(
        drawer.unreadCount > 0
          ? "Activity, \(drawer.unreadCount) \(drawer.unreadCount == 1 ? "item needs" : "items need") you"
          : "Activity"
      )
      .accessibilityHint("Opens the Activity drawer.")
    icon(
      "bubble.left.and.bubble.right",
      tier: tier,
      badge: actions.chatsAvailable ? actions.chatsAttentionCount : 0,
      action: actions.onOpenChats
    )
    .disabled(!actions.chatsAvailable)
    .accessibilityLabel(actions.chatsAttentionCount > 0
      ? "Chats, \(actions.chatsAttentionCount) awaiting input"
      : "Chats")
    .accessibilityHint("Opens conversations that are not linked to a project.")
    icon("gearshape", tier: tier, action: actions.onOpenSettings)
      .accessibilityLabel("Settings")
  }

  private func addButton(_ tier: HubHeaderTier) -> some View {
    icon("plus", tier: tier, action: actions.onAdd)
      .accessibilityLabel("Add project")
      .accessibilityHint("Adds a project from one of your machines.")
  }

  private func icon(_ symbol: String, tier: HubHeaderTier, badge: Int = 0, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: tier.glyphSize, weight: .regular))
        // The tier fits at `iconWidth` (`ViewThatFits` measures the ideal);
        // laid out, each icon grows into the spare width up to `iconMaxWidth`.
        .frame(minWidth: tier.iconWidth, idealWidth: tier.iconWidth, maxWidth: tier.iconMaxWidth)
        .frame(height: tier.height)
        .contentShape(Rectangle())
        .overlay(alignment: .topTrailing) {
          if badge > 0 {
            Text(badge > 99 ? "99+" : "\(badge)")
              .font(.caption2.weight(.semibold).monospacedDigit())
              .foregroundStyle(.white)
              .padding(.horizontal, 5)
              .frame(minWidth: 18, minHeight: 18)
              .background(Color.red, in: Capsule())
              .offset(tier.badgeOffset)
              .accessibilityHidden(true)
          }
        }
    }
    .buttonStyle(.plain)
    .foregroundStyle(ADEColor.textPrimary)
  }
}

/// How much room the Hub's header row has. `.full` is a row of its own under
/// the status bar; the others sit in the band beside the clock on the Duo's
/// outer display, from the roomiest to the tightest.
enum HubHeaderTier: Equatable {
  case full
  /// The wordmark, the machines glyph, the icon group, and Add on its own.
  case inlineBrand
  /// No wordmark.
  case inline
  /// Add joins the icon group.
  case inlineGrouped
  /// Add moves into the machines menu, so the other icons keep their size.
  case inlineTight
  /// The machines and the icons share one capsule, and the machine count
  /// moves into the menu.
  case inlineTightest

  enum AddPlacement { case own, group, menu }

  var height: CGFloat {
    self == .full ? 48 : 40
  }

  /// The narrowest an icon gets in this tier: the width the tier is measured
  /// at when the row picks one.
  var iconWidth: CGFloat {
    switch self {
    case .full: return 48
    case .inlineBrand, .inline: return 40
    case .inlineGrouped, .inlineTight: return 36
    case .inlineTightest: return 34
    }
  }

  /// The widest an icon grows into spare room beside it. Wider than this and
  /// the icons drift apart; the rest of the band stays a gap.
  var iconMaxWidth: CGFloat {
    self == .full ? 48 : 44
  }

  /// One glyph size beside the clock: a narrower band takes width between the
  /// icons, never the icons' size.
  var glyphSize: CGFloat {
    self == .full ? 19 : 17
  }

  var spacing: CGFloat {
    self == .full ? 12 : 6
  }

  var titlePadding: CGFloat {
    self == .full ? 10 : 6
  }

  var iconGroupPadding: CGFloat {
    self == .full ? 4 : 0
  }

  /// Beside the clock the title keeps its size first, then the icons take
  /// the band's spare width before any gap does. A row of its own has room
  /// for all of them.
  var titlePriority: Double {
    self == .full ? 0 : 2
  }

  var iconsPriority: Double {
    self == .full ? 0 : 1
  }

  /// Where an icon's badge sits on its corner.
  var badgeOffset: CGSize {
    self == .full ? CGSize(width: -2, height: 4) : CGSize(width: 2, height: 0)
  }

  var addPlacement: AddPlacement {
    switch self {
    case .full, .inlineBrand, .inline: return .own
    case .inlineGrouped: return .group
    case .inlineTight, .inlineTightest: return .menu
    }
  }

  var showsBrand: Bool { self == .inlineBrand }
  var showsMachineCount: Bool { self != .inlineTightest }
  var titleSharesCapsule: Bool { self == .inlineTightest }
}
