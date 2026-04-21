import SwiftUI

/// CTO Worker detail drill-down. Header, activity, budget, core memory,
/// revisions. Mirrors screen-worker-detail.jsx.
struct CtoWorkerDetailScreen: View {
  @EnvironmentObject private var syncService: SyncService

  let agentId: String
  let displayName: String

  @State private var agent: AgentIdentity?
  @State private var budgetSnapshotWorker: AgentBudgetSnapshotWorker?
  @State private var companyCapCents: Int?
  @State private var coreMemory: AgentCoreMemory?
  @State private var runs: [WorkerAgentRun] = []
  @State private var revisions: [AgentConfigRevision] = []
  @State private var isLoading = false
  @State private var errorMessage: String?

  @State private var pendingStatusMutation = false
  @State private var pendingWakeup = false
  @State private var pendingRollbackId: String?
  @State private var pendingDismiss = false
  @State private var showEditSheet = false
  @State private var showDismissConfirm = false
  @State private var mutationNotice: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        if let errorMessage {
          ADENoticeCard(
            title: "Worker failed to load",
            message: errorMessage,
            icon: "exclamationmark.triangle.fill",
            tint: ADEColor.danger,
            actionTitle: "Retry",
            action: { Task { await loadAll() } }
          )
          .padding(.horizontal, 16)
        }

        headerCard

        activitySection

        budgetSection

        coreMemorySection

        revisionsSection

        dismissButton

