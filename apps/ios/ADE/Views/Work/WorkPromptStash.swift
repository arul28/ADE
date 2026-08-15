import SwiftUI

func workComposerHasStashableContent(text: String, attachments: [WorkChatInputAttachment]) -> Bool {
  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    || !workChatInputReadyAttachments(attachments).isEmpty
}

func workComposerOverflowStashTitle(hasContent: Bool) -> String {
  hasContent ? "Stash prompt" : "View prompt stash"
}

func workPromptStashEntryLabel(_ entry: PromptStashEntry) -> String {
  let normalized = entry.text.trimmingCharacters(in: .whitespacesAndNewlines)
    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
  if !normalized.isEmpty { return normalized }
  let count = entry.resolvedAttachmentCount
  if count == 1 { return "1 stashed image" }
  if count > 1 { return "\(count) stashed images" }
  return "Stashed prompt"
}

struct WorkPromptStashScope: Equatable {
  var chatSessionId: String? = nil
  var projectId: String? = nil
  var projectRootPath: String? = nil
}

struct WorkComposerOverflowButton: View {
  @EnvironmentObject private var syncService: SyncService
  @StateObject private var promptStash = WorkPromptStashController()
  @Binding var attachmentPickerPresented: Bool
  @Binding var draft: String
  @Binding var attachments: [WorkChatInputAttachment]
  let canCompose: Bool
  let attachmentsAvailable: Bool
  let onDictate: () -> Void
  let stashAvailable: Bool
  let scope: WorkPromptStashScope
  let provider: String?
  let modelId: String?

  private var hasContent: Bool {
    workComposerHasStashableContent(text: draft, attachments: attachments)
  }

