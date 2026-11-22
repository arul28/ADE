#if DEBUG
import SwiftUI

// Fixture screens for the CTO v2 surfaces (`-adePreviewScreen cto-…`). Each
// holds its own data and starts no live machinery.

@MainActor
enum CtoPreviewData {
  static let name = "Nova"
  static let look = CtoAvatarLook(shape: "pebble", color: "#7c9cff", eyes: "caret", energy: "lively")

  static func iso(minutesFromNow minutes: Double) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date().addingTimeInterval(minutes * 60))
  }

  /// The next weekday at 9:00, local time.
  static func nextWeekdayNine() -> String {
    let calendar = Calendar.current
    var day = calendar.startOfDay(for: Date())
    for _ in 0..<8 {
      day = calendar.date(byAdding: .day, value: 1, to: day) ?? day
      let weekday = calendar.component(.weekday, from: day)
      if weekday != 1 && weekday != 7 { break }
    }
    let nine = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: day) ?? day
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: nine)
  }

  /// The next Friday at 16:00, local time.
  static func nextFridayFour() -> String {
    let calendar = Calendar.current
    var day = calendar.startOfDay(for: Date())
    for _ in 0..<8 {
      day = calendar.date(byAdding: .day, value: 1, to: day) ?? day
      if calendar.component(.weekday, from: day) == 6 { break }
    }
    let four = calendar.date(bySettingHour: 16, minute: 0, second: 0, of: day) ?? day
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: four)
  }

  static var snapshot: CtoSnapshot {
    CtoSnapshot(
      identity: CtoIdentity(
        name: name,
        version: 4,
        persona: nil,
        systemPromptExtension: "Open PRs as drafts.\nAsk before landing anything on main.",
        onboardingState: nil,
        modelPreferences: CtoModelPreferences(provider: "claude", model: "claude-sonnet-5", reasoningEffort: nil, modelId: "anthropic/claude-sonnet-5"),
        fallbackModels: [
          CtoModelPreferences(provider: "codex", model: "gpt-5.5", reasoningEffort: nil, modelId: "openai/gpt-5.5"),
        ],
        avatar: look,
        personality: "friendly",
        updatedAt: nil
      ),
      recentSessions: nil
    )
  }

  static var memory: CtoMemory {
    CtoMemory(
      memory: "- Deploys go through the release lane\n- Tests run with npm run test:unit\n- Arul reviews PRs in the morning\n- The iOS build needs Xcode 26\n- Staging resets every Sunday",
      memoryBytes: 168,
      memoryLimitBytes: 4096,
      userNotes: "- Prefers short answers\n- Likes proof with every PR",
      userNotesBytes: 48,
      userNotesLimitBytes: 2048,
      memoryHash: "a1",
      userNotesHash: "b2",
      openWork: [
        CtoOpenWorkItem(id: "ow-1", text: "Land the login race fix", createdAt: iso(minutesFromNow: -90), doneAt: nil, addedBy: "cto"),
        CtoOpenWorkItem(id: "ow-2", text: "Watch PR #482 checks", createdAt: iso(minutesFromNow: -40), doneAt: nil, addedBy: "cto"),
        CtoOpenWorkItem(id: "ow-3", text: "Ship the avatar on iOS", createdAt: iso(minutesFromNow: -300), doneAt: iso(minutesFromNow: -20), addedBy: "user"),
      ]
    )
  }

  static var routines: [AgentChatScheduledWorkItem] {
    [
      AgentChatScheduledWorkItem(
        id: "r-1", sessionId: "fixture-cto", kind: "cron", status: "scheduled",
        title: "Morning check-in", prompt: "Look over open PRs and failing checks.",
        reason: nil, cron: "0 9 * * 1-5", nextRunAt: nextWeekdayNine(), lastRunAt: iso(minutesFromNow: -60 * 24),
        expiresAt: nil, createdAt: iso(minutesFromNow: -60 * 24 * 7), durable: true, cancellable: true,
        late: nil, outcomeSummary: "2 PRs green, 1 waiting on review"
      ),
      AgentChatScheduledWorkItem(
        id: "r-2", sessionId: "fixture-cto", kind: "wakeup", status: "scheduled",
        title: "Recheck PR #482", prompt: "See if CI passed on #482.",
        reason: nil, cron: nil, nextRunAt: iso(minutesFromNow: 25), lastRunAt: nil,
        expiresAt: nil, createdAt: iso(minutesFromNow: -10), durable: true, cancellable: true,
        late: nil, outcomeSummary: nil
      ),
      AgentChatScheduledWorkItem(
        id: "r-3", sessionId: "fixture-cto", kind: "cron", status: "paused",
        title: "Friday release notes", prompt: "Draft release notes from merged PRs.",
        reason: nil, cron: "0 16 * * 5", nextRunAt: nextFridayFour(), lastRunAt: nil,
        expiresAt: nil, createdAt: iso(minutesFromNow: -60 * 24 * 14), durable: true, cancellable: true,
        late: nil, outcomeSummary: nil, source: nil, paused: true
      ),
    ]
  }

  static var children: [CtoChildRow] {
    [
      CtoChildRow(id: "c-1", laneId: "lane-auth", title: "Fix the login race", laneName: "auth-fix", provider: "codex", status: .working, startedAt: iso(minutesFromNow: -12)),
      CtoChildRow(id: "c-2", laneId: "lane-ios", title: "iOS avatar polish", laneName: "cto-ios", provider: "claude", status: .needsYou, startedAt: iso(minutesFromNow: -30)),
      CtoChildRow(id: "c-3", laneId: "lane-docs", title: "Release notes draft", laneName: "docs", provider: "cursor", status: .idle, startedAt: iso(minutesFromNow: -200)),
    ]
  }

  static var library: [CtoLibraryItem] {
    [
      CtoLibraryItem(id: "pr:1", kind: .prs, title: "Fix the login race", detail: "#482 · auth-fix", at: iso(minutesFromNow: -8), prState: "open", prId: "pr-1", prNumber: 482, laneId: "lane-auth", sessionId: nil),
      CtoLibraryItem(id: "lane:1", kind: .lanes, title: "auth-fix", detail: "2 chats · auth-fix", at: iso(minutesFromNow: -9), prState: nil, prId: nil, prNumber: nil, laneId: "lane-auth", sessionId: "c-1"),
      CtoLibraryItem(id: "pr:2", kind: .prs, title: "CTO avatar on iOS", detail: "#479 · cto-ios", at: iso(minutesFromNow: -180), prState: "merged", prId: "pr-2", prNumber: 479, laneId: "lane-ios", sessionId: nil),
      CtoLibraryItem(id: "lane:2", kind: .lanes, title: "cto-ios", detail: "1 chat · cto-ios", at: iso(minutesFromNow: -190), prState: nil, prId: nil, prNumber: nil, laneId: "lane-ios", sessionId: "c-2"),
      CtoLibraryItem(id: "pr:3", kind: .prs, title: "Release notes for 1.4", detail: "#471 · docs", at: iso(minutesFromNow: -60 * 26), prState: "draft", prId: "pr-3", prNumber: 471, laneId: "lane-docs", sessionId: nil),
    ]
  }

  static func store() -> CtoStore {
    CtoStore(fixtureSnapshot: snapshot, fixtureMemory: memory, routines: routines, children: children, library: library)
  }

  static func live(turnActive: Bool = false, step: String? = nil) -> CtoLiveModel {
    let model = CtoLiveModel()
    model.look = look
    model.name = name
    model.turnActive = turnActive
    model.liveStep = step
    model.runningChildren = 1
    model.sessionId = "fixture-cto"
    if turnActive { model.turnStartedAt = Date().addingTimeInterval(-14) }
    return model
  }

  // MARK: Thread

  private static func envelope(_ sequence: Int, _ event: WorkChatEvent, minutesAgo: Double = 2) -> WorkChatEnvelope {
    WorkChatEnvelope(sessionId: "preview-chat-session", timestamp: iso(minutesFromNow: -minutesAgo), sequence: sequence, event: event)
  }

  static var transcript: [WorkChatEnvelope] {
    [
      envelope(1, .userMessage(text: "Morning. Where are we on the login flake?", attachments: nil, turnId: "t1", steerId: nil, deliveryState: "delivered", processed: true), minutesAgo: 30),
      envelope(2, .toolCall(tool: "mcp__ade__getPullRequestStatus", argsText: #"{"prNumber":482}"#, itemId: "tc-1", parentItemId: nil, turnId: "t1"), minutesAgo: 29.8),
      envelope(3, .toolResult(tool: "mcp__ade__getPullRequestStatus", resultText: #"{"state":"open"}"#, itemId: "tc-1", parentItemId: nil, turnId: "t1", status: .completed, sources: nil, sourceRefsOmittedForMobile: nil), minutesAgo: 29.7),
      envelope(4, .assistantText(text: "Good news: the flake was a race between the token refresh and the first request. The fix is on **auth-fix** as PR #482; checks are running.", turnId: "t1", itemId: "m-1"), minutesAgo: 29.5),
      envelope(5, .toolCall(tool: "mcp__ade__remember", argsText: #"{"note":"Login flake = token refresh race; fixed in #482"}"#, itemId: "tc-2", parentItemId: nil, turnId: "t1"), minutesAgo: 29.4),
      envelope(6, .toolResult(tool: "mcp__ade__remember", resultText: #"{"success":true}"#, itemId: "tc-2", parentItemId: nil, turnId: "t1", status: .completed, sources: nil, sourceRefsOmittedForMobile: nil), minutesAgo: 29.4),
      envelope(7, .toolCall(tool: "mcp__ade__trackWork", argsText: #"{"text":"Land the login race fix"}"#, itemId: "tc-3", parentItemId: nil, turnId: "t1"), minutesAgo: 29.3),
      envelope(8, .toolResult(tool: "mcp__ade__trackWork", resultText: #"{"success":true}"#, itemId: "tc-3", parentItemId: nil, turnId: "t1", status: .completed, sources: nil, sourceRefsOmittedForMobile: nil), minutesAgo: 29.3),
      envelope(9, .toolCall(tool: "mcp__ade__scheduleWork", argsText: #"{"reason":"Recheck PR #482","delaySeconds":1500}"#, itemId: "tc-4", parentItemId: nil, turnId: "t1"), minutesAgo: 29.2),
      envelope(10, .toolResult(tool: "mcp__ade__scheduleWork", resultText: #"{"success":true,"item":{"title":"Recheck PR #482"}}"#, itemId: "tc-4", parentItemId: nil, turnId: "t1", status: .completed, sources: nil, sourceRefsOmittedForMobile: nil), minutesAgo: 29.2),
      envelope(11, .done(status: "completed", summary: "", usage: WorkUsageSummary(turnCount: 1, inputTokens: 18_420, outputTokens: 1_120, cacheReadTokens: 9_200, cacheCreationTokens: 0, costUsd: 0.04), turnId: "t1", model: "claude-sonnet-5", modelId: "anthropic/claude-sonnet-5"), minutesAgo: 29),
      envelope(12, .systemNotice(kind: AgentChatNoticeKind.ctoContextRefreshed.rawValue, message: "Fresh context — notes, open work, the story so far and the newest messages carried over.", detail: nil, turnId: nil, steerId: nil), minutesAgo: 10),
      envelope(13, .userMessage(text: "Land it once checks pass, then start on the release notes.", attachments: nil, turnId: "t2", steerId: nil, deliveryState: "delivered", processed: true), minutesAgo: 1),
      envelope(14, .toolCall(tool: "mcp__ade__listPullRequests", argsText: "{}", itemId: "tc-5", parentItemId: nil, turnId: "t2"), minutesAgo: 0.9),
      envelope(15, .toolResult(tool: "mcp__ade__listPullRequests", resultText: "{}", itemId: "tc-5", parentItemId: nil, turnId: "t2", status: .completed, sources: nil, sourceRefsOmittedForMobile: nil), minutesAgo: 0.85),
      envelope(16, .userMessage(text: "Is staging green too?", attachments: nil, turnId: "t2", steerId: "steer-1", deliveryState: "delivered", processed: true), minutesAgo: 0.6),
      envelope(17, .assistantText(text: "Yes, staging passed at 9:12. Checking #482 now.", turnId: "t2", itemId: "m-2"), minutesAgo: 0.5),
      envelope(18, .toolCall(tool: "mcp__ade__getPullRequestStatus", argsText: #"{"prNumber":482}"#, itemId: "tc-6", parentItemId: nil, turnId: "t2"), minutesAgo: 0.3),
    ]
  }
}

/// Hosts one CTO fixture screen.
struct CtoPreviewHost: View {
  let screen: ADEPreviewScreen

  @StateObject private var store = CtoPreviewData.store()
  @StateObject private var live = CtoPreviewData.live()
  @StateObject private var workingLive = CtoPreviewData.live(turnActive: true, step: "Checking PR #482")

  var body: some View {
    switch screen {
    case .ctoAvatar:
      CtoAvatarFixtureScreen()
    case .ctoWelcome:
      CtoWelcomeFixture()
    case .ctoThread:
      CtoThreadFixture(live: workingLive, store: store)
    case .ctoProfile:
      CtoThreadFixture(live: workingLive, store: store, presentsProfile: .activity)
    case .ctoProfileLibrary:
      CtoThreadFixture(live: workingLive, store: store, presentsProfile: .library)
    case .ctoSettingsLook:
      CtoSettingsScreen(store: store, live: live, initialRoute: .look)
    case .ctoSettingsBrain:
      CtoSettingsScreen(store: store, live: live, initialRoute: .brain)
    case .ctoSettingsMemory:
      CtoSettingsScreen(store: store, live: live, initialRoute: .memory)
    case .ctoOffline:
      NavigationStack {
        CtoStateCard(
          look: CtoPreviewData.look,
          name: CtoPreviewData.name,
          state: .asleep,
          line: "windows is offline",
          message: "Pick another home to keep going; its notes and recent chat come along.",
          actionTitle: "Reconnect",
          action: {},
          secondaryActionTitle: "Pick another home",
          secondaryAction: {}
        )
        .background(ADEColor.pageBackground.ignoresSafeArea())
      }
    default:
      EmptyView()
    }
  }
}

/// Every state animating, then every body in a few colours and every face.
private struct CtoAvatarFixtureScreen: View {
  private let colours = ["#7c9cff", "#3ecf9c", "#ff9150", "#f28ac9", "#556079"]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        Text("States")
          .font(.subheadline.weight(.semibold))
          .padding(.top, 8)
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 84), spacing: 8)], spacing: 14) {
          ForEach(CtoAvatarState.allCases) { state in
            VStack(spacing: 4) {
              CtoAvatarView(look: CtoPreviewData.look, state: state, size: 76, motion: .live, label: state.label, blips: false)
                .modifier(CtoFixtureLoop(state: state))
              Text(state.label).font(.caption).foregroundStyle(ADEColor.textSecondary)
            }
          }
        }
        .padding(.top, 10)

        Text("Shapes")
          .font(.subheadline.weight(.semibold))
          .padding(.top, 24)
        VStack(spacing: 10) {
          ForEach(CtoAvatarShape.allCases) { shape in
            HStack(spacing: 0) {
              Text(shape.label)
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
                .frame(width: 52, alignment: .leading)
              ForEach(colours, id: \.self) { hex in
                CtoAvatarView(
                  look: CtoAvatarLook(shape: shape.rawValue, color: hex, eyes: "caret", energy: "lively"),
                  state: .idle, size: 52, motion: .still
                )
                .frame(maxWidth: .infinity)
              }
            }
          }
        }
        .padding(.top, 10)

        Text("Eyes")
          .font(.subheadline.weight(.semibold))
          .padding(.top, 24)
        HStack {
          ForEach(CtoAvatarEyes.allCases) { eyes in
            VStack(spacing: 4) {
              CtoAvatarView(look: CtoAvatarLook(shape: "bean", color: "#f4bf4f", eyes: eyes.rawValue, energy: "lively"), state: .idle, size: 64, motion: .live)
              Text(eyes.label).font(.caption).foregroundStyle(ADEColor.textSecondary)
            }
            .frame(maxWidth: .infinity)
          }
        }
        .padding(.top, 10)
        Color.clear.frame(height: 40)
      }
      .padding(.horizontal, 20)
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
  }
}

/// Replays the one-shot states (happy, error) every few seconds.
private struct CtoFixtureLoop: ViewModifier {
  let state: CtoAvatarState
  @State private var token = 0

  func body(content: Content) -> some View {
    if state == .happy || state == .error {
      content
        .id(token)
        .task {
          while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 2_200_000_000)
            token += 1
          }
        }
    } else {
      content
    }
  }
}

/// The welcome: tap the button to watch it wake.
private struct CtoWelcomeFixture: View {
  @State private var waking = false

  var body: some View {
    NavigationStack {
      CtoWelcomeView(look: CtoPreviewData.look, name: CtoPreviewData.name, waking: waking, onPick: {
        waking = true
        Task {
          try? await Task.sleep(nanoseconds: 2_400_000_000)
          waking = false
        }
      })
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationBarTitleDisplayMode(.inline)
    }
    .tint(CtoPreviewData.look.accent)
  }
}

/// The real chat view over a CTO transcript (a live turn, chips, a fresh
/// context line, a steered question and its quick reply) under the header pill.
private struct CtoThreadFixture: View {
  @ObservedObject var live: CtoLiveModel
  @ObservedObject var store: CtoStore
  var presentsProfile: CtoProfileTab? = nil

  @State private var profile: CtoProfileTab? = nil
  @State private var detent: PresentationDetent = .large

  var body: some View {
    NavigationStack {
      workPreviewChatSessionView(transcript: CtoPreviewData.transcript, isStreaming: true, ctoLive: live)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            // The phone's real header: back to the Hub, then the CTO's pill.
            HStack(spacing: 0) {
              DuoHubBackInCapsule()
              CtoHeaderPillLabel(model: live)
            }
            .fixedSize()
            .glassEffect(.regular, in: Capsule())
          }
          .sharedBackgroundVisibility(.hidden)
          ToolbarItem(placement: .topBarTrailing) {
            Button {} label: { Label("Settings", systemImage: "gearshape") }
          }
        }
    }
    .tint(live.look.ctoAccent)
    .onAppear {
      live.onOpenProfile = { profile = .activity }
      if let presentsProfile { profile = presentsProfile }
    }
    .sheet(item: $profile) { tab in
      CtoProfileSheet(live: live, store: store, initialTab: tab)
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        .presentationBackground(ADEColor.pageBackground)
    }
  }
}

extension CtoProfileTab: Identifiable {
  var id: String { rawValue }
}
#endif
