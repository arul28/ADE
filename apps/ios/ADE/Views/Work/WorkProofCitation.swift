import SwiftUI
import UIKit

// MARK: - Proof inside the answer

/// What an answer's proof citations read: the chat's proof, the bytes loaded
/// so far, and the loader. Nil on surfaces with no chat (previews, the PR
/// wizard); a citation there says it cannot show the proof.
struct WorkProofCitationContext {
  let artifactsById: [String: ComputerUseArtifactSummary]
  /// Finds a cited id the chat's own list does not hold (another chat's proof
  /// in the same project). Nil where there is no database to ask.
  var lookup: ((String) -> ComputerUseArtifactSummary?)? = nil
  let content: [String: WorkLoadedArtifactContent]
  let load: WorkArtifactLoader
  /// Asks the chat's host about a cited id the list does not hold (filed after
  /// the list was read, or by another chat). The chat asks once per id.
  var resolveMissing: (@MainActor (String) async -> Void)? = nil
  /// The picture the chat's resting ADE Cloud computer saved for a cited id
  /// (a still for a video), from the account with no wake. Answers nil for a
  /// chat with a live link.
  var savedProof: (@MainActor (String) async -> CloudSavedChatProof?)? = nil
  /// Wakes the chat's own computer: a saved video's "Wake to play".
  var wakeComputer: (@MainActor () async -> Void)? = nil
}

private struct WorkProofCitationEnvironmentKey: EnvironmentKey {
  static let defaultValue: WorkProofCitationContext? = nil
}

extension EnvironmentValues {
  var workProofCitations: WorkProofCitationContext? {
    get { self[WorkProofCitationEnvironmentKey.self] }
    set { self[WorkProofCitationEnvironmentKey.self] = newValue }
  }
}

/// `![caption](ade-proof://<id>)` in an answer: the picture or the video at a
/// readable size, the caption under it, and where it came from.
struct WorkProofCitationView: View {
  let artifactId: String
  let caption: String
  var compact = false

  @Environment(\.workProofCitations) private var citations
  @State private var viewerOpen = false
  @State private var seekRequest: Double?
  /// The chapters stay behind their toggle until the person opens them.
  @State private var chaptersOpen = false
  /// What the chat's resting computer saved for this id, once asked.
  @State private var saved: CloudSavedChatProof?
  @State private var waking = false

  private var mediaMaxHeight: CGFloat { compact ? 220 : 360 }

