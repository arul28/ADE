import SwiftUI

struct PrHeaderCard: View {
  let pr: PullRequestListItem
  let snapshot: PullRequestSnapshot?
  let transitionNamespace: Namespace.ID?
  @Binding var titleDraft: String
  @Binding var isEditingTitle: Bool
  let canUpdateTitle: Bool
  let onSaveTitle: () -> Void
  let onOpenGitHub: () -> Void
  let onOpenQueue: () -> Void
  let onOpenLane: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 6) {
          if isEditingTitle {
            TextField("PR title", text: $titleDraft)
              .textFieldStyle(.plain)
              .font(.headline)
              .adeInsetField()
          } else {
            Text(pr.title)
              .font(.headline)
              .foregroundStyle(ADEColor.textPrimary)
              .adeMatchedGeometry(id: transitionNamespace == nil ? nil : "pr-title-\(pr.id)", in: transitionNamespace)
          }

          Text("#\(pr.githubPrNumber) · \(pr.repoOwner)/\(pr.repoName)")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
          Text("\(pr.headBranch) → \(pr.baseBranch)")
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
        }

        Spacer(minLength: 8)

        VStack(alignment: .trailing, spacing: 6) {
          ADEStatusPill(text: pr.state.uppercased(), tint: prStateTint(pr.state))
            .adeMatchedGeometry(id: transitionNamespace == nil ? nil : "pr-status-\(pr.id)", in: transitionNamespace)
          if snapshot?.detail?.isDraft == true {
            ADEStatusPill(text: "DRAFT", tint: ADEColor.warning)
          }
        }
      }

      HStack(spacing: 10) {
        if canUpdateTitle {
          if isEditingTitle {
            Button("Save title") {
              onSaveTitle()
            }
            .buttonStyle(.glassProminent)
            .tint(ADEColor.accent)
          } else {
            Button("Edit title") {
              isEditingTitle = true
            }
            .buttonStyle(.glass)
          }
        }

        if pr.linkedGroupType == "queue", pr.linkedGroupId != nil {
          Button("Open queue") {
            onOpenQueue()
          }
          .buttonStyle(.glass)
        }

        if !pr.laneId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          Button("Open lane") {
            onOpenLane()
          }
          .buttonStyle(.glass)
        }

        Button("Open on GitHub") {
          onOpenGitHub()
        }
        .buttonStyle(.glass)
      }
    }
    .adeListCard()
  }
}

struct PrOverviewTab: View {
  let pr: PullRequestListItem
  let snapshot: PullRequestSnapshot?
  let actionAvailability: PrActionAvailability
  @Binding var mergeMethod: PrMergeMethodOption
  @Binding var bypassMergeGuards: Bool
  @Binding var reviewerInput: String
  @Binding var labelsInput: String
  @Binding var assigneesInput: String
  @Binding var reviewBody: String
  @Binding var selectedReviewEvent: String
  @Binding var bodyDraft: String
  @Binding var isEditingBody: Bool
  let isLive: Bool
  let canUpdateBody: Bool
  let canSetLabels: Bool
  let canSetAssignees: Bool
  let canSubmitReview: Bool
  let groupMembers: [PrGroupMemberSummary]
  let onMerge: () -> Void
  let onClose: () -> Void
  let onReopen: () -> Void
  let onRequestReviewers: () -> Void
  let onSetLabels: () -> Void
  let onSetAssignees: () -> Void
  let onSaveBody: () -> Void
  let onSubmitReview: () -> Void
  let onOpenGitHub: () -> Void
  let onArchiveLane: () -> Void
  let onDeleteBranch: () -> Void
  let onOpenLane: () -> Void
  let onOpenRebase: () -> Void
  let onOpenLinkedPr: (String) -> Void

