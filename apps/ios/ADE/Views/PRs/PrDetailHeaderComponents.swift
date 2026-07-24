import SwiftUI

/// PR description rendered as the first card of the thread.
struct PrThreadDescriptionCard: View {
  let author: String?
  private let blocks: [PrGitHubDescriptionBlock]
  @State private var expandedDisclosureIds: Set<String> = []

  init(author: String?, text: String) {
    self.author = author
    blocks = parsePrGitHubDescriptionBlocks(text)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text("Description")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 0)
        if let author, !author.isEmpty {
          Text("@\(author)")
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
      }

      Divider().overlay(PrGlassPalette.cardBorder)

      ForEach(blocks) { block in
        switch block {
        case .markdown(_, let markdown):
          PrMarkdownRenderer(markdown: markdown)
        case .disclosure(let id, let title, let markdown):
          DisclosureGroup(isExpanded: disclosureBinding(for: id)) {
            PrMarkdownRenderer(markdown: markdown)
              .padding(.top, 8)
          } label: {
            Text(title)
              .font(.system(size: 14, weight: .semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
              .contentShape(Rectangle())
          }
          .tint(ADEColor.textSecondary)
          .accessibilityValue(expandedDisclosureIds.contains(id) ? "Expanded" : "Collapsed")
        }
      }
    }
    .padding(.horizontal, 4)
    .padding(.vertical, 4)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func disclosureBinding(for id: String) -> Binding<Bool> {
    Binding(
      get: { expandedDisclosureIds.contains(id) },
      set: { expanded in
        if expanded {
          expandedDisclosureIds.insert(id)
        } else {
          expandedDisclosureIds.remove(id)
        }
      }
    )
  }
}

/// Compact mobile summary that replaces the old PR hero card. It keeps the
/// state/actions context above the thread without forcing a large title card at
/// the top of every detail screen.
struct PrDetailSummarySection: View {
  let pr: PullRequestListItem
  let snapshot: PullRequestSnapshot?
  let mergeGate: PrMergeGateInfo
  @Binding var commitsExpanded: Bool
  let onChecksTap: () -> Void
  let onFilesTap: () -> Void
  let onCommitTap: (PrCommit) -> Void

  private var state: String { snapshot?.status?.state ?? pr.state }
  private var stateTint: Color { prStateTint(state) }
  private var checksStatus: String { snapshot?.status?.checksStatus ?? pr.checksStatus }
  private var files: [PrFile] { snapshot?.files ?? [] }
  private var commits: [PrCommit] { snapshot?.commits ?? [] }

  private var additions: Int {
    files.isEmpty ? pr.additions : files.reduce(0) { $0 + $1.additions }
  }

  private var deletions: Int {
    files.isEmpty ? pr.deletions : files.reduce(0) { $0 + $1.deletions }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .center, spacing: 8) {
        PrTagChip(label: state.isEmpty ? "unknown" : state, color: stateTint)
        Text(mergeGate.subline)
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 14)
      .padding(.top, 13)
      .padding(.bottom, 10)

      Divider().overlay(PrGlassPalette.cardBorder)

      HStack(spacing: 0) {
        PrSummaryMetricButton(
          title: "Checks",
          value: prChecksLabel(checksStatus),
          tint: prChecksTint(checksStatus),
          action: onChecksTap
        )

        PrSummaryMetricDivider()

        PrSummaryMetricButton(
          title: "Changes",
          value: "\(files.count) file\(files.count == 1 ? "" : "s")",
          detail: "+\(additions) / −\(deletions)",
          tint: ADEColor.info,
          action: onFilesTap
        )

        PrSummaryMetricDivider()

        PrSummaryMetricButton(
          title: "Commits",
          value: "\(commits.count) commit\(commits.count == 1 ? "" : "s")",
          tint: ADEColor.accent,
          isExpanded: commits.isEmpty ? nil : commitsExpanded,
          action: {
            guard !commits.isEmpty else { return }
            withAnimation(.easeInOut(duration: 0.18)) {
              commitsExpanded.toggle()
            }
          }
        )
      }

      if commitsExpanded, !commits.isEmpty {
        Divider().overlay(PrGlassPalette.cardBorder)
        VStack(spacing: 0) {
          ForEach(Array(commits.prefix(25).enumerated()), id: \.element.id) { index, commit in
            PrSummaryCommitRow(commit: commit) {
              onCommitTap(commit)
            }
            if index < min(commits.count, 25) - 1 {
              Divider()
                .padding(.leading, 14)
                .overlay(PrGlassPalette.cardBorder)
            }
          }
          if commits.count > 25 {
            Divider()
              .padding(.leading, 14)
              .overlay(PrGlassPalette.cardBorder)
            Text("+ \(commits.count - 25) older commits")
              .font(.system(size: 11, design: .monospaced))
              .foregroundStyle(ADEColor.textMuted)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.horizontal, 14)
              .padding(.vertical, 10)
          }
        }
        .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .prGlassCard(cornerRadius: 16)
  }
}

