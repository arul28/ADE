import SwiftUI

/// CTO Team tab — hero CTO card pinned at the top, followed by budget card and
/// the full roster of hired workers. Primary tap opens chat; a secondary
/// "Details" chip drills into the worker dashboard.
struct CtoTeamScreen: View {
  @EnvironmentObject private var syncService: SyncService
  @Binding var path: NavigationPath

  @State private var agents: [AgentIdentity] = []
  @State private var budget: AgentBudgetSnapshot?
  @State private var isLoading = false
  @State private var loadError: String?

  @State private var showHireSheet = false
  @State private var pendingWakeup: Set<String> = []
  @State private var wakeupNotice: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        headerRow
          .padding(.horizontal, 20)

        ctoHeroCard
          .padding(.horizontal, 16)

        budgetCard
          .padding(.horizontal, 16)

        rosterSectionHeader
          .padding(.horizontal, 20)

        if isLoading && agents.isEmpty {
          VStack(spacing: 8) {
            ForEach(0..<4, id: \.self) { _ in
              ADECardSkeleton(rows: 2)
            }
          }
          .padding(.horizontal, 16)
        } else if agents.isEmpty && loadError != nil {
          ADENoticeCard(
            title: "Couldn't load workers",
            message: loadError ?? "Unknown error.",
            icon: "exclamationmark.triangle.fill",
            tint: ADEColor.warning,
            actionTitle: "Retry",
            action: { Task { await load() } }
          )
          .padding(.horizontal, 16)
        } else if agents.isEmpty {
          ADEEmptyStateView(
            symbol: "person.crop.circle.badge.questionmark",
            title: "No workers hired yet",
            message: "The persistent CTO is available above. Hire specialized workers from the desktop CTO tab."
          )
          .padding(.horizontal, 16)
        } else {
          VStack(spacing: 8) {
            ForEach(agents) { agent in
              WorkerRowCard(
                agent: agent,
                spentOverride: spentOverride(for: agent),
                isWaking: pendingWakeup.contains(agent.id),
                onOpenChat: {
                  path.append(CtoSessionRoute.worker(agentId: agent.id, displayName: agent.name))
                },
                onWake: { Task { await wakeUp(agent: agent) } },
                onDetails: {
                  path.append(CtoSessionRoute.workerDetail(agentId: agent.id, displayName: agent.name))
                }
              )
            }
          }
          .padding(.horizontal, 16)
        }

        if let wakeupNotice {
          Text(wakeupNotice)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .padding(.horizontal, 16)
            .transition(.opacity)
        }

