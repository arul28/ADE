import SwiftUI
import UIKit

func workPlanResolvedProvider(source: String, fallbackProvider: String?) -> String? {
  let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? fallbackProvider : trimmed
}

struct WorkPlanAccentGradient: View {
  let accent: Color

  var body: some View {
    LinearGradient(
      colors: [Color.clear, accent.opacity(0.55), Color.clear],
      startPoint: .leading,
      endPoint: .trailing
    )
    .frame(height: 1)
  }
}

struct WorkPlanProviderHeader: View {
  let plan: WorkPendingPlanApprovalModel
  var fallbackProvider: String? = nil
  var showsChevron: Bool = true

  private var resolvedProvider: String? {
    workPlanResolvedProvider(source: plan.source, fallbackProvider: fallbackProvider)
  }

  private var accent: Color {
    ADEColor.providerChatAccent(for: resolvedProvider)
  }

  var body: some View {
    HStack(spacing: 7) {
      WorkProviderBareLogo(
        provider: resolvedProvider,
        fallbackSymbol: providerIcon(resolvedProvider ?? ""),
        tint: accent,
        size: 16
      )

      Text(plan.providerHeaderVerb(fallbackProvider: fallbackProvider))
        .font(.caption.weight(.semibold))
        .foregroundStyle(accent)
        .lineLimit(1)
        .truncationMode(.tail)

      if showsChevron {
        Image(systemName: "chevron.up")
          .font(.system(size: 9, weight: .bold))
          .foregroundStyle(accent.opacity(0.55))
      }
    }
  }
}

struct WorkPlanComposerCopyButton: View {
  let text: String
  var accent: Color
  @State private var copied = false

  var body: some View {
    Button {
      UIPasteboard.general.string = text
      copied = true
      Task { @MainActor in
        try? await Task.sleep(nanoseconds: 1_400_000_000)
        copied = false
      }
    } label: {
      Label(copied ? "Copied" : "Copy plan", systemImage: copied ? "checkmark" : "doc.on.doc")
        .font(.caption.weight(.semibold))
        .foregroundStyle(copied ? ADEColor.success : accent)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(copied ? "Copied to clipboard" : "Copy plan")
  }
}

struct WorkPlanRejectFeedbackSection: View {
  @Binding var feedbackText: String
  let busy: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      Text("Feedback (optional)")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)

      TextField("Describe what to change...", text: $feedbackText, axis: .vertical)
        .lineLimit(2...4)
        .adePromptInputTraits()
        .adeInsetField(cornerRadius: 12, padding: 10)
        .disabled(busy)
    }
    .transition(.opacity.combined(with: .move(edge: .top)))
  }
}

struct WorkPlanApprovalActionRow: View {
  @Binding var rejectFlowVisible: Bool
  @Binding var feedbackText: String
  let busy: Bool
  let onDecision: @MainActor (AgentChatApprovalDecision, String?) async -> Void

