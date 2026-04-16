import SwiftUI

struct PrOverviewTab: View {
  let pr: PullRequestListItem
  let snapshot: PullRequestSnapshot?
  let actionAvailability: PrActionAvailability
  @Binding var mergeMethod: PrMergeMethodOption
  @Binding var reviewerInput: String
  let isLive: Bool
  let groupMembers: [PrGroupMemberSummary]
  let onMerge: () -> Void
  let onClose: () -> Void
  let onReopen: () -> Void
  let onRequestReviewers: () -> Void
  let onOpenGitHub: () -> Void
  let onArchiveLane: () -> Void
  let onDeleteBranch: () -> Void

  private var mergeable: Bool {
    (snapshot?.status?.isMergeable ?? true) && !(snapshot?.status?.mergeConflicts ?? false)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      PrDetailSectionCard("Description") {
        if let body = snapshot?.detail?.body, !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          PrMarkdownRenderer(markdown: body)
        } else {
          Text("No description was synced for this PR yet.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }

      PrDetailSectionCard("Overview") {
        VStack(alignment: .leading, spacing: 10) {
          HStack(spacing: 8) {
            ADEStatusPill(text: prChecksLabel(snapshot?.status?.checksStatus ?? pr.checksStatus), tint: prChecksTint(snapshot?.status?.checksStatus ?? pr.checksStatus))
            ADEStatusPill(text: prReviewLabel(snapshot?.status?.reviewStatus ?? pr.reviewStatus), tint: prReviewTint(snapshot?.status?.reviewStatus ?? pr.reviewStatus))
            if let cleanupState = pr.cleanupState, !cleanupState.isEmpty {
              ADEStatusPill(text: cleanupState.uppercased(), tint: ADEColor.warning)
            }
          }

          Text("Author: \(snapshot?.detail?.author.login ?? "Unknown")")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)

          if let detail = snapshot?.detail {
            if !detail.requestedReviewers.isEmpty {
              PrChipWrap(users: detail.requestedReviewers.map(\.login), tint: ADEColor.warning)
            }
            if !detail.labels.isEmpty {
              PrChipWrap(users: detail.labels.map(\.name), tint: ADEColor.accent)
            }
            if !detail.linkedIssues.isEmpty {
              Text(detail.linkedIssues.map { "#\($0.number) \($0.title)" }.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }

          if !groupMembers.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
              Text("Stack")
                .font(.caption.weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
              ForEach(groupMembers) { member in
                Text("\(member.position + 1). #\(member.githubPrNumber) · \(member.title)")
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)
              }
            }
          }
        }
      }

      PrDetailSectionCard("Merge readiness") {
        VStack(alignment: .leading, spacing: 10) {
          Label(
            mergeable ? "Ready to merge" : "Needs attention before merge",
            systemImage: mergeable ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
          )
          .foregroundStyle(mergeable ? ADEColor.success : ADEColor.warning)

          if let status = snapshot?.status {
            if status.mergeConflicts {
              Text("The host reported merge conflicts for this branch.")
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
            }
            if status.behindBaseBy > 0 {
              Text("This branch is \(status.behindBaseBy) commit\(status.behindBaseBy == 1 ? "" : "s") behind the base branch.")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }
        }
      }

      PrDetailSectionCard("Actions") {
        VStack(alignment: .leading, spacing: 12) {
          Picker("Merge strategy", selection: $mergeMethod) {
            ForEach(PrMergeMethodOption.allCases) { option in
              Text(option.shortTitle).tag(option)
            }
          }
          .pickerStyle(.menu)
          .adeInsetField()

          Text(mergeMethod.description)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)

          if actionAvailability.showsMerge {
            Button(mergeMethod.title) {
              onMerge()
            }
            .buttonStyle(.glassProminent)
            .tint(ADEColor.accent)
            .disabled(!isLive || !actionAvailability.mergeEnabled || !mergeable)
          }

          if actionAvailability.showsClose {
            Button("Close PR", role: .destructive) {
              onClose()
            }
            .buttonStyle(.glass)
            .disabled(!isLive)
          }

          if actionAvailability.showsReopen {
            Button("Reopen PR") {
              onReopen()
            }
            .buttonStyle(.glass)
            .disabled(!isLive)
          }

          if actionAvailability.showsRequestReviewers {
            TextField("Request reviewers (comma-separated)", text: $reviewerInput)
              .adeInsetField()
            Button("Request reviewers") {
              onRequestReviewers()
            }
            .buttonStyle(.glass)
            .disabled(!isLive || reviewerInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }

          Button("Open in GitHub") {
            onOpenGitHub()
          }
          .buttonStyle(.glass)
          .tint(ADEColor.textSecondary)
        }
      }

      if pr.state == "merged" {
        PrLaneCleanupBanner(laneName: pr.laneName, onArchive: onArchiveLane, onDeleteBranch: onDeleteBranch)
      }
    }
  }
}

struct PrHeaderCard: View {
  let pr: PullRequestListItem
  let transitionNamespace: Namespace.ID?

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 6) {
          Text(pr.title)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
            .adeMatchedGeometry(id: transitionNamespace == nil ? nil : "pr-title-\(pr.id)", in: transitionNamespace)
          Text("#\(pr.githubPrNumber) · \(pr.headBranch) → \(pr.baseBranch)")
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 8)
        ADEStatusPill(text: pr.state.uppercased(), tint: prStateTint(pr.state))
          .adeMatchedGeometry(id: transitionNamespace == nil ? nil : "pr-status-\(pr.id)", in: transitionNamespace)
      }

      HStack(spacing: 8) {
        if let laneName = pr.laneName, !laneName.isEmpty {
          ADEStatusPill(text: laneName.uppercased(), tint: ADEColor.textSecondary)
        }
        if let label = prAdeKindLabel(pr.adeKind) {
          ADEStatusPill(text: label, tint: ADEColor.accent)
        }
        Spacer(minLength: 0)
        Text("Updated \(prRelativeTime(pr.updatedAt))")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
    }
    .adeListCard()
    .accessibilityElement(children: .combine)
    .accessibilityLabel("PR #\(pr.githubPrNumber), \(pr.title), state \(pr.state)")
  }
}

struct PrDetailSectionCard<Content: View>: View {
  let title: String
  let content: Content

  init(_ title: String, @ViewBuilder content: () -> Content) {
    self.title = title
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      content
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

struct PrChipWrap: View {
  let users: [String]
  let tint: Color

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(users, id: \.self) { user in
          ADEStatusPill(text: user.uppercased(), tint: tint)
        }
      }
    }
  }
}

struct PrLaneCleanupBanner: View {
  let laneName: String?
  let onArchive: () -> Void
  let onDeleteBranch: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: "trash.circle.fill")
          .foregroundStyle(ADEColor.warning)
        VStack(alignment: .leading, spacing: 4) {
          Text("Lane cleanup")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text("\(laneName ?? "This lane") merged successfully. Clean it up now to archive it or delete its branch.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }

      HStack(spacing: 10) {
        Button("Archive lane") {
          onArchive()
        }
        .buttonStyle(.glass)

        Button("Delete branch") {
          onDeleteBranch()
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.warning)
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}