  var body: some View {
    WorkChatComposerOverflowMenu(
      attachmentPickerPresented: $attachmentPickerPresented,
      canCompose: canCompose,
      attachmentsAvailable: attachmentsAvailable,
      attachmentCount: attachments.count,
      dictationAvailable: SpeechDictationService.isAvailable,
      onDictate: onDictate,
      stashAvailable: stashAvailable,
      hasComposerContent: hasContent,
      stashBusy: promptStash.busy,
      stashCount: promptStash.entries.count,
      onStashOrView: {
        Task {
          await promptStash.handleMenuAction(
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
      }
    )
    .sheet(isPresented: $promptStash.listPresented) {
      WorkPromptStashListSheet(
        controller: promptStash,
        syncService: syncService,
        currentText: draft,
        currentAttachments: attachments,
        scope: scope,
        onDraftChange: { draft = $0 },
        onAttachmentsChange: { attachments = $0 }
      )
    }
    .task(id: scope) {
      guard stashAvailable else { return }
      await promptStash.refresh(syncService: syncService, scope: scope)
    }
  }
}

struct WorkChatComposerOverflowMenu: View {
  @Binding var attachmentPickerPresented: Bool
  let canCompose: Bool
  let attachmentsAvailable: Bool
  let attachmentCount: Int
  let dictationAvailable: Bool
  let onDictate: () -> Void
  let stashAvailable: Bool
  let hasComposerContent: Bool
  let stashBusy: Bool
  let stashCount: Int
  let onStashOrView: () -> Void

  private var attachDisabled: Bool {
    !canCompose || !attachmentsAvailable || attachmentCount >= workChatInputAttachmentLimit
  }

  var body: some View {
    Menu {
      Button {
        attachmentPickerPresented = true
      } label: {
        Label("Attach image", systemImage: "photo")
      }
      .disabled(attachDisabled)

      if dictationAvailable {
        Button(action: onDictate) {
          Label("Dictate voice", systemImage: "mic.fill")
        }
        .disabled(!canCompose)
      }

      if stashAvailable {
        Divider()
        Button(action: onStashOrView) {
          Label(
            workComposerOverflowStashTitle(hasContent: hasComposerContent),
            systemImage: hasComposerContent ? "bookmark" : "bookmark.fill"
          )
        }
        .disabled(stashBusy)
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
          if stashCount > 0 {
            Text("\(min(stashCount, 99))")
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
final class WorkPromptStashController: ObservableObject {
  @Published var entries: [PromptStashEntry] = []
  @Published var busy = false
  @Published var errorMessage: String?
  @Published var listPresented = false
  private var refreshToken = UUID()

  func refresh(syncService: SyncService, scope: WorkPromptStashScope) async {
    let token = UUID()
    refreshToken = token
    guard syncService.canInvokeRemoteAction("chat.listPromptStashes") else {
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
    scope: WorkPromptStashScope,
    provider: String?,
    modelId: String?,
    onDraftChange: (String) -> Void,
    onAttachmentsChange: ([WorkChatInputAttachment]) -> Void
  ) async {
    if workComposerHasStashableContent(text: text, attachments: attachments) {
      await stash(
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

  func stash(
    syncService: SyncService,
    text: String,
    attachments: [WorkChatInputAttachment],
    scope: WorkPromptStashScope,
    provider: String?,
    modelId: String?,
    onDraftChange: (String) -> Void,
    onAttachmentsChange: ([WorkChatInputAttachment]) -> Void
  ) async {
    guard !busy else { return }
    refreshToken = UUID()
    if workChatInputHasLoadingAttachments(attachments) {
      errorMessage = "Wait for images to finish loading before stashing."
      listPresented = true
      return
    }
    let ready = workChatInputReadyAttachments(attachments)
    guard workComposerHasStashableContent(text: text, attachments: attachments) else { return }
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

  func restore(
    entry: PromptStashEntry,
    syncService: SyncService,
    currentText: String,
    currentAttachments: [WorkChatInputAttachment],
    scope: WorkPromptStashScope,
    onDraftChange: (String) -> Void,
    onAttachmentsChange: ([WorkChatInputAttachment]) -> Void
  ) async {
    guard !busy else { return }
    refreshToken = UUID()
    if workComposerHasStashableContent(text: currentText, attachments: currentAttachments) {
      listPresented = false
      return
    }
    if entry.imagesUnavailable {
      errorMessage = "These images live on the machine where this prompt was stashed. Connect to that machine to restore it."
      return
    }
    busy = true
    errorMessage = nil
    defer { busy = false }
    do {
      let restored = try await workChatInputAttachments(
        from: entry.resolvedAttachments,
        syncService: syncService,
        chatSessionId: scope.chatSessionId,
        projectId: scope.projectId,
        projectRootPath: scope.projectRootPath
      )
      guard restored.count == entry.resolvedAttachments.count else {
        throw NSError(
          domain: "ADE",
          code: 28,
          userInfo: [NSLocalizedDescriptionKey: "Could not restore every stashed image. The prompt is still in your stash."]
        )
      }
      onDraftChange(entry.text)
      onAttachmentsChange(restored)
      _ = try await deleteEntry(entry.id, syncService: syncService, scope: scope)
      entries.removeAll { $0.id == entry.id }
      listPresented = false
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func remove(
    entry: PromptStashEntry,
    syncService: SyncService,
    scope: WorkPromptStashScope
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

  private func listEntries(
    syncService: SyncService,
    scope: WorkPromptStashScope
  ) async throws -> [PromptStashEntry] {
    if let chatSessionId = scope.chatSessionId, !chatSessionId.isEmpty {
      return try await syncService.listPromptStashesForChat(sessionId: chatSessionId)
    }
    return try await syncService.listPromptStashes(
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.projectRootPath
    )
  }

  private func createEntry(
    syncService: SyncService,
    scope: WorkPromptStashScope,
    text: String,
    attachments: [AgentChatFileRef],
    provider: String?,
    modelId: String?
  ) async throws -> PromptStashEntry {
    if let chatSessionId = scope.chatSessionId, !chatSessionId.isEmpty {
      return try await syncService.createPromptStashForChat(
        sessionId: chatSessionId,
        text: text,
        attachments: attachments,
        provider: provider,
        modelId: modelId
      )
    }
    return try await syncService.createPromptStash(
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
    scope: WorkPromptStashScope
  ) async throws -> Bool {
    if let chatSessionId = scope.chatSessionId, !chatSessionId.isEmpty {
      return try await syncService.deletePromptStashForChat(sessionId: chatSessionId, id: id)
    }
    return try await syncService.deletePromptStash(
      id: id,
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.projectRootPath
    )
  }
}

struct WorkPromptStashListSheet: View {
  @ObservedObject var controller: WorkPromptStashController
  let syncService: SyncService
  let currentText: String
  let currentAttachments: [WorkChatInputAttachment]
  let scope: WorkPromptStashScope
  let onDraftChange: (String) -> Void
  let onAttachmentsChange: ([WorkChatInputAttachment]) -> Void

  var body: some View {
    NavigationStack {
      Group {
        if controller.entries.isEmpty {
          ContentUnavailableView(
            "No stashed prompts",
            systemImage: "bookmark",
            description: Text("Stash a prompt from the composer menu to keep it for later.")
          )
        } else {
          List {
            ForEach(controller.entries) { entry in
              Button {
                Task {
                  await controller.restore(
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
                  Text(workPromptStashEntryLabel(entry))
                    .font(.body)
                    .foregroundStyle(ADEColor.textPrimary)
                    .lineLimit(3)
                  HStack(spacing: 8) {
                    if entry.resolvedAttachmentCount > 0 {
                      Label(
                        "\(entry.resolvedAttachmentCount)",
                        systemImage: "photo"
                      )
                      .font(.caption2)
                      .foregroundStyle(entry.imagesUnavailable ? ADEColor.warning : ADEColor.textMuted)
                    }
                    if let provider = entry.provider, !provider.isEmpty {
                      Text(provider.capitalized)
                        .font(.caption2)
                        .foregroundStyle(ADEColor.textMuted)
                    }
                  }
                }
              }
              .swipeActions {
                Button(role: .destructive) {
                  Task {
                    await controller.remove(
                      entry: entry,
                      syncService: syncService,
                      scope: scope
                    )
                  }
                } label: {
                  Label("Delete", systemImage: "trash")
                }
              }
            }
          }
        }
      }
      .navigationTitle("Stashed prompts")
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
    }
    .presentationDetents([.medium, .large])
  }
}
