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

  private var primaryProject: MobileProjectSummary? {
    syncService.activeProject ?? syncService.projects.first
  }

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
      ZStack(alignment: .top) {
        welcomeBackground
        ScrollView {
          VStack(spacing: 30) {
            welcomeHero
            openProjectButton
            projectSection
          }
          .frame(maxWidth: 520)
          .frame(maxWidth: .infinity)
          .padding(.horizontal, 22)
          .padding(.top, 88)
          .padding(.bottom, 38)
        }
        .scrollIndicators(.hidden)
      }
      .navigationTitle("ADE")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          connectionButton
        }
      }
    }
  }

  private var welcomeBackground: some View {
    ZStack {
      ADEColor.pageBackground
      RadialGradient(
        colors: [
          ADEColor.purpleAccent.opacity(0.28),
          ADEColor.purpleAccent.opacity(0.10),
          Color.clear
        ],
        center: .center,
        startRadius: 20,
        endRadius: 210
      )
      .frame(width: 420, height: 420)
      .offset(y: 66)
      .blur(radius: 6)
    }
    .ignoresSafeArea()
  }

  private var welcomeHero: some View {
    ZStack {
      Text("ADE")
        .font(.system(size: 78, weight: .heavy, design: .rounded))
        .foregroundStyle(ADEColor.purpleAccent.opacity(0.58))
        .offset(x: 9, y: 10)
      Text("ADE")
        .font(.system(size: 78, weight: .heavy, design: .rounded))
        .foregroundStyle(ADEColor.textPrimary)
        .shadow(color: ADEColor.purpleAccent.opacity(0.80), radius: 28, x: 0, y: 0)
        .shadow(color: ADEColor.purpleAccent.opacity(0.55), radius: 2, x: 7, y: 8)
    }
    .frame(height: 142)
    .frame(maxWidth: .infinity)
    .accessibilityLabel("ADE")
  }

  private var openProjectButton: some View {
    Button {
      if let primaryProject {
        syncService.selectProject(primaryProject)
      } else {
        syncService.settingsPresented = true
      }
    } label: {
      Label("OPEN PROJECT", systemImage: "folder")
        .font(.system(.subheadline, design: .rounded).weight(.semibold))
        .foregroundStyle(Color(red: 0.08, green: 0.08, blue: 0.10))
        .frame(width: 220, height: 52)
        .background(Color.white.opacity(0.94), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .stroke(Color.white.opacity(0.10), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.16), radius: 18, x: 0, y: 12)
    }
    .buttonStyle(.plain)
    .accessibilityHint(primaryProject == nil ? "Opens computer connection settings." : "Opens the most recent project.")
  }

  private var connectionButton: some View {
    Button {
      syncService.settingsPresented = true
    } label: {
      ZStack(alignment: .topTrailing) {
        Image(systemName: "desktopcomputer")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(connectionTint)
          .frame(width: 36, height: 36)
          .background(ADEColor.raisedBackground, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .stroke(ADEColor.border, lineWidth: 1)
          )
        Circle()
          .fill(connectionTint)
          .frame(width: 8, height: 8)
          .overlay(
            Circle()
              .stroke(ADEColor.pageBackground, lineWidth: 2)
          )
          .offset(x: 1, y: -1)
      }
      .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
    .accessibilityLabel("Computer connection: \(connectionLabel)")
    .accessibilityHint("Opens computer connection settings.")
  }

  private var projectSection: some View {
    VStack(spacing: 14) {
      Text("RECENT PROJECTS")
        .font(.system(.caption, design: .rounded).weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
        .tracking(0.8)

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
    Button {
      syncService.settingsPresented = true
    } label: {
      HStack(spacing: 12) {
        ProjectHomeIcon(isActive: false)
        VStack(alignment: .leading, spacing: 4) {
          Text("Connect ADE desktop")
            .font(.system(.subheadline, design: .rounded).weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(syncService.hostName ?? "No recent projects yet")
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
        Spacer(minLength: 8)
        Image(systemName: "desktopcomputer")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(ADEColor.textSecondary)
      }
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.cardBackground.opacity(0.62), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .stroke(ADEColor.border.opacity(0.80), lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
  }
}

private struct ProjectHomeIcon: View {
  let isActive: Bool

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 7, style: .continuous)
        .fill(isActive ? ADEColor.accent.opacity(0.16) : ADEColor.recessedBackground)
        .frame(width: 38, height: 38)
      Image(systemName: "folder")
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(isActive ? ADEColor.accent : ADEColor.textSecondary)
    }
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
        ProjectHomeIcon(isActive: isActive)

        VStack(alignment: .leading, spacing: 4) {
          Text(project.displayName)
            .font(.system(.subheadline, design: .rounded).weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)

          if let rootPath = project.rootPath, !rootPath.isEmpty {
            Text(rootPath)
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          }
        }

        Spacer(minLength: 8)

        if isSwitching {
          ProgressView()
            .controlSize(.small)
        } else {
          VStack(alignment: .trailing, spacing: 6) {
            Text("\(project.laneCount) lane\(project.laneCount == 1 ? "" : "s")")
              .font(.system(.caption2, design: .rounded).weight(.semibold))
              .foregroundStyle(ADEColor.accent)
              .padding(.horizontal, 8)
              .padding(.vertical, 4)
              .background(ADEColor.accent.opacity(0.16), in: Capsule())
            if let lastOpened = projectHomeRelativeTimestamp(project.lastOpenedAt) {
              Text(lastOpened)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(ADEColor.textMuted)
            }
          }
        }
      }
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.cardBackground.opacity(0.62), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .stroke(isActive ? ADEColor.accent.opacity(0.55) : ADEColor.border.opacity(0.80), lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
    .disabled(isDisabled)
  }
}

private func projectHomeRelativeTimestamp(_ value: String?) -> String? {
  guard let value, !value.isEmpty else { return nil }
  let fractional = ISO8601DateFormatter()
  fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  let plain = ISO8601DateFormatter()
  guard let date = fractional.date(from: value) ?? plain.date(from: value) else { return nil }
  return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
}
