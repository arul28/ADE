import SwiftUI
import UIKit

// Links inside a chat message, on its long-press menu, and a skill chip's
// instructions.
//
// A message is one SwiftUI `Text` per block, and a `Text` has no menu of its
// own per link. So the long-press menu a block already carries (Copy message,
// Open full response) gains a section with that block's links: each one opens
// to Open and Copy link, and a skill chip opens to View instructions and Copy.
// The links are read from the same attributed string the block draws, so the
// menu names exactly what the reader sees: a chat link by the chat's live
// title, a lane by its name. Nothing is computed until the menu is shown.

/// The scheme a skill chip links to. Never leaves the app: the chat surface
/// turns it into the instructions sheet (`WorkSkillInstructionsModel`).
let workSkillURLScheme = "ade-skill"

func workSkillURL(name: String) -> URL? {
  var components = URLComponents()
  components.scheme = workSkillURLScheme
  components.host = "skill"
  components.queryItems = [URLQueryItem(name: "name", value: name)]
  return components.url
}

func workSkillName(from url: URL) -> String? {
  guard url.scheme?.lowercased() == workSkillURLScheme else { return nil }
  let name = URLComponents(url: url, resolvingAgainstBaseURL: false)?
    .queryItems?
    .first(where: { $0.name == "name" })?
    .value?
    .trimmingCharacters(in: .whitespacesAndNewlines)
  return name?.isEmpty == false ? name : nil
}

// MARK: - Links in a message

struct WorkMessageLink: Identifiable, Equatable {
  enum Kind: Equatable {
    case web
    case chat
    case lane
    case pullRequest
    case issue
    case machine
    case adeOther
    case skill(name: String)
  }

  var id: String { url.absoluteString }
  let title: String
  let url: URL
  let kind: Kind

  var openTitle: String {
    switch kind {
    case .web: return "Open link"
    case .chat: return "Open chat"
    case .lane: return "Open lane"
    case .pullRequest: return "Open pull request"
    case .issue: return "Open issue"
    case .machine: return "Show machine"
    case .adeOther: return "Open"
    case .skill: return "View instructions"
    }
  }

  var systemImage: String {
    switch kind {
    case .web: return "safari"
    case .chat: return "bubble.left.and.bubble.right"
    case .lane: return "square.stack.3d.up"
    case .pullRequest: return "arrow.triangle.pull"
    case .issue: return "circle.dashed"
    case .machine: return "desktopcomputer"
    case .adeOther: return "link"
    case .skill: return "sparkles"
    }
  }

  /// What Copy puts on the clipboard. An `ade://` link works pasted into any
  /// ADE chat and opens from anywhere ADE is installed; a skill copies as the
  /// `/name` the composer takes.
  var copyText: String {
    if case .skill(let name) = kind { return "/\(name)" }
    return url.absoluteString
  }

  var copyTitle: String {
    if case .skill(let name) = kind { return "Copy /\(name)" }
    return "Copy link"
  }
}

/// The most links one menu lists. A block that names more is a list of links,
/// and the first few are the ones a long-press is after.
let workMessageLinkMenuLimit = 8

func workMessageLinkKind(_ url: URL) -> WorkMessageLink.Kind? {
  let scheme = url.scheme?.lowercased() ?? ""
  if let name = workSkillName(from: url) { return .skill(name: name) }
  switch scheme {
  case "http", "https":
    return .web
  case "ade":
    switch url.host?.lowercased() {
    case "session": return .chat
    case "lane": return .lane
    case "pr": return .pullRequest
    case "linear-issue", "issue": return .issue
    case "machine": return .machine
    default: return .adeOther
    }
  default:
    // `ade-thread-time://` toggles a timestamp in place, and every other
    // scheme is either internal or not something to hand the system blind.
    return nil
  }
}

/// Every distinct link in `text`, in reading order: its runs' `.link`.
func workMessageLinks(in text: AttributedString, limit: Int = workMessageLinkMenuLimit) -> [WorkMessageLink] {
  var links: [WorkMessageLink] = []
  var seen: Set<String> = []
  for (link, range) in text.runs[\.link] {
    guard let link, let kind = workMessageLinkKind(link) else { continue }
    guard seen.insert(link.absoluteString).inserted else { continue }
    links.append(WorkMessageLink(title: workMessageLinkTitle(String(text[range].characters), url: link), url: link, kind: kind))
    if links.count >= limit { break }
  }
  return links
}

/// The visible text of a link run, without a chip's live dot, short enough for
/// a menu row. A bare URL shows its host and path.
func workMessageLinkTitle(_ raw: String, url: URL) -> String {
  var title = raw.replacingOccurrences(of: "●", with: "")
    .trimmingCharacters(in: .whitespacesAndNewlines)
  // A chip's run leads with its glyph ("💬 Phone perf"); the menu row has its
  // own icon, so the glyph would show twice.
  if let space = title.firstIndex(of: " "),
     title[..<space].unicodeScalars.allSatisfy({ !CharacterSet.alphanumerics.contains($0) }) {
    title = String(title[title.index(after: space)...]).trimmingCharacters(in: .whitespaces)
  }
  if title.isEmpty || title == url.absoluteString {
    let host = url.host ?? url.absoluteString
    let path = url.path == "/" ? "" : url.path
    title = host + path
  }
  if title.count > 48 { title = String(title.prefix(47)) + "…" }
  return title
}

