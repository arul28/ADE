import SwiftUI
import UIKit

// MARK: - Shared plan approval helpers

func workPlanResolvedProvider(
  source: String,
  fallbackProvider: String?
) -> String? {
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
  var showsChevron: Bool = false
  var chevronRotation: Double = 0

  private var resolvedProvider: String? {
    workPlanResolvedProvider(source: plan.source, fallbackProvider: fallbackProvider)
  }

  private var accent: Color {
    ADEColor.providerChatAccent(for: resolvedProvider)
  }

  var body: some View {
    HStack(alignment: .center, spacing: 8) {
      WorkProviderBareLogo(
        provider: resolvedProvider,
        fallbackSymbol: providerIcon(resolvedProvider ?? ""),
        tint: accent,
        size: 18
      )

      Text(plan.providerHeaderVerb(fallbackProvider: fallbackProvider))
        .font(.caption.weight(.semibold))
        .foregroundStyle(accent)

      Spacer(minLength: 8)

      if showsChevron {
        Image(systemName: "chevron.right")
          .font(.system(size: 11, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
          .rotationEffect(.degrees(chevronRotation))
      } else {
        Image(systemName: "list.bullet.clipboard")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(accent.opacity(0.45))
      }
    }
  }
}

struct WorkPlanCopyButton: View {
  let text: String
  var accent: Color = ADEColor.warning
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
      HStack(spacing: 4) {
        Image(systemName: copied ? "checkmark" : "doc.on.doc")
          .font(.system(size: 9, weight: .bold))
        Text(copied ? "Copied" : "Copy plan")
          .font(.system(size: 10, weight: .semibold, design: .monospaced))
          .tracking(0.6)
      }
      .foregroundStyle(copied ? ADEColor.success : accent.opacity(0.55))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(copied ? "Copied to clipboard" : "Copy plan to clipboard")
  }
}

struct WorkPlanRejectFeedbackSection: View {
  @Binding var feedbackText: String
  let busy: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Feedback (optional)")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      TextField("Describe what to change…", text: $feedbackText, axis: .vertical)
        .lineLimit(2...5)
        .adeInsetField(cornerRadius: 12, padding: 10)
        .disabled(busy)
    }
    .transition(.opacity.combined(with: .move(edge: .top)))
  }
}

struct WorkPlanApprovalActionRow: View {
  let busy: Bool
  @Binding var rejectFlowVisible: Bool
  @Binding var feedbackText: String
  let onDecision: @MainActor (AgentChatApprovalDecision, String?) async -> Void

  var body: some View {
    HStack(spacing: 10) {
      if !rejectFlowVisible {
        Button {
          Task { await onDecision(.accept, nil) }
        } label: {
          HStack(spacing: 6) {
            Image(systemName: "checkmark")
              .font(.system(size: 11, weight: .bold))
            Text("Approve & Implement")
              .font(.caption.weight(.semibold))
          }
          .foregroundStyle(.white)
          .padding(.horizontal, 14)
          .padding(.vertical, 9)
          .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .fill(ADEColor.success.opacity(0.82))
          )
          .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .stroke(ADEColor.success.opacity(0.40), lineWidth: 0.8)
          )
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel("Approve plan and begin implementation")

        Button {
          withAnimation(.spring(duration: 0.22)) {
            rejectFlowVisible = true
          }
        } label: {
          Text("Reject & Revise")
            .font(.caption.weight(.medium))
            .foregroundStyle(ADEColor.textSecondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(ADEColor.surfaceBackground.opacity(0.70))
            )
            .overlay(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(ADEColor.border.opacity(0.22), lineWidth: 0.8)
            )
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel("Reject plan and request revisions")
      } else {
        Button {
          let feedback = feedbackText.trimmingCharacters(in: .whitespacesAndNewlines)
          Task { await onDecision(.decline, feedback.isEmpty ? nil : feedback) }
        } label: {
          Text("Send Rejection")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(ADEColor.danger.opacity(0.82))
            )
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel("Confirm plan rejection")

        Button {
          withAnimation(.spring(duration: 0.22)) {
            rejectFlowVisible = false
            feedbackText = ""
          }
        } label: {
          Text("Cancel")
            .font(.caption.weight(.medium))
            .foregroundStyle(ADEColor.textSecondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(ADEColor.surfaceBackground.opacity(0.70))
            )
            .overlay(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(ADEColor.border.opacity(0.22), lineWidth: 0.8)
            )
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel("Cancel rejection")
      }
    }
    .animation(.spring(duration: 0.22), value: rejectFlowVisible)
  }
}

// MARK: - Composer strip (collapsed)

/// Compact plan-approval strip above the Work chat composer. Tap the header or
/// preview line to open the full-screen plan reader; approve/reject stay here.
struct WorkPlanComposerStrip: View {
  let plan: WorkPendingPlanApprovalModel
  let busy: Bool
  let onDecision: @MainActor (AgentChatApprovalDecision, String?) async -> Void
  var fallbackProvider: String? = nil

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  @State private var isPlanExpanded = false
  @State private var rejectFlowVisible = false
  @State private var feedbackText = ""