        Color.clear.frame(height: 24)
      }
      .padding(.top, 8)
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .tint(ADEColor.ctoAccent)
    .navigationTitle(displayName)
    .navigationBarTitleDisplayMode(.inline)
    .task { if agent == nil { await loadAll() } }
    .refreshable { await loadAll() }
    .sheet(isPresented: $showEditSheet) {
      CtoWorkerQuickEditSheet(agent: agent) { updatedStatus, updatedBudgetCents in
        Task { await applyQuickEdit(status: updatedStatus, budgetCents: updatedBudgetCents) }
      }
      .presentationDetents([.medium, .large])
    }
    .confirmationDialog(
      "Dismiss \(displayName)?",
      isPresented: $showDismissConfirm,
      titleVisibility: .visible
    ) {
      Button("Dismiss", role: .destructive) {
        Task { await dismissWorker() }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("This will remove the worker from the org. Their sessions and revisions remain accessible but the agent will stop running.")
    }
    .overlay(alignment: .bottom) {
      if let mutationNotice {
        Text(mutationNotice)
          .font(.caption)
          .foregroundStyle(ADEColor.textPrimary)
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
          .background(ADEColor.cardBackground, in: Capsule())
          .overlay(Capsule().stroke(ADEColor.glassBorder, lineWidth: 0.5))
          .padding(.bottom, 24)
          .transition(.opacity)
      }
    }
  }

  // MARK: - Header card

  private var headerCard: some View {
    let tint = ctoAvatarTint(name: displayName, seed: agentId)
    let status = agent?.status ?? "idle"
    let statusTint = ctoStatusTint(status)

    return VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .center, spacing: 12) {
        Text(ctoAvatarInitial(for: displayName))
          .font(.system(size: 21, weight: .heavy))
          .foregroundStyle(ADEColor.textPrimary)
          .frame(width: 46, height: 46)
          .background(
            LinearGradient(
              colors: [tint.opacity(0.4), tint.opacity(0.7)],
              startPoint: .topLeading,
              endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
          )
          .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
              .stroke(tint.opacity(0.5), lineWidth: 0.5)
          )

        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 6) {
            Text(agent?.name ?? displayName)
              .font(.system(size: 17, weight: .heavy))
              .tracking(-0.2)
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            ADEStatusPill(text: status, tint: statusTint)
          }
          Text(headerRoleLine)
            .font(.system(size: 10.5, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
          Text(headerModelLine)
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted.opacity(0.8))
            .lineLimit(1)
        }
        Spacer(minLength: 0)
      }

      HStack(spacing: 6) {
        HeaderActionButton(
          icon: "play.fill",
          label: pendingWakeup ? "Waking…" : "Wake now",
          style: .primary,
          disabled: pendingWakeup,
          action: { Task { await wakeUp() } }
        )
        HeaderActionButton(
          icon: isPaused ? "play.circle" : "pause.fill",
          label: isPaused ? "Resume" : "Pause",
          style: .secondary,
          disabled: pendingStatusMutation,
          action: { Task { await togglePause() } }
        )
        HeaderActionButton(
          icon: "gearshape",
          label: "Edit",
          style: .secondary,
          disabled: false,
          action: { showEditSheet = true }
        )
      }
    }
    .padding(14)
    .background(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .fill(
          LinearGradient(
            colors: [tint.opacity(0.18), ADEColor.cardBackground.opacity(0.95)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )
    )
    .overlay(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .stroke(tint.opacity(0.28), lineWidth: 0.5)
    )
    .padding(.horizontal, 16)
  }

  private var headerRoleLine: String {
    let role = agent?.role ?? "Worker"
    let reports = agent?.reportsTo?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let reports, !reports.isEmpty {
      return "\(role) · reports to \(reports)"
    }
    return "\(role) · reports to CTO"
  }

  private var headerModelLine: String {
    let model = agent?.model?.trimmingCharacters(in: .whitespacesAndNewlines)
    let adapter = agent?.adapterType ?? ""
    let leftover = [model?.isEmpty == false ? model! : nil, adapter.isEmpty ? nil : adapter]
      .compactMap { $0 }
    return leftover.joined(separator: " · ").ifEmptyReturn("—")
  }

  private var isPaused: Bool {
    agent?.status.lowercased() == "paused"
  }

  // MARK: - Activity section

  private var activitySection: some View {
    VStack(alignment: .leading, spacing: 8) {
      CtoSectionHeader(title: "Activity", trailing: "last 7 days")
        .padding(.horizontal, 20)

      if isLoading && runs.isEmpty {
        ADECardSkeleton(rows: 3)
          .padding(.horizontal, 16)
      } else if runs.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          Text("No recent runs")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
          Text("Runs will appear here as this worker executes tasks.")
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
        }
        .adeListCard()
        .padding(.horizontal, 16)
      } else {
        VStack(spacing: 0) {
          ForEach(Array(runs.enumerated()), id: \.element.id) { index, run in
            RunRow(run: run)
            if index < runs.count - 1 {
              Divider().opacity(0.1).padding(.leading, 34)
            }
          }
        }
        .background(
          RoundedRectangle(cornerRadius: 16, style: .continuous)
            .fill(ADEColor.glassBackground)
        )
        .overlay(
          RoundedRectangle(cornerRadius: 16, style: .continuous)
            .stroke(ADEColor.glassBorder, lineWidth: 0.5)
        )
        .padding(.horizontal, 16)
      }
    }
  }

  // MARK: - Budget section

  private var budgetSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      CtoSectionHeader(title: "Budget")
        .padding(.horizontal, 20)

      let spent = budgetSnapshotWorker?.spentMonthlyCents ?? agent?.spentMonthlyCents ?? 0
      let cap = budgetSnapshotWorker?.budgetMonthlyCents ?? agent?.budgetMonthlyCents
      let pct = ctoBudgetPercent(spentCents: spent, capCents: cap)

      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .firstTextBaseline) {
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(ctoFormatCents(spent))
              .font(.system(size: 22, weight: .heavy))
              .tracking(-0.3)
              .foregroundStyle(ADEColor.textPrimary)
            if let cap {
              Text("/ \(ctoFormatCents(cap))")
                .font(.system(size: 13))
                .foregroundStyle(ADEColor.textMuted)
            }
          }
          Spacer(minLength: 0)
          if let pct {
            ADEStatusPill(
              text: pct > 80 ? "warning" : "healthy",
              tint: pct > 80 ? ADEColor.warning : ADEColor.success
            )
          }
        }
        if let pct {
          Text("\(pct)% this month")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
          GeometryReader { proxy in
            let width = proxy.size.width * CGFloat(pct) / 100.0
            ZStack(alignment: .leading) {
              RoundedRectangle(cornerRadius: 3, style: .continuous)
                .fill(ADEColor.recessedBackground.opacity(0.5))
              RoundedRectangle(cornerRadius: 3, style: .continuous)
                .fill(
                  LinearGradient(
                    colors: pct > 80
                      ? [ADEColor.warning, ADEColor.warning.opacity(0.7)]
                      : [ADEColor.accentDeep, ADEColor.ctoAccent],
                    startPoint: .leading,
                    endPoint: .trailing
                  )
                )
                .frame(width: max(0, width))
            }
          }
          .frame(height: 6)
        } else {
          Text("No monthly cap set")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .adeListCard()
      .padding(.horizontal, 16)
    }
  }

  // MARK: - Core memory

  private var coreMemorySection: some View {
    VStack(alignment: .leading, spacing: 8) {
      CtoSectionHeader(title: "Core memory")
        .padding(.horizontal, 20)

      VStack(alignment: .leading, spacing: 0) {
        VStack(alignment: .leading, spacing: 4) {
          Text("Specialization")
            .font(.caption2.monospaced().weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)
            .textCase(.uppercase)
            .tracking(0.4)
          Text(specializationText)
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 11)
        .padding(.horizontal, 14)

        Divider().opacity(0.08)

        VStack(alignment: .leading, spacing: 6) {
          Text("Conventions (\(coreMemory?.criticalConventions.count ?? 0))")
            .font(.caption2.monospaced().weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)
            .textCase(.uppercase)
            .tracking(0.4)
          if let conventions = coreMemory?.criticalConventions, !conventions.isEmpty {
            FlowLayout(spacing: 5) {
              ForEach(conventions, id: \.self) { item in
                LearnedChip(text: item)
              }
            }
          } else {
            Text("No conventions captured yet.")
              .font(.caption)
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        .padding(.vertical, 11)
        .padding(.horizontal, 14)

        if let focus = coreMemory?.activeFocus, !focus.isEmpty {
          Divider().opacity(0.08)
          VStack(alignment: .leading, spacing: 6) {
            Text("Focus (\(focus.count))")
              .font(.caption2.monospaced().weight(.semibold))
              .foregroundStyle(ADEColor.textMuted)
              .textCase(.uppercase)
              .tracking(0.4)
            FlowLayout(spacing: 5) {
              ForEach(focus, id: \.self) { item in
                LearnedChip(text: item)
              }
            }
          }
          .padding(.vertical, 11)
          .padding(.horizontal, 14)
        }
      }
      .background(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .fill(ADEColor.glassBackground)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 0.5)
      )
      .padding(.horizontal, 16)
    }
  }

  private var specializationText: String {
    let summary = coreMemory?.projectSummary.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !summary.isEmpty { return summary }
    // Fall back to the worker's own systemPromptExtension when memory is empty.
    let prompt = agent?.systemPromptExtension?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return prompt.isEmpty ? "No specialization captured." : prompt
  }

  // MARK: - Revisions

  private var revisionsSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      CtoSectionHeader(title: "Revisions", trailing: revisions.isEmpty ? nil : "\(revisions.count) revisions")
        .padding(.horizontal, 20)

      if isLoading && revisions.isEmpty {
        ADECardSkeleton(rows: 2)
          .padding(.horizontal, 16)
      } else if revisions.isEmpty {
        Text("No revisions recorded yet.")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .adeListCard()
          .padding(.horizontal, 16)
      } else {
        VStack(spacing: 0) {
          ForEach(Array(revisions.enumerated()), id: \.element.id) { index, revision in
            RevisionRow(
              revision: revision,
              label: revisionLabel(for: index, total: revisions.count),
              isCurrent: index == 0,
              isRolling: pendingRollbackId == revision.id,
              onRollback: { Task { await rollback(revisionId: revision.id) } }
            )
            if index < revisions.count - 1 {
              Divider().opacity(0.1).padding(.leading, 14)
            }
          }
        }
        .background(
          RoundedRectangle(cornerRadius: 16, style: .continuous)
            .fill(ADEColor.glassBackground)
        )
        .overlay(
          RoundedRectangle(cornerRadius: 16, style: .continuous)
            .stroke(ADEColor.glassBorder, lineWidth: 0.5)
        )
        .padding(.horizontal, 16)
      }
    }
  }

  private func revisionLabel(for index: Int, total: Int) -> String {
    // Latest revision displayed first; label as v{total-index}. If API-provided
    // ordering changes, this stays monotonic within the rendered list.
    "v\(total - index)"
  }

  // MARK: - Dismiss

  private var dismissButton: some View {
    Button {
      showDismissConfirm = true
    } label: {
      HStack(spacing: 6) {
        if pendingDismiss {
          ProgressView().controlSize(.mini).tint(ADEColor.danger)
        } else {
          Image(systemName: "person.badge.minus")
            .font(.system(size: 12, weight: .semibold))
        }
        Text(pendingDismiss ? "Dismissing…" : "Dismiss worker")
          .font(.system(size: 13, weight: .semibold))
      }
      .foregroundStyle(ADEColor.danger)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 12)
      .background(ADEColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(ADEColor.danger.opacity(0.25), lineWidth: 0.5)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(pendingDismiss)
    .padding(.horizontal, 16)
    .padding(.top, 6)
    .accessibilityLabel("Dismiss worker")
    .accessibilityHint("Removes this worker from the CTO org after confirmation.")
  }

  // MARK: - Data loading

  /// Loads everything in parallel and tolerates partial failures. The agent
  /// itself (from `listAgents`) is the only piece that can surface as a
  /// top-level error — the rest degrade to empty-state views if they fail.
  @MainActor
  private func loadAll() async {
    if isLoading { return }
    isLoading = true
    errorMessage = nil
    defer { isLoading = false }

    async let agentsR = CtoAsyncResult { try await syncService.fetchCtoAgents() }
    async let budgetR = CtoAsyncResult { try await syncService.fetchCtoBudget() }
    async let memoryR = CtoAsyncResult { try await syncService.fetchAgentCoreMemory(agentId: agentId) }
    async let runsR = CtoAsyncResult { try await syncService.listAgentRuns(agentId: agentId, limit: 20) }
    async let revisionsR = CtoAsyncResult { try await syncService.listAgentRevisions(agentId: agentId, limit: 10) }

    let (agentsResult, budgetResult, memoryResult, runsResult, revisionsResult) =
      await (agentsR, budgetR, memoryR, runsR, revisionsR)

    if case .success(let fetched) = agentsResult {
      agent = fetched.first(where: { $0.id == agentId })
    } else if case .failure(let err) = agentsResult, agent == nil {
      errorMessage = err.localizedDescription
    }

    if case .success(let snap) = budgetResult {
      budgetSnapshotWorker = snap.workers.first(where: { $0.agentId == agentId })
      companyCapCents = snap.companyCapMonthlyCents
    }

    if case .success(let mem) = memoryResult { coreMemory = mem }
    if case .success(let fetched) = runsResult { runs = fetched }
    if case .success(let fetched) = revisionsResult { revisions = fetched }
  }

  // MARK: - Mutations

  @MainActor
  private func wakeUp() async {
    guard !pendingWakeup else { return }
    pendingWakeup = true
    defer { pendingWakeup = false }
    do {
      _ = try await syncService.triggerAgentWakeup(agentId: agentId)
      flashNotice("Woke \(displayName).")
    } catch {
      flashNotice("Wake failed: \(error.localizedDescription)")
    }
  }

  @MainActor
  private func togglePause() async {
    guard !pendingStatusMutation, var current = agent else { return }
    let target = current.status.lowercased() == "paused" ? "active" : "paused"
    pendingStatusMutation = true
    let previousStatus = current.status
    current.status = target
    agent = current
    defer { pendingStatusMutation = false }
    do {
      try await syncService.setAgentStatus(agentId: agentId, status: target)
      flashNotice(target == "paused" ? "Paused." : "Resumed.")
    } catch {
      // Revert optimistic change.
      current.status = previousStatus
      agent = current
      flashNotice("Status update failed: \(error.localizedDescription)")
    }
  }

  @MainActor
  private func dismissWorker() async {
    guard !pendingDismiss else { return }
    pendingDismiss = true
    defer { pendingDismiss = false }
    do {
      try await syncService.removeAgent(agentId: agentId)
      flashNotice("Worker dismissed.")
      // Pop after a short delay to let the notice show.
      try? await Task.sleep(nanoseconds: 1_200_000_000)
    } catch {
      flashNotice("Dismiss failed: \(error.localizedDescription)")
    }
  }

  @MainActor
  private func applyQuickEdit(status: String?, budgetCents: Int?) async {
    var mutated = false
    if let status, agent?.status != status {
      do {
        try await syncService.setAgentStatus(agentId: agentId, status: status)
        var current = agent
        current?.status = status
        agent = current
        mutated = true
      } catch {
        flashNotice("Status update failed: \(error.localizedDescription)")
        return
      }
    }
    if mutated { flashNotice("Worker updated.") }
  }

  @MainActor
  private func rollback(revisionId: String) async {
    guard pendingRollbackId == nil else { return }
    pendingRollbackId = revisionId
    defer { pendingRollbackId = nil }
    do {
      try await syncService.rollbackAgentRevision(agentId: agentId, revisionId: revisionId)
      flashNotice("Rolled back.")
      await loadAll()
    } catch {
      flashNotice("Rollback failed: \(error.localizedDescription)")
    }
  }

  @MainActor
  private func flashNotice(_ text: String) {
    withAnimation(.easeInOut(duration: 0.2)) { mutationNotice = text }
    Task {
      try? await Task.sleep(nanoseconds: 2_500_000_000)
      await MainActor.run {
        withAnimation(.easeInOut(duration: 0.2)) { mutationNotice = nil }
      }
    }
  }
}

