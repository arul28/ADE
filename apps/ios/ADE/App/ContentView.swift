import SwiftUI
import UIKit

private let adeAccent = ADEColor.accent

private enum RootTab: Hashable {
  case work
  case lanes
  case prs
  case files
  case more
}

struct ContentView: View {
  @EnvironmentObject private var syncService: SyncService
  @State private var selectedTab: RootTab = .work
  @AppStorage("ade.colorScheme") private var colorSchemeRaw: String = ADEColorSchemeChoice.system.rawValue

  private var colorSchemeChoice: ADEColorSchemeChoice {
    ADEColorSchemeChoice(rawValue: colorSchemeRaw) ?? .system
  }

  var body: some View {
    rootTabs
      .tint(adeAccent)
      .tabBarMinimizeBehavior(.onScrollDown)
      .adeScreenBackground()
      .adeNavigationGlass()
      .preferredColorScheme(colorSchemeChoice.preferredColorScheme)
      .sensoryFeedback(.selection, trigger: selectedTab)
      .onChange(of: syncService.settingsPresented) { _, presented in
        guard presented else { return }
        selectedTab = .more
        syncService.settingsPresented = false
      }
      .onChange(of: syncService.requestedFilesNavigation?.id) { _, requestId in
        guard requestId != nil else { return }
        selectedTab = .files
      }
      .onChange(of: syncService.requestedLaneNavigation?.id) { _, requestId in
        guard requestId != nil else { return }
        selectedTab = .lanes
      }
      .onChange(of: syncService.requestedPrNavigation?.id) { _, requestId in
        guard requestId != nil else { return }
        selectedTab = .prs
      }
  }

  private var rootTabs: some View {
    TabView(selection: $selectedTab) {
      workTab
      lanesTab
      prsTab
      filesTab
      moreTab
    }
  }

  private var workTab: some View {
    WorkTabView(isActive: selectedTab == .work)
      .tag(RootTab.work)
      .tabItem {
        Label("Work", systemImage: "terminal")
      }
      .badge(syncService.runningChatSessionCount)
  }

  private var lanesTab: some View {
    LanesTabView(isActive: selectedTab == .lanes)
      .tag(RootTab.lanes)
      .tabItem {
        Label("Lanes", systemImage: "square.stack.3d.up")
      }
  }

  private var prsTab: some View {
    PRsTabView(isActive: selectedTab == .prs)
      .tag(RootTab.prs)
      .tabItem {
        Label("PRs", systemImage: "arrow.triangle.pull")
      }
  }

  private var filesTab: some View {
    FilesTabView(isActive: selectedTab == .files)
      .tag(RootTab.files)
      .tabItem {
        Label("Files", systemImage: "doc.text")
      }
  }

  private var moreTab: some View {
    DesktopMoreTabScreen()
      .tag(RootTab.more)
      .tabItem {
        Label("More", systemImage: "ellipsis")
      }
  }
}

private enum DesktopParitySection {
  case project
  case graph
  case history
  case automations
  case missions
  case cto

  var title: String {
    switch self {
    case .project: return "Run"
    case .graph: return "Graph"
    case .history: return "History"
    case .automations: return "Automations"
    case .missions: return "Missions"
    case .cto: return "CTO"
    }
  }

  var symbol: String {
    switch self {
    case .project: return "play.circle.fill"
    case .graph: return "point.3.connected.trianglepath.dotted"
    case .history: return "clock.arrow.circlepath"
    case .automations: return "gearshape.2.fill"
    case .missions: return "arrow.triangle.branch"
    case .cto: return "brain.head.profile"
    }
  }

  var tint: Color {
    switch self {
    case .project: return ADEColor.purpleAccent
    case .graph: return ADEColor.tintGraph
    case .history: return ADEColor.tintHistory
    case .automations: return ADEColor.tintAutomations
    case .missions: return ADEColor.tintMissions
    case .cto: return ADEColor.accent
    }
  }

  var route: String {
    switch self {
    case .project: return "/project"
    case .graph: return "/graph"
    case .history: return "/history"
    case .automations: return "/automations"
    case .missions: return "/missions"
    case .cto: return "/cto"
    }
  }

  var checks: [String] {
    switch self {
    case .project:
      return ["Process monitor", "Command cards", "Runtime lanes", "Network view"]
    case .graph:
      return ["Lane graph", "Risk edges", "Conflict nodes", "Workspace topology"]
    case .history:
      return ["Timeline tracks", "WIP rows", "Event detail", "Branch movement"]
    case .automations:
      return ["Rules", "Templates", "Run history", "Budget pacing"]
    case .missions:
      return ["Mission dashboard", "Agent channels", "Plan and logs", "Artifacts"]
    case .cto:
      return ["Linear pipeline", "Worker activity", "Team identity", "Operations"]
    }
  }
}

