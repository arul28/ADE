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

/// Identifies the foreign project a hub chat streams from in cross-project
/// "quick look" mode. Passed to `WorkSessionDestinationView.crossProjectContext`.
struct WorkChatCrossProjectContext: Equatable {
  let projectId: String
  let projectRootPath: String?
  let displayName: String
}

/// How the hub decided to open a chat: still deciding, a lightweight
/// cross-project quick look (no project switch), or after a full activation.
private enum HubChatOpenMode: Equatable {
  case deciding
  case crossProject(WorkChatCrossProjectContext, TerminalSessionSummary)
  case activated(TerminalSessionSummary?)
}

/// Synthesize a `TerminalSessionSummary` from the Hub roster so a destination
/// can render immediately. A foreign session never enters the phone's active
/// project DB; a same-project session may simply be ahead of CRDT replication.
/// In both cases the live stream and eventual row remain authoritative.
func makeRosterSessionStub(chat: RemoteRosterChat, lane: RemoteRosterLane?) -> TerminalSessionSummary? {
  // The roster carries enough metadata to open a chat transcript, but not a
  // terminal: CLI rows omit the PTY id, transcript offsets, and tracked state
  // required by TerminalSessionScreen. Let CLI activation hydrate its real
  // project row instead of manufacturing a terminal that cannot subscribe.
  guard chat.isChatTool else { return nil }
  return chat.asTerminalSessionSummary(laneName: lane?.name ?? chat.laneId)
}

private struct HubChatCover: View {
  let target: HubChatTarget
  let syncService: SyncService
  let onClose: () -> Void
  @State private var mode: HubChatOpenMode = .deciding

  var body: some View {
    NavigationStack {
      Group {
        switch mode {
        case .deciding:
          HubChatActivatingView(projectName: target.project.displayName, onClose: onClose)
        case .crossProject(let context, let sessionStub):
          // Lightweight cross-project quick look: stream the transcript from the
          // foreign project WITHOUT switching the phone's active project. Lane/PR
          // affordances are hidden (showsLaneActions: false) and gated off inside
          // the view; sending / approving still work via scoped commands.
          WorkSessionDestinationView(
            sessionId: target.chat.id,
            initialOpeningPrompt: nil,
            initialSession: sessionStub,
            initialChatSummary: nil,
            initialTranscript: nil,
            transitionNamespace: nil,
            isLive: true,
            navigationChrome: .pushedDetail,
            forceFreshTranscriptOnOpen: true,
            showsLaneActions: false,
            lanes: target.lane.map { [$0.asLaneSummary()] } ?? [],
            crossProjectContext: context
          )
          .id(target.id)
        case .activated(let sessionStub):
          WorkSessionDestinationView(
            sessionId: target.chat.id,
            initialOpeningPrompt: nil,
            // A chat roster row is authoritative enough to render and
            // subscribe before CRR catches up. CLI rows intentionally pass nil
            // here so the destination hydrates their real PTY-backed row.
            initialSession: sessionStub,
            initialChatSummary: nil,
            initialTranscript: nil,
            transitionNamespace: nil,
            isLive: true,
            navigationChrome: .pushedDetail,
            forceFreshTranscriptOnOpen: true,
            lanes: target.lane.map { [$0.asLaneSummary()] } ?? []
          )
          .id(target.id)
        }
      }
    }
    .task { await decideAndOpen() }
  }

  private func decideAndOpen() async {
    let sessionStub = makeRosterSessionStub(chat: target.chat, lane: target.lane)
    // Already the active project → the full-detail path (existing infra).
    if syncService.isActiveProject(target.project) {
      mode = .activated(sessionStub)
      return
    }
    // Cross-project quick look when the host supports it (newer brain): stream
    // the foreign chat in place, no project switch. Chat sessions only — CLI
    // sessions have no chat transcript JSONL to stream, so they take the
    // activation path below and open as a terminal.
    if syncService.supportsCrossProjectChat, let sessionStub {
      mode = .crossProject(
        WorkChatCrossProjectContext(
          projectId: target.project.id,
          projectRootPath: target.project.rootPath,
          displayName: target.project.displayName
        ),
        sessionStub
      )
      return
    }
    // Fallback for hosts without cross-project support (e.g. the currently
    // published brain): activate the project first (keeping the hub), then
    // render the chat once the switch lands. An offline/failed switch leaves
    // the activating spinner so the cover never opens against the wrong project.
    await syncService.openProjectForHubChat(target.project)
    guard syncService.isActiveProject(target.project) else { return }
    mode = .activated(sessionStub)
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
