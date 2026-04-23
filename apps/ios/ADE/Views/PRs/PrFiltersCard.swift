import SwiftUI

struct PrGitHubFiltersCard: View {
  let repo: GitHubRepoRef?
  let viewerLogin: String?
  let syncedAt: String?
  @Binding var statusFilter: PrGitHubStatusFilter
  @Binding var scopeFilter: PrGitHubScopeFilter
  @Binding var sortOption: PrGitHubSortOption
  let counts: PrGitHubFilterCounts
  let visibleCount: Int
  let totalCount: Int
  let isLive: Bool
  let onRefresh: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      header

      PrScopeChipRow {
        ForEach(PrGitHubStatusFilter.allCases) { filter in
          PrScopeChip(
            label: statusLabel(filter),
            count: statusCount(filter),
            isActive: statusFilter == filter
          ) {
            statusFilter = filter
          }
        }
      }

      PrScopeChipRow {
        ForEach(PrGitHubScopeFilter.allCases) { filter in
          PrScopeChip(
            label: scopeLabel(filter),
            count: scopeCount(filter),
            isActive: scopeFilter == filter
          ) {
            scopeFilter = filter
          }
        }
      }

      Picker("Sort", selection: $sortOption) {
        ForEach(PrGitHubSortOption.allCases) { option in
          Text(option.title).tag(option)
        }
      }
      .pickerStyle(.segmented)
    }
    .adeListCard()
  }

  @ViewBuilder
  private var header: some View {
    HStack(alignment: .top, spacing: 12) {
      VStack(alignment: .leading, spacing: 4) {
        Text("GitHub pull requests")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        HStack(spacing: 6) {
          PrMonoText(text: "\(visibleCount)/\(totalCount)", color: ADEColor.textSecondary, size: 10)
          if let repo {
            PrMonoText(text: "\(repo.owner)/\(repo.name)", color: ADEColor.textMuted, size: 10)
              .lineLimit(1)
              .truncationMode(.middle)
          }
          if let viewerLogin, !viewerLogin.isEmpty {
            PrMonoText(text: "@\(viewerLogin)", color: ADEColor.textMuted, size: 10)
              .lineLimit(1)
          }
          if let defaultBranch = repo?.defaultBranch, !defaultBranch.isEmpty {
            PrMonoText(text: "· \(defaultBranch)", color: ADEColor.textMuted, size: 10)
              .lineLimit(1)
          }
        }
      }
      Spacer(minLength: 0)
      Button(action: onRefresh) {
        Image(systemName: "arrow.clockwise")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(ADEColor.accent)
          .padding(8)
          .background(
            Circle().fill(ADEColor.accent.opacity(0.12))
          )
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Refresh GitHub pull requests")
    }
  }

  private func statusLabel(_ filter: PrGitHubStatusFilter) -> String {
    switch filter {
    case .open: return "Open"
    case .merged: return "Merged"
    case .closed: return "Closed"
    case .all: return "All"
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

  private func scopeCount(_ filter: PrGitHubScopeFilter) -> Int {
    switch filter {
    case .all: return counts.all
    case .ade: return counts.ade
    case .external: return counts.external
    }
  }
}

/// Horizontal scroll container for `PrScopeChip` rows with 6pt gaps per the design.
struct PrScopeChipRow<Content: View>: View {
  @ViewBuilder let content: () -> Content

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        content()
      }
    }
  }
}
