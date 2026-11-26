import OSLog
import SwiftUI

private let ctoAccountCopyLog = Logger(subsystem: "com.ade.ios", category: "cto-account-copy")

// The CTO's account copy (`GET /cloud/cto?origin=`): what its home saved
// after its last turn (notes, open work, routines, the end of the last
// turns). It shows when the home is asleep or offline, or when the project
// has no computer, so the person can read where the CTO left off. It is
// read once when the screen opens; nothing here wakes the home.

@MainActor
final class CtoAccountCopyModel: ObservableObject {
  @Published private(set) var read: CloudAtRestStore.Read<CloudCtoCopy>?
  private var readOrigin: String?

  func load(origin: String?, using sync: SyncService) async {
    #if DEBUG
    if isFixture { return }
    #endif
    guard let origin else {
      read = nil
      return
    }
    // A failed read is read again on the next open.
    if readOrigin == origin, let read {
      if case .failed = read {} else { return }
    }
    readOrigin = origin
    guard let client = await sync.cloudServerClient() else { return }
    do {
      let summary = try await client.ctoCopy(origin: origin)
      if let copy = summary.copy, summary.available {
        read = .loaded(copy)
      } else {
        read = .missing
      }
    } catch CloudServerClient.Failure.noAccess {
      // An older server: the screen stays as it was.
      read = .missing
    } catch {
      read = .failed(cloudServerFailureMessage(error))
      ctoAccountCopyLog.notice("cto_account_copy read failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
    }
  }

  #if DEBUG
  private var isFixture = false
  func seedPreview(_ copy: CloudCtoCopy) {
    isFixture = true
    read = .loaded(copy)
  }
  #endif
}

/// One line under the asleep CTO: what its home saved, and a tap to read it.
/// Nothing shows when there is no copy.
struct CtoAccountCopyEntry: View {
  let name: String
  @ObservedObject var model: CtoAccountCopyModel
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @State private var presented = false

  var body: some View {
    Group {
      if case .loaded(let copy)? = model.read {
        Button { presented = true } label: {
          HStack(alignment: .center, spacing: 12) {
            Image(systemName: "note.text")
              .font(.system(size: 16, weight: .semibold))
              .foregroundStyle(ADEColor.accent)
              .frame(width: 22)
              .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
              Text("Read where \(name) left off")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
              Text(ctoCopyLine(copy))
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(2)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
              .font(.system(size: 12, weight: .semibold))
              .foregroundStyle(ADEColor.textMuted)
              .accessibilityHidden(true)
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 12)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .adeKitCard(padding: nil)
        .padding(.horizontal, 16)
        .padding(.bottom, 12)
        .frame(maxWidth: 560)
        .adeInspectable("Cto.AccountCopy.Entry")
        .sheet(isPresented: $presented) {
          CtoAccountCopySheet(name: name, copy: copy)
        }
      }
    }
    .task(id: syncPublishes.service.cloudProjectOrigin) {
      await model.load(origin: syncPublishes.service.cloudProjectOrigin, using: syncPublishes.service)
    }
  }
}

/// "Saved 2 h ago. Open work: …" for the entry line. Pure.
func ctoCopyLine(_ copy: CloudCtoCopy) -> String {
  var parts: [String] = []
  if let savedAt = copy.savedAt.flatMap({ ISO8601DateFormatter().date(from: $0) }) {
    parts.append("Saved \(savedAt.formatted(.relative(presentation: .named))).")
  }
  if let openWork = nonEmptyTrimmed(copy.openWork) {
    parts.append(openWork)
  } else if let story = copy.storySummary {
    parts.append(story)
  }
  return parts.isEmpty ? "Its notes, open work and last turns." : parts.joined(separator: " ")
}

/// The whole copy, read-only.
struct CtoAccountCopySheet: View {
  let name: String
  let copy: CloudCtoCopy
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          Text("What \(name)'s home saved after its last turn. Moving the CTO to another home brings all of this along.")
            .font(.footnote)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          if let openWork = nonEmptyTrimmed(copy.openWork) {
            section("Open work", symbol: "checklist", text: openWork)
          }
          if let story = copy.storySummary {
            section("The story so far", symbol: "book", text: story)
          }
          if !copy.routines.isEmpty {
            ADEKitCard(title: "Routines", symbol: "clock", count: "\(copy.routines.count)") {
              VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(copy.routines.enumerated()), id: \.offset) { _, routine in
                  HStack(spacing: 8) {
                    Text(routine.title)
                      .font(.subheadline)
                      .foregroundStyle(ADEColor.textPrimary)
                    Spacer(minLength: 6)
                    if routine.paused {
                      ADEKitTag(text: "Paused", tone: .neutral, keepsCase: true)
                    }
                    Text(routine.check != nil && !routine.paused ? "\(routine.cron) · on change" : routine.cron)
                      .font(.adeMono(11))
                      .foregroundStyle(ADEColor.textMuted)
                  }
                }
              }
            }
          }
          if let rules = nonEmptyTrimmed(copy.rules) {
            section("Rules", symbol: "list.bullet.rectangle", text: rules)
          }
          if !copy.skills.isEmpty {
            ADEKitCard(title: "Skills", symbol: "book.closed", count: "\(copy.skills.count)") {
              VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(copy.skills.enumerated()), id: \.offset) { _, skill in
                  VStack(alignment: .leading, spacing: 1) {
                    Text(skill.name)
                      .font(.subheadline.weight(.medium))
                      .foregroundStyle(ADEColor.textPrimary)
                    if let description = nonEmptyTrimmed(skill.description) {
                      Text(description)
                        .font(.caption)
                        .foregroundStyle(ADEColor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                  }
                  .accessibilityElement(children: .combine)
                }
              }
            }
          }
          if let notes = nonEmptyTrimmed(copy.projectNotes) {
            section("Project notes", symbol: "doc.text", text: notes)
          }
          if let notes = nonEmptyTrimmed(copy.userNotes) {
            section("Notes about you", symbol: "person", text: notes)
          }
          if let tail = nonEmptyTrimmed(copy.tail) {
            ADEKitCard(title: "Last turns", symbol: "bubble.left.and.bubble.right", hint: copy.tailTruncated ? "The newest part; the start is cut." : nil) {
              Text(tail)
                .font(.system(size: 13))
                .foregroundStyle(ADEColor.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
        }
        .padding(16)
        .frame(maxWidth: 720, alignment: .leading)
        .frame(maxWidth: .infinity)
      }
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("Where \(name) left off")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
    .adeInspectable("Cto.AccountCopy")
  }

  private func section(_ title: String, symbol: String, text: String) -> some View {
    ADEKitCard(title: title, symbol: symbol) {
      Text(text)
        .font(.system(size: 14))
        .foregroundStyle(ADEColor.textPrimary)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
    }
  }
}
