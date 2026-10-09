import SwiftUI

func workComposerHasDraftableContent(text: String, attachments: [WorkChatInputAttachment]) -> Bool {
  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    || !workChatInputReadyAttachments(attachments).isEmpty
}

/// The ⋯ item doubles as "save" and "open the list": with content it saves,
/// without content it opens. The title says which one this tap will do.
func workComposerOverflowDraftTitle(hasContent: Bool) -> String {
  hasContent ? "Save draft" : "View drafts"
}

func workDraftEntryLabel(_ entry: DraftEntry) -> String {
  let normalized = entry.text.trimmingCharacters(in: .whitespacesAndNewlines)
    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
  if !normalized.isEmpty { return normalized }
  let count = entry.resolvedAttachmentCount
  if count == 1 { return "1 draft image" }
  if count > 1 { return "\(count) draft images" }
  return "Empty draft"
}

/// The machine-local clock time a scheduled row will fire, in the phone's own
/// time zone. Nil for a plain draft or a row with no parseable fire time.
func workDraftFireTimeLabel(_ entry: DraftEntry) -> String? {
  guard let date = entry.scheduledDate else { return nil }
  return workDraftFireClockFormatter.string(from: date)
}

/// The one line a blocked or missed row carries under its snippet: the reason
/// the machine could not deliver it, for the Needs-you bucket.
func workDraftNeedsYouReason(_ entry: DraftEntry) -> String {
  let stored = entry.lastError?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  if !stored.isEmpty { return stored }
  return entry.resolvedStatus == .missed
    ? "Its send time passed before this machine could deliver it."
    : "This send needs you before it can go out."
}

private let workDraftFireClockFormatter: DateFormatter = {
  let formatter = DateFormatter()
  formatter.dateFormat = "h:mm a"
  formatter.amSymbol = "AM"
  formatter.pmSymbol = "PM"
  return formatter
}()

/// Whether a composer's access mode will let a scheduled send run without the
/// user present. Surfaced as a warning badge, never as a block: the send is the
/// user's choice, but they should see it before arming it.
func workDraftPermissionIsElevated(provider: String, runtimeMode: String) -> Bool {
  runtimeMode.lowercased() == "full-auto"
    || workCliPermissionMode(provider: provider, runtimeMode: runtimeMode) == "bypassPermissions"
}

struct WorkDraftScope: Equatable {
  var chatSessionId: String? = nil
  var projectId: String? = nil
  var projectRootPath: String? = nil
}

/// The one flat list, filtered three ways. Counts come from the same entries so
/// the tabs can never disagree with the rows under them.
enum WorkDraftFilter: String, CaseIterable, Identifiable {
  case all
  case scheduled
  case needsYou

  var id: String { rawValue }

  var title: String {
    switch self {
    case .all: return "All"
    case .scheduled: return "Scheduled"
    case .needsYou: return "Needs you"
    }
  }

  func includes(_ entry: DraftEntry) -> Bool {
    switch self {
    case .all: return true
    case .scheduled: return entry.isScheduled
    case .needsYou: return entry.needsYou
    }
  }
}

struct WorkComposerOverflowButton: View {
  @EnvironmentObject private var syncService: SyncService
  @StateObject private var drafts = WorkDraftController()
  @State private var schedulePresented = false
  @Binding var presentedPicker: WorkComposerPicker?
  @Binding var draft: String
  @Binding var attachments: [WorkChatInputAttachment]
  let canCompose: Bool
  /// Whether files may be staged. Nil means "same as `canCompose`", which is
  /// what every composer without a pending-input gate wants. The chat composer
  /// passes it explicitly: a blocking question locks TEXT, not FILES.
  var canAttach: Bool? = nil
  /// Plain-language note shown over the attach rows. The chat composer sets it
  /// while a question is open, because "the paperclip still works" is only half
  /// the answer — the user also needs to know where the file ends up.
  var attachHint: String? = nil
  let attachmentsAvailable: Bool
  let onDictate: () -> Void
  /// Hosts an older brain omits `chat.listDrafts`: the drafts surface hides
  /// outright rather than going limited, matching every other optional action.
  let draftsAvailable: Bool
  /// `chat.createDraft` is the arming half of the same surface. An older brain
  /// that lacks it keeps the drafts list but not "Schedule send…".
  let scheduleAvailable: Bool
  let scope: WorkDraftScope
  let provider: String?
  let modelId: String?
  /// The composer's access mode, shown in the schedule summary so the user sees
  /// an elevated mode before they arm a send that runs without them.
  var runtimeMode: String = ""
  /// Rows placed above the attach/dictate/draft items. The chat composer's
  /// folded state puts its model, access, send-mode and stop-mode controls
  /// here, since the row that normally shows them is hidden.
  var extraMenuContent: AnyView? = nil