  private var resolvedProvider: String? {
    workPlanResolvedProvider(source: plan.source, fallbackProvider: fallbackProvider)
  }

  private var accent: Color {
    ADEColor.providerChatAccent(for: resolvedProvider)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      WorkPlanAccentGradient(accent: accent)

      VStack(alignment: .leading, spacing: 10) {
        expandTrigger

        if rejectFlowVisible {
          WorkPlanRejectFeedbackSection(feedbackText: $feedbackText, busy: busy)
        }

        WorkPlanApprovalActionRow(
          busy: busy,
          rejectFlowVisible: $rejectFlowVisible,
          feedbackText: $feedbackText,
          onDecision: onDecision
        )
      }
      .padding(12)
    }
    .background(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(ADEColor.cardBackground.opacity(0.92))
    )
    .glassEffect(in: .rect(cornerRadius: 14))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(accent.opacity(0.22), lineWidth: 0.8)
    )
    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    .accessibilityElement(children: .contain)
    .accessibilityLabel(
      "\(workChatSurfaceProviderName(resolvedProvider)) · Plan ready. Tap to review the full plan."
    )
    .sheet(isPresented: $isPlanExpanded) {
      WorkPlanFullScreenView(
        plan: plan,
        fallbackProvider: fallbackProvider,
        onDismiss: { isPlanExpanded = false }
      )
      .presentationDetents([.large])
      .presentationDragIndicator(.visible)
    }
  }

  private var expandTrigger: some View {
    Button {
      withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
        isPlanExpanded = true
      }
    } label: {
      VStack(alignment: .leading, spacing: 4) {
        WorkPlanProviderHeader(
          plan: plan,
          fallbackProvider: fallbackProvider,
          showsChevron: true,
          chevronRotation: isPlanExpanded ? 90 : 0
        )

        Text("Tap to review the full plan")
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityHint("Opens the full plan in a sheet.")
  }
}

// MARK: - Full-screen plan reader

struct WorkPlanFullScreenView: View {
  let plan: WorkPendingPlanApprovalModel
  var fallbackProvider: String? = nil
  let onDismiss: () -> Void

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
        WorkMarkdownRenderer(markdown: plan.planText)
          .textSelection(.enabled)
          .padding(.horizontal, 16)
          .padding(.vertical, 12)
      }
      .background(ADEColor.pageBackground)
      .navigationTitle(plan.providerHeaderVerb(fallbackProvider: fallbackProvider))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button {
            onDismiss()
            dismiss()
          } label: {
            Image(systemName: "xmark")
              .font(.system(size: 13, weight: .semibold))
          }
          .accessibilityLabel("Close plan")
        }
        ToolbarItem(placement: .topBarTrailing) {
          WorkPlanCopyButton(text: plan.planText, accent: accent)
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Full plan. \(plan.planText.prefix(120))")
  }
}