private enum DesktopMoreDestination: Hashable {
  case project
  case graph
  case history
  case automations
  case missions
  case cto
  case settings
}

private struct DesktopMoreTabScreen: View {
  private let rows: [(destination: DesktopMoreDestination, title: String, symbol: String, tint: Color)] = [
    (.project, "Run", "play.circle.fill", ADEColor.purpleAccent),
    (.graph, "Graph", "point.3.connected.trianglepath.dotted", ADEColor.tintGraph),
    (.history, "History", "clock.arrow.circlepath", ADEColor.tintHistory),
    (.automations, "Automations", "gearshape.2.fill", ADEColor.tintAutomations),
    (.missions, "Missions", "arrow.triangle.branch", ADEColor.tintMissions),
    (.cto, "CTO", "brain.head.profile", ADEColor.accent),
    (.settings, "Settings", "gearshape", ADEColor.tintSettings),
  ]

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          ForEach(rows, id: \.destination) { row in
            NavigationLink {
              destinationView(for: row.destination)
            } label: {
              HStack(spacing: 12) {
                Image(systemName: row.symbol)
                  .font(.system(size: 18, weight: .semibold))
                  .foregroundStyle(row.tint)
                  .frame(width: 36, height: 36)
                  .background(row.tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                Text(row.title)
                  .font(.headline)
                  .foregroundStyle(ADEColor.textPrimary)

                Spacer(minLength: 0)

                Image(systemName: "chevron.right")
                  .font(.caption.weight(.bold))
                  .foregroundStyle(ADEColor.textMuted)
              }
              .padding(14)
              .background(ADEColor.cardBackground.opacity(0.78), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
              .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                  .stroke(ADEColor.glassBorder, lineWidth: 0.7)
              )
            }
            .buttonStyle(.plain)
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("More")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          ADEConnectionDot()
        }
      }
    }
  }

  @ViewBuilder
  private func destinationView(for destination: DesktopMoreDestination) -> some View {
    switch destination {
    case .project:
      DesktopParityTabScreen(section: .project)
    case .graph:
      DesktopParityTabScreen(section: .graph)
    case .history:
      DesktopParityTabScreen(section: .history)
    case .automations:
      DesktopParityTabScreen(section: .automations)
    case .missions:
      DesktopParityTabScreen(section: .missions)
    case .cto:
      DesktopParityTabScreen(section: .cto)
    case .settings:
      ConnectionSettingsView()
    }
  }
}

private struct DesktopParityTabScreen: View {
  @EnvironmentObject private var syncService: SyncService

  let section: DesktopParitySection
  @State private var isLoading = false
  @State private var errorMessage: String?
  @State private var sessions: [TerminalSessionSummary] = []
  @State private var lanes: [LaneSummary] = []
  @State private var laneSnapshots: [LaneListSnapshot] = []
  @State private var pullRequests: [PullRequestListItem] = []
  @State private var integrationProposals: [IntegrationProposal] = []
  @State private var queueStates: [QueueLandingState] = []
  @State private var chatSessions: [AgentChatSessionSummary] = []
  @State private var recentCommitsByLaneId: [String: [GitCommitSummary]] = [:]
  @State private var processDefinitions: [ProcessDefinition] = []
  @State private var processRuntime: [ProcessRuntime] = []
  @State private var selectedRunLaneId: String?
  @State private var processActionInFlightIds: Set<String> = []