  private var hasContent: Bool {
    workComposerHasDraftableContent(text: draft, attachments: attachments)
  }

  /// Resolved from the connected host's advertised actions plus the chat's own
  /// scope, so the two file routes are gated here rather than at upload time.
  private var fileAttachmentAvailability: WorkChatFileAttachmentAvailability {
    workChatFileAttachmentAvailability(
      hostSupportsChunkedUpload: syncService.supportsViewerRemoteAction(
        workChatFileAttachmentHostAction
      ),
      isPersonalChat: scope.chatSessionId.map {
        syncService.isPersonalChatScope(sessionId: $0)
      } ?? false
    )
  }

  var body: some View {
    WorkChatComposerOverflowMenu(
      presentedPicker: $presentedPicker,
      canCompose: canCompose,
      canAttach: canAttach ?? canCompose,
      attachHint: attachHint,
      attachmentsAvailable: attachmentsAvailable,
      fileAttachmentAvailability: fileAttachmentAvailability,
      attachmentCount: attachments.count,
      dictationAvailable: SpeechDictationService.isAvailable,
      onDictate: onDictate,
      draftsAvailable: draftsAvailable,
      scheduleAvailable: scheduleAvailable,
      hasComposerContent: hasContent,
      draftBusy: drafts.busy,
      draftCount: drafts.entries.count,
      extraMenuContent: extraMenuContent,
      onDraftOrView: {
        Task {
          await drafts.handleMenuAction(
            syncService: syncService,
            text: draft,
            attachments: attachments,
            scope: scope,
            provider: provider,
            modelId: modelId,
            onDraftChange: { draft = $0 },
            onAttachmentsChange: { attachments = $0 }
          )
        }
      },
      onScheduleSend: { schedulePresented = true }
    )
    .sheet(isPresented: $drafts.listPresented) {
      WorkDraftListSheet(
        controller: drafts,
        syncService: syncService,
        currentText: draft,
        currentAttachments: attachments,
        scope: scope,
        onDraftChange: { draft = $0 },
        onAttachmentsChange: { attachments = $0 }
      )
    }
    .sheet(isPresented: $schedulePresented) {
      WorkDraftScheduleSheet(
        scope: scope,
        text: draft,
        attachments: attachments,
        provider: provider,
        modelId: modelId,
        runtimeMode: runtimeMode,
        onScheduled: { created in
          drafts.didSchedule(created)
          draft = ""
          attachments = []
        }
      )
    }
    .task(id: scope) {
      guard draftsAvailable else { return }
      await drafts.refresh(syncService: syncService, scope: scope)
    }
  }
}

struct WorkChatComposerOverflowMenu: View {
  @Binding var presentedPicker: WorkComposerPicker?
  let canCompose: Bool
  /// Gates the three attach rows on their own. Defaults to `canCompose`; the
  /// chat composer separates them so a pending question cannot take the
  /// paperclip away. See `WorkComposerInputGate`.
  var canAttach: Bool? = nil
  /// See `WorkComposerOverflowButton.attachHint`.
  var attachHint: String? = nil
  let attachmentsAvailable: Bool
  var fileAttachmentAvailability: WorkChatFileAttachmentAvailability = .available
  let attachmentCount: Int
  let dictationAvailable: Bool
  let onDictate: () -> Void
  let draftsAvailable: Bool
  let scheduleAvailable: Bool
  let hasComposerContent: Bool
  let draftBusy: Bool
  let draftCount: Int
  var extraMenuContent: AnyView? = nil
  let onDraftOrView: () -> Void
  let onScheduleSend: () -> Void