  var body: some View {
    HStack(spacing: 8) {
      if rejectFlowVisible {
        Button {
          let feedback = feedbackText.trimmingCharacters(in: .whitespacesAndNewlines)
          Task { await onDecision(.decline, feedback.isEmpty ? nil : feedback) }
        } label: {
          Text("Send Rejection")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(ADEColor.danger.opacity(0.82), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel("Send plan rejection")

        Button {
          withAnimation(.smooth(duration: 0.2)) {
            rejectFlowVisible = false
            feedbackText = ""
          }
        } label: {
          Text("Cancel")
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(ADEColor.surfaceBackground.opacity(0.70), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(ADEColor.border.opacity(0.22), lineWidth: 0.8)
            )
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel("Cancel plan rejection")
      }
    }
    .animation(.smooth(duration: 0.2), value: rejectFlowVisible)
  }
}

struct WorkPlanComposerStrip: View {
  let plan: WorkPendingPlanApprovalModel
  let busy: Bool
  var fallbackProvider: String? = nil
  let onDecision: @MainActor (AgentChatApprovalDecision, String?) async -> Void

  @State private var rejectFlowVisible = false
  @State private var feedbackText = ""
  @State private var isPlanExpanded = false

  private var resolvedProvider: String? {
    workPlanResolvedProvider(source: plan.source, fallbackProvider: fallbackProvider)
  }

  private var accent: Color {
    ADEColor.providerChatAccent(for: resolvedProvider)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: rejectFlowVisible ? 8 : 0) {
      compactRow
        .frame(height: workChatSubagentActivePopupHeight)

      if rejectFlowVisible {
        WorkPlanRejectFeedbackSection(feedbackText: $feedbackText, busy: busy)
        WorkPlanApprovalActionRow(
          rejectFlowVisible: $rejectFlowVisible,
          feedbackText: $feedbackText,
          busy: busy,
          onDecision: onDecision
        )
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, rejectFlowVisible ? 9 : 0)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ADEColor.cardBackground.opacity(0.76), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(accent.opacity(0.22), lineWidth: 1)
    )
    .overlay(alignment: .top) {
      WorkPlanAccentGradient(accent: accent)
        .padding(.horizontal, 12)
    }
    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    .sheet(isPresented: $isPlanExpanded) {
      WorkPlanFullScreenView(plan: plan, fallbackProvider: fallbackProvider)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
    .animation(.smooth(duration: 0.2), value: rejectFlowVisible)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(workChatSurfaceProviderName(resolvedProvider)) plan ready")
  }

  private var compactRow: some View {
    HStack(spacing: 8) {
      Button {
        isPlanExpanded = true
      } label: {
        WorkPlanProviderHeader(plan: plan, fallbackProvider: fallbackProvider)
          .frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(plan.providerHeaderVerb(fallbackProvider: fallbackProvider)). Review full plan.")
      .accessibilityHint("Opens the full plan sheet.")

      if !rejectFlowVisible {
        compactActionButton(
          title: "Approve",
          icon: "checkmark",
          tint: ADEColor.success,
          filled: true,
          accessibilityLabel: "Approve plan and begin implementation"
        ) {
          Task { await onDecision(.accept, nil) }
        }
        .disabled(busy)

        compactActionButton(
          title: "Reject",
          icon: "xmark",
          tint: ADEColor.danger,
          filled: false,
          accessibilityLabel: "Reject plan and request revisions"
        ) {
          withAnimation(.smooth(duration: 0.2)) {
            rejectFlowVisible = true
          }
        }
        .disabled(busy)
      }
    }
  }

  private func compactActionButton(
    title: String,
    icon: String,
    tint: Color,
    filled: Bool,
    accessibilityLabel: String,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      HStack(spacing: 4) {
        Image(systemName: icon)
          .font(.system(size: 9, weight: .bold))
        Text(title)
          .font(.caption2.weight(.semibold))
          .lineLimit(1)
      }
      .foregroundStyle(filled ? .white : tint)
      .padding(.horizontal, 8)
      .padding(.vertical, 5)
      .background(
        filled ? tint.opacity(0.86) : tint.opacity(0.08),
        in: Capsule(style: .continuous)
      )
      .overlay(
        Capsule(style: .continuous)
          .stroke(tint.opacity(filled ? 0.18 : 0.28), lineWidth: 0.8)
      )
    }
    .buttonStyle(.plain)
    .accessibilityLabel(accessibilityLabel)
  }
}

/// Pinned tool / file-change approval badge shown directly above the composer,
/// mirroring `WorkPlanComposerStrip`. Collapsed row = provider logo + "{Provider}
/// · Approval" + Accept / Decline; tapping the header opens a detail sheet that
/// adds an "Accept all for session" action and the raw request detail. Wired to
/// the same `onApproveRequest` path the plan badge uses (accept / accept_for_session
/// / decline).
struct WorkApprovalComposerStrip: View {
  let approval: WorkPendingApprovalModel
  let busy: Bool
  var fallbackProvider: String? = nil
  let onDecision: @MainActor (AgentChatApprovalDecision) async -> Void

  @State private var detailPresented = false

  private var accent: Color { ADEColor.providerChatAccent(for: fallbackProvider) }
  private var providerName: String { workChatSurfaceProviderName(fallbackProvider) }

  var body: some View {
    compactRow
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.cardBackground.opacity(0.76), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .stroke(accent.opacity(0.22), lineWidth: 1)
      )
      .overlay(alignment: .top) {
        WorkPlanAccentGradient(accent: accent)
          .padding(.horizontal, 12)
      }
      .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
      .sheet(isPresented: $detailPresented) {
        WorkApprovalDetailSheet(
          approval: approval,
          busy: busy,
          fallbackProvider: fallbackProvider,
          onDecision: onDecision
        )
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
      }
      .accessibilityElement(children: .contain)
      .accessibilityLabel("\(providerName) approval requested. \(approval.description)")
  }

  private var compactRow: some View {
    HStack(spacing: 8) {
      Button {
        detailPresented = true
      } label: {
        HStack(spacing: 7) {
          WorkProviderBareLogo(
            provider: fallbackProvider,
            fallbackSymbol: providerIcon(fallbackProvider ?? ""),
            tint: accent,
            size: 16
          )
          VStack(alignment: .leading, spacing: 1) {
            Text("\(providerName) · Approval")
              .font(.caption.weight(.semibold))
              .foregroundStyle(accent)
              .lineLimit(1)
            Text(approval.description)
              .font(.caption2)
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(1)
              .truncationMode(.tail)
          }
          Image(systemName: "chevron.up")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(accent.opacity(0.55))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Review approval details and more options.")
      .accessibilityHint("Opens the approval detail sheet.")

      WorkApprovalCompactActionButton(
        title: "Accept",
        icon: "checkmark",
        tint: ADEColor.success,
        filled: true,
        accessibilityLabel: "Accept and allow this action"
      ) {
        Task { await onDecision(.accept) }
      }
      .disabled(busy)

      WorkApprovalCompactActionButton(
        title: "Decline",
        icon: "xmark",
        tint: ADEColor.danger,
        filled: false,
        accessibilityLabel: "Decline this action"
      ) {
        Task { await onDecision(.decline) }
      }
      .disabled(busy)
    }
  }
}

/// Compact capsule button matching the plan badge's action buttons — used by the
/// collapsed approval strip.
private struct WorkApprovalCompactActionButton: View {
  let title: String
  let icon: String
  let tint: Color
  let filled: Bool
  let accessibilityLabel: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 4) {
        Image(systemName: icon)
          .font(.system(size: 9, weight: .bold))
        Text(title)
          .font(.caption2.weight(.semibold))
          .lineLimit(1)
      }
      .foregroundStyle(filled ? .white : tint)
      .padding(.horizontal, 8)
      .padding(.vertical, 5)
      .background(
        filled ? tint.opacity(0.86) : tint.opacity(0.08),
        in: Capsule(style: .continuous)
      )
      .overlay(
        Capsule(style: .continuous)
          .stroke(tint.opacity(filled ? 0.18 : 0.28), lineWidth: 0.8)
      )
    }
    .buttonStyle(.plain)
    .accessibilityLabel(accessibilityLabel)
  }
}

/// Expanded approval sheet: full request detail plus the three decision actions,
/// including "Accept all for session" which doesn't fit the collapsed strip.
struct WorkApprovalDetailSheet: View {
  let approval: WorkPendingApprovalModel
  let busy: Bool
  var fallbackProvider: String? = nil
  let onDecision: @MainActor (AgentChatApprovalDecision) async -> Void

