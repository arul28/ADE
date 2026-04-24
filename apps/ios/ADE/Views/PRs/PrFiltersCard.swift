import SwiftUI

/// Slim flat filter bar for the PRs root. Two chip rows (state + scope) and a
/// compact sort menu chip — no wrapping card, no count header, no @author
/// line, no tri-toggle sort. Matches the PRs-tab design spec.
struct PrGitHubFiltersCard: View {
  @Binding var statusFilter: PrGitHubStatusFilter
  @Binding var scopeFilter: PrGitHubScopeFilter
  @Binding var sortOption: PrGitHubSortOption
  let counts: PrGitHubFilterCounts

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      // Scope first — "All / ADE / External" is the primary axis users
      // think about ("show me my work" vs "show me everything"). State
      // (Open/Draft/Merged/Closed) is the secondary refinement.
      PrScopeChipRow {
        ForEach(PrGitHubScopeFilter.allCases) { filter in
          PrGlassChip(
            label: scopeLabel(filter),
            count: scopeCount(filter),
            tint: scopeTint(filter),
            isActive: scopeFilter == filter,
            icon: scopeIcon(filter)
          ) {
            scopeFilter = filter
          }
        }
      }

      HStack(spacing: 8) {
        PrScopeChipRow {
          ForEach(PrGitHubStatusFilter.allCases) { filter in
            PrGlassChip(
              label: statusLabel(filter),
              count: statusCount(filter),
              tint: statusTint(filter),
              isActive: statusFilter == filter,
              icon: statusIcon(filter)
            ) {
              statusFilter = filter
            }
          }
        }

        Spacer(minLength: 0)

        sortMenu
      }
    }
  }

  @ViewBuilder
  private var sortMenu: some View {
    Menu {
      ForEach(PrGitHubSortOption.allCases) { option in
        Button(action: { sortOption = option }) {
          Text(option.title)
          if option == sortOption {
            Image(systemName: "checkmark")
          }
        }
      }
    } label: {
      sortMenuLabel
    }
    .menuStyle(.borderlessButton)
    .accessibilityLabel("Sort pull requests")
  }

  @ViewBuilder
  private var sortMenuLabel: some View {
    HStack(spacing: 5) {
      Image(systemName: "arrow.up.arrow.down")
        .font(.system(size: 9, weight: .bold))
      Text(sortOption.title)
        .font(.system(size: 11, weight: .semibold))
    }
    .foregroundStyle(PrsGlass.textSecondary)
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background(
      Capsule(style: .continuous)
        .fill(Color.white.opacity(0.05))
    )
    .overlay(
      Capsule(style: .continuous)
        .stroke(Color.white.opacity(0.10), lineWidth: 0.6)
    )
  }

  private func statusLabel(_ filter: PrGitHubStatusFilter) -> String {
    switch filter {
    case .open: return "Open"
    case .merged: return "Merged"
    case .closed: return "Closed"
    case .all: return "All"
    }
  }

  private func statusIcon(_ filter: PrGitHubStatusFilter) -> String {
    switch filter {
    case .open: return "arrow.triangle.pull"
    case .merged: return "arrow.merge"
    case .closed: return "xmark.circle"
    case .all: return "circle.dashed"
    }
  }

  private func statusTint(_ filter: PrGitHubStatusFilter) -> Color {
    switch filter {
    case .open: return PrsGlass.openTop
    case .merged: return PrsGlass.mergedTop
    case .closed: return PrsGlass.closedTop
    case .all: return PrsGlass.accentTop
    }
  }

  private func statusCount(_ filter: PrGitHubStatusFilter) -> Int {
    switch filter {
    case .open: return counts.open
    case .merged: return counts.merged
    case .closed: return counts.closed
    case .all: return counts.all
    }
  }

  private func scopeLabel(_ filter: PrGitHubScopeFilter) -> String {
    switch filter {
    case .all: return "All"
    case .ade: return "ADE"
    case .external: return "External"
    }
  }

  private func scopeIcon(_ filter: PrGitHubScopeFilter) -> String {
    switch filter {
    case .all: return "square.grid.2x2"
    case .ade: return "sparkles"
    case .external: return "arrow.up.right.square"
    }
  }

  private func scopeTint(_ filter: PrGitHubScopeFilter) -> Color {
    switch filter {
    case .all: return PrsGlass.textSecondary
    case .ade: return PrsGlass.accentTop
    case .external: return PrsGlass.externalTop
    }
  }

  private func scopeCount(_ filter: PrGitHubScopeFilter) -> Int {
    switch filter {
    case .all: return counts.all
    case .ade: return counts.ade
    case .external: return counts.external
    }
  }
}

/// Horizontal scroll container for chip rows with 6pt gaps.
struct PrScopeChipRow<Content: View>: View {
  @ViewBuilder let content: () -> Content

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        content()
      }
      .padding(.vertical, 1)
    }
  }
}

// MARK: - Liquid-glass filter chip.

struct PrGlassChip: View {
  let label: String
  let count: Int?
  let tint: Color
  let isActive: Bool
  var icon: String? = nil
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        if let icon {
          Image(systemName: icon)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(isActive ? tint : PrsGlass.textSecondary)
        }
        Text(label)
          .font(.system(size: 11, weight: isActive ? .bold : .semibold))
          .foregroundStyle(isActive ? PrsGlass.textPrimary : PrsGlass.textSecondary)
          .lineLimit(1)