/// Links in an agent's markdown block: the attributed string it is drawn from.
func workAssistantMarkdownLinks(_ texts: [String], lookup: WorkThreadEntityLookup, lookupRevision: Int) -> [WorkMessageLink] {
  var links: [WorkMessageLink] = []
  var seen: Set<String> = []
  for text in texts where !text.isEmpty {
    let attributed = workThreadEntityAttributedString(
      text,
      intermediate: false,
      lookup: lookup,
      lookupRevision: lookupRevision,
      revealedTimes: []
    )
    for link in workMessageLinks(in: attributed) where seen.insert(link.id).inserted {
      links.append(link)
      if links.count >= workMessageLinkMenuLimit { return links }
    }
  }
  return links
}

/// Links in the user's own message: its chips, built the way the bubble is.
func workUserMessageLinks(_ text: String, lookup: WorkThreadEntityLookup, attachments: [AgentChatFileRef]?) -> [WorkMessageLink] {
  let attributed = workChipAttributedMessage(
    text,
    chipForeground: ADEColor.textPrimary,
    chipBackground: .clear,
    lookup: lookup,
    attachments: attachments
  )
  return workMessageLinks(in: attributed)
}

extension WorkMarkdownBlockKind {
  /// The inline text a block draws, for its links. Code, rules and proof
  /// blocks carry none.
  var inlineTexts: [String] {
    switch self {
    case .paragraph(let text), .heading(_, let text): return [text]
    case .list(let items): return items.map(\.text)
    case .blockquote(let lines): return lines
    case .table(let headers, let rows): return headers + rows.flatMap { $0 }
    case .code, .rule, .proofCitation, .proofCompare: return []
    }
  }
}

/// Opens one message link the way a tap on it would.
@MainActor
func workOpenMessageLink(_ link: WorkMessageLink, skills: WorkSkillInstructionsModel?) {
  if case .skill(let name) = link.kind {
    skills?.present(name: name)
    return
  }
  // `workOpenChipURL` handles every `ade://` link in-app and hands the rest
  // back to the system; a menu has no `openURL` to hand them to, so open here.
  if link.url.scheme?.lowercased() == "ade" {
    _ = workOpenChipURL(link.url)
  } else {
    UIApplication.shared.open(link.url)
  }
}

/// The links section of a message's long-press menu. A view of its own so the
/// links are found only when the menu is drawn, not on every transcript pass.
struct WorkMessageLinkMenuItems: View {
  enum Source {
    case assistant([String])
    case user(String, attachments: [AgentChatFileRef]?)
  }

  let source: Source
  @Environment(\.workSkillInstructions) private var skills

  var body: some View {
    let directory = WorkThreadEntityDirectory.shared
    let links: [WorkMessageLink] = {
      switch source {
      case .assistant(let texts):
        return workAssistantMarkdownLinks(texts, lookup: directory.lookup, lookupRevision: directory.revision)
      case .user(let text, let attachments):
        return workUserMessageLinks(text, lookup: directory.lookup, attachments: attachments)
      }
    }()
    if !links.isEmpty {
      Section {
        ForEach(links) { link in
          Menu {
            if case .skill = link.kind {
              // No viewer on this surface (a preview), or the chat's machine
              // cannot read skills: Copy only, never a dead "View".
              if skills?.canShow == true {
                Button { workOpenMessageLink(link, skills: skills) } label: {
                  Label(link.openTitle, systemImage: "doc.text")
                }
              }
            } else {
              Button { workOpenMessageLink(link, skills: skills) } label: {
                Label(link.openTitle, systemImage: "arrow.up.right")
              }
            }
            Button {
              UIPasteboard.general.string = link.copyText
            } label: {
              Label(link.copyTitle, systemImage: "doc.on.doc")
            }
          } label: {
            Label(link.title, systemImage: link.systemImage)
          }
        }
      }
    }
  }
}

// MARK: - Skill instructions

struct WorkSkillInstructionsRequest: Identifiable, Equatable {
  /// Fresh per request: asking for the same skill twice re-presents.
  let id = UUID()
  let name: String
}

/// Owner of one chat surface's skill sheet. Chips ask for it through the
/// environment, the way boxes ask for `WorkOutputViewerModel`, so no
/// transcript row carries a presentation of its own.
@MainActor
final class WorkSkillInstructionsModel: ObservableObject {
  @Published var request: WorkSkillInstructionsRequest?
  /// Asks the chat's machine, at the moment a chip or menu needs to know,
  /// whether it can read skills. Set by the surface that owns the sheet.
  var isSupported: @MainActor () -> Bool = { false }