  @Environment(\.dismiss) private var dismiss

  private var accent: Color { ADEColor.providerChatAccent(for: fallbackProvider) }
  private var providerName: String { workChatSurfaceProviderName(fallbackProvider) }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          HStack(spacing: 7) {
            WorkProviderBareLogo(
              provider: fallbackProvider,
              fallbackSymbol: providerIcon(fallbackProvider ?? ""),
              tint: accent,
              size: 18
            )
            Text("\(providerName) · Approval")
              .font(.caption.weight(.semibold))
              .foregroundStyle(accent)
          }

          Text(approval.description)
            .font(.title3.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .frame(maxWidth: .infinity, alignment: .leading)

          if let detail = approval.detail, !detail.isEmpty {
            WorkStructuredOutputBlock(title: "Request detail", text: detail)
          }

          VStack(spacing: 10) {
            actionButton(title: "Accept", icon: "checkmark", tint: ADEColor.success, filled: true) {
              await onDecision(.accept)
            }
            actionButton(title: "Accept all for session", icon: "checkmark.circle", tint: accent, filled: false) {
              await onDecision(.acceptForSession)
            }
            actionButton(title: "Decline", icon: "xmark", tint: ADEColor.danger, filled: false) {
              await onDecision(.decline)
            }
          }
        }
        .padding(20)
      }
      .scrollIndicators(.hidden)
      .background(workChatCanvasBackground.ignoresSafeArea())
      .navigationTitle("Approval")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button {
            dismiss()
          } label: {
            Image(systemName: "xmark")
              .font(.system(size: 13, weight: .semibold))
              .foregroundStyle(ADEColor.textSecondary)
          }
          .accessibilityLabel("Dismiss approval")
        }
      }
    }
  }

  private func actionButton(
    title: String,
    icon: String,
    tint: Color,
    filled: Bool,
    action: @escaping @MainActor () async -> Void
  ) -> some View {
    Button {
      Task {
        await action()
        dismiss()
      }
    } label: {
      HStack(spacing: 6) {
        Image(systemName: icon)
          .font(.system(size: 12, weight: .bold))
        Text(title)
          .font(.subheadline.weight(.semibold))
        Spacer(minLength: 0)
      }
      .foregroundStyle(filled ? .white : tint)
      .padding(.horizontal, 14)
      .padding(.vertical, 11)
      .frame(maxWidth: .infinity)
      .background(
        filled ? tint.opacity(0.86) : tint.opacity(0.08),
        in: RoundedRectangle(cornerRadius: 12, style: .continuous)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(tint.opacity(filled ? 0.20 : 0.28), lineWidth: 0.8)
      )
    }
    .buttonStyle(.plain)
    .disabled(busy)
    .accessibilityLabel(title)
  }
}

