import SwiftUI
import UIKit

private let adeAccent = ADEColor.accent

private enum RootTab: Hashable {
  case work
  case lanes
  case prs
  case files
  case cto
}

struct ContentView: View {
  @EnvironmentObject private var syncService: SyncService
  @State private var selectedTab: RootTab = .work
  @AppStorage("ade.colorScheme") private var colorSchemeRaw: String = ADEColorSchemeChoice.system.rawValue

  private var colorSchemeChoice: ADEColorSchemeChoice {
    ADEColorSchemeChoice(rawValue: colorSchemeRaw) ?? .system
  }

  var body: some View {
    Group {
      if syncService.shouldShowProjectHome {
        ProjectHomeView()
      } else {
        rootTabs
      }
    }
      .tint(adeAccent)
      .tabBarMinimizeBehavior(.onScrollDown)
      .adeScreenBackground()
      .adeNavigationGlass()
      .preferredColorScheme(colorSchemeChoice.preferredColorScheme)
      .sensoryFeedback(.selection, trigger: selectedTab)
      .environmentObject(syncService.attentionDrawer)
      .sheet(isPresented: $syncService.settingsPresented) {
        ConnectionSettingsView()
          .environmentObject(syncService)
      }
      .sheet(isPresented: $syncService.attentionDrawerPresented) {
        AttentionDrawerSheet()
          .environmentObject(syncService)
          .environmentObject(syncService.attentionDrawer)
      }
      .onChange(of: syncService.requestedFilesNavigation?.id) { _, requestId in
        guard requestId != nil else { return }
        syncService.closeProjectHome()
        if selectedTab != .files {
          selectedTab = .files
        }
      }
      .onChange(of: syncService.requestedLaneNavigation?.id) { _, requestId in
        guard requestId != nil else { return }
        syncService.closeProjectHome()
        if selectedTab != .lanes {
          selectedTab = .lanes
        }
      }
      .onChange(of: syncService.requestedPrNavigation?.id) { _, requestId in
        guard requestId != nil else { return }
        syncService.closeProjectHome()
        if selectedTab != .prs {
          selectedTab = .prs
        }
      }
  }

