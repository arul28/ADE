import SwiftUI

// Opening a chat FROM THE HUB. The chat is presented as a full-screen cover over
// the hub so Back returns to the all-projects list (the second entry point —
// inside a project — pushes the same `WorkSessionDestinationView` onto the Work
// tab's stack instead, where Back returns to Work). Before the chat renders we
// activate its project (without leaving the hub) so the transcript can stream.

extension View {
  func hubChatCover(target: Binding<HubChatTarget?>) -> some View {
    modifier(HubChatCoverModifier(target: target))
  }
}

private struct HubChatCoverModifier: ViewModifier {
  @Binding var target: HubChatTarget?
  @EnvironmentObject private var syncService: SyncService
  @EnvironmentObject private var dictationController: DictationController

  func body(content: Content) -> some View {
    content.fullScreenCover(item: $target) { target in
      HubChatCover(target: target, syncService: syncService) { self.target = nil }
        .environmentObject(syncService)
        .environmentObject(dictationController)
    }
  }
}

private struct HubChatCover: View {
  let target: HubChatTarget
  let syncService: SyncService
  let onClose: () -> Void
  @State private var ready = false

  var body: some View {
    NavigationStack {
      Group {
        if ready {
          WorkSessionDestinationView(
            sessionId: target.chat.id,
            initialOpeningPrompt: nil,
            initialSession: nil,
            initialChatSummary: nil,
            initialTranscript: nil,
            transitionNamespace: nil,
            isLive: true,
            navigationChrome: .pushedDetail,
            forceFreshTranscriptOnOpen: true,
            lanes: target.lane.map { [$0.asLaneSummary()] } ?? []
          )
          .id(target.id)
        } else {
          HubChatActivatingView(projectName: target.project.displayName, onClose: onClose)
        }
      }
    }
    .task {
      // Activate the chat's project (keeping the hub) so transcript sync targets
      // the right project, then render the chat. No-op when already active.
      if syncService.isActiveProject(target.project) {
        ready = true
        return
      }
      await syncService.openProjectForHubChat(target.project)
      // Only render the chat once the project switch actually landed; otherwise
      // the cover would open against the wrong active project (failed/offline switch).
      guard syncService.isActiveProject(target.project) else { return }
      ready = true
    }
  }
}

private struct HubChatActivatingView: View {
  let projectName: String
  let onClose: () -> Void

  var body: some View {
    ZStack {
      ADEColor.pageBackground.ignoresSafeArea()
      VStack(spacing: 14) {
        ProgressView().controlSize(.large)
        Text("Opening \(projectName)…")
          .font(.system(.subheadline, design: .rounded).weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
      }
    }
    .safeAreaInset(edge: .top, spacing: 0) {
      HStack {
        Button(action: onClose) {
          HStack(spacing: 4) {
            Image(systemName: "chevron.left").font(.system(size: 15, weight: .semibold))
            Text("Hub")
          }
          .foregroundStyle(ADEColor.accent)
        }
        .buttonStyle(.plain)
        Spacer()
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 10)
    }
  }
}
