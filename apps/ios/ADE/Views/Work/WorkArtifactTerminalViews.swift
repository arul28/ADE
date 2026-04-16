import SwiftUI
import UIKit
import AVKit

final class WorkArtifactVideoPlayerModel: ObservableObject {
  let player: AVPlayer

  init(url: URL) {
    player = AVPlayer(url: url)
  }

  func update(url: URL) {
    if let currentURL = (player.currentItem?.asset as? AVURLAsset)?.url, currentURL == url {
      return
    }
    player.replaceCurrentItem(with: AVPlayerItem(url: url))
  }
}

struct WorkArtifactVideoPlayerView: View {
  let url: URL
  @StateObject var model: WorkArtifactVideoPlayerModel

  init(url: URL) {
    self.url = url
    _model = StateObject(wrappedValue: WorkArtifactVideoPlayerModel(url: url))
  }

  var body: some View {
    VideoPlayer(player: model.player)
      .frame(height: 220)
      .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
      .onChange(of: url) { _, newValue in
        model.update(url: newValue)
      }
  }
}

struct WorkArtifactView: View {
  let artifact: ComputerUseArtifactSummary
  let content: WorkLoadedArtifactContent?
  let onAppear: () -> Void
  let onOpenImage: (UIImage) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        Image(systemName: artifact.artifactKind == "video_recording" ? "video.fill" : "photo.fill")
          .foregroundStyle(ADEColor.accent)
        VStack(alignment: .leading, spacing: 3) {
          Text(artifact.title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(artifact.artifactKind.replacingOccurrences(of: "_", with: " ").capitalized)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer()
        Text(relativeTimestamp(artifact.createdAt))
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }

      Group {
        switch content {
        case .image(let image):
          Button {
            onOpenImage(image)
          } label: {
            Image(uiImage: image)
              .resizable()
              .scaledToFill()
              .frame(maxWidth: .infinity)
              .frame(height: 180)
              .clipped()
              .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Open artifact image \(artifact.title)")
        case .video(let url):
          WorkArtifactVideoPlayerView(url: url)
        case .remoteURL(let url):
          if artifact.artifactKind == "video_recording" {
            WorkArtifactVideoPlayerView(url: url)
          } else {
            AsyncImage(url: url) { image in
              image
                .resizable()
                .scaledToFill()
            } placeholder: {
              ProgressView()
            }
            .frame(height: 180)
            .frame(maxWidth: .infinity)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
          }
        case .text(let text):
          WorkStructuredOutputBlock(title: "Artifact", text: text)
        case .error(let message):
          Text(message)
            .font(.caption)
            .foregroundStyle(ADEColor.danger)
        case .none:
          HStack(spacing: 10) {
            ProgressView()
            Text("Loading artifact preview…")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(12)
          .background(ADEColor.surfaceBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
      }
    }
    .padding(14)
    .background(ADEColor.surfaceBackground.opacity(0.7), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .task {
      onAppear()
    }
  }
}

struct WorkTerminalSessionView: View {
  @EnvironmentObject var syncService: SyncService
  let session: TerminalSessionSummary
  let disconnectedNotice: Bool
  let transitionNamespace: Namespace.ID?
  let onOpenLane: (() -> Void)?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        WorkSessionHeader(
          session: session,
          chatSummary: nil,
          transitionNamespace: transitionNamespace,
          onOpenLane: onOpenLane,
          onOpenSettings: nil
        )

        if disconnectedNotice {
          ADENoticeCard(
            title: "Showing cached terminal output",
            message: "Reconnect to resume live ANSI rendering for this session.",
            icon: "wifi.slash",
            tint: ADEColor.warning,
            actionTitle: nil,
            action: nil
          )
        }

        Text(ansiAttributedString(syncService.terminalBuffers[session.id] ?? session.lastOutputPreview ?? "No output yet."))
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(14)
          .background(ADEColor.surfaceBackground.opacity(0.7), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
          .textSelection(.enabled)
      }
      .padding(16)
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .task {
      try? await syncService.subscribeTerminal(sessionId: session.id)
    }
  }
}

struct WorkFullscreenImageView: View {
  @Environment(\.dismiss) var dismiss
  let image: WorkFullscreenImage

  @State var scale: CGFloat = 1
  @State var lastScale: CGFloat = 1

  var body: some View {
    NavigationStack {
      ScrollView([.horizontal, .vertical]) {
        Image(uiImage: image.image)
          .resizable()
          .scaledToFit()
          .scaleEffect(scale)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .padding(24)
          .gesture(
            MagnifyGesture()
              .onChanged { value in
                scale = max(1, min(6, lastScale * value.magnification))
              }
              .onEnded { _ in
                lastScale = scale
              }
          )
      }
      .background(Color.black.ignoresSafeArea())
      .navigationTitle(image.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
  }
}