  private var attachDisabled: Bool {
    !(canAttach ?? canCompose)
      || !attachmentsAvailable
      || attachmentCount >= workChatInputAttachmentLimit
  }

  var body: some View {
    Menu {
      if let extraMenuContent {
        extraMenuContent
      }

      Section {
        Button {
          presentedPicker = .photos
        } label: {
          Label("Attach image", systemImage: "photo")
        }
        .disabled(attachDisabled)
      } header: {
        if let attachHint {
          Text(attachHint)
        }
      }

      // Hidden outright on an images-only chat; present but disabled under a
      // plain-language header when the computer is simply out of date, so the
      // user learns the fix instead of watching a picked file fail to send.
      if fileAttachmentAvailability != .imagesOnly {
        Section {
          Button {
            presentedPicker = .videos
          } label: {
            Label("Attach video…", systemImage: "film")
          }
          .disabled(attachDisabled || !fileAttachmentAvailability.isAvailable)

          Button {
            presentedPicker = .files
          } label: {
            Label("Attach file…", systemImage: "doc")
          }
          .disabled(attachDisabled || !fileAttachmentAvailability.isAvailable)
        } header: {
          if let hint = fileAttachmentAvailability.menuHint {
            Text(hint)
          }
        }
      }

      if dictationAvailable {
        Button(action: onDictate) {
          Label("Dictate voice", systemImage: "mic.fill")
        }
        .disabled(!canCompose)
      }

      if draftsAvailable {
        Divider()
        Button(action: onDraftOrView) {
          Label(
            workComposerOverflowDraftTitle(hasContent: hasComposerContent),
            systemImage: hasComposerContent ? "bookmark" : "bookmark.fill"
          )
        }
        .disabled(draftBusy)

        // Directly beneath Drafts, so arming a send reads as the same idea as
        // saving one. Disabled without content: there is nothing to schedule.
        if scheduleAvailable {
          Button(action: onScheduleSend) {
            Label("Schedule send…", systemImage: "clock.badge")
          }
          .disabled(draftBusy || !hasComposerContent)
        }
      }
    } label: {
      Image(systemName: "ellipsis")
        .font(.system(size: 14, weight: .bold))
        .foregroundStyle(ADEColor.textPrimary)
        .frame(width: 28, height: 28)
        .background(ADEColor.surfaceBackground.opacity(0.38), in: Circle())
        .overlay(Circle().stroke(ADEColor.border.opacity(0.28), lineWidth: 0.6))
        .frame(width: 44, height: 44)
        .contentShape(Circle())
        .overlay(alignment: .topTrailing) {
          if draftCount > 0 {
            Text("\(min(draftCount, 99))")
              .font(.system(size: 8, weight: .bold, design: .rounded))
              .foregroundStyle(ADEColor.textPrimary)
              .padding(.horizontal, 3)
              .padding(.vertical, 1)
              .background(ADEColor.surfaceBackground, in: Capsule())
              .overlay(Capsule().stroke(ADEColor.border.opacity(0.35), lineWidth: 0.5))
              .offset(x: 2, y: 2)
          }
        }
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Composer actions")
    .accessibilityIdentifier("Work.Chat.Composer.OverflowMenu")
  }
}

@MainActor
final class WorkDraftController: ObservableObject {
  @Published var entries: [DraftEntry] = []
  @Published var busy = false
  @Published var errorMessage: String?
  @Published var listPresented = false
  private var refreshToken = UUID()

  func refresh(syncService: SyncService, scope: WorkDraftScope) async {
    let token = UUID()
    refreshToken = token
    guard syncService.canInvokeRemoteAction("chat.listDrafts") else {
      guard refreshToken == token else { return }
      entries = []
      return
    }
    do {
      let fetched = try await listEntries(syncService: syncService, scope: scope)
      guard refreshToken == token else { return }
      entries = fetched
    } catch {
      guard refreshToken == token else { return }
      errorMessage = error.localizedDescription
    }
  }

