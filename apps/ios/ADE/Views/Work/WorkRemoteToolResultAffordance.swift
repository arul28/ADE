import SwiftUI

/// Result block for a mobile tool result whose tail remains on the host.
///
/// Keeping the fetch state with this focused view prevents a recycled tool row
/// from carrying a previous result's loading/error state, while the transcript
/// sequence keeps a retried item id from hydrating the old full result.
struct WorkRemoteToolResultAffordance: View {
  let toolName: String
  let itemId: String
  let sessionId: String
  let resultText: String
  let remoteResultBytes: Int
  let eventSequence: Int?
  /// Timestamp of the same `tool_result` envelope the sequence came from. The
  /// pair is what identifies this generation on a legacy transcript, where a
  /// sequence can repeat across host restarts.
  let eventTimestamp: String?

  @EnvironmentObject private var syncService: SyncService
  @State private var resultExpanded = false
  @State private var fetchedFullResult: String?
  @State private var fetchingFullResult = false
  @State private var fullResultError: String?
  @State private var fetchGeneration = 0

  private var effectiveResultText: String {
    fetchedFullResult ?? resultText
  }

  /// Same fields the cache and the host key on, so a row that switches
  /// generation resets its fetched state instead of keeping the old output.
  private var resultIdentity: String {
    let sequence = eventSequence.map(String.init) ?? "latest"
    let timestamp = eventTimestamp.flatMap { $0.isEmpty ? nil : $0 } ?? "-"
    return "\(sessionId)|\(itemId)|\(sequence)|\(timestamp)"
  }

  var body: some View {
    let result = workToolResultBlockText(effectiveResultText, expanded: resultExpanded)
    VStack(alignment: .leading, spacing: 8) {
      WorkStructuredOutputBlock(title: "Result", text: result.displayed, copyText: result.copy)
      affordances(
        resultText: result.copy,
        displayedText: result.displayed,
        didTruncate: result.didTruncate
      )
    }
    .onAppear(perform: hydrateCachedResult)
    .onChange(of: resultIdentity) { _, _ in
      fetchGeneration += 1
      fetchedFullResult = nil
      fetchingFullResult = false
      fullResultError = nil
      resultExpanded = false
      hydrateCachedResult()
    }
  }

  @ViewBuilder
  private func affordances(
    resultText: String,
    displayedText: String,
    didTruncate: Bool
  ) -> some View {
    if fetchedFullResult == nil {
      remoteAffordance
    } else {
      let affordance = workTruncatedOutputAffordance(
        isTruncated: didTruncate,
        hasExpandedInPlace: resultExpanded,
        isClipped: workOutputBoxOverflows(
          displayedText,
          lineCapacity: workStructuredOutputBoxLineCapacity,
          columnCapacity: workStructuredOutputBoxColumnCapacity
        )
      )
      HStack(spacing: 12) {
        switch affordance {
        case .none:
          EmptyView()
        case .showMore:
          Button {
            resultExpanded = true
          } label: {
            Text("Show all (\(workToolResultByteLabel(resultText)))")
              .font(.caption2.weight(.semibold))
              .foregroundStyle(ADEColor.accent)
              .frame(minHeight: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Show full tool result")
        case .openFullOutput:
          WorkOpenFullOutputButton(
            title: toolName,
            subtitle: "Result",
            text: resultText,
            label: "Open full output",
            prominent: true
          )
        }

        if resultExpanded {
          Button {
            resultExpanded = false
          } label: {
            Text("Collapse")
              .font(.caption2.weight(.semibold))
              .foregroundStyle(ADEColor.textSecondary)
              .frame(minHeight: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Collapse tool result")
        }
        Spacer(minLength: 0)
      }
    }
  }

  @ViewBuilder
  private var remoteAffordance: some View {
    HStack(spacing: 12) {
      if fetchingFullResult {
        HStack(spacing: 8) {
          ProgressView()
            .controlSize(.small)
          Text("Loading full result…")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(ADEColor.textSecondary)
        }
        .frame(minHeight: 44)
        .accessibilityLabel("Loading full tool result")
      } else {
        Button(action: loadFullResult) {
          // A host that flagged truncation without a size gives 0 here; the
          // button still has to exist, it just cannot name a number.
          Text(remoteResultBytes > 0
            ? "Show all (\(workToolResultRemoteByteLabel(remoteResultBytes)))"
            : "Show all")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(ADEColor.accent)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Show full tool result")
      }

      if let fullResultError {
        Text(fullResultError)
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(2)
      }
      Spacer(minLength: 0)
    }
  }

  private func loadFullResult() {
    guard !fetchingFullResult else { return }
    fetchGeneration += 1
    let requestGeneration = fetchGeneration
    fetchingFullResult = true
    fullResultError = nil
    Task { @MainActor in
      defer {
        if fetchGeneration == requestGeneration {
          fetchingFullResult = false
        }
      }
      do {
        let fullResult = try await syncService.fullToolResult(
          sessionId: sessionId,
          itemId: itemId,
          eventSequence: eventSequence,
          eventTimestamp: eventTimestamp
        )
        guard fetchGeneration == requestGeneration else { return }
        fetchedFullResult = fullResult
        resultExpanded = true
      } catch {
        guard fetchGeneration == requestGeneration else { return }
        // The slice stays on screen; only the affordance changes. Losing the
        // preview to an error message would hide what the user already had.
        fullResultError = (error as NSError).localizedDescription
      }
    }
  }

  private func hydrateCachedResult() {
    guard fetchedFullResult == nil else { return }
    fetchedFullResult = syncService.cachedFullToolResult(
      sessionId: sessionId,
      itemId: itemId,
      eventSequence: eventSequence,
      eventTimestamp: eventTimestamp
    )
  }
}
