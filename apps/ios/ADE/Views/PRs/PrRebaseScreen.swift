import SwiftUI

/// Rebase attention screen — mirrors the desktop RebaseTab detail pane:
/// drift analysis stat grid, collapsible commits list, and the full set of
/// rebase actions (AI resolver, local-only, push, defer, dismiss) so the
/// mobile and desktop paths stay in sync.
struct PrRebaseScreen: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let laneId: String
  let laneName: String?
  let prNumber: Int?
  let prId: String?
  let behindCount: Int
  let conflictPredicted: Bool
  let branchRef: String?
  let baseBranch: String?
  let targetCommits: [RebaseTargetCommit]?
  let rebaseMode: String?
  let creationStrategy: String?

  init(
    laneId: String,
    laneName: String?,
    prNumber: Int?,
    prId: String?,
    behindCount: Int,
    conflictPredicted: Bool,
    branchRef: String?,
    baseBranch: String?,
    targetCommits: [RebaseTargetCommit]? = nil,
    rebaseMode: String? = nil,
    creationStrategy: String? = nil
  ) {
    self.laneId = laneId
    self.laneName = laneName
    self.prNumber = prNumber
    self.prId = prId
    self.behindCount = behindCount
    self.conflictPredicted = conflictPredicted
    self.branchRef = branchRef
    self.baseBranch = baseBranch
    self.targetCommits = targetCommits
    self.rebaseMode = rebaseMode
    self.creationStrategy = creationStrategy
  }

  private var isManualRebaseMode: Bool { rebaseMode == "manual" }
  private var effectiveBaseBranch: String { baseBranch ?? "origin/main" }

  @State private var isDispatching = false
  @State private var pendingAction: PendingAction?
  @State private var errorMessage: String?
  @State private var commitsExpanded = true

  private enum PendingAction: Equatable {
    case rebaseAi
    case rebaseLocal
    case rebasePush
    case defer4h
    case dismissLane
  }

  var body: some View {
    ZStack {
      prLiquidGlassBackdrop()

      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          header
            .padding(.horizontal, 16)
            .padding(.top, 8)

          if isManualRebaseMode {
            manualBaseNotice
              .padding(.horizontal, 16)
          }

          driftAnalysisCard
            .padding(.horizontal, 16)

          if behindCount > 0 {
            newCommitsCard
              .padding(.horizontal, 16)
          }

          rebaseActionsCard
            .padding(.horizontal, 16)

          if let errorMessage {
            ADENoticeCard(
              title: "Rebase failed",
              message: errorMessage,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: nil,
              action: nil
            )
            .padding(.horizontal, 16)
          }

          Color.clear.frame(height: 24)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .navigationTitle(prNumber.map { "#\($0) · Rebase" } ?? "Rebase")
    .navigationBarTitleDisplayMode(.inline)
  }

  // MARK: - Header

  private var header: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        Text(laneName ?? "Rebase lane")
          .font(.system(size: 22, weight: .bold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
        Spacer(minLength: 0)
        PrsLivePulse(isLive: true, syncedLabel: nil)
      }
      HStack(spacing: 8) {
        Text("base:")
          .font(.system(size: 11, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
        Text(effectiveBaseBranch)
          .font(.system(size: 11, weight: .semibold, design: .monospaced))
          .foregroundStyle(ADEColor.textSecondary)
        if prNumber != nil {
          PrTagChip(label: "PR linked", color: PrGlassPalette.info)
        }
        if isManualRebaseMode {
          PrTagChip(label: "manual", color: PrGlassPalette.purple)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var manualBaseNotice: some View {
    Text("This PR was opened with the lane_base strategy — auto-rebase is off. Rebase now if you want to move the PR forward.")
      .font(.system(size: 12))
      .foregroundStyle(ADEColor.textSecondary)
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(PrGlassPalette.purple.opacity(0.10))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .strokeBorder(PrGlassPalette.purple.opacity(0.25), lineWidth: 0.5)
      )
  }

  // MARK: - Drift analysis

  private var driftAnalysisCard: some View {
    VStack(alignment: .leading, spacing: 12) {
      PrsEyebrowLabel(text: "DRIFT ANALYSIS")

      let behindTint: Color = behindCount > 5
        ? PrGlassPalette.warning
        : behindCount > 0 ? PrGlassPalette.info : PrGlassPalette.success

      HStack(spacing: 10) {
        driftStat(
          label: "BEHIND BY",
          valueText: "\(behindCount)",
          suffix: behindCount == 1 ? "commit" : "commits",
          tint: behindTint
        )
        driftStat(
          label: "CONFLICTS",
          valueText: conflictPredicted ? "PREDICTED" : "NONE",
          suffix: nil,
          tint: conflictPredicted ? ADEColor.danger : PrGlassPalette.success
        )
      }

      HStack(spacing: 10) {
        driftStat(
          label: "RISK",
          valueText: riskLabel,
          suffix: nil,
          tint: riskTint
        )
        driftStat(
          label: "REBASE MODE",
          valueText: isManualRebaseMode ? "MANUAL" : "AUTO",
          suffix: nil,
          tint: isManualRebaseMode ? PrGlassPalette.purple : PrGlassPalette.info
        )
      }
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .prGlassCard(cornerRadius: 16)
  }

  private var riskLabel: String {
    if conflictPredicted { return "HIGH" }
    if behindCount > 5 { return "MEDIUM" }
    if behindCount == 0 { return "NONE" }
    return "LOW"
  }

  private var riskTint: Color {
    if conflictPredicted { return ADEColor.danger }
    if behindCount > 5 { return PrGlassPalette.warning }
    if behindCount == 0 { return PrGlassPalette.success }
    return PrGlassPalette.success
  }

  private func driftStat(label: String, valueText: String, suffix: String?, tint: Color) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label)
        .font(.system(size: 9.5, weight: .bold, design: .monospaced))
        .tracking(1.0)
        .foregroundStyle(ADEColor.textMuted)
      HStack(alignment: .firstTextBaseline, spacing: 4) {
        Text(valueText)
          .font(.system(size: 18, weight: .bold, design: .monospaced))
          .foregroundStyle(tint)
        if let suffix {
          Text(suffix)
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(Color.white.opacity(0.03))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .strokeBorder(Color.white.opacity(0.05), lineWidth: 0.5)
    )
  }

  // MARK: - New commits (collapsible)

  private var newCommitsCard: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        withAnimation(.easeInOut(duration: 0.18)) {
          commitsExpanded.toggle()
        }
      } label: {
        HStack(spacing: 8) {
          Image(systemName: "arrow.triangle.branch")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(PrGlassPalette.info)
          Text("NEW COMMITS ON \(effectiveBaseBranch.uppercased())")
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .tracking(1.0)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
          Text("\(behindCount)")
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .foregroundStyle(PrGlassPalette.info)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(
              RoundedRectangle(cornerRadius: 4)
                .fill(PrGlassPalette.info.opacity(0.12))
            )
          Spacer(minLength: 0)
          Image(systemName: commitsExpanded ? "chevron.down" : "chevron.right")
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(ADEColor.textMuted)
        }
        .padding(14)
      }
      .buttonStyle(.plain)

      if commitsExpanded {
        Divider().overlay(Color.white.opacity(0.06))
        if let commits = targetCommits, !commits.isEmpty {
          ForEach(Array(commits.enumerated()), id: \.element.id) { index, commit in
            commitRow(commit: commit)
            if index < commits.count - 1 {
              Divider().overlay(Color.white.opacity(0.04))
                .padding(.leading, 14)
            }
          }
        } else {
          Text("Commit details unavailable on this host.")
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
            .padding(14)
        }
      }
    }
    .prGlassCard(cornerRadius: 16)
  }

  private func commitRow(commit: RebaseTargetCommit) -> some View {
    let sha = commit.shortSha.isEmpty ? String(commit.sha.prefix(7)) : commit.shortSha
    return HStack(alignment: .top, spacing: 10) {
      Text(sha)
        .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
        .foregroundStyle(PrGlassPalette.purpleBright)
        .frame(width: 56, alignment: .leading)

      VStack(alignment: .leading, spacing: 2) {
        Text(commit.subject.isEmpty ? commit.sha : commit.subject)
          .font(.system(size: 13))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
        Text(commit.author.isEmpty ? "—" : commit.author)
          .font(.system(size: 10.5, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
      }

      Spacer(minLength: 6)

      Text(prCompactRelativeTime(commit.committedAt))
        .font(.system(size: 10.5, design: .monospaced))
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
  }

  // MARK: - Rebase actions

  private var rebaseActionsCard: some View {
    VStack(alignment: .leading, spacing: 12) {
      PrsEyebrowLabel(text: "REBASE ACTIONS")

      HStack(spacing: 6) {
        Text("Scope:")
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
        Text("CURRENT LANE")
          .font(.system(size: 10, weight: .bold, design: .monospaced))
          .tracking(0.8)
          .foregroundStyle(PrGlassPalette.purpleBright)
          .padding(.horizontal, 8)
          .padding(.vertical, 3)
          .background(
            RoundedRectangle(cornerRadius: 6)
              .fill(PrGlassPalette.purple.opacity(0.15))
          )
          .overlay(
            RoundedRectangle(cornerRadius: 6)
              .strokeBorder(PrGlassPalette.purple.opacity(0.30), lineWidth: 0.5)
          )
        Spacer(minLength: 0)
      }

      // Primary row: Rebase with AI (disabled for manual-mode / PR-target paths
      // per desktop parity — AI only runs against lane base).
      actionButton(
        action: .rebaseAi,
        label: "Rebase with AI",
        icon: "sparkles",
        style: .primary,
        disabled: behindCount == 0
      )

      HStack(spacing: 10) {
        actionButton(
          action: .rebaseLocal,
          label: "Rebase now",
          icon: nil,
          style: .secondary,
          disabled: behindCount == 0
        )
        actionButton(
          action: .rebasePush,
          label: "Rebase + push",
          icon: "arrow.up.circle",
          style: .secondary,
          disabled: behindCount == 0
        )
      }

      HStack(spacing: 10) {
        actionButton(
          action: .defer4h,
          label: "Defer 4h",
          icon: "clock",
          style: .ghost,
          disabled: false
        )
        actionButton(
          action: .dismissLane,
          label: "Dismiss",
          icon: "xmark.circle",
          style: .ghost,
          disabled: false
        )
      }

      if behindCount == 0 {
        HStack(spacing: 8) {
          Image(systemName: "checkmark.circle.fill")
            .foregroundStyle(PrGlassPalette.success)
            .font(.system(size: 12))
          Text("Branch is up to date with \(effectiveBaseBranch).")
            .font(.system(size: 11))
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .prGlassCard(cornerRadius: 16)
  }

  private enum ActionStyle { case primary, secondary, ghost }

  @ViewBuilder
  private func actionButton(
    action: PendingAction,
    label: String,
    icon: String?,
    style: ActionStyle,
    disabled: Bool
  ) -> some View {
    let isRunning = pendingAction == action && isDispatching
    let isDisabled = disabled || (isDispatching && pendingAction != action)

    Button {
      perform(action: action)
    } label: {
      HStack(spacing: 6) {
        if isRunning {
          ProgressView()
            .controlSize(.small)
            .tint(style == .primary ? .white : ADEColor.textPrimary)
        } else if let icon {
          Image(systemName: icon)
            .font(.system(size: 12, weight: .semibold))
        }
        Text(label)
          .font(.system(size: 13, weight: style == .primary ? .bold : .semibold))
      }
      .foregroundStyle(buttonForeground(style: style, disabled: isDisabled))
      .frame(maxWidth: .infinity)
      .frame(height: 42)
      .background(buttonBackground(style: style))
      .overlay(buttonBorder(style: style))
      .shadow(
        color: style == .primary ? PrGlassPalette.purple.opacity(0.35) : .clear,
        radius: 10, x: 0, y: 3
      )
    }
    .buttonStyle(.plain)
    .disabled(isDisabled || isRunning)
    .opacity(isDisabled ? 0.5 : 1)
  }

  private func buttonForeground(style: ActionStyle, disabled: Bool) -> Color {
    switch style {
    case .primary: return .white
    case .secondary: return ADEColor.textPrimary
    case .ghost: return ADEColor.textSecondary
    }
  }

  @ViewBuilder
  private func buttonBackground(style: ActionStyle) -> some View {
    switch style {
    case .primary:
      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .fill(
          LinearGradient(
            colors: [PrGlassPalette.purpleBright, PrGlassPalette.purple],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )
    case .secondary:
      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .fill(.ultraThinMaterial)
    case .ghost:
      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .fill(Color.white.opacity(0.02))
    }
  }

  @ViewBuilder
  private func buttonBorder(style: ActionStyle) -> some View {
    switch style {
    case .primary:
      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .strokeBorder(Color.white.opacity(0.40), lineWidth: 0.5)
    case .secondary:
      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
    case .ghost:
      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)
    }
  }

  // MARK: - Dispatch

  private func perform(action: PendingAction) {
    guard !isDispatching else { return }
    isDispatching = true
    pendingAction = action
    errorMessage = nil
    Task { @MainActor in
      defer {
        isDispatching = false
        pendingAction = nil
      }
      do {
        switch action {
        case .rebaseAi:
          try await syncService.startLaneRebase(
            laneId: laneId, scope: "lane_only", pushMode: "none", aiAssisted: true
          )
          dismiss()
        case .rebaseLocal:
          try await syncService.startLaneRebase(
            laneId: laneId, scope: "lane_only", pushMode: "none", aiAssisted: false
          )
          dismiss()
        case .rebasePush:
          try await syncService.startLaneRebase(
            laneId: laneId, scope: "lane_only", pushMode: "review_then_push", aiAssisted: false
          )
          dismiss()
        case .defer4h:
          try await syncService.deferRebaseSuggestion(laneId: laneId, minutes: 240)
          dismiss()
        case .dismissLane:
          try await syncService.dismissRebaseSuggestion(laneId: laneId)
          dismiss()
        }
      } catch {
        errorMessage = error.localizedDescription
      }
    }
  }
}

#Preview("PrRebaseScreen · conflict") {
  NavigationStack {
    PrRebaseScreen(
      laneId: "lane-1",
      laneName: "Fix auth middleware ordering",
      prNumber: 316,
      prId: "pr-316",
      behindCount: 83,
      conflictPredicted: true,
      branchRef: "lane/auth-fix",
      baseBranch: "origin/main",
      targetCommits: [
        RebaseTargetCommit(sha: "70fd4e51aaaa", shortSha: "70fd4e5", subject: "Review engine: multi-pass pipeline", author: "Arul", committedAt: ""),
        RebaseTargetCommit(sha: "56ec29c5bbbb", shortSha: "56ec29c", subject: "chat-ux: collapse thoughts + scroll", author: "Arul", committedAt: ""),
      ]
    )
  }
}

#Preview("PrRebaseScreen · clean") {
  NavigationStack {
    PrRebaseScreen(
      laneId: "lane-2",
      laneName: "Payments idempotency key",
      prNumber: 315,
      prId: "pr-315",
      behindCount: 0,
      conflictPredicted: false,
      branchRef: "lane/payments",
      baseBranch: "origin/main"
    )
  }
}