  var canShow: Bool {
    #if DEBUG
    if Self.previewSkill != nil { return true }
    #endif
    return isSupported()
  }

  #if DEBUG
  /// Fixture seam (`chat-links`): every chip's sheet shows this skill.
  static var previewSkill: WorkSkillInstructions?
  #endif

  func present(name: String) {
    guard canShow else { return }
    request = WorkSkillInstructionsRequest(name: name)
  }
}

private struct WorkSkillInstructionsKey: EnvironmentKey {
  static let defaultValue: WorkSkillInstructionsModel? = nil
}

extension EnvironmentValues {
  /// Nil where a message renders with no skill sheet behind it (previews,
  /// other surfaces). A skill chip there is a label.
  var workSkillInstructions: WorkSkillInstructionsModel? {
    get { self[WorkSkillInstructionsKey.self] }
    set { self[WorkSkillInstructionsKey.self] = newValue }
  }
}

/// A skill's SKILL.md, read from the chat's own machine.
struct WorkSkillInstructionsSheet: View {
  let sessionId: String
  let name: String
  let service: SyncService?
  @Environment(\.dismiss) private var dismiss

  enum LoadState: Equatable {
    case loading
    case ready(WorkSkillInstructions)
    case notFound
    case failed(String)
  }

  @State private var state: LoadState = .loading

  #if DEBUG
  /// Fixture seam: renders this instead of asking a host.
  var previewState: LoadState?
  #endif

  private var machineName: String? {
    service?.chatMachineName(sessionId: sessionId)
  }

  var body: some View {
    NavigationStack {
      content
        .adeScreenBackground()
        .navigationTitle("/\(name)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Done") { dismiss() }
          }
          ToolbarItem(placement: .primaryAction) {
            Button {
              UIPasteboard.general.string = "/\(name)"
              ADEHaptics.light()
            } label: {
              Label("Copy /\(name)", systemImage: "doc.on.doc")
            }
          }
        }
    }
    .task(id: name) { await load() }
  }

  @ViewBuilder
  private var content: some View {
    switch state {
    case .loading:
      VStack(spacing: 12) {
        ProgressView()
        Text(machineName.map { "Reading the skill on \($0)…" } ?? "Reading the skill…")
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    case .ready(let skill):
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          header(skill)
          if let body = skill.body, !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            WorkMarkdownRenderer(markdown: body)
              .frame(maxWidth: .infinity, alignment: .leading)
          } else {
            Text("This skill's file has no instructions.")
              .font(.footnote)
              .foregroundStyle(ADEColor.textSecondary)
          }
          if skill.truncated == true {
            Text("Only the start of this file is shown. It's longer than a phone needs to read.")
              .font(.caption)
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 16)
      }
    case .notFound:
      message(
        systemImage: "questionmark.folder",
        text: "\(machineName ?? "This machine") has no instructions file for /\(name). It may be built into the agent rather than a skill folder."
      )
    case .failed(let text):
      message(systemImage: "exclamationmark.triangle", text: text)
    }
  }

  private func header(_ skill: WorkSkillInstructions) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        ADEKitTag(text: workSkillSourceLabel(skill.source), color: ADEColor.accent)
        if let machineName {
          Text(machineName)
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
      }
      if let description = skill.description, !description.isEmpty {
        Text(description)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let path = skill.path, !path.isEmpty {
        Text(verbatim: path)
          .font(.adeMono(10.5))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(2)
          .truncationMode(.middle)
          .textSelection(.enabled)
      }
      Rectangle().fill(ADEFlat.hairline).frame(height: 0.5).padding(.top, 4)
    }
  }

  private func message(systemImage: String, text: String) -> some View {
    VStack(spacing: 12) {
      Image(systemName: systemImage)
        .font(.title3.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      Text(text)
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 28)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private func load() async {
    #if DEBUG
    if let previewState {
      state = previewState
      return
    }
    if let skill = WorkSkillInstructionsModel.previewSkill {
      state = .ready(skill)
      return
    }
    #endif
    guard let service else {
      state = .failed("Not connected to a machine.")
      return
    }
    guard service.supportsSkillInstructions(sessionId: sessionId) else {
      state = .failed("Update ADE on \(machineName ?? "this chat's machine") to read skill instructions from the phone.")
      return
    }
    state = .loading
    do {
      let skill = try await service.fetchSkillInstructions(sessionId: sessionId, name: name)
      guard !Task.isCancelled else { return }
      state = skill.isReady ? .ready(skill) : .notFound
    } catch {
      guard !Task.isCancelled else { return }
      state = .failed(error.localizedDescription)
    }
  }
}

func workSkillSourceLabel(_ source: String?) -> String {
  switch source {
  case "project": return "Project skill"
  case "user": return "Personal skill"
  case "bundled": return "ADE skill"
  default: return "Skill"
  }
}