  func handleMenuAction(
    syncService: SyncService,
    text: String,
    attachments: [WorkChatInputAttachment],
    scope: WorkDraftScope,
    provider: String?,
    modelId: String?,
    onDraftChange: (String) -> Void,
    onAttachmentsChange: ([WorkChatInputAttachment]) -> Void
  ) async {
    if workComposerHasDraftableContent(text: text, attachments: attachments) {
      await save(
        syncService: syncService,
        text: text,
        attachments: attachments,
        scope: scope,
        provider: provider,
        modelId: modelId,
        onDraftChange: onDraftChange,
        onAttachmentsChange: onAttachmentsChange
      )
    } else {
      await refresh(syncService: syncService, scope: scope)
      listPresented = true
    }
  }

  func save(
    syncService: SyncService,
    text: String,
    attachments: [WorkChatInputAttachment],
    scope: WorkDraftScope,
    provider: String?,
    modelId: String?,
    onDraftChange: (String) -> Void,
    onAttachmentsChange: ([WorkChatInputAttachment]) -> Void
  ) async {
    guard !busy else { return }
    refreshToken = UUID()
    if workChatInputHasLoadingAttachments(attachments) {
      errorMessage = "Wait for images to finish loading before saving a draft."
      listPresented = true
      return
    }
    let ready = workChatInputReadyAttachments(attachments)
    guard workComposerHasDraftableContent(text: text, attachments: attachments) else { return }
    busy = true
    errorMessage = nil
    defer { busy = false }
    do {
      let refs = try await workChatSaveInputAttachments(
        ready,
        syncService: syncService,
        chatSessionId: scope.chatSessionId,
        targetProjectId: scope.projectId,
        targetProjectRootPath: scope.projectRootPath
      )
      let created = try await createEntry(
        syncService: syncService,
        scope: scope,
        text: text,
        attachments: refs,
        provider: provider,
        modelId: modelId
      )
      if !refs.isEmpty {
        let confirmed = created.resolvedAttachments
        let allConfirmed = refs.allSatisfy { stored in
          confirmed.contains { $0.path == stored.path && $0.type == stored.type }
        }
        if !allConfirmed {
          _ = try? await deleteEntry(created.id, syncService: syncService, scope: scope)
          throw NSError(
            domain: "ADE",
            code: 27,
            userInfo: [NSLocalizedDescriptionKey: "The connected ADE runtime could not preserve the attached images. They are still in your composer."]
          )
        }
      }
      entries = [created] + entries.filter { $0.id != created.id }
      onDraftChange("")
      onAttachmentsChange([])
    } catch {
      errorMessage = error.localizedDescription
      listPresented = true
    }
  }

  /// A scheduled send was just armed from the composer: show it at the top of
  /// the list without a round trip.
  func didSchedule(_ entry: DraftEntry) {
    entries = [entry] + entries.filter { $0.id != entry.id }
  }