struct WorkPlanFullScreenView: View {
  let plan: WorkPendingPlanApprovalModel
  var fallbackProvider: String? = nil
  @Environment(\.dismiss) private var dismiss

  private var resolvedProvider: String? {
    workPlanResolvedProvider(source: plan.source, fallbackProvider: fallbackProvider)
  }

  private var accent: Color {
    ADEColor.providerChatAccent(for: resolvedProvider)
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          WorkPlanProviderHeader(plan: plan, fallbackProvider: fallbackProvider, showsChevron: false)

          if !plan.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Text(plan.title)
              .font(.title3.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .frame(maxWidth: .infinity, alignment: .leading)
          }

          WorkMarkdownRenderer(markdown: plan.planText)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(20)
      }
      .scrollIndicators(.hidden)
      .background(workChatCanvasBackground.ignoresSafeArea())
      .navigationTitle("Plan ready")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button {
            dismiss()
          } label: {
            Image(systemName: "xmark")
              .font(.system(size: 13, weight: .semibold))
              .foregroundStyle(ADEColor.textSecondary)
          }
          .accessibilityLabel("Dismiss plan")
        }
        ToolbarItem(placement: .topBarTrailing) {
          WorkPlanComposerCopyButton(text: plan.planText, accent: accent)
        }
      }
    }
  }
}
