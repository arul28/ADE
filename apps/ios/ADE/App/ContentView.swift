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

  private var attachedComputerLabel: String {
    let trimmedHost = syncService.hostName?.trimmingCharacters(in: .whitespacesAndNewlines)
    let host = (trimmedHost?.isEmpty == false) ? trimmedHost! : nil
    switch syncService.connectionState {
    case .connected, .syncing:
      if let host { return "Attached to \(host)" }
      return "Attached to computer"
    case .connecting:
      if let host { return "Connecting to \(host)…" }
      return "Connecting…"
    case .error:
      if let host { return "Cannot reach \(host)" }
      return "Connection error"
    case .disconnected:
      return "No computer attached"
    }
  }

  private var attachedComputerTint: Color {
    switch syncService.connectionState {
    case .connected: return ADEColor.success
    case .syncing, .connecting: return ADEColor.warning
    case .error, .disconnected: return ADEColor.textMuted
    }
  }

  var body: some View {
    NavigationStack {
      ZStack(alignment: .top) {
        welcomeBackground
        ScrollView {
          VStack(spacing: 30) {
            welcomeHero
            attachedComputerBanner
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
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar(.hidden, for: .navigationBar)
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
    Image("BrandMark")
      .resizable()
      .renderingMode(.original)
      .interpolation(.high)
      .aspectRatio(contentMode: .fit)
      .frame(maxWidth: 280)
      .frame(height: 142)
      .frame(maxWidth: .infinity)
      .shadow(color: ADEColor.purpleAccent.opacity(0.45), radius: 24, x: 0, y: 0)
      .accessibilityLabel("ADE")
  }

  private var attachedComputerBanner: some View {
    Button {
      syncService.settingsPresented = true
    } label: {
      HStack(spacing: 10) {
        Circle()
          .fill(attachedComputerTint)
          .frame(width: 8, height: 8)
        Image(systemName: "desktopcomputer")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.textSecondary)
        Text(attachedComputerLabel)
          .font(.system(.footnote, design: .rounded).weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        Image(systemName: "chevron.right")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      .background(ADEColor.cardBackground.opacity(0.62), in: Capsule())
      .overlay(
        Capsule().stroke(ADEColor.border.opacity(0.80), lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
    .accessibilityLabel(attachedComputerLabel)
    .accessibilityHint("Opens computer connection settings.")
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

  private var projectSection: some View {
    VStack(spacing: 14) {
      Text("DESKTOP TABS")
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
        ProjectHomeIcon(iconDataUrl: nil, isActive: false)
        VStack(alignment: .leading, spacing: 4) {
          Text(emptyProjectsTitle)
            .font(.system(.subheadline, design: .rounded).weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(emptyProjectsSubtitle)
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

  private var emptyProjectsTitle: String {
    switch syncService.connectionState {
    case .connected, .syncing: return "No projects on desktop"
    case .connecting: return "Connecting to desktop"
    case .error, .disconnected: return "Connect ADE desktop"
    }
  }

  private var emptyProjectsSubtitle: String {
    switch syncService.connectionState {
    case .connected, .syncing:
      return "Open a project on \(syncService.hostName ?? "your computer")"
    case .connecting, .error, .disconnected:
      return syncService.hostName ?? "Pair a computer to see your tabs"
    }
  }
}

private struct ProjectHomeIcon: View {
  let iconDataUrl: String?
  let isActive: Bool

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 7, style: .continuous)
        .fill(isActive ? ADEColor.accent.opacity(0.16) : ADEColor.recessedBackground)
        .frame(width: 38, height: 38)
      if let image = projectHomeIconImage(from: iconDataUrl) {
        Image(uiImage: image)
          .resizable()
          .interpolation(.high)
          .aspectRatio(contentMode: .fit)
          .frame(width: 24, height: 24)
          .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
      } else {
        Image(systemName: "folder")
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(isActive ? ADEColor.accent : ADEColor.textSecondary)
      }
    }
  }
}

private let projectHomeIconImageCache = NSCache<NSString, UIImage>()

private func projectHomeIconImage(from dataUrl: String?) -> UIImage? {
  guard let dataUrl, !dataUrl.isEmpty else { return nil }
  let cacheKey = dataUrl as NSString
  if let cached = projectHomeIconImageCache.object(forKey: cacheKey) {
    return cached
  }
  guard let commaIndex = dataUrl.firstIndex(of: ",") else { return nil }
  let base64 = String(dataUrl[dataUrl.index(after: commaIndex)...])
  guard let data = Data(base64Encoded: base64),
        let image = UIImage(data: data)
  else { return nil }
  projectHomeIconImageCache.setObject(image, forKey: cacheKey)
  return image
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
        ProjectHomeIcon(iconDataUrl: project.iconDataUrl, isActive: isActive)

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
              Text("Last opened \(lastOpened)")
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
