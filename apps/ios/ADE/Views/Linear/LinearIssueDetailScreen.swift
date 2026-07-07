import SwiftUI

/// Issue detail: description, labels, properties, sub-issues, comments, and the
/// primary "Launch" action. Comments load lazily on appear.
struct LinearIssueDetailScreen: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.openURL) private var openURL

  let issue: NormalizedLinearIssue
  let hasLane: Bool

  @State private var comments: [LinearIssueComment] = []
  @State private var commentsPhase: LinearPaneStore.Phase = .idle

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        header
        if let description = issue.description, !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          Text(markdownAttributedString(description))
            .font(.subheadline)
            .foregroundStyle(ADEColor.textPrimary)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        labels
        propertiesCard
        subIssues
        activity
      }
      .padding(16)
      .padding(.bottom, 96)
    }
    .scrollContentBackground(.hidden)
    .navigationTitle(issue.identifier)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        if let url = issue.url.flatMap(URL.init(string:)) {
          Button {
            openURL(url)
          } label: {
            Image(systemName: "arrow.up.forward.square")
              .foregroundStyle(ADEColor.textSecondary)
          }
          .accessibilityLabel("Open in Linear")
        }
      }
    }
    .safeAreaInset(edge: .bottom) { launchBar }
    .task(id: issue.id) { await loadComments() }
  }

  // MARK: Header

  private var header: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(issue.title)
        .font(.title3.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .frame(maxWidth: .infinity, alignment: .leading)
      HStack(spacing: 10) {
        LinearStatusChip(stateType: issue.stateType, stateName: issue.stateName)
        if let priorityLabel = issue.priorityLabel ?? linearPriorityLabel(issue.priority) {
          HStack(spacing: 5) {
            LinearPriorityIcon(priority: issue.priority, size: 13)
            Text(priorityLabel).font(.caption.weight(.medium)).foregroundStyle(ADEColor.textSecondary)
          }
        }
        if hasLane {
          Label("Has lane", systemImage: "square.stack.3d.up.fill")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(LinearBrand.primaryBright)
        }
      }
    }
  }

  // MARK: Labels

  @ViewBuilder
  private var labels: some View {
    if let labels = issue.labels, !labels.isEmpty {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          ForEach(labels, id: \.self) { label in
            Text(label)
              .font(.caption2.weight(.medium))
              .foregroundStyle(ADEColor.textSecondary)
              .padding(.horizontal, 8)
              .padding(.vertical, 3)
              .background(ADEColor.surfaceBackground, in: Capsule())
              .overlay(Capsule().stroke(ADEColor.glassBorder, lineWidth: 0.5))
          }
        }
      }
    }
  }

  // MARK: Properties

  private var propertiesCard: some View {
    VStack(spacing: 0) {
      LinearPropertyRow(label: "Assignee", value: issue.assigneeName ?? "Unassigned")
      if let project = issue.projectName {
        LinearPropertyRow(label: "Project", value: project)
      }
      if let team = issue.teamName ?? issue.teamKey {
        LinearPropertyRow(label: "Team", value: team)
      }
      if let due = linearFormatDate(issue.dueDate) {
        LinearPropertyRow(label: "Due", value: due)
      }
      LinearPropertyRow(
        label: "Branch",
        value: linearIssueBranchName(identifier: issue.identifier, title: issue.title),
        monospaced: true
      )
      if issue.hasOpenBlockers == true {
        LinearPropertyRow(label: "Blockers", value: "Has open blockers", tint: ADEColor.warning)
      }
    }
    .adeGlassCard()
  }

  // MARK: Sub-issues

  @ViewBuilder
  private var subIssues: some View {
    if let children = issue.childIssues, !children.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        Text("Sub-issues")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        ForEach(children) { child in
          HStack(spacing: 8) {
            LinearStateIcon(stateType: child.stateType, size: 13)
            Text(child.identifier)
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textMuted)
            Text(child.title)
              .font(.caption)
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            Spacer()
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .adeGlassCard()
    }
  }

  // MARK: Activity / comments

  @ViewBuilder
  private var activity: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Comments")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textSecondary)
      switch commentsPhase {
      case .loading:
        ADESkeletonView(height: 12)
        ADESkeletonView(width: 200, height: 12)
      case .failed:
        Text("Couldn\u{2019}t load comments.")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
      default:
        if comments.isEmpty {
          Text("No comments yet.")
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
        } else {
          ForEach(comments) { comment in
            LinearCommentRow(comment: comment)
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  // MARK: Launch bar

  private var launchBar: some View {
    HStack(spacing: 10) {
      // "New lane" — creates a lane attached to the issue, no agent.
      NavigationLink(value: LinearRoute.launch(issue: issue, laneOnly: true)) {
        launchActionLabel(title: "New lane", systemImage: "link", filled: false)
      }
      .buttonStyle(.plain)
      // "Launch agent" — opens the chat/CLI launch config in a new attached lane.
      NavigationLink(value: LinearRoute.launch(issue: issue, laneOnly: false)) {
        launchActionLabel(title: "Launch agent", systemImage: "play.fill", filled: true)
      }
      .buttonStyle(.plain)
    }
    .padding(.horizontal, 16)
    .padding(.top, 10)
    .padding(.bottom, 8)
    .background(.ultraThinMaterial)
  }

  private func launchActionLabel(title: String, systemImage: String, filled: Bool) -> some View {
    HStack(spacing: 6) {
      Image(systemName: systemImage).font(.system(size: 12, weight: .semibold))
      Text(title).font(.subheadline.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.7)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 13)
    .background(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(filled ? LinearBrand.primary : Color.clear)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(filled ? Color.clear : LinearBrand.border, lineWidth: 1)
    )
    .foregroundStyle(filled ? .white : LinearBrand.primaryBright)
  }

  private func loadComments() async {
    commentsPhase = .loading
    do {
      comments = try await syncService.fetchLinearIssueComments(issueId: issue.id)
      commentsPhase = .loaded
    } catch {
      commentsPhase = .failed
    }
  }
}

// MARK: - Supporting rows

struct LinearStatusChip: View {
  let stateType: String?
  let stateName: String?

  var body: some View {
    HStack(spacing: 5) {
      LinearStateIcon(stateType: stateType, size: 13)
      Text(stateName ?? stateType?.capitalized ?? "\u{2014}")
        .font(.caption.weight(.medium))
        .foregroundStyle(ADEColor.textSecondary)
    }
  }
}

struct LinearPropertyRow: View {
  let label: String
  let value: String
  var monospaced = false
  var tint: Color = ADEColor.textPrimary

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Text(label)
        .font(.caption)
        .foregroundStyle(ADEColor.textMuted)
        .frame(width: 78, alignment: .leading)
      Text(value)
        .font(monospaced ? .caption.monospaced() : .caption)
        .foregroundStyle(tint)
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }
    .padding(.vertical, 7)
    .overlay(alignment: .bottom) {
      Divider().overlay(ADEColor.glassBorder.opacity(0.5))
    }
  }
}

struct LinearCommentRow: View {
  let comment: LinearIssueComment

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        Text(comment.userDisplayName ?? comment.userName ?? "Someone")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        if let date = linearFormatDate(comment.createdAt) {
          Text(date).font(.caption2).foregroundStyle(ADEColor.textMuted)
        }
      }
      Text(markdownAttributedString(comment.body))
        .font(.caption)
        .foregroundStyle(ADEColor.textPrimary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(11)
    .background(ADEColor.surfaceBackground.opacity(0.5), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
  }
}

// MARK: - Date helper

private let linearISOParsers: [ISO8601DateFormatter] = {
  let withFractional = ISO8601DateFormatter()
  withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  let plain = ISO8601DateFormatter()
  plain.formatOptions = [.withInternetDateTime]
  return [withFractional, plain]
}()

private let linearDisplayFormatter: DateFormatter = {
  let formatter = DateFormatter()
  formatter.dateStyle = .medium
  formatter.timeStyle = .none
  return formatter
}()

func linearFormatDate(_ raw: String?) -> String? {
  guard let raw, !raw.isEmpty else { return nil }
  for parser in linearISOParsers {
    if let date = parser.date(from: raw) {
      return linearDisplayFormatter.string(from: date)
    }
  }
  return nil
}
