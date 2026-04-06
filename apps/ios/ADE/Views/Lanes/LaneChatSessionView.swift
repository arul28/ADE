import SwiftUI

// MARK: - Chat session view

struct LaneChatSessionView: View {
  @EnvironmentObject private var syncService: SyncService
  let summary: AgentChatSessionSummary

  @State private var transcript: [AgentChatTranscriptEntry] = []
  @State private var composer = ""
  @State private var errorMessage: String?
  @State private var sending = false
  @State private var transcriptRequestId: UInt64 = 0

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(spacing: 14) {
          GlassSection(title: summary.title ?? summary.provider.uppercased()) {
            HStack(spacing: 8) {
              LaneTypeBadge(text: summary.status.uppercased(), tint: summary.status == "active" ? ADEColor.success : ADEColor.textSecondary)
              Text(summary.model)
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }

          if let errorMessage {
            HStack(spacing: 10) {
              Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(ADEColor.danger)
              Text(errorMessage)
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
              Spacer()
            }
            .padding(12)
            .background(ADEColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          }

          if transcript.isEmpty {
            GlassSection(title: "Transcript") {
              Text("No chat messages yet.")
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)
            }
          } else {
            VStack(alignment: .leading, spacing: 8) {
              ForEach(transcript) { entry in
                VStack(alignment: .leading, spacing: 4) {
                  Text(entry.role.uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(entry.role == "assistant" ? ADEColor.accent : ADEColor.textMuted)
                  Text(entry.text)
                    .font(.body)
                    .foregroundStyle(ADEColor.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                  Text(relativeTimestamp(entry.timestamp))
                    .font(.caption2)
                    .foregroundStyle(ADEColor.textMuted)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                  RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(entry.role == "assistant" ? ADEColor.accent.opacity(0.08) : ADEColor.surfaceBackground.opacity(0.6))
                )
              }
            }
          }

          Color.clear
            .frame(height: 1)
            .id("lane-chat-end")
        }
        .padding(16)
      }
      .refreshable { await loadTranscript() }
      .safeAreaInset(edge: .bottom) {
        VStack(spacing: 10) {
          HStack(spacing: 10) {
            TextField("Send a message", text: $composer, axis: .vertical)
              .textFieldStyle(.plain)
              .adeInsetField(cornerRadius: 12, padding: 10)

            Button {
              let text = composer.trimmingCharacters(in: .whitespacesAndNewlines)
              guard !text.isEmpty, !sending else { return }
              sending = true
              composer = ""
              Task {
                await sendMessage(text: text)
                withAnimation(.snappy) {
                  proxy.scrollTo("lane-chat-end", anchor: .bottom)
                }
              }
            } label: {
              Image(systemName: sending ? "ellipsis.circle" : "paperplane.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(ADEColor.accent)
                .frame(width: 40, height: 40)
                .background(ADEColor.accent.opacity(0.15), in: Circle())
            }
            .accessibilityLabel("Send message")
            .disabled(composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(ADEColor.surfaceBackground.opacity(0.08))
        .glassEffect()
      }
      .onChange(of: transcript.count) { _, _ in
        withAnimation(.snappy) {
          proxy.scrollTo("lane-chat-end", anchor: .bottom)
        }
      }
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(summary.title ?? summary.provider.uppercased())
    .navigationBarTitleDisplayMode(.inline)
    .task {
      await loadTranscript()
    }
  }

  @MainActor
  private func loadTranscript() async {
    transcriptRequestId &+= 1
    let myId = transcriptRequestId
    do {
      let result = try await syncService.fetchChatTranscript(sessionId: summary.sessionId)
      guard myId == transcriptRequestId else { return }
      transcript = result
      errorMessage = nil
    } catch {
      guard myId == transcriptRequestId else { return }
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func sendMessage(text: String) async {
    defer { sending = false }

    do {
      try await syncService.sendChatMessage(sessionId: summary.sessionId, text: text)
      errorMessage = nil
    } catch {
      errorMessage = "Message not sent. \(error.localizedDescription)"
      return
    }

    transcriptRequestId &+= 1
    let myId = transcriptRequestId
    do {
      let result = try await syncService.fetchChatTranscript(sessionId: summary.sessionId)
      guard myId == transcriptRequestId else { return }
      transcript = result
      errorMessage = nil
    } catch {
      guard myId == transcriptRequestId else { return }
      errorMessage = "Message sent, but the transcript did not refresh. \(error.localizedDescription)"
    }
  }
}