        Color.clear.frame(height: 32)
      }
      .padding(.top, 8)
    }
    .refreshable { await load() }
    .task { if agents.isEmpty { await load() } }
    .sheet(isPresented: $showHireSheet) {
      CtoDesktopOnlyNotice(
        title: "Hire worker",
        message: "Hire worker on the desktop CTO tab — mobile support is coming soon."
      )
      .presentationDetents([.fraction(0.3), .medium])
    }
  }

  // MARK: - Header

  private var headerRow: some View {
    HStack(alignment: .top, spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Text("Team")
          .font(.system(size: 19, weight: .heavy))
          .tracking(-0.3)
          .foregroundStyle(ADEColor.textPrimary)
        Text(headerSubtitle)
          .font(.system(size: 10.5, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
      }
      Spacer(minLength: 0)
      Button {
        showHireSheet = true
      } label: {
        Text("+ Hire worker")
          .font(.system(size: 12, weight: .bold))
          .foregroundStyle(Color.black)
          .padding(.horizontal, 12)
          .padding(.vertical, 6)
          .background(ADEColor.ctoAccent, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Hire worker")
      .accessibilityHint("Opens a sheet explaining hire is desktop-only for now.")
    }
  }

  private var headerSubtitle: String {
    let count = agents.count
    let workerWord = count == 1 ? "worker" : "workers"
    let spent = ctoFormatCents(budget?.companySpentMonthlyCents ?? companySpentFallbackCents)
    if let cap = budget?.companyCapMonthlyCents {
      return "\(count) \(workerWord) · \(spent) of \(ctoFormatCents(cap)) this month"
    }
    return "\(count) \(workerWord) · \(spent) this month"
  }

  // MARK: - Hero CTO card

  private var ctoHeroCard: some View {
    Button {
      path.append(CtoSessionRoute.cto)
    } label: {
      HStack(alignment: .center, spacing: 14) {
        ZStack {
          RoundedRectangle(cornerRadius: 16, style: .continuous)
            .fill(
              LinearGradient(
                colors: [ADEColor.ctoAccent.opacity(0.32), ADEColor.ctoAccent.opacity(0.14)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
              )
            )
          RoundedRectangle(cornerRadius: 16, style: .continuous)
            .stroke(ADEColor.ctoAccent.opacity(0.4), lineWidth: 0.8)
          Text("C")
            .font(.system(size: 22, weight: .heavy))
            .foregroundStyle(ADEColor.ctoAccent)
        }
        .frame(width: 52, height: 52)
        .accessibilityHidden(true)

        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 6) {
            Text("CTO")
              .font(.system(size: 16, weight: .bold))
              .foregroundStyle(ADEColor.textPrimary)
            ADEStatusPill(text: "Persistent", tint: ADEColor.ctoAccent)
          }
          Text("Technical lead · tap to chat")
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textSecondary)
        }

        Spacer(minLength: 8)

        Image(systemName: "message.fill")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.ctoAccent)
          .padding(8)
          .background(
            Circle().fill(ADEColor.ctoAccent.opacity(0.14))
          )
          .overlay(
            Circle().stroke(ADEColor.ctoAccent.opacity(0.32), lineWidth: 0.5)
          )
          .accessibilityHidden(true)
      }
      .padding(.vertical, 4)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .adeListCard()
    .accessibilityLabel("CTO, persistent technical lead")
    .accessibilityHint("Opens the CTO chat.")
  }

  private var companySpentFallbackCents: Int {
    agents.map { $0.spentMonthlyCents ?? 0 }.reduce(0, +)
  }

  // MARK: - Budget card

  private var budgetCard: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text("Project budget")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
          .textCase(.uppercase)
          .tracking(0.4)
        Spacer(minLength: 0)
        Text(budgetRightLabel)
          .font(.system(size: 10.5, design: .monospaced).weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
      }

      if let pct = companyBudgetPercent {
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
        .frame(height: 5)
      }
    }
    .adeListCard()
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Project budget \(budgetRightLabel)")
  }

  private var budgetRightLabel: String {
    let spent = ctoFormatCents(budget?.companySpentMonthlyCents ?? companySpentFallbackCents)
    if let cap = budget?.companyCapMonthlyCents {
      return "\(spent) / \(ctoFormatCents(cap))"
    }
    return spent
  }

  private var companyBudgetPercent: Int? {
    guard let snapshot = budget else { return nil }
    return ctoBudgetPercent(spentCents: snapshot.companySpentMonthlyCents, capCents: snapshot.companyCapMonthlyCents)
  }

  private func spentOverride(for agent: AgentIdentity) -> Int? {
    budget?.workers.first(where: { $0.agentId == agent.id })?.spentMonthlyCents
  }

  // MARK: - Roster section header

  private var rosterSectionHeader: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text("Workers")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
        .textCase(.uppercase)
        .tracking(0.4)
      Spacer(minLength: 0)
      if !agents.isEmpty {
        Text("\(agents.count)")
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textMuted)
      }
    }
  }

  // MARK: - Actions

  /// Loads agents and budget in parallel but tolerates partial failure — a
  /// missing budget snapshot shouldn't hide the worker list, and a listAgents
  /// failure shouldn't hide the budget card. Connection-level errors are
  /// surfaced globally by the top-right gear, not inline here.
  @MainActor
  private func load() async {
    if isLoading { return }
    isLoading = true
    defer { isLoading = false }

    async let agentsR = CtoTeamAsyncResult { try await syncService.fetchCtoAgents() }
    async let budgetR = CtoTeamAsyncResult { try await syncService.fetchCtoBudget() }
    let (agentsResult, budgetResult) = await (agentsR, budgetR)

    switch agentsResult {
    case .success(let fetched):
      agents = fetched
      loadError = nil
    case .failure(let error):
      if syncService.connectionState.isHostUnreachable {
        loadError = nil
      } else {
        loadError = (error as NSError).localizedDescription
      }
    }
    if case .success(let snap) = budgetResult {
      budget = snap
    }
  }

  @MainActor
  private func wakeUp(agent: AgentIdentity) async {
    guard !pendingWakeup.contains(agent.id) else { return }
    pendingWakeup.insert(agent.id)
    defer { pendingWakeup.remove(agent.id) }
    do {
      _ = try await syncService.triggerAgentWakeup(agentId: agent.id)
      wakeupNotice = "Woke \(agent.name)."
    } catch {
      wakeupNotice = "Wake failed: \(error.localizedDescription)"
    }
  }
}

// MARK: - WorkerRowCard

/// Full-width worker row. Primary tap opens chat; the Details chip on the
/// right opens the worker dashboard. A context menu (long-press) mirrors both
/// actions plus Wake.
private struct WorkerRowCard: View {
  let agent: AgentIdentity
  let spentOverride: Int?
  let isWaking: Bool
  let onOpenChat: () -> Void
  let onWake: () -> Void
  let onDetails: () -> Void