  var body: some View {
    if let citations, let artifact = citations.artifactsById[artifactId] ?? citations.lookup?(artifactId) {
      let content = citations.content[artifactId]
      let failed = Self.isError(content)
      VStack(alignment: .leading, spacing: 6) {
        Group {
          // The computer can't send it (asleep, deleted): the copy it saved before it rested.
          if failed, let saved {
            // Once awake, the live proof loads again and takes the saved one's place.
            savedMedia(saved, label: captionText(artifact)) { await citations.load(artifact, .retry) }
          } else {
            media(artifact: artifact, content: content, load: citations.load)
          }
        }
        .task(id: artifactId) { await citations.load(artifact, .preview) }
        .task(id: "\(artifactId)|\(failed)") { if failed { await askSaved() } }
        captionRows(artifact)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .fullScreenCover(isPresented: $viewerOpen) {
        WorkProofViewer(
          artifacts: [artifact],
          artifactContent: citations.content,
          initialArtifactId: artifact.id,
          onLoadArtifact: citations.load
        )
      }
    } else {
      Group {
        if let saved {
          VStack(alignment: .leading, spacing: 6) {
            // Once awake, the chat's host is asked for the proof again; found, the live view loads it.
            savedMedia(saved, label: caption.isEmpty ? (saved.source == .video ? "Video proof" : "Proof") : caption) {
              await citations?.resolveMissing?(artifactId)
            }
            if !caption.isEmpty {
              Text(caption)
                .font(.footnote)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        } else {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
              .foregroundStyle(ADEColor.warning)
            Text(missingText)
              .font(.footnote)
              .foregroundStyle(ADEColor.textSecondary)
          }
          .padding(10)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(ADEColor.recessedBackground.opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
      }
      .task(id: artifactId) {
        await citations?.resolveMissing?(artifactId)
        await askSaved()
      }
    }
  }

  private static func isError(_ content: WorkLoadedArtifactContent?) -> Bool {
    if case .error = content { return true }
    return false
  }

  /// Asks the account once for the saved copy; nil (a live chat, nothing saved) leaves the view as it was.
  private func askSaved() async {
    guard saved == nil, let ask = citations?.savedProof else { return }
    saved = await ask(artifactId)
  }

  /// The saved picture where the live proof would be. A video shows its
  /// still with "Wake to play"; the video itself plays only from the computer.
  @ViewBuilder
  private func savedMedia(_ proof: CloudSavedChatProof, label: String, afterWake: @escaping @MainActor () async -> Void) -> some View {
    let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
    VStack(alignment: .leading, spacing: 4) {
      if let image = UIImage(data: proof.data) {
        ZStack {
          Image(uiImage: image)
            .resizable()
            .scaledToFit()
            .frame(maxHeight: mediaMaxHeight)
            .clipShape(shape)
            .overlay(shape.strokeBorder(ADEColor.border.opacity(0.3)))
            .accessibilityLabel(label)
          if proof.source == .video, let wake = citations?.wakeComputer {
            Button {
              waking = true
              Task {
                await wake()
                await afterWake()
                waking = false
              }
            } label: {
              Label(waking ? "Waking…" : "Wake to play", systemImage: waking ? "hourglass" : "play.fill")
                .font(.footnote.weight(.semibold))
            }
            .buttonStyle(.borderedProminent)
            .disabled(waking)
          }
        }
      }
      Text(proof.source == .video ? "A still from the video, saved while its computer rests." : "Saved copy, shown while its computer rests.")
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
    }
  }

  private var missingText: String {
    let cited = caption.isEmpty ? "" : " It was cited as \"\(caption)\"."
    return "ADE has no proof with the id \(artifactId).\(cited)"
  }

  @ViewBuilder
  private func media(
    artifact: ComputerUseArtifactSummary,
    content: WorkLoadedArtifactContent?,
    load: @escaping WorkArtifactLoader
  ) -> some View {
    let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
    switch content {
    case .image(let image):
      Button {
        viewerOpen = true
      } label: {
        Image(uiImage: image)
          .resizable()
          .scaledToFit()
          .frame(maxHeight: mediaMaxHeight)
          .clipShape(shape)
          .overlay(shape.strokeBorder(ADEColor.border.opacity(0.3)))
      }
      .buttonStyle(.plain)
      .accessibilityLabel(captionText(artifact))
      .accessibilityHint("Opens the proof full screen")
    case .video(let url), .remoteURL(let url):
      WorkArtifactInlineVideoView(url: url, seek: $seekRequest) { viewerOpen = true }
        .aspectRatio(16.0 / 10.0, contentMode: .fit)
        .frame(maxHeight: mediaMaxHeight)
        .clipShape(shape)
    case .videoOnDemand(let sizeBytes):
      WorkArtifactPlayPlaceholder(
        sizeBytes: sizeBytes,
        tint: ADEColor.textSecondary,
        onPlay: { Task { await load(artifact, .play) } }
      )
      .frame(maxWidth: .infinity, minHeight: compact ? 120 : 180)
      .background(Color.black.opacity(0.85), in: shape)
    case .text:
      Text("This proof is text. Open the proof sheet to read it.")
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
    case .error(let message):
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Image(systemName: "exclamationmark.triangle")
          .foregroundStyle(ADEColor.warning)
        Text(message)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
        Spacer(minLength: 8)
        Button("Retry") { Task { await load(artifact, .retry) } }
          .font(.footnote.weight(.semibold))
          .buttonStyle(.borderless)
      }
      .padding(10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.recessedBackground.opacity(0.6), in: shape)
    case .none:
      ProgressView()
        .frame(maxWidth: .infinity, minHeight: compact ? 120 : 180)
        .background(ADEColor.recessedBackground.opacity(0.6), in: shape)
    }
  }

  private func captionText(_ artifact: ComputerUseArtifactSummary) -> String {
    if !caption.isEmpty { return caption }
    let description = artifact.description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return description.isEmpty ? WorkProofRowModel(artifact: artifact).title : description
  }

  @ViewBuilder
  private func captionRows(_ artifact: ComputerUseArtifactSummary) -> some View {
    let chapters = workDemoChapters(artifact.metadataJson)
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(captionText(artifact))
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
        .frame(maxWidth: .infinity, alignment: .leading)
      // One chapter has nowhere to jump to.
      if chapters.count > 1 {
        Button {
          withAnimation(.easeOut(duration: 0.15)) { chaptersOpen.toggle() }
        } label: {
          HStack(spacing: 3) {
            Text("Chapters · \(chapters.count)")
            Image(systemName: "chevron.down")
              .imageScale(.small)
              .rotationEffect(.degrees(chaptersOpen ? 180 : 0))
          }
          .font(.caption2)
          .foregroundStyle(ADEColor.textSecondary.opacity(0.75))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(chaptersOpen ? "Hide chapters" : "Show \(chapters.count) chapters")
      }
    }
    if chapters.count > 1, chaptersOpen {
      WorkDemoChaptersRow(chapters: chapters) { seekRequest = $0 }
    }
    // The one provenance fact worth a line in an answer: a video older than the request.
    if let older = workProofProvenanceLines(artifact.metadataJson).older {
      Text(older)
        .font(.caption2)
        .foregroundStyle(ADEColor.warning)
    }
  }
}

/// A ```proof-compare block: before and after, side by side.
struct WorkProofCompareView: View {
  let compare: WorkProofCompare

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 8) {
        side("Before", compare.before)
        side("After", compare.after)
      }
      if !compare.caption.isEmpty {
        Text(compare.caption)
          .font(.footnote)
          .foregroundStyle(ADEColor.textPrimary)
      }
    }
  }

  private func side(_ title: String, _ entry: WorkProofCompareSide) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title.uppercased())
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      WorkProofCitationView(artifactId: entry.artifactId, caption: entry.label, compact: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}