  private var connectionLabel: String {
    switch syncService.connectionState {
    case .connected, .syncing: return "Connected"
    case .connecting: return "Connecting"
    case .disconnected: return "Offline"
    case .error: return "Connection error"
    }
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          headerCard
          if let errorMessage {
            parityStatusCard(
              title: "Refresh failed",
              message: errorMessage,
              symbol: "exclamationmark.triangle.fill",
              tint: ADEColor.danger
            )
          }
          metricsGrid
          primaryContent
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
      }
      .refreshable { await loadData(force: true) }
      .scrollBounceBehavior(.basedOnSize)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle(section.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          ADEConnectionDot()
        }
      }
      .task(id: section.title) {
        await loadData(force: false)
      }
    }
  }

  private var headerCard: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .center, spacing: 12) {
        Image(systemName: section.symbol)
          .font(.system(size: 22, weight: .semibold))
          .foregroundStyle(section.tint)
          .frame(width: 42, height: 42)
          .background(section.tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
              .stroke(section.tint.opacity(0.26), lineWidth: 0.8)
          )

        VStack(alignment: .leading, spacing: 4) {
          Text(section.title)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text(section.route)
            .font(.caption.monospaced())
            .foregroundStyle(ADEColor.textMuted)
        }

        Spacer(minLength: 0)

        HStack(spacing: 6) {
          if isLoading {
            ProgressView()
              .controlSize(.mini)
          }
          Text(connectionLabel)
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textSecondary)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(ADEColor.raisedBackground.opacity(0.8), in: Capsule())
      }

    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
  }

  private var metricsGrid: some View {
    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
      ForEach(metrics) { metric in
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 8) {
            Image(systemName: metric.symbol)
              .font(.caption.weight(.bold))
              .foregroundStyle(metric.tint)
            Text(metric.label)
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textMuted)
          }
          Text(metric.value)
            .font(.title3.weight(.bold))
            .foregroundStyle(ADEColor.textPrimary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(ADEColor.cardBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 16, style: .continuous)
            .stroke(ADEColor.glassBorder, lineWidth: 0.6)
        )
      }
    }
  }

  @ViewBuilder
  private var primaryContent: some View {
    switch section {
    case .project:
      runContent
    case .graph:
      itemList(title: "Lane graph", emptyTitle: "No lane graph yet", emptyMessage: "Pull to hydrate lane topology.", items: graphItems)
    case .history:
      itemList(title: "Recent history", emptyTitle: "No commit history cached", emptyMessage: "Pull to fetch recent commits.", items: historyItems)
    case .automations:
      itemList(title: "Automation runs", emptyTitle: "No automation activity", emptyMessage: "Rules, queues, and runs appear here.", items: automationItems)
    case .missions:
      itemList(title: "Mission activity", emptyTitle: "No mission activity", emptyMessage: "Mission lanes and chats appear here.", items: missionItems)
    case .cto:
      itemList(title: "CTO operations", emptyTitle: "No CTO activity", emptyMessage: "Queues and PR flow appear here.", items: ctoItems)
    }
  }

  private var runContent: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .center, spacing: 10) {
        VStack(alignment: .leading, spacing: 3) {
          Text("Commands")
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)
          Text(runLaneName)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
        }
        Spacer(minLength: 0)
        if activeLanes.count > 1 {
          Menu {
            ForEach(activeLanes) { lane in
              Button(lane.name) {
                selectedRunLaneId = lane.id
                Task { await loadProcessRuntime(for: lane.id) }
              }
            }
          } label: {
            Label("Lane", systemImage: "arrow.triangle.branch")
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textSecondary)
              .padding(.horizontal, 10)
              .padding(.vertical, 7)
              .background(ADEColor.raisedBackground.opacity(0.82), in: Capsule())
              .overlay(Capsule().stroke(ADEColor.glassBorder, lineWidth: 0.6))
          }
          .buttonStyle(.plain)
        }
      }

      if processDefinitions.isEmpty {
        itemListContent(
          emptyTitle: "No commands",
          emptyMessage: runItems.isEmpty ? "Add commands on desktop to run them here." : "Showing run session fallback.",
          items: runItems
        )
      } else {
        ForEach(processDefinitions) { definition in
          runProcessRow(definition)
        }
      }
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
  }

  private func itemList(title: String, emptyTitle: String, emptyMessage: String, items: [ParityDashboardItem]) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(title)
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)

      itemListContent(emptyTitle: emptyTitle, emptyMessage: emptyMessage, items: items)
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
  }

  @ViewBuilder
  private func itemListContent(emptyTitle: String, emptyMessage: String, items: [ParityDashboardItem]) -> some View {
    if items.isEmpty {
      parityStatusCard(title: emptyTitle, message: emptyMessage, symbol: "tray", tint: section.tint)
    } else {
      ForEach(items) { item in
        parityDashboardRow(item)
      }
    }
  }

  private func parityDashboardRow(_ item: ParityDashboardItem) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: item.symbol)
        .font(.system(size: 15, weight: .bold))
        .foregroundStyle(item.tint)
        .frame(width: 32, height: 32)
        .background(item.tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

      VStack(alignment: .leading, spacing: 5) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(item.title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)
          Spacer(minLength: 0)
          Text(item.value)
            .font(.caption.monospacedDigit().weight(.semibold))
            .foregroundStyle(item.tint)
        }
        if !item.subtitle.isEmpty {
          Text(item.subtitle)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
        }
        if !item.detail.isEmpty {
          Text(item.detail)
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(2)
        }
      }
    }
    .padding(12)
    .background(ADEColor.cardBackground.opacity(0.68), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.6)
    )
  }

  private func runProcessRow(_ definition: ProcessDefinition) -> some View {
    let runtimes = processRuntime
      .filter { $0.processId == definition.id && $0.laneId == currentRunLaneId }
      .sorted { ($0.startedAt ?? "") > ($1.startedAt ?? "") }
    let activeRuntime = runtimes.first(where: { isActiveProcessRuntime($0) })
    let latestRuntime = activeRuntime ?? runtimes.first
    let status = latestRuntime?.status ?? "stopped"
    let statusTint = processStatusTint(status)
    let command = definition.command.joined(separator: " ")
    let isBusy = processActionInFlightIds.contains(definition.id)

    return HStack(alignment: .top, spacing: 12) {
      Image(systemName: isActiveProcessRuntime(latestRuntime) ? "play.fill" : "terminal.fill")
        .font(.system(size: 15, weight: .bold))
        .foregroundStyle(statusTint)
        .frame(width: 32, height: 32)
        .background(statusTint.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(definition.name)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          Spacer(minLength: 0)
          Text(status)
            .font(.caption.monospacedDigit().weight(.semibold))
            .foregroundStyle(statusTint)
        }

        Text(command)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)

        HStack(spacing: 8) {
          if let readiness = latestRuntime?.readiness, readiness != "unknown" {
            runInlineChip(readiness, symbol: readiness == "ready" ? "checkmark.seal.fill" : "clock", tint: readiness == "ready" ? ADEColor.success : ADEColor.warning)
          }
          if let ports = latestRuntime?.ports, !ports.isEmpty {
            runInlineChip(ports.map { ":\($0)" }.joined(separator: " "), symbol: "network", tint: ADEColor.info)
          }
          if !definition.groupIds.isEmpty {
            runInlineChip("\(definition.groupIds.count) groups", symbol: "folder", tint: ADEColor.textMuted)
          }
        }

        HStack(spacing: 8) {
          Button {
            Task { await startProcess(definition) }
          } label: {
            Label("Run", systemImage: "play.fill")
              .font(.caption.weight(.bold))
          }
          .buttonStyle(.borderedProminent)
          .buttonBorderShape(.capsule)
          .tint(ADEColor.accentDeep)
          .controlSize(.small)
          .disabled(isBusy || currentRunLaneId == nil)

          if isActiveProcessRuntime(activeRuntime) {
            Button {
              Task { await stopProcess(definition) }
            } label: {
              Label("Stop", systemImage: "stop.fill")
                .font(.caption.weight(.bold))
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .tint(ADEColor.danger)
            .controlSize(.small)
            .disabled(isBusy || currentRunLaneId == nil)
          }

          if isBusy {
            ProgressView()
              .controlSize(.mini)
          }

          Spacer(minLength: 0)
        }
      }
    }
    .padding(12)
    .background(ADEColor.cardBackground.opacity(0.68), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.6)
    )
  }

  private func runInlineChip(_ text: String, symbol: String, tint: Color) -> some View {
    Label(text, systemImage: symbol)
      .font(.caption2.weight(.semibold))
      .foregroundStyle(tint)
      .lineLimit(1)
      .padding(.horizontal, 7)
      .padding(.vertical, 4)
      .background(tint.opacity(0.1), in: Capsule())
  }

  private func parityStatusCard(title: String, message: String, symbol: String, tint: Color) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: symbol)
        .font(.headline)
        .foregroundStyle(tint)
        .frame(width: 32, height: 32)
        .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      VStack(alignment: .leading, spacing: 5) {
        Text(title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(message)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(12)
    .background(ADEColor.cardBackground.opacity(0.68), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.6)
    )
  }

  @MainActor
  private func loadData(force: Bool) async {
    if isLoading && !force { return }
    isLoading = true
    defer { isLoading = false }

    do {
      if force {
        try? await syncService.refreshLaneSnapshots()
        try? await syncService.refreshWorkSessions()
        try? await syncService.refreshPullRequestSnapshots()
      }

      async let sessionsTask = syncService.fetchSessions()
      async let lanesTask = syncService.fetchLanes(includeArchived: true)
      async let snapshotsTask = syncService.fetchLaneListSnapshots(includeArchived: true)
      async let prsTask = syncService.fetchPullRequestListItems()
      async let proposalsTask = syncService.fetchIntegrationProposals()
      async let queuesTask = syncService.fetchQueueStates()

      let loadedSessions = try await sessionsTask
      let loadedLanes = try await lanesTask
      let loadedSnapshots = try await snapshotsTask
      let loadedPrs = try await prsTask
      let loadedProposals = try await proposalsTask
      let loadedQueues = try await queuesTask

      sessions = loadedSessions
      lanes = loadedLanes
      laneSnapshots = loadedSnapshots
      pullRequests = loadedPrs
      integrationProposals = loadedProposals
      queueStates = loadedQueues

      selectedRunLaneId = selectedRunLaneId ?? loadedLanes.first(where: { $0.archivedAt == nil })?.id

      if section == .project, syncService.supportsRemoteAction("processes.listDefinitions") {
        processDefinitions = (try? await syncService.listProcessDefinitions()) ?? []
        if let laneId = selectedRunLaneId {
          await loadProcessRuntime(for: laneId)
        }
      }

      if section == .history {
        recentCommitsByLaneId = await loadRecentCommits(for: Array(loadedLanes.filter { $0.archivedAt == nil }.prefix(5)))
      }
      if section == .automations || section == .missions || section == .cto {
        chatSessions = await loadChatSummaries(for: Array(loadedLanes.filter { $0.archivedAt == nil }.prefix(8)))
      }

      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func loadProcessRuntime(for laneId: String) async {
    guard syncService.supportsRemoteAction("processes.listRuntime") else { return }
    processRuntime = (try? await syncService.listProcessRuntime(laneId: laneId)) ?? []
  }

  private func startProcess(_ definition: ProcessDefinition) async {
    guard let laneId = currentRunLaneId else { return }
    processActionInFlightIds.insert(definition.id)
    defer { processActionInFlightIds.remove(definition.id) }
    do {
      _ = try await syncService.startProcess(laneId: laneId, processId: definition.id)
      await loadProcessRuntime(for: laneId)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func stopProcess(_ definition: ProcessDefinition) async {
    guard let laneId = currentRunLaneId else { return }
    processActionInFlightIds.insert(definition.id)
    defer { processActionInFlightIds.remove(definition.id) }
    do {
      try await syncService.stopProcess(laneId: laneId, processId: definition.id)
      await loadProcessRuntime(for: laneId)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func loadRecentCommits(for lanes: [LaneSummary]) async -> [String: [GitCommitSummary]] {
    var loaded: [String: [GitCommitSummary]] = [:]
    for lane in lanes {
      if let commits = try? await syncService.listRecentCommits(laneId: lane.id) {
        loaded[lane.id] = commits
      }
    }
    return loaded
  }

  private func loadChatSummaries(for lanes: [LaneSummary]) async -> [AgentChatSessionSummary] {
    var loaded: [AgentChatSessionSummary] = []
    for lane in lanes {
      if let summaries = try? await syncService.listChatSessions(laneId: lane.id) {
        loaded.append(contentsOf: summaries)
      }
    }
    return loaded
  }

  private var metrics: [ParityMetric] {
    switch section {
    case .project:
      let runCount = processDefinitions.isEmpty ? runSessions.count : processDefinitions.count
      let active = processDefinitions.isEmpty
        ? runSessions.filter { $0.status == "running" }.count
        : processRuntime.filter(isActiveProcessRuntime).count
      return [
        ParityMetric(label: "Commands", value: "\(runCount)", symbol: "play.circle.fill", tint: section.tint),
        ParityMetric(label: "Active", value: "\(active)", symbol: "bolt.fill", tint: ADEColor.success),
        ParityMetric(label: "Lanes", value: "\(activeLanes.count)", symbol: "square.stack.3d.up", tint: ADEColor.tintLanes),
        ParityMetric(label: "Ports", value: "\(processRuntime.flatMap(\.ports).count)", symbol: "network", tint: ADEColor.info),
      ]
    case .graph:
      let conflicted = laneSnapshots.filter { ($0.conflictStatus?.peerConflictCount ?? 0) > 0 || ($0.conflictStatus?.overlappingFileCount ?? 0) > 0 }.count
      return [
        ParityMetric(label: "Lanes", value: "\(activeLanes.count)", symbol: "point.3.connected.trianglepath.dotted", tint: section.tint),
        ParityMetric(label: "Running", value: "\(laneSnapshots.reduce(0) { $0 + $1.runtime.runningCount })", symbol: "bolt.fill", tint: ADEColor.success),
        ParityMetric(label: "Conflicts", value: "\(conflicted)", symbol: "exclamationmark.triangle.fill", tint: conflicted > 0 ? ADEColor.danger : ADEColor.textMuted),
        ParityMetric(label: "PRs", value: "\(pullRequests.count)", symbol: "arrow.triangle.pull", tint: ADEColor.tintPRs),
      ]
    case .history:
      let commitCount = recentCommitsByLaneId.values.reduce(0) { $0 + $1.count }
      return [
        ParityMetric(label: "Commits", value: "\(commitCount)", symbol: "clock.arrow.circlepath", tint: section.tint),
        ParityMetric(label: "Dirty", value: "\(activeLanes.filter { $0.status.dirty }.count)", symbol: "pencil.and.outline", tint: ADEColor.warning),
        ParityMetric(label: "Ahead", value: "\(activeLanes.reduce(0) { $0 + $1.status.ahead })", symbol: "arrow.up", tint: ADEColor.success),
        ParityMetric(label: "Behind", value: "\(activeLanes.reduce(0) { $0 + $1.status.behind })", symbol: "arrow.down", tint: ADEColor.warning),
      ]
    case .automations:
      return [
        ParityMetric(label: "Queues", value: "\(queueStates.count)", symbol: "list.bullet.rectangle", tint: section.tint),
        ParityMetric(label: "Proposals", value: "\(integrationProposals.count)", symbol: "point.topleft.down.curvedto.point.bottomright.up", tint: ADEColor.tintPRs),
        ParityMetric(label: "Runs", value: "\(automationChats.count)", symbol: "gearshape.2.fill", tint: section.tint),
        ParityMetric(label: "Open PRs", value: "\(pullRequests.filter { $0.state.lowercased() == "open" }.count)", symbol: "arrow.triangle.pull", tint: ADEColor.tintPRs),
      ]
    case .missions:
      return [
        ParityMetric(label: "Mission lanes", value: "\(missionSnapshots.count)", symbol: "arrow.triangle.branch", tint: section.tint),
        ParityMetric(label: "Mission chats", value: "\(missionChats.count)", symbol: "bubble.left.and.text.bubble.right", tint: ADEColor.tintWork),
        ParityMetric(label: "Queues", value: "\(queueStates.count)", symbol: "list.bullet.rectangle", tint: ADEColor.tintAutomations),
        ParityMetric(label: "Active", value: "\(missionSnapshots.filter { $0.runtime.runningCount > 0 }.count)", symbol: "bolt.fill", tint: ADEColor.success),
      ]
    case .cto:
      return [
        ParityMetric(label: "Queues", value: "\(queueStates.count)", symbol: "list.bullet.rectangle", tint: section.tint),
        ParityMetric(label: "PRs", value: "\(pullRequests.count)", symbol: "arrow.triangle.pull", tint: ADEColor.tintPRs),
        ParityMetric(label: "Automation", value: "\(automationChats.count)", symbol: "gearshape.2.fill", tint: ADEColor.tintAutomations),
        ParityMetric(label: "Blocked", value: "\(queueStates.filter { $0.lastError != nil || $0.waitReason != nil }.count)", symbol: "exclamationmark.triangle.fill", tint: ADEColor.warning),
      ]
    }
  }

  private var activeLanes: [LaneSummary] {
    lanes.filter { $0.archivedAt == nil }
  }

  private var currentRunLaneId: String? {
    if let selectedRunLaneId, activeLanes.contains(where: { $0.id == selectedRunLaneId }) {
      return selectedRunLaneId
    }
    return activeLanes.first?.id
  }

  private var runLaneName: String {
    guard let laneId = currentRunLaneId else { return "No lane" }
    return activeLanes.first(where: { $0.id == laneId })?.name ?? "Lane"
  }

  private var runSessions: [TerminalSessionSummary] {
    sessions
      .filter { isRunOwnedSession($0) || (!isChatSession($0) && $0.toolType != "shell") }
      .sorted { workSessionActivityTimestamp(session: $0, summary: nil) > workSessionActivityTimestamp(session: $1, summary: nil) }
  }

  private var chatLikeSessions: [TerminalSessionSummary] {
    sessions.filter(isChatSession)
  }

  private var automationChats: [AgentChatSessionSummary] {
    chatSessions.filter { $0.surface == "automation" || $0.automationId != nil || $0.automationRunId != nil }
  }

  private var missionSnapshots: [LaneListSnapshot] {
    laneSnapshots.filter { snapshot in
      snapshot.stateSnapshot?.missionSummary?.isEmpty == false
      || snapshot.lane.name.localizedCaseInsensitiveContains("mission")
      || snapshot.lane.folder?.localizedCaseInsensitiveContains("mission") == true
    }
  }

  private var missionChats: [AgentChatSessionSummary] {
    chatSessions.filter { chat in
      chat.goal?.localizedCaseInsensitiveContains("mission") == true
      || chat.title?.localizedCaseInsensitiveContains("mission") == true
      || chat.capabilityMode?.localizedCaseInsensitiveContains("mission") == true
    }
  }

  private var runItems: [ParityDashboardItem] {
    runSessions.prefix(12).map { session in
      ParityDashboardItem(
        title: session.title,
        subtitle: "\(session.laneName) · \(session.toolType ?? "session")",
        detail: session.lastOutputPreview ?? session.summary ?? session.resumeCommand ?? "",
        value: session.status,
        symbol: session.status == "running" ? "play.fill" : "checkmark.circle.fill",
        tint: session.status == "running" ? ADEColor.success : ADEColor.textMuted
      )
    }
  }

  private var graphItems: [ParityDashboardItem] {
    let rows = laneSnapshots
      .filter { $0.lane.archivedAt == nil }
      .sorted {
        if $0.runtime.runningCount != $1.runtime.runningCount { return $0.runtime.runningCount > $1.runtime.runningCount }
        return $0.lane.name.localizedCaseInsensitiveCompare($1.lane.name) == .orderedAscending
      }
      .prefix(14)
    return rows.map { snapshot in
      let status = snapshot.lane.status
      let conflictCount = (snapshot.conflictStatus?.overlappingFileCount ?? 0) + (snapshot.conflictStatus?.peerConflictCount ?? 0)
      let tint = conflictCount > 0 ? ADEColor.danger : snapshot.runtime.runningCount > 0 ? ADEColor.success : section.tint
      let detail = [
        status.dirty ? "dirty" : "clean",
        status.ahead > 0 ? "ahead \(status.ahead)" : nil,
        status.behind > 0 ? "behind \(status.behind)" : nil,
        conflictCount > 0 ? "\(conflictCount) conflict signals" : nil,
      ].compactMap { $0 }.joined(separator: " · ")
      return ParityDashboardItem(
        title: snapshot.lane.name,
        subtitle: snapshot.lane.branchRef,
        detail: detail.isEmpty ? "runtime \(snapshot.runtime.bucket)" : detail,
        value: "\(snapshot.runtime.sessionCount)",
        symbol: conflictCount > 0 ? "exclamationmark.triangle.fill" : "circle.hexagongrid.fill",
        tint: tint
      )
    }
  }

  private var historyItems: [ParityDashboardItem] {
    recentCommitsByLaneId
      .flatMap { laneId, commits in
        commits.map { commit in (laneId, commit) }
      }
      .sorted { $0.1.authoredAt > $1.1.authoredAt }
      .prefix(14)
      .map { laneId, commit in
        let laneName = lanes.first(where: { $0.id == laneId })?.name ?? laneId
        return ParityDashboardItem(
          title: commit.subject,
          subtitle: "\(laneName) · \(commit.authorName)",
          detail: commit.shortSha,
          value: relativeTimestamp(commit.authoredAt),
          symbol: commit.pushed ? "checkmark.seal.fill" : "arrow.up.circle",
          tint: commit.pushed ? ADEColor.success : section.tint
        )
      }
  }

  private var automationItems: [ParityDashboardItem] {
    let queueItems = queueStates.prefix(6).map { queue in
      ParityDashboardItem(
        title: queue.groupName ?? queue.queueId,
        subtitle: queue.targetBranch ?? "Queue",
        detail: queue.waitReason ?? queue.lastError ?? "\(queue.entries.count) entries",
        value: queue.state,
        symbol: "list.bullet.rectangle",
        tint: queue.lastError == nil ? section.tint : ADEColor.danger
      )
    }
    let proposalItems = integrationProposals.prefix(6).map { proposal in
      ParityDashboardItem(
        title: proposal.title ?? proposal.proposalId,
        subtitle: proposal.integrationLaneName ?? proposal.baseBranch,
        detail: "\(proposal.steps.count) steps · \(proposal.sourceLaneIds.count) lanes",
        value: proposal.status,
        symbol: "point.topleft.down.curvedto.point.bottomright.up",
        tint: ADEColor.tintPRs
      )
    }
    let chatItems = automationChats.prefix(4).map { chat in
      ParityDashboardItem(
        title: chat.title ?? defaultWorkChatTitle(provider: chat.provider),
        subtitle: chat.provider.capitalized,
        detail: chat.lastOutputPreview ?? chat.summary ?? chat.automationId ?? "",
        value: chat.status,
        symbol: "gearshape.2.fill",
        tint: section.tint
      )
    }
    return Array(queueItems + proposalItems + chatItems)
  }

  private var missionItems: [ParityDashboardItem] {
    let laneItems = missionSnapshots.prefix(8).map { snapshot in
      ParityDashboardItem(
        title: snapshot.lane.name,
        subtitle: snapshot.lane.branchRef,
        detail: missionSummaryLine(snapshot.stateSnapshot?.missionSummary) ?? "runtime \(snapshot.runtime.bucket)",
        value: "\(snapshot.runtime.runningCount) active",
        symbol: "arrow.triangle.branch",
        tint: snapshot.runtime.runningCount > 0 ? ADEColor.success : section.tint
      )
    }
    let chatItems = missionChats.prefix(5).map { chat in
      ParityDashboardItem(
        title: chat.title ?? defaultWorkChatTitle(provider: chat.provider),
        subtitle: chat.provider.capitalized,
        detail: chat.goal ?? chat.summary ?? chat.lastOutputPreview ?? "",
        value: chat.status,
        symbol: "bubble.left.and.text.bubble.right.fill",
        tint: ADEColor.tintWork
      )
    }
    return Array(laneItems + chatItems)
  }

  private var ctoItems: [ParityDashboardItem] {
    let queueItems = queueStates.prefix(6).map { queue in
      ParityDashboardItem(
        title: queue.groupName ?? queue.queueId,
        subtitle: queue.targetBranch ?? "CTO queue",
        detail: queue.waitReason ?? queue.lastError ?? "\(queue.entries.count) entries",
        value: queue.state,
        symbol: "brain.head.profile",
        tint: queue.lastError == nil ? section.tint : ADEColor.danger
      )
    }
    let prItems = pullRequests.prefix(8).map { pr in
      ParityDashboardItem(
        title: "#\(pr.githubPrNumber) \(pr.title)",
        subtitle: pr.laneName ?? pr.headBranch,
        detail: "\(pr.checksStatus) · \(pr.reviewStatus)",
        value: pr.state,
        symbol: "arrow.triangle.pull",
        tint: ADEColor.tintPRs
      )
    }
    return Array(queueItems + prItems)
  }

  private func isActiveProcessRuntime(_ runtime: ProcessRuntime?) -> Bool {
    guard let runtime else { return false }
    return isActiveProcessRuntime(runtime)
  }

  private func isActiveProcessRuntime(_ runtime: ProcessRuntime) -> Bool {
    runtime.status == "starting" || runtime.status == "running" || runtime.status == "degraded"
  }

  private func processStatusTint(_ status: String) -> Color {
    switch status {
    case "starting", "running":
      return ADEColor.success
    case "degraded":
      return ADEColor.warning
    case "crashed":
      return ADEColor.danger
    case "stopping":
      return ADEColor.info
    default:
      return ADEColor.textMuted
    }
  }

  private func missionSummaryLine(_ summary: [String: RemoteJSONValue]?) -> String? {
    guard let summary, !summary.isEmpty else { return nil }
    let preferredKeys = ["status", "phase", "title", "goal", "summary"]
    for key in preferredKeys {
      if let value = summary[key], let text = remoteValueString(value), !text.isEmpty {
        return "\(key): \(text)"
      }
    }
    return "\(summary.count) mission fields"
  }

  private func remoteValueString(_ value: RemoteJSONValue) -> String? {
    switch value {
    case .string(let string):
      return string
    case .number(let number):
      return number.formatted()
    case .bool(let bool):
      return bool ? "true" : "false"
    case .array(let array):
      return "\(array.count) items"
    case .object(let object):
      return "\(object.count) fields"
    case .null:
      return nil
    }
  }
}

private struct ParityMetric: Identifiable {
  let id = UUID()
  var label: String
  var value: String
  var symbol: String
  var tint: Color
}

private struct ParityDashboardItem: Identifiable {
  let id = UUID()
  var title: String
  var subtitle: String
  var detail: String
  var value: String
  var symbol: String
  var tint: Color
}