  private var spentCents: Int { spentOverride ?? agent.spentMonthlyCents ?? 0 }
  private var budgetCents: Int? { agent.budgetMonthlyCents }

  private var progressPct: Int? {
    guard let cap = budgetCents, cap > 0 else { return nil }
    return ctoBudgetPercent(spentCents: spentCents, capCents: cap)
  }

  private var statusDot: Color { ctoStatusTint(agent.status) }
  private var isRunning: Bool { agent.status.lowercased() == "running" }

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      Button(action: onOpenChat) {
        HStack(alignment: .center, spacing: 12) {
          avatar

          VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
              Circle()
                .fill(statusDot)
                .frame(width: 7, height: 7)
                .shadow(color: isRunning ? statusDot.opacity(0.8) : .clear, radius: 3)
              Text(agent.name)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(ADEColor.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
              Spacer(minLength: 0)
            }

            HStack(spacing: 5) {
              Text(agent.role)
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(1)
              Text("·")
                .font(.system(size: 10.5))
                .foregroundStyle(ADEColor.textMuted.opacity(0.5))
              Text(agent.model ?? "—")
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(1)
            }

            HStack(spacing: 6) {
              Text(ctoFormatCents(spentCents) + "/mo")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(ADEColor.textMuted)
              if let pct = progressPct {
                GeometryReader { proxy in
                  let width = proxy.size.width * CGFloat(pct) / 100.0
                  ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 1, style: .continuous)
                      .fill(ADEColor.recessedBackground.opacity(0.5))
                    RoundedRectangle(cornerRadius: 1, style: .continuous)
                      .fill(pct > 80 ? ADEColor.warning : ADEColor.ctoAccent)
                      .frame(width: max(0, width))
                  }
                }
                .frame(height: 2)
              }
            }
            .padding(.top, 1)
          }
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(agent.name), \(agent.role), status \(agent.status)")
      .accessibilityHint("Opens chat with \(agent.name).")

      actionsStack
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(
          LinearGradient(
            colors: [ADEColor.cardBackground.opacity(0.85), ADEColor.cardBackground.opacity(0.95)],
            startPoint: .top,
            endPoint: .bottom
          )
        )
    )
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.5)
    )
    .contextMenu {
      Button {
        onOpenChat()
      } label: {
        Label("Chat", systemImage: "message")
      }
      Button {
        onDetails()
      } label: {
        Label("Details", systemImage: "info.circle")
      }
      Button {
        onWake()
      } label: {
        Label(isWaking ? "Waking…" : "Wake", systemImage: "bolt")
      }
      .disabled(isWaking)
    }
  }

  private var avatar: some View {
    let tint = ctoAvatarTint(name: agent.name, seed: agent.id)
    return ZStack {
      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .fill(tint.opacity(0.18))
      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .stroke(tint.opacity(0.35), lineWidth: 0.6)
      Text(ctoAvatarInitial(for: agent.name))
        .font(.system(size: 14, weight: .heavy))
        .foregroundStyle(tint)
    }
    .frame(width: 38, height: 38)
    .accessibilityHidden(true)
  }

  private var actionsStack: some View {
    VStack(spacing: 4) {
      MiniActionButton(label: isWaking ? "…" : "Wake", action: onWake)
        .disabled(isWaking)
        .accessibilityLabel("Wake \(agent.name)")
      MiniActionButton(label: "Details", action: onDetails)
        .accessibilityLabel("Details for \(agent.name)")
    }
  }
}

private struct MiniActionButton: View {
  let label: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(label)
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(minWidth: 52)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(ADEColor.recessedBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 6, style: .continuous)
            .stroke(ADEColor.glassBorder, lineWidth: 0.5)
        )
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

// MARK: - Shared sheet

private func CtoTeamAsyncResult<T>(_ body: @escaping () async throws -> T) async -> Result<T, Error> {
  do { return .success(try await body()) }
  catch { return .failure(error) }
}

struct CtoDesktopOnlyNotice: View {
  let title: String
  let message: String
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(spacing: 16) {
      Capsule()
        .fill(ADEColor.border.opacity(0.6))
        .frame(width: 36, height: 4)
        .padding(.top, 8)

      Image(systemName: "desktopcomputer")
        .font(.system(size: 28, weight: .semibold))
        .foregroundStyle(ADEColor.ctoAccent)
        .padding(.top, 8)

      VStack(spacing: 6) {
        Text(title)
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
        Text(message)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .multilineTextAlignment(.center)
          .padding(.horizontal, 16)
      }

      Button("OK") { dismiss() }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.ctoAccent)
        .controlSize(.regular)
        .padding(.top, 4)

      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(24)
    .background(ADEColor.surfaceBackground.ignoresSafeArea())
  }
}