        if let count {
          Text("\(count)")
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .foregroundStyle(isActive ? tint : PrsGlass.textMuted)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background {
              Capsule(style: .continuous)
                .fill((isActive ? tint : PrsGlass.textMuted).opacity(0.16))
            }
        }
      }
      .padding(.horizontal, 11)
      .padding(.vertical, 6)
      .background {
        Capsule(style: .continuous)
          .fill(
            isActive
              ? AnyShapeStyle(
                  LinearGradient(
                    colors: [tint.opacity(0.33), tint.opacity(0.09)],
                    startPoint: .top,
                    endPoint: .bottom
                  )
                )
              : AnyShapeStyle(Color.white.opacity(0.06))
          )
      }
      .overlay {
        Capsule(style: .continuous)
          .stroke(
            isActive ? tint.opacity(0.55) : Color.white.opacity(0.10),
            lineWidth: 0.75
          )
      }
      .shadow(color: isActive ? tint.opacity(0.30) : .clear, radius: 8, x: 0, y: 2)
    }
    .buttonStyle(.plain)
  }
}

// MARK: - Surface toggle (GitHub vs Workflows).
//
// Liquid-glass segmented capsule rendered at the top of the PRs root. The
// active tab uses the purple accent gradient with a glow; the inactive tab is
// a muted glass pill. Counts are rendered as a compact trailing badge.

struct PrsSurfaceToggle: View {
  @Binding var selection: PrRootSurface
  let repoPrCount: Int
  let workflowCount: Int

  var body: some View {
    HStack(spacing: 4) {
      segment(for: .github, icon: "chevron.left.forwardslash.chevron.right", count: repoPrCount)
      segment(for: .workflows, icon: "point.3.filled.connected.trianglepath.dotted", count: workflowCount)
    }
    .padding(4)
    .background {
      Capsule(style: .continuous)
        .fill(Color.white.opacity(0.04))
    }
    .overlay {
      Capsule(style: .continuous)
        .stroke(Color.white.opacity(0.10), lineWidth: 0.75)
    }
  }

  @ViewBuilder
  private func segment(for surface: PrRootSurface, icon: String, count: Int) -> some View {
    let isActive = selection == surface
    Button {
      withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
        selection = surface
      }
    } label: {
      HStack(spacing: 6) {
        Image(systemName: icon)
          .font(.system(size: 11, weight: .bold))
        Text(surface.title)
          .font(.system(size: 13, weight: isActive ? .bold : .semibold))

        if count > 0 {
          Text("\(count)")
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background {
              Capsule(style: .continuous)
                .fill(Color.white.opacity(isActive ? 0.18 : 0.08))
            }
        }
      }
      .foregroundStyle(isActive ? PrsGlass.textPrimary : PrsGlass.textSecondary)
      .padding(.horizontal, 14)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity)
      .background {
        if isActive {
          Capsule(style: .continuous)
            .fill(
              LinearGradient(
                colors: [PrsGlass.accentTop.opacity(0.55), PrsGlass.accentBottom.opacity(0.95)],
                startPoint: UnitPoint(x: 0.15, y: 0.0),
                endPoint: UnitPoint(x: 0.85, y: 1.0)
              )
            )
            .shadow(color: PrsGlass.glowPurple.opacity(0.45), radius: 14, x: 0, y: 4)
        }
      }
      .overlay {
        if isActive {
          Capsule(style: .continuous)
            .strokeBorder(
              LinearGradient(
                colors: [Color.white.opacity(0.45), .clear],
                startPoint: .top,
                endPoint: .bottom
              ),
              lineWidth: 1
            )
        }
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(surface.title), \(count) items")
  }
}

// MARK: - Workflow kind filter pills (Queue / Integration / Rebase / All).

struct PrsWorkflowFilterPills: View {
  @Binding var selection: PrWorkflowKindFilter
  let counts: [String: Int]

  var body: some View {
    PrScopeChipRow {
      ForEach(PrWorkflowKindFilter.allCases) { filter in
        PrGlassChip(
          label: filter.title,
          count: countForFilter(filter),
          tint: tintFor(filter),
          isActive: selection == filter,
          icon: iconFor(filter)
        ) {
          withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
            selection = filter
          }
        }
      }
    }
  }

  private func countForFilter(_ filter: PrWorkflowKindFilter) -> Int? {
    let key = filter.rawValue
    return counts[key]
  }

  private func iconFor(_ filter: PrWorkflowKindFilter) -> String {
    switch filter {
    case .all: return "square.grid.2x2"
    case .queue: return "list.number"
    case .integration: return "arrow.triangle.merge"
    case .rebase: return "arrow.triangle.2.circlepath"
    }
  }

  private func tintFor(_ filter: PrWorkflowKindFilter) -> Color {
    switch filter {
    case .all: return PrsGlass.accentTop
    case .queue: return PrsGlass.openTop
    case .integration: return PrsGlass.externalTop
    case .rebase: return PrsGlass.draftTop
    }
  }
}

// MARK: - Liquid-glass segmented option (used for the sort row).

struct PrGlassSegment: View {
  let label: String
  let isActive: Bool
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(label)
        .font(.system(size: 11, weight: isActive ? .bold : .semibold))
        .foregroundStyle(isActive ? PrsGlass.textPrimary : PrsGlass.textSecondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background {
          if isActive {
            Capsule(style: .continuous)
              .fill(
                LinearGradient(
                  colors: [PrsGlass.accentTop.opacity(0.55), PrsGlass.accentBottom.opacity(0.85)],
                  startPoint: .topLeading,
                  endPoint: .bottomTrailing
                )
              )
              .shadow(color: PrsGlass.glowPurple.opacity(0.45), radius: 10, x: 0, y: 2)
          }
        }
        .overlay {
          if isActive {
            Capsule(style: .continuous)
              .strokeBorder(
                LinearGradient(
                  colors: [Color.white.opacity(0.45), .clear],
                  startPoint: .top,
                  endPoint: .bottom
                ),
                lineWidth: 1
              )
          }
        }
    }
    .buttonStyle(.plain)
  }
}