struct PrDetailSummarySkeleton: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 10) {
        ADESkeletonView(width: 58, height: 22, cornerRadius: 7)
        ADESkeletonView(width: 190, height: 13, cornerRadius: 5)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 13)

      Divider().overlay(PrGlassPalette.cardBorder)

      HStack(spacing: 0) {
        ForEach(0..<3, id: \.self) { index in
          VStack(alignment: .leading, spacing: 6) {
            ADESkeletonView(width: 48, height: 10, cornerRadius: 4)
            ADESkeletonView(width: index == 1 ? 68 : 58, height: 14, cornerRadius: 4)
          }
          .frame(maxWidth: .infinity, minHeight: 58, alignment: .leading)
          .padding(.horizontal, 12)
          .padding(.vertical, 10)

          if index < 2 {
            PrSummaryMetricDivider()
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .prGlassCard(cornerRadius: 16)
  }
}

private struct PrSummaryMetricButton: View {
  let title: String
  let value: String
  var detail: String?
  let tint: Color
  var isExpanded: Bool? = nil
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 4) {
          Text(title)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
          Spacer(minLength: 0)
          if let isExpanded {
            Image(systemName: "chevron.right")
              .font(.system(size: 9, weight: .semibold))
              .foregroundStyle(ADEColor.textMuted)
              .rotationEffect(.degrees(isExpanded ? 90 : 0))
          }
        }
        Text(value)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(tint)
          .lineLimit(1)
          .minimumScaleFactor(0.75)
        if let detail, !detail.isEmpty {
          Text(detail)
            .font(.system(size: 10.5))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, minHeight: 58, alignment: .topLeading)
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

private struct PrSummaryMetricDivider: View {
  var body: some View {
    Rectangle()
      .fill(PrGlassPalette.cardBorder)
      .frame(width: 1, height: 44)
  }
}

private struct PrSummaryCommitRow: View {
  let commit: PrCommit
  let action: () -> Void

  private var author: String? {
    commit.authorLogin ?? commit.authorName
  }

  private var message: String {
    commit.message
      .split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
      .first
      .map(String.init)?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      ?? "Commit"
  }

  private var shortSha: String {
    commit.shortSha.isEmpty ? String(commit.sha.prefix(7)) : commit.shortSha
  }

  var body: some View {
    Button(action: action) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: "smallcircle.filled.circle")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(prChecksTint(commit.checkStatus ?? "none"))
          .frame(width: 15, height: 18)
        VStack(alignment: .leading, spacing: 3) {
          Text(message)
            .font(.system(size: 12.5, weight: .medium))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)
          HStack(spacing: 7) {
            Text(shortSha)
              .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
              .foregroundStyle(ADEColor.accent)
            if let author, !author.isEmpty {
              Text(author)
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(1)
            }
            Spacer(minLength: 0)
            Text(prCompactRelativeTime(commit.committedDate))
              .font(.system(size: 10.5, design: .monospaced))
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        Image(systemName: "arrow.down.to.line.compact")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
          .padding(.top, 2)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

/// Amber banner shown at the top of the thread when the PR is not mapped to an
/// ADE lane. Primary action is auto-map ("Create lane from PR branch", gated on
/// host support); mapping to an existing lane and opening GitHub stay available
/// without leaving the full detail view.
struct PrUnmappedThreadBanner: View {
  let canAutoMap: Bool
  let canMap: Bool
  @Binding var isExpanded: Bool
  let onAutoMap: () -> Void
  let onMap: () -> Void
  let onOpenInGitHub: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        withAnimation(.easeInOut(duration: 0.18)) {
          isExpanded.toggle()
        }
      } label: {
        HStack(spacing: 10) {
          Image(systemName: "exclamationmark.triangle.fill")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.warning)
          Text("Not mapped to a lane")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Spacer(minLength: 0)
          Image(systemName: "chevron.right")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
            .rotationEffect(.degrees(isExpanded ? 90 : 0))
        }
        .padding(.horizontal, 13)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Not mapped to a lane")
      .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
      .accessibilityHint(isExpanded ? "Collapses lane mapping actions" : "Shows lane mapping actions")

      if isExpanded {
        Divider().overlay(ADEColor.warning.opacity(0.22))

        VStack(alignment: .leading, spacing: 0) {
          Text("Connect this GitHub branch to an ADE lane to unlock local actions.")
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 13)
            .padding(.vertical, 10)

          if canAutoMap {
            PrUnmappedActionRow(
              title: "Create lane from PR branch",
              systemImage: "arrow.triangle.branch",
              tint: ADEColor.accent,
              action: onAutoMap
            )
          }

          if canMap {
            PrUnmappedActionRow(
              title: "Map to existing lane",
              systemImage: "link",
              tint: ADEColor.accent,
              action: onMap
            )
          }

          PrUnmappedActionRow(
            title: "Open in GitHub",
            systemImage: "arrow.up.right.square",
            trailingSystemImage: "arrow.up.right",
            tint: ADEColor.textSecondary,
            action: onOpenInGitHub
          )
        }
        .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ADEColor.warning.opacity(0.06), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 13, style: .continuous)
        .strokeBorder(ADEColor.warning.opacity(0.24), lineWidth: 0.7)
    )
  }
}

private struct PrUnmappedActionRow: View {
  let title: String
  let systemImage: String
  var trailingSystemImage = "chevron.right"
  let tint: Color
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Image(systemName: systemImage)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(tint)
          .frame(width: 18)
        Text(title)
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 0)
        Image(systemName: trailingSystemImage)
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 13)
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}
