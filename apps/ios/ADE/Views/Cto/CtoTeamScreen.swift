import SwiftUI

/// CTO Team tab — hero CTO card pinned at the top, followed by budget card and
/// the full roster of hired workers. Primary tap opens chat; a secondary
/// "Details" chip drills into the worker dashboard.
struct CtoTeamScreen: View {
  @EnvironmentObject private var syncService: SyncService
  @Binding var path: NavigationPath
  var isTabActive = true

  @State private var agents: [AgentIdentity] = []
  @State private var fallbackWorkers: [CtoWorkerEntry] = []
  @State private var budget: AgentBudgetSnapshot?
  @State private var isLoading = false
  @State private var loadError: String?

  @State private var showHireSheet = false
  @State private var pendingWakeup: Set<String> = []
  @State private var wakeupNotice: String?
  @State private var wakeupNoticeGeneration = 0
  @State private var lastLiveReloadAt: Date?

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

        if isLoading && displayAgents.isEmpty {
          VStack(spacing: 8) {
            ForEach(0..<4, id: \.self) { _ in
              ADECardSkeleton(rows: 2)
            }
          }
          .padding(.horizontal, 16)
        } else if displayAgents.isEmpty && loadError != nil {
          ADENoticeCard(
            title: "Couldn't load workers",
            message: loadError ?? "Unknown error.",
            icon: "exclamationmark.triangle.fill",
            tint: ADEColor.warning,
            actionTitle: "Retry",
            action: { Task { await load() } }
          )
          .padding(.horizontal, 16)
        } else if displayAgents.isEmpty {
          ADEEmptyStateView(
            symbol: "person.crop.circle.badge.questionmark",
            title: "No workers hired yet",
            message: "The persistent CTO is available above. Hire specialized workers from ADE on your machine."
          )
          .padding(.horizontal, 16)
        } else {
          VStack(spacing: 8) {
            ForEach(displayAgents) { agent in
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
    .refreshable { await load(force: true) }
    .task { if displayAgents.isEmpty { await load(force: true) } }
    .task(id: ctoAgentsLiveReloadKey) {
      guard ctoAgentsLiveReloadKey != nil else { return }
      let now = Date()
      guard shouldRunCtoLiveReload(lastReloadAt: lastLiveReloadAt, now: now) else { return }
      lastLiveReloadAt = now
      await load(force: true)
    }
    .sheet(isPresented: $showHireSheet) {
      CtoWorkerHireSheet(existingAgents: displayAgents) { saved in
        showHireSheet = false
        await load(force: true)
        flashWakeupNotice("Hired \(saved.name).")
      }
      .environmentObject(syncService)
      .presentationDetents([.large])
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
          .glassEffect(in: .rect(cornerRadius: 8))
          .shadow(color: ADEColor.ctoAccent.opacity(0.45), radius: 8, y: 2)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Hire worker")
      .accessibilityHint("Opens the worker creation form.")
    }
  }

  private var headerSubtitle: String {
    let count = displayAgents.count
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
      if !displayAgents.isEmpty {
        Text("\(displayAgents.count)")
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
  private func load(force: Bool = false) async {
    if isLoading { return }
    if !force && !displayAgents.isEmpty { return }
    isLoading = true
    clearWakeupNotice()
    defer { isLoading = false }

    async let agentsR = CtoTeamAsyncResult { try await syncService.fetchCtoAgents() }
    async let budgetR = CtoTeamAsyncResult { try await syncService.fetchCtoBudget() }
    let (agentsResult, budgetResult) = await (agentsR, budgetR)

    switch agentsResult {
    case .success(let fetched):
      agents = fetched
      if fetched.isEmpty {
        if let roster = try? await syncService.fetchCtoRoster() {
          fallbackWorkers = roster.workers
        } else {
          fallbackWorkers = []
        }
      } else {
        fallbackWorkers = []
      }
      loadError = nil
    case .failure(let error):
      agents = []
      let rosterWorkers = (try? await syncService.fetchCtoRoster())?.workers ?? []
      fallbackWorkers = rosterWorkers
      if syncService.connectionState.isHostUnreachable || !rosterWorkers.isEmpty {
        loadError = nil
      } else {
        loadError = (error as NSError).localizedDescription
      }
    }
    if case .success(let snap) = budgetResult {
      budget = snap
    }
    lastLiveReloadAt = Date()
  }

  private var displayAgents: [AgentIdentity] {
    if !agents.isEmpty { return agents }
    return fallbackWorkers.map { worker in
      AgentIdentity(
        id: worker.agentId,
        name: worker.name,
        slug: nil,
        role: "worker",
        title: nil,
        reportsTo: nil,
        capabilities: [],
        status: worker.status,
        adapterType: "legacy_roster",
        adapterConfig: nil,
        personality: nil,
        systemPromptExtension: nil,
        budgetMonthlyCents: nil,
        spentMonthlyCents: nil,
        lastHeartbeatAt: nil,
        createdAt: nil,
        updatedAt: nil
      )
    }
  }

  private var ctoAgentsLiveReloadKey: String? {
    // Don't poll fetchCtoAgents/fetchCtoBudget while the CTO tab isn't frontmost.
    guard isTabActive else { return nil }
    switch syncService.connectionState {
    case .connected, .syncing:
      return "live-\(syncService.localStateRevision)"
    case .connecting, .disconnected, .error:
      return nil
    }
  }

  @MainActor
  private func wakeUp(agent: AgentIdentity) async {
    guard !pendingWakeup.contains(agent.id) else { return }
    pendingWakeup.insert(agent.id)
    defer { pendingWakeup.remove(agent.id) }
    do {
      _ = try await syncService.triggerAgentWakeup(agentId: agent.id)
      flashWakeupNotice("Woke \(agent.name).")
    } catch {
      flashWakeupNotice("Wake failed: \(error.localizedDescription)")
    }
  }

  @MainActor
  private func flashWakeupNotice(_ text: String) {
    wakeupNoticeGeneration += 1
    let generation = wakeupNoticeGeneration
    withAnimation(.easeInOut(duration: 0.2)) { wakeupNotice = text }
    Task {
      try? await Task.sleep(nanoseconds: 4_000_000_000)
      guard wakeupNoticeGeneration == generation else { return }
      withAnimation(.easeInOut(duration: 0.2)) { wakeupNotice = nil }
    }
  }

  @MainActor
  private func clearWakeupNotice() {
    guard wakeupNotice != nil else { return }
    wakeupNoticeGeneration += 1
    withAnimation(.easeInOut(duration: 0.2)) { wakeupNotice = nil }
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
    .background(ADEColor.glassBackground, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .glassEffect(in: .rect(cornerRadius: 14))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(
          LinearGradient(
            colors: [Color.white.opacity(0.06), .clear],
            startPoint: .top,
            endPoint: .bottom
          )
        )
        .allowsHitTesting(false)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.75)
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
    .adeInspectable(
      "CTO.Team.WorkerRow",
      metadata: [
        "label": "\(agent.name), \(agent.role), status \(agent.status)",
        "agentId": agent.id,
        "agentName": agent.name,
        "role": "row",
        "status": agent.status
      ]
    )
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
        .adeInspectable(
          "CTO.Team.WakeButton",
          metadata: [
            "label": "Wake \(agent.name)",
            "agentId": agent.id,
            "agentName": agent.name,
            "role": "button"
          ]
        )
      MiniActionButton(label: "Details", action: onDetails)
        .accessibilityLabel("Details for \(agent.name)")
        .adeInspectable(
          "CTO.Team.DetailsButton",
          metadata: [
            "label": "Details for \(agent.name)",
            "agentId": agent.id,
            "agentName": agent.name,
            "role": "button"
          ]
        )
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
        .background(ADEColor.recessedBackground.opacity(0.6), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .glassEffect(in: .rect(cornerRadius: 6))
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

private struct CtoWorkerTemplate: Identifiable, Hashable {
  let id: String
  let name: String
  let role: String
  let title: String
  let capabilities: [String]
  let model: String
  let description: String
  let systemImage: String
}

private let ctoWorkerTemplates: [CtoWorkerTemplate] = [
  CtoWorkerTemplate(
    id: "backend-engineer",
    name: "Backend Engineer",
    role: "engineer",
    title: "Backend Engineer",
    capabilities: ["backend", "api", "database", "testing"],
    model: "claude-sonnet-4-6",
    description: "Services, persistence, integrations, and tests.",
    systemImage: "server.rack"
  ),
  CtoWorkerTemplate(
    id: "frontend-engineer",
    name: "Frontend Engineer",
    role: "engineer",
    title: "Frontend Engineer",
    capabilities: ["frontend", "ui", "accessibility", "testing"],
    model: "claude-sonnet-4-6",
    description: "Interfaces, state, polish, and browser validation.",
    systemImage: "rectangle.on.rectangle.angled"
  ),
  CtoWorkerTemplate(
    id: "qa-tester",
    name: "QA Tester",
    role: "qa",
    title: "QA Tester",
    capabilities: ["qa", "regression", "edge-cases", "automation"],
    model: "claude-sonnet-4-6",
    description: "Regression passes, edge cases, and proof capture.",
    systemImage: "checkmark.shield"
  ),
  CtoWorkerTemplate(
    id: "devops",
    name: "DevOps Engineer",
    role: "devops",
    title: "DevOps Engineer",
    capabilities: ["ci", "release", "infra", "observability"],
    model: "claude-sonnet-4-6",
    description: "Builds, CI, releases, and operational fixes.",
    systemImage: "gearshape.2"
  ),
  CtoWorkerTemplate(
    id: "researcher",
    name: "Researcher",
    role: "researcher",
    title: "Researcher",
    capabilities: ["research", "analysis", "planning", "docs"],
    model: "claude-sonnet-4-6",
    description: "Investigations, comparisons, and written findings.",
    systemImage: "book"
  ),
  CtoWorkerTemplate(
    id: "custom",
    name: "Custom Worker",
    role: "general",
    title: "",
    capabilities: [],
    model: "claude-sonnet-4-6",
    description: "Start blank and define the role yourself.",
    systemImage: "wand.and.stars"
  ),
]

private struct CtoWorkerHireSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let existingAgents: [AgentIdentity]
  let onSaved: (AgentIdentity) async -> Void

  @State private var selectedTemplateId = ctoWorkerTemplates.first?.id ?? "custom"
  @State private var name = ""
  @State private var title = ""
  @State private var role = "engineer"
  @State private var capabilitiesText = ""
  @State private var adapterType = "claude-local"
  @State private var model = "claude-sonnet-4-6"
  @State private var budgetText = ""
  @State private var maxConcurrentRuns = 1
  @State private var wakeOnDemand = true
  @State private var saving = false
  @State private var errorMessage: String?

  private let roleOptions = [
    ("engineer", "Engineer"),
    ("qa", "QA"),
    ("designer", "Designer"),
    ("devops", "DevOps"),
    ("researcher", "Researcher"),
    ("general", "General"),
  ]

  private let adapterOptions = [
    ("claude-local", "Claude local"),
    ("codex-local", "Codex local"),
  ]

  private var canSave: Bool {
    !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !saving
  }

  var body: some View {
    NavigationStack {
      Form {
        if let errorMessage {
          Section {
            Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
              .foregroundStyle(ADEColor.danger)
          }
        }

        Section("Template") {
          ForEach(ctoWorkerTemplates) { template in
            Button {
              apply(template)
            } label: {
              HStack(alignment: .top, spacing: 10) {
                Image(systemName: template.systemImage)
                  .foregroundStyle(ADEColor.ctoAccent)
                  .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                  Text(template.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ADEColor.textPrimary)
                  Text(template.description)
                    .font(.caption)
                    .foregroundStyle(ADEColor.textSecondary)
                }
                Spacer(minLength: 8)
                if selectedTemplateId == template.id {
                  Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(ADEColor.ctoAccent)
                }
              }
            }
            .buttonStyle(.plain)
          }
        }

        Section("Identity") {
          TextField("Name", text: $name)
            .textInputAutocapitalization(.words)
          TextField("Title", text: $title)
            .textInputAutocapitalization(.words)
          Picker("Role", selection: $role) {
            ForEach(roleOptions, id: \.0) { value, label in
              Text(label).tag(value)
            }
          }
          TextField("Capabilities", text: $capabilitiesText, axis: .vertical)
            .lineLimit(2...4)
            .textInputAutocapitalization(.never)
        }

        Section("Runtime") {
          Picker("Adapter", selection: $adapterType) {
            ForEach(adapterOptions, id: \.0) { value, label in
              Text(label).tag(value)
            }
          }
          TextField("Model", text: $model)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          Stepper("Max concurrent runs: \(maxConcurrentRuns)", value: $maxConcurrentRuns, in: 1...10)
          Toggle("Wake on demand", isOn: $wakeOnDemand)
        }

        Section("Budget") {
          TextField("Monthly cap in dollars", text: $budgetText)
            .keyboardType(.decimalPad)
          Text("Leave empty or use 0 for no monthly cap.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }

        if !existingAgents.isEmpty {
          Section {
            Text("The worker will appear in the CTO roster after the paired machine saves it.")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
      }
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .navigationTitle("Hire worker")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            Task { await save() }
          } label: {
            if saving {
              ProgressView()
            } else {
              Text("Save")
                .fontWeight(.semibold)
            }
          }
          .disabled(!canSave)
        }
      }
    }
    .tint(ADEColor.ctoAccent)
    .onAppear {
      guard name.isEmpty, let first = ctoWorkerTemplates.first else { return }
      apply(first)
    }
  }

  @MainActor
  private func apply(_ template: CtoWorkerTemplate) {
    selectedTemplateId = template.id
    name = template.id == "custom" ? "" : template.name
    title = template.title
    role = template.role
    capabilitiesText = template.capabilities.joined(separator: ", ")
    model = template.model
    if adapterType != "claude-local" && adapterType != "codex-local" {
      adapterType = "claude-local"
    }
  }

  @MainActor
  private func save() async {
    let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedName.isEmpty else { return }
    saving = true
    errorMessage = nil
    defer { saving = false }

    do {
      let saved = try await syncService.saveAgent(makeAgentInput(name: trimmedName))
      await onSaved(saved)
      dismiss()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func makeAgentInput(name: String) -> AgentUpsertInput {
    let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
    var adapterConfig: [String: RemoteJSONValue] = [:]
    if !trimmedModel.isEmpty {
      adapterConfig["model"] = .string(trimmedModel)
    }

    return AgentUpsertInput(
      id: nil,
      name: name,
      role: role,
      title: trimmedTitle.isEmpty ? nil : trimmedTitle,
      reportsTo: nil,
      capabilities: parsedCapabilities,
      status: "active",
      adapterType: adapterType,
      adapterConfig: adapterConfig.isEmpty ? nil : adapterConfig,
      runtimeConfig: AgentRuntimeConfigPatch(
        heartbeat: AgentHeartbeatConfig(
          enabled: false,
          intervalSec: 0,
          wakeOnDemand: wakeOnDemand,
          activeHours: nil
        ),
        maxConcurrentRuns: maxConcurrentRuns
      ),
      linearIdentity: nil,
      budgetMonthlyCents: parsedBudgetCents
    )
  }

  private var parsedCapabilities: [String] {
    capabilitiesText
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
  }

  private var parsedBudgetCents: Int? {
    let normalized = budgetText
      .replacingOccurrences(of: "$", with: "")
      .replacingOccurrences(of: ",", with: "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty, let dollars = Double(normalized), dollars > 0 else { return nil }
    return max(1, Int((dollars * 100).rounded()))
  }
}

struct CtoMachineOnlyNotice: View {
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