  private var rootTabs: some View {
    TabView(selection: $selectedTab) {
      workTab
      lanesTab
      prsTab
      filesTab
      ctoTab
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

  private var ctoTab: some View {
    CtoRootScreen(isTabActive: selectedTab == .cto)
      .tag(RootTab.cto)
      .tabItem {
        Label("CTO", systemImage: "brain.head.profile")
      }
  }
}

private struct ProjectHomeView: View {
  @EnvironmentObject private var syncService: SyncService

  private var connectionLabel: String {
    switch syncService.connectionState {
    case .connected: return "Connected"
    case .syncing: return "Syncing"
    case .connecting: return "Connecting"
    case .error: return "Connection error"
    case .disconnected: return "Connect to computer"
    }
  }

  private var connectionTint: Color {
    switch syncService.connectionState {
    case .connected: return ADEColor.success
    case .syncing, .connecting: return ADEColor.warning
    case .error, .disconnected: return ADEColor.danger
    }
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 22) {
          header
          projectSection
        }
        .padding(.horizontal, 20)
        .padding(.top, 18)
        .padding(.bottom, 32)
      }
      .scrollIndicators(.hidden)
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("ADE")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          connectionButton
        }
      }
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .center, spacing: 12) {
        ZStack {
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(ADEColor.raisedBackground)
            .frame(width: 64, height: 48)
            .overlay(
              RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(ADEColor.border, lineWidth: 1)
            )
          Image("BrandMark")
            .resizable()
            .scaledToFit()
            .frame(width: 44, height: 24)
            .accessibilityHidden(true)
        }

        VStack(alignment: .leading, spacing: 3) {
          Text("Projects")
            .font(.system(.largeTitle, design: .rounded).weight(.bold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(syncService.hostName ?? "Choose a desktop project to open on this phone.")
            .font(.callout)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
        }
      }

      if let activeProject = syncService.activeProject {
        Button {
          syncService.selectProject(activeProject)
        } label: {
          Label("Return to \(activeProject.displayName)", systemImage: "arrow.forward.circle.fill")
            .font(.system(.subheadline, design: .rounded).weight(.semibold))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.borderedProminent)
        .tint(ADEColor.accent)
      }
    }
  }

  private var connectionButton: some View {
    Button {
      syncService.settingsPresented = true
    } label: {
      HStack(spacing: 6) {
        Image(systemName: "desktopcomputer")
          .font(.system(size: 13, weight: .semibold))
        Text(connectionLabel)
          .font(.system(.caption, design: .rounded).weight(.semibold))
      }
      .foregroundStyle(connectionTint)
      .padding(.horizontal, 10)
      .padding(.vertical, 7)
      .background(connectionTint.opacity(0.12), in: Capsule())
      .overlay(
        Capsule()
          .stroke(connectionTint.opacity(0.35), lineWidth: 0.5)
      )
    }
    .accessibilityLabel(connectionLabel)
    .accessibilityHint("Opens computer connection settings.")
  }

  private var projectSection: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text("Desktop projects")
          .font(.system(.headline, design: .rounded).weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer()
        Text("\(syncService.projects.count)")
          .font(.system(.caption, design: .monospaced).weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
      }

      if syncService.projects.isEmpty {
        emptyProjects
      } else {
        LazyVStack(spacing: 8) {
          ForEach(syncService.projects) { project in
            ProjectHomeRow(
              project: project,
              isActive: syncService.isActiveProject(project),
              isSwitching: syncService.isSwitchingProject(project),
              isDisabled: syncService.isProjectSwitching
            ) {
              syncService.selectProject(project)
            }
          }
        }
      }
    }
  }

  private var emptyProjects: some View {
    VStack(alignment: .leading, spacing: 12) {
      Image(systemName: "desktopcomputer")
        .font(.system(size: 28, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
      Text("No desktop projects cached yet.")
        .font(.system(.headline, design: .rounded).weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Text("Connect to the ADE desktop app, then projects from that computer will appear here.")
        .font(.callout)
        .foregroundStyle(ADEColor.textSecondary)
      Button {
        syncService.settingsPresented = true
      } label: {
        Label("Connect to computer", systemImage: "desktopcomputer")
          .font(.system(.subheadline, design: .rounded).weight(.semibold))
      }
      .buttonStyle(.borderedProminent)
      .tint(ADEColor.accent)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(18)
    .background(ADEColor.cardBackground, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .stroke(ADEColor.border, lineWidth: 1)
    )
  }
}

private struct ProjectHomeRow: View {
  let project: MobileProjectSummary
  let isActive: Bool
  let isSwitching: Bool
  let isDisabled: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(alignment: .center, spacing: 12) {
        ZStack {
          RoundedRectangle(cornerRadius: 7, style: .continuous)
            .fill(isActive ? ADEColor.accent.opacity(0.16) : ADEColor.recessedBackground)
            .frame(width: 40, height: 40)
          Image(systemName: "folder")
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(isActive ? ADEColor.accent : ADEColor.textSecondary)
        }

        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 6) {
            Text(project.displayName)
              .font(.system(.headline, design: .rounded).weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            if isActive {
              Text("Selected")
                .font(.system(.caption2, design: .rounded).weight(.semibold))
                .foregroundStyle(ADEColor.accent)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(ADEColor.accent.opacity(0.12), in: Capsule())
            }
          }

          if let rootPath = project.rootPath, !rootPath.isEmpty {
            Text(rootPath)
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          }

          HStack(spacing: 8) {
            Label("\(project.laneCount) lane\(project.laneCount == 1 ? "" : "s")", systemImage: "square.stack.3d.up")
            if project.isCached {
              Label(project.isAvailable ? "Cached" : "Unavailable", systemImage: project.isAvailable ? "checkmark.circle" : "exclamationmark.triangle")
            }
          }
          .font(.system(.caption2, design: .rounded).weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        }

        Spacer(minLength: 8)

        if isSwitching {
          ProgressView()
            .controlSize(.small)
        } else {
          Image(systemName: "chevron.right")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.cardBackground, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .stroke(isActive ? ADEColor.accent.opacity(0.55) : ADEColor.border, lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
    .disabled(isDisabled)
  }
}