  private var mergeable: Bool {
    (snapshot?.status?.isMergeable ?? true) && !(snapshot?.status?.mergeConflicts ?? false)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      PrDetailSectionCard("Description") {
        VStack(alignment: .leading, spacing: 10) {
          if isEditingBody {
            TextEditor(text: $bodyDraft)
              .frame(minHeight: 160)
              .adeInsetField(cornerRadius: 14, padding: 10)
            Button("Save description") {
              onSaveBody()
            }
            .buttonStyle(.glassProminent)
            .tint(ADEColor.accent)
            .disabled(!isLive || !canUpdateBody)
          } else if let body = snapshot?.detail?.body, !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            PrMarkdownRenderer(markdown: body)
          } else {
            Text("No description was synced for this PR yet.")
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
          }

          if canUpdateBody && !isEditingBody {
            Button("Edit description") {
              isEditingBody = true
            }
            .buttonStyle(.glass)
          }
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

          if let detail = snapshot?.detail {
            Text("Author: \(detail.author.login)")
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)

            if let milestone = detail.milestone, !milestone.isEmpty {
              Text("Milestone: \(milestone)")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }

            if !detail.linkedIssues.isEmpty {
              Text(detail.linkedIssues.map { "#\($0.number) \($0.title)" }.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }

          Text("Created \(prAbsoluteTime(pr.createdAt)) · Updated \(prAbsoluteTime(pr.updatedAt))")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)

          Text("+\(pr.additions) additions · -\(pr.deletions) deletions")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }

      PrDetailSectionCard("Assignees") {
        VStack(alignment: .leading, spacing: 10) {
          if let detail = snapshot?.detail, !detail.assignees.isEmpty {
            PrChipWrap(values: detail.assignees.map(\.login), tint: ADEColor.textSecondary)
          }

          TextField("Assignees (comma-separated)", text: $assigneesInput)
            .adeInsetField()

          Button("Save assignees") {
            onSetAssignees()
          }
          .buttonStyle(.glass)
          .disabled(!isLive || !canSetAssignees)

          if !canSetAssignees {
            disabledMetaNote("Assignee edits require a host that exposes `prs.setAssignees` to mobile sync.")
          }
        }
      }

      PrDetailSectionCard("Reviewers") {
        VStack(alignment: .leading, spacing: 10) {
          if let detail = snapshot?.detail, !detail.requestedReviewers.isEmpty {
            PrChipWrap(values: detail.requestedReviewers.map(\.login), tint: ADEColor.warning)
          }
          TextField("Request reviewers (comma-separated)", text: $reviewerInput)
            .adeInsetField()
          Button("Request reviewers") {
            onRequestReviewers()
          }
          .buttonStyle(.glass)
          .disabled(!isLive || reviewerInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }

      PrDetailSectionCard("Labels") {
        VStack(alignment: .leading, spacing: 10) {
          if let detail = snapshot?.detail, !detail.labels.isEmpty {
            PrChipWrap(values: detail.labels.map(\.name), tint: ADEColor.accent)
          }

          TextField("Labels (comma-separated)", text: $labelsInput)
            .adeInsetField()

          Button("Save labels") {
            onSetLabels()
          }
          .buttonStyle(.glass)
          .disabled(!isLive || !canSetLabels)

          if !canSetLabels {
            disabledMetaNote("Label edits are ready on mobile, but this host has not exposed them to sync yet.")
          }
        }
      }

      if !groupMembers.isEmpty {
        PrDetailSectionCard("Stack members") {
          VStack(alignment: .leading, spacing: 10) {
            ForEach(groupMembers) { member in
              Button {
                onOpenLinkedPr(member.prId)
              } label: {
                HStack {
                  Text("\(member.position + 1). #\(member.githubPrNumber)")
                    .font(.system(.caption, design: .monospaced))
                  Text(member.title)
                    .font(.caption)
                    .lineLimit(1)
                  Spacer(minLength: 0)
                  Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                }
                .foregroundStyle(ADEColor.textPrimary)
                .padding(.vertical, 6)
              }
              .buttonStyle(.plain)
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
            Text("Checks: \(prChecksLabel(status.checksStatus))")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
            Text("Reviews: \(prReviewLabel(status.reviewStatus))")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)

            if status.mergeConflicts {
              Text("The host reported merge conflicts for this branch.")
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
            }

            if status.behindBaseBy > 0 {
              HStack {
                Text("This branch is \(status.behindBaseBy) commit\(status.behindBaseBy == 1 ? "" : "s") behind the base branch.")
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)
                Spacer(minLength: 8)
                Button("Open rebase") {
                  onOpenRebase()
                }
                .buttonStyle(.glass)
              }
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

          if actionAvailability.showsMerge {
            Button(mergeMethod.title) {
              onMerge()
            }
            .buttonStyle(.glassProminent)
            .tint(ADEColor.accent)
            .disabled(!isLive || !actionAvailability.mergeEnabled || (!mergeable && !bypassMergeGuards))
          }

          if actionAvailability.showsMerge && !mergeable {
            Toggle("Attempt merge anyway if GitHub allows bypass rules", isOn: $bypassMergeGuards)
              .tint(ADEColor.warning)
              .font(.caption)
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

          Button("Open on GitHub") {
            onOpenGitHub()
          }
          .buttonStyle(.glass)
        }
      }

      PrDetailSectionCard("Submit review") {
        VStack(alignment: .leading, spacing: 10) {
          Picker("Review", selection: $selectedReviewEvent) {
            Text("Comment").tag("COMMENT")
            Text("Approve").tag("APPROVE")
            Text("Request changes").tag("REQUEST_CHANGES")
          }
          .pickerStyle(.segmented)

          TextEditor(text: $reviewBody)
            .frame(minHeight: 100)
            .adeInsetField(cornerRadius: 14, padding: 10)

          Button("Submit review") {
            onSubmitReview()
          }
          .buttonStyle(.glass)
          .disabled(!isLive || !canSubmitReview)

          if !canSubmitReview {
            disabledMetaNote("Review submission will activate when the host exposes `prs.submitReview` to mobile sync.")
          }
        }
      }

      if pr.state == "merged" || pr.state == "closed" {
        PrLaneCleanupBanner(laneName: pr.laneName, onArchive: onArchiveLane, onDeleteBranch: onDeleteBranch)
      }
    }
  }

  @ViewBuilder
  private func disabledMetaNote(_ text: String) -> some View {
    Label(text, systemImage: "sparkles")
      .font(.caption)
      .foregroundStyle(ADEColor.textSecondary)
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.surfaceBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
  }
}