// MARK: - Row views

private struct HeaderActionButton: View {
  enum Style { case primary, secondary }

  let icon: String
  let label: String
  let style: Style
  let disabled: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 4) {
        Image(systemName: icon)
          .font(.system(size: 10, weight: .bold))
        Text(label)
          .font(.system(size: 11.5, weight: .bold))
      }
      .foregroundStyle(style == .primary ? Color.black : ADEColor.textPrimary)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 9)
      .background(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(style == .primary ? ADEColor.ctoAccent : ADEColor.recessedBackground.opacity(0.55))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .stroke(style == .primary ? Color.clear : ADEColor.glassBorder, lineWidth: 0.5)
      )
      .opacity(disabled ? 0.55 : 1.0)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .accessibilityLabel(label)
  }
}

private struct RunRow: View {
  let run: WorkerAgentRun

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var pulsing = false

  private var stateColor: Color {
    switch run.status.lowercased() {
    case "running": return ctoStatusRunningBlue
    case "completed", "done", "succeeded": return ADEColor.success
    case "failed", "error": return ADEColor.danger
    case "cancelled": return ADEColor.textMuted
    default: return ADEColor.textMuted
    }
  }

  private var isRunning: Bool { run.status.lowercased() == "running" }
  private var isFailed: Bool {
    let s = run.status.lowercased()
    return s == "failed" || s == "error"
  }

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Circle()
        .fill(stateColor)
        .frame(width: 6, height: 6)
        .padding(.top, 6)
        .shadow(color: isRunning ? stateColor.opacity(0.8) : .clear, radius: 3)
        .scaleEffect(pulsing && isRunning && !reduceMotion ? 1.25 : 1.0)
        .onAppear {
          guard isRunning, !reduceMotion else { return }
          withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
            pulsing = true
          }
        }

      VStack(alignment: .leading, spacing: 1) {
        Text(run.displayTitle)
          .font(.system(size: 12.5, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .truncationMode(.tail)
        Text(subtitle)
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }

      Spacer(minLength: 0)
    }
    .padding(.vertical, 11)
    .padding(.horizontal, 14)
  }

  private var subtitle: String {
    // Prefer startedAt when available; queued/deferred runs don't have one
    // yet, so we fall back to createdAt (always present on desktop).
    let timestamp = run.startedAt ?? run.createdAt
    var parts: [String] = [ctoRelativeAgo(from: timestamp)]
    if let reason = run.wakeupReason, !reason.isEmpty {
      parts.append(reason)
    }
    parts.append(run.status)
    var base = parts.joined(separator: " · ")
    if isFailed, let err = run.errorMessage, !err.isEmpty {
      base += " · \(err)"
    }
    return base
  }
}