  /// Fill a composer from a draft. The claim *is* the delete: only the caller
  /// that wins it may fill a composer, so two machines can never hold the same
  /// text. A nil claim means another machine took it first.
  func claim(
    entry: DraftEntry,
    syncService: SyncService,
    currentText: String,
    currentAttachments: [WorkChatInputAttachment],
    scope: WorkDraftScope,
    onDraftChange: (String) -> Void,
    onAttachmentsChange: ([WorkChatInputAttachment]) -> Void
  ) async {
    guard !busy else { return }
    refreshToken = UUID()
    if workComposerHasDraftableContent(text: currentText, attachments: currentAttachments) {
      listPresented = false
      return
    }
    if entry.isScheduled {
      errorMessage = "This is a scheduled send. Cancel its schedule before editing it here."
      return
    }
    if entry.imagesUnavailable {
      errorMessage = "These images live on the machine where this draft was saved. Connect to that machine to use it."
      return
    }
    busy = true
    errorMessage = nil
    defer { busy = false }
    do {
      guard let claimed = try await claimEntry(entry.id, syncService: syncService, scope: scope) else {
        // Another machine claimed it in the same moment. The row is gone
        // everywhere; say so and leave the composer as it was.
        entries.removeAll { $0.id == entry.id }
        errorMessage = "This draft was taken on another machine."
        return
      }
      let restored = try await workChatInputAttachments(
        from: claimed.resolvedAttachments,
        syncService: syncService,
        chatSessionId: scope.chatSessionId,
        projectId: scope.projectId,
        projectRootPath: scope.projectRootPath
      )
      guard restored.count == claimed.resolvedAttachments.count else {
        throw NSError(
          domain: "ADE",
          code: 28,
          userInfo: [NSLocalizedDescriptionKey: "Could not restore every draft image. The draft is still available on the machine that made it."]
        )
      }
      onDraftChange(claimed.text)
      onAttachmentsChange(restored)
      entries.removeAll { $0.id == claimed.id }
      listPresented = false
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func remove(
    entry: DraftEntry,
    syncService: SyncService,
    scope: WorkDraftScope
  ) async {
    guard !busy else { return }
    refreshToken = UUID()
    busy = true
    defer { busy = false }
    do {
      _ = try await deleteEntry(entry.id, syncService: syncService, scope: scope)
      entries.removeAll { $0.id == entry.id }
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  /// Unarm a scheduled row, returning it to a plain draft in place.
  func unschedule(
    entry: DraftEntry,
    syncService: SyncService,
    scope: WorkDraftScope
  ) async {
    guard !busy else { return }
    refreshToken = UUID()
    busy = true
    defer { busy = false }
    do {
      if let updated = try await updateEntry(entry.id, unschedule: true, syncService: syncService, scope: scope) {
        replace(updated)
      } else {
        entries.removeAll { $0.id == entry.id }
        errorMessage = "This draft was taken on another machine."
      }
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  /// Resend a blocked or missed send by re-arming it moments from now. It rides
  /// the same scheduler as a fresh schedule, so the machine that owns the target
  /// chat delivers it exactly as it would any other scheduled send.
  func resend(
    entry: DraftEntry,
    syncService: SyncService,
    scope: WorkDraftScope
  ) async {
    guard !busy else { return }
    refreshToken = UUID()
    busy = true
    defer { busy = false }
    // The desktop refuses a fire time that is not in the future; a few seconds
    // out is as close to "now" as the contract allows.
    let fireAt = ISO8601DateFormatter().string(from: Date().addingTimeInterval(5))
    let schedule = DraftScheduleInput(
      scheduledAt: fireAt,
      targetKind: entry.targetKind ?? (entry.targetSessionId != nil ? .existing : .new),
      targetSessionId: entry.targetSessionId,
      targetLaneId: entry.targetLaneId,
      targetMachineKey: entry.targetMachineKey,
      deliveryPolicy: entry.deliveryPolicy ?? .wait,
      graceSeconds: entry.graceSeconds,
      provider: entry.provider,
      modelId: entry.modelId,
      permissionMode: entry.permissionMode,
      thinking: entry.thinking
    )
    do {
      if let updated = try await updateEntry(entry.id, schedule: schedule, syncService: syncService, scope: scope) {
        replace(updated)
      } else {
        entries.removeAll { $0.id == entry.id }
        errorMessage = "This draft was taken on another machine."
      }
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func replace(_ entry: DraftEntry) {
    if let index = entries.firstIndex(where: { $0.id == entry.id }) {
      entries[index] = entry
    } else {
      entries = [entry] + entries
    }
  }

  private func listEntries(
    syncService: SyncService,
    scope: WorkDraftScope
  ) async throws -> [DraftEntry] {
    if let chatSessionId = scope.chatSessionId, !chatSessionId.isEmpty {
      return try await syncService.listDraftsForChat(sessionId: chatSessionId)
    }
    return try await syncService.listDrafts(
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.projectRootPath
    )
  }

  private func createEntry(
    syncService: SyncService,
    scope: WorkDraftScope,
    text: String,
    attachments: [AgentChatFileRef],
    provider: String?,
    modelId: String?
  ) async throws -> DraftEntry {
    if let chatSessionId = scope.chatSessionId, !chatSessionId.isEmpty {
      return try await syncService.createDraftForChat(
        sessionId: chatSessionId,
        text: text,
        attachments: attachments,
        provider: provider,
        modelId: modelId
      )
    }
    return try await syncService.createDraft(
      text: text,
      attachments: attachments,
      provider: provider,
      modelId: modelId,
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.projectRootPath
    )
  }

  private func deleteEntry(
    _ id: String,
    syncService: SyncService,
    scope: WorkDraftScope
  ) async throws -> Bool {
    if let chatSessionId = scope.chatSessionId, !chatSessionId.isEmpty {
      return try await syncService.deleteDraftForChat(sessionId: chatSessionId, id: id)
    }
    return try await syncService.deleteDraft(
      id: id,
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.projectRootPath
    )
  }

  private func claimEntry(
    _ id: String,
    syncService: SyncService,
    scope: WorkDraftScope
  ) async throws -> DraftEntry? {
    if let chatSessionId = scope.chatSessionId, !chatSessionId.isEmpty {
      return try await syncService.claimDraftForChat(sessionId: chatSessionId, id: id)
    }
    return try await syncService.claimDraft(
      id: id,
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.projectRootPath
    )
  }

  private func updateEntry(
    _ id: String,
    text: String? = nil,
    schedule: DraftScheduleInput? = nil,
    unschedule: Bool = false,
    syncService: SyncService,
    scope: WorkDraftScope
  ) async throws -> DraftEntry? {
    if let chatSessionId = scope.chatSessionId, !chatSessionId.isEmpty {
      return try await syncService.updateDraftForChat(
        sessionId: chatSessionId,
        id: id,
        text: text,
        schedule: schedule,
        unschedule: unschedule
      )
    }
    return try await syncService.updateDraft(
      id: id,
      text: text,
      schedule: schedule,
      unschedule: unschedule,
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.projectRootPath
    )
  }
}

struct WorkDraftListSheet: View {
  @ObservedObject var controller: WorkDraftController
  let syncService: SyncService
  let currentText: String
  let currentAttachments: [WorkChatInputAttachment]
  let scope: WorkDraftScope
  let onDraftChange: (String) -> Void
  let onAttachmentsChange: ([WorkChatInputAttachment]) -> Void

  @State private var filter: WorkDraftFilter = .all

  private var filteredEntries: [DraftEntry] {
    controller.entries.filter { filter.includes($0) }
  }

  private func count(for filter: WorkDraftFilter) -> Int {
    controller.entries.filter { filter.includes($0) }.count
  }

  var body: some View {
    NavigationStack {
      Group {
        if controller.entries.isEmpty {
          ContentUnavailableView(
            "No drafts",
            systemImage: "bookmark",
            description: Text("Save a draft from the composer menu, or schedule a send for later.")
          )
        } else {
          VStack(spacing: 0) {
            filterBar
            if filteredEntries.isEmpty {
              ContentUnavailableView(
                "Nothing here",
                systemImage: "tray",
                description: Text("No drafts match “\(filter.title)”.")
              )
            } else {
              List {
                ForEach(filteredEntries) { entry in
                  draftRow(entry)
                }
              }
              .listStyle(.plain)
            }
          }
        }
      }
      .navigationTitle("Drafts")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { controller.listPresented = false }
        }
      }
      .safeAreaInset(edge: .bottom) {
        if let errorMessage = controller.errorMessage {
          Text(errorMessage)
            .font(.caption)
            .foregroundStyle(ADEColor.danger)
            .padding()
        }
      }
      .task {
        await controller.refresh(syncService: syncService, scope: scope)
      }
    }
    .presentationDetents([.medium, .large])
  }

  private var filterBar: some View {
    HStack(spacing: 8) {
      ForEach(WorkDraftFilter.allCases) { option in
        let selected = option == filter
        Button {
          filter = option
        } label: {
          HStack(spacing: 5) {
            Text(option.title)
              .font(.system(size: 13, weight: .semibold))
            Text("\(count(for: option))")
              .font(.system(size: 11, weight: .semibold, design: .rounded))
              .foregroundStyle(selected ? ADEColor.textPrimary : ADEColor.textMuted)
          }
          .foregroundStyle(selected ? ADEColor.textPrimary : ADEColor.textMuted)
          .padding(.horizontal, 12)
          .frame(height: 30)
          .background(
            selected ? ADEColor.surfaceBackground : Color.clear,
            in: Capsule(style: .continuous)
          )
          .overlay(
            Capsule(style: .continuous)
              .strokeBorder(ADEColor.border.opacity(selected ? 0.4 : 0.2), lineWidth: 0.75)
          )
        }
        .buttonStyle(.plain)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 8)
  }

  @ViewBuilder
  private func draftRow(_ entry: DraftEntry) -> some View {
    if entry.isScheduled {
      scheduledRow(entry)
    } else {
      plainRow(entry)
    }
  }

  /// A plain draft: tap claims it into the composer. The claim is the delete.
  private func plainRow(_ entry: DraftEntry) -> some View {
    Button {
      Task {
        await controller.claim(
          entry: entry,
          syncService: syncService,
          currentText: currentText,
          currentAttachments: currentAttachments,
          scope: scope,
          onDraftChange: onDraftChange,
          onAttachmentsChange: onAttachmentsChange
        )
      }
    } label: {
      VStack(alignment: .leading, spacing: 6) {
        Text(workDraftEntryLabel(entry))
          .font(.body)
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(3)
        HStack(spacing: 8) {
          if entry.resolvedAttachmentCount > 0 {
            Label("\(entry.resolvedAttachmentCount)", systemImage: "photo")
              .font(.caption2)
              .foregroundStyle(entry.imagesUnavailable ? ADEColor.warning : ADEColor.textMuted)
          }
          if let provider = entry.provider, !provider.isEmpty {
            Text(provider.capitalized)
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
          }
          if let origin = workDraftOriginLabel(entry, scope: scope, syncService: syncService) {
            Text("· \(origin)")
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          }
          Text("· \(workProofRelativeTime(entry.createdAt))")
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
        }
      }
    }
    .swipeActions {
      deleteAction(entry)
    }
  }

  /// A scheduled send: a clock glyph and its fire time, plus a warning glyph and
  /// the reason when it needs the user. Tapping does not claim it — a scheduled
  /// row is delivered by its machine, not dropped back into a composer.
  private func scheduledRow(_ entry: DraftEntry) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(workDraftEntryLabel(entry))
        .font(.body)
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(3)
      HStack(spacing: 8) {
        if let fireTime = workDraftFireTimeLabel(entry) {
          Label(fireTime, systemImage: "clock")
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
        }
        if entry.resolvedAttachmentCount > 0 {
          Label("\(entry.resolvedAttachmentCount)", systemImage: "photo")
            .font(.caption2)
            .foregroundStyle(entry.imagesUnavailable ? ADEColor.warning : ADEColor.textMuted)
        }
      }
      if entry.needsYou {
        HStack(spacing: 6) {
          Image(systemName: "exclamationmark.triangle.fill")
            .font(.caption2)
            .foregroundStyle(ADEColor.warning)
          Text(workDraftNeedsYouReason(entry))
            .font(.caption2)
            .foregroundStyle(ADEColor.warning)
            .lineLimit(2)
        }
        Button {
          Task {
            await controller.resend(entry: entry, syncService: syncService, scope: scope)
          }
        } label: {
          Label("Resend", systemImage: "arrow.clockwise")
            .font(.caption)
        }
        .buttonStyle(.plain)
        .foregroundStyle(ADEColor.textPrimary)
      }
    }
    .swipeActions {
      Button {
        Task {
          await controller.unschedule(entry: entry, syncService: syncService, scope: scope)
        }
      } label: {
        Label("Unschedule", systemImage: "calendar.badge.minus")
      }
      .tint(ADEColor.textSecondary)
      deleteAction(entry)
    }
  }

  private func deleteAction(_ entry: DraftEntry) -> some View {
    Button(role: .destructive) {
      Task {
        await controller.remove(entry: entry, syncService: syncService, scope: scope)
      }
    } label: {
      Label("Delete", systemImage: "trash")
    }
  }
}

/// Where a draft was written, for the row's "· origin" chip: the chat's title
/// when the phone still knows it, else "This chat" for the one on screen.
@MainActor
func workDraftOriginLabel(
  _ entry: DraftEntry,
  scope: WorkDraftScope,
  syncService: SyncService
) -> String? {
  guard let origin = entry.originSessionId?.trimmingCharacters(in: .whitespacesAndNewlines),
        !origin.isEmpty else { return nil }
  if let title = syncService.chatSummaryCache[origin]?.title?.trimmingCharacters(in: .whitespacesAndNewlines),
     !title.isEmpty {
    return title
  }
  return origin == scope.chatSessionId ? "This chat" : nil
}