private struct RevisionRow: View {
  let revision: AgentConfigRevision
  let label: String
  let isCurrent: Bool
  let isRolling: Bool
  let onRollback: () -> Void

  var body: some View {
    HStack(alignment: .center, spacing: 10) {
      Text(label)
        .font(.system(size: 10, design: .monospaced).weight(.bold))
        .foregroundStyle(isCurrent ? ADEColor.ctoAccent : ADEColor.textMuted)
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        .background(
          RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(isCurrent ? ADEColor.ctoAccent.opacity(0.14) : ADEColor.recessedBackground.opacity(0.5))
        )
        .overlay(
          RoundedRectangle(cornerRadius: 6, style: .continuous)
            .stroke(isCurrent ? ADEColor.ctoAccent.opacity(0.3) : ADEColor.glassBorder, lineWidth: 0.5)
        )

      VStack(alignment: .leading, spacing: 1) {
        Text(revisionNote)
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
        HStack(spacing: 4) {
          Text(ctoRelativeAgo(from: revision.createdAt))
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
          if isCurrent {
            Text("· current")
              .font(.system(size: 10, design: .monospaced))
              .foregroundStyle(ADEColor.ctoAccent)
          }
        }
      }

      Spacer(minLength: 0)

      if !isCurrent {
        Button(action: onRollback) {
          Text(isRolling ? "…" : "Rollback")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(ADEColor.textSecondary)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(ADEColor.recessedBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(
              RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(ADEColor.glassBorder, lineWidth: 0.5)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isRolling)
        .accessibilityLabel("Rollback to \(label)")
      }
    }
    .padding(.vertical, 11)
    .padding(.horizontal, 14)
  }

  private var revisionNote: String {
    let note = revision.note?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !note.isEmpty { return note }
    if !revision.changedKeys.isEmpty {
      return "Changed: " + revision.changedKeys.joined(separator: ", ")
    }
    return "No notes"
  }
}

private struct LearnedChip: View {
  let text: String
  var body: some View {
    Text(text)
      .font(.system(size: 10.5, weight: .medium))
      .foregroundStyle(ADEColor.ctoAccent)
      .padding(.horizontal, 8)
      .padding(.vertical, 3)
      .background(ADEColor.ctoAccent.opacity(0.14), in: Capsule())
      .overlay(Capsule().stroke(ADEColor.ctoAccent.opacity(0.28), lineWidth: 0.5))
      .lineLimit(1)
  }
}

// MARK: - FlowLayout

/// Simple flowing HStack for chip rows. Wraps to the next line when children
/// exceed the container width.
private struct FlowLayout: Layout {
  let spacing: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let maxWidth = proposal.width ?? .infinity
    var x: CGFloat = 0
    var y: CGFloat = 0
    var rowHeight: CGFloat = 0
    var totalWidth: CGFloat = 0
    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if x + size.width > maxWidth && x > 0 {
        y += rowHeight + spacing
        x = 0
        rowHeight = 0
      }
      x += size.width + spacing
      totalWidth = max(totalWidth, x)
      rowHeight = max(rowHeight, size.height)
    }
    let finalWidth = proposal.width ?? totalWidth
    return CGSize(width: finalWidth, height: y + rowHeight)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let maxWidth = bounds.width
    var x: CGFloat = bounds.minX
    var y: CGFloat = bounds.minY
    var rowHeight: CGFloat = 0
    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if x + size.width > bounds.minX + maxWidth && x > bounds.minX {
        y += rowHeight + spacing
        x = bounds.minX
        rowHeight = 0
      }
      subview.place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: .unspecified)
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
    }
  }
}

// MARK: - Utility

private extension String {
  func ifEmptyReturn(_ fallback: String) -> String {
    isEmpty ? fallback : self
  }
}

/// Swift Concurrency helper: wraps an async throwing call into a Result so
/// callers can `async let` multiple operations and inspect each outcome
/// independently without a single throw collapsing all of them.
private func CtoAsyncResult<T>(_ body: @escaping () async throws -> T) async -> Result<T, Error> {
  do { return .success(try await body()) }
  catch { return .failure(error) }
}

// MARK: - CtoWorkerQuickEditSheet

/// Lightweight edit sheet for fields that can be mutated from mobile:
/// status toggle and notes. Budget cap and adapter config require the
/// full desktop wizard.
struct CtoWorkerQuickEditSheet: View {
  let agent: AgentIdentity?
  let onSave: (_ status: String?, _ budgetCents: Int?) -> Void

  @Environment(\.dismiss) private var dismiss

  private let statusOptions: [(String, String)] = [
    ("active", "Active"),
    ("paused", "Paused"),
    ("idle", "Idle"),
  ]

  @State private var selectedStatus: String = "active"

  var body: some View {
    NavigationStack {
      Form {
        Section("Status") {
          Picker("Status", selection: $selectedStatus) {
            ForEach(statusOptions, id: \.0) { value, label in
              Text(label).tag(value)
            }
          }
          .pickerStyle(.inline)
          .labelsHidden()
        }

        Section {
          HStack {
            Image(systemName: "desktopcomputer")
              .foregroundStyle(ADEColor.textMuted)
            VStack(alignment: .leading, spacing: 2) {
              Text("More settings on desktop")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(ADEColor.textPrimary)
              Text("Budget cap, adapter config, Linear identity, and heartbeat policy are managed from the desktop CTO tab.")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }
          .padding(.vertical, 4)
        }
      }
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .navigationTitle("Edit worker")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Save") {
            let newStatus = selectedStatus != (agent?.status ?? "active") ? selectedStatus : nil
            onSave(newStatus, nil)
            dismiss()
          }
          .fontWeight(.semibold)
        }
      }
    }
    .tint(ADEColor.ctoAccent)
    .onAppear {
      selectedStatus = agent?.status.lowercased() ?? "active"
    }
  }
}
