import SwiftUI

// The Overview tab on the flat base: the cleaned description, the open review
// threads as compact rows, then the history — push dividers, one digest row
// per bot, people's comments and the lifecycle events.

struct PrOverviewSections: View {
  let description: String
  let digest: PrConversationDigest
  let threadsById: [String: PrReviewThread]
  let canAct: Bool
  let onReply: (_ threadId: String, _ body: String) -> Void
  let onResolve: (_ threadId: String, _ resolved: Bool) -> Void

  @State private var expandedBots: Set<String> = []
  @State private var expandedEntries: Set<String> = []

  var body: some View {
    Group {
      Section {
        if description.isEmpty {
          Text("No description.")
            .font(.footnote)
            .foregroundStyle(ADEColor.textMuted)
            .adeFlatRow(separator: .hidden)
        } else {
          PrFlatDescription(text: description)
            .adeFlatRow(insets: EdgeInsets(top: 4, leading: 16, bottom: 14, trailing: 16), separator: .hidden)
        }
      }

      if !digest.openThreads.isEmpty {
        Section {
          ForEach(digest.openThreads) { item in
            threadLink(item.entry) {
              PrOpenThreadRow(entry: item.entry, identity: item.identity)
            }
          }
        } header: {
          ADEFlatSectionHeader("Open threads", detail: "\(digest.openThreads.count)")
        }
      }

      if !digest.items.isEmpty {
        Section {
          ForEach(digest.items) { item in
            switch item {
            case .push(let push):
              PrPushDividerRow(push: push)
                .adeFlatRow(insets: EdgeInsets(top: 10, leading: 16, bottom: 4, trailing: 16), separator: .hidden)
            case .bot(let group):
              botRows(group)
            case .entry(let entry, let identity):
              entryRow(entry, identity: identity)
            case .story(let event):
              PrStoryRow(event: event)
                .adeFlatRow(insets: EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16), separator: .hidden)
            }
          }
        } header: {
          ADEFlatSectionHeader("Activity")
        }
      }
    }
  }

  @ViewBuilder
  private func botRows(_ group: PrDigestBotGroup) -> some View {
    let expanded = expandedBots.contains(group.id)
    Button {
      withAnimation(.snappy(duration: 0.2)) {
        if expanded { expandedBots.remove(group.id) } else { expandedBots.insert(group.id) }
      }
    } label: {
      PrBotDigestRow(group: group, expanded: expanded)
    }
    .buttonStyle(.plain)
    .adeFlatRow(insets: EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16), separator: .hidden)
    if expanded {
      ForEach(group.entries) { entry in
        if entry.kind == .thread {
          threadLink(entry) {
            PrDigestEntryLine(entry: entry)
          }
          .listRowInsets(EdgeInsets(top: 5, leading: 46, bottom: 5, trailing: 16))
        } else {
          let open = expandedEntries.contains(entry.id)
          VStack(alignment: .leading, spacing: 6) {
            Button {
              withAnimation(.snappy(duration: 0.2)) {
                if open { expandedEntries.remove(entry.id) } else { expandedEntries.insert(entry.id) }
              }
            } label: {
              PrDigestEntryLine(entry: entry)
            }
            .buttonStyle(.plain)
            if open, let body = entry.body {
              PrMarkdownRenderer(markdown: prCleanBody(body).body)
                .padding(.leading, 20)
            }
          }
          .adeFlatRow(insets: EdgeInsets(top: 5, leading: 46, bottom: 5, trailing: 16), separator: .hidden)
        }
      }
    }
  }

  @ViewBuilder
  private func entryRow(_ entry: PrDigestEntry, identity: PrAuthorIdentity) -> some View {
    if entry.kind == .thread {
      threadLink(entry) {
        PrOpenThreadRow(entry: entry, identity: identity)
      }
    } else {
      PrHumanEntryRow(entry: entry, identity: identity)
        .adeFlatRow(insets: EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16), separator: .hidden)
    }
  }

  @ViewBuilder
  private func threadLink<Label: View>(_ entry: PrDigestEntry, @ViewBuilder label: () -> Label) -> some View {
    let threadId = entry.id.hasPrefix("thread:") ? String(entry.id.dropFirst("thread:".count)) : entry.id
    if let thread = threadsById[threadId] {
      NavigationLink {
        PrThreadPage(thread: thread, canAct: canAct, onReply: { onReply(threadId, $0) }, onResolve: { onResolve(threadId, $0) })
      } label: {
        label()
      }
      .adeFlatRow(insets: EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
    } else {
      label()
        .adeFlatRow(insets: EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
    }
  }
}

// MARK: - Rows

/// An open review thread: who, where, and the first line of what they said.
struct PrOpenThreadRow: View {
  let entry: PrDigestEntry
  let identity: PrAuthorIdentity

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      PrAvatar(login: entry.author, isBot: entry.authorIsBot, avatarUrl: entry.avatarUrl, size: 20)
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(identity.displayName)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          if let location = entry.location {
            Text(verbatim: location)
              .font(.adeMono(11))
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
              .truncationMode(.middle)
          }
          Spacer(minLength: 0)
          if entry.resolved {
            Image(systemName: "checkmark.circle.fill").font(.system(size: 11)).foregroundStyle(ADEColor.success)
          }
        }
        let preview = prDigestPreview(entry.body)
        Text(preview.isEmpty ? "Review comment" : preview)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)
      }
    }
    .accessibilityElement(children: .combine)
  }
}

/// `── ⟲ e348c0e feat(providers)… · 3 commits · 11d ──`
struct PrPushDividerRow: View {
  let push: PrDigestPush

  var body: some View {
    HStack(spacing: 6) {
      Rectangle().fill(ADEFlat.hairline).frame(width: 10, height: 0.5)
      Image(systemName: push.forcePushed ? "arrow.triangle.2.circlepath" : "arrow.up.circle")
        .font(.system(size: 10, weight: .semibold))
      Text(verbatim: push.shortSha)
        .font(.adeMono(10.5))
        .padding(.horizontal, 4)
        .padding(.vertical, 1)
        .background(ADEColor.textPrimary.opacity(0.06), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
      Text(push.subject)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
        .truncationMode(.tail)
      if push.commitCount > 1 {
        Text("· \(push.commitCount) commits").font(.caption).lineLimit(1).fixedSize()
      }
      Text("· \(prCompactRelativeTime(push.at))").font(.adeMono(10.5)).fixedSize()
      Rectangle().fill(ADEFlat.hairline).frame(minWidth: 8, maxWidth: .infinity, maxHeight: 0.5)
        .layoutPriority(-1)
    }
    .foregroundStyle(ADEColor.textMuted)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(push.forcePushed ? "Force push" : "Push") \(push.shortSha), \(push.subject)")
  }
}

/// "Devin · 10 threads · all resolved · 2 comments", amber while a thread is open.
struct PrBotDigestRow: View {
  let group: PrDigestBotGroup
  let expanded: Bool

  private var fromDescription: Bool {
    !group.entries.isEmpty && group.entries.allSatisfy { $0.id.hasPrefix(prDescriptionBotEventPrefix) }
  }

  var body: some View {
    HStack(spacing: 10) {
      PrAvatar(login: group.identity.login, isBot: true, avatarUrl: group.avatarUrl, size: 20)
      VStack(alignment: .leading, spacing: 1) {
        HStack(spacing: 6) {
          Text(group.identity.displayName)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          if fromDescription {
            Text("in the description").font(.caption2).foregroundStyle(ADEColor.textMuted)
          }
        }
        Text(prDescribeBotGroup(group))
          .font(.caption)
          .foregroundStyle(group.openThreadCount > 0 ? ADEColor.warning : ADEColor.textSecondary)
          .lineLimit(1)
      }
      Spacer(minLength: 6)
      Text(prCompactRelativeTime(group.latestAt)).font(.adeMono(10.5)).foregroundStyle(ADEColor.textMuted)
      Image(systemName: "chevron.right")
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
        .rotationEffect(.degrees(expanded ? 90 : 0))
    }
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
    .accessibilityValue(expanded ? "Expanded" : "Collapsed")
  }
}

/// One of a bot's entries: its state, where, and its first line.
struct PrDigestEntryLine: View {
  let entry: PrDigestEntry

  private var glyph: (String, Color) {
    switch entry.kind {
    case .thread:
      if entry.outdated { return ("clock", ADEColor.textMuted) }
      return entry.resolved ? ("checkmark.circle.fill", ADEColor.success) : ("exclamationmark.circle.fill", ADEColor.warning)
    case .review:
      switch entry.reviewState {
      case "approved": return ("checkmark.circle.fill", ADEColor.success)
      case "changes_requested": return ("exclamationmark.circle.fill", ADEColor.danger)
      default: return ("eye", ADEColor.textMuted)
      }
    case .comment:
      return ("text.bubble", ADEColor.textMuted)
    }
  }

  private var text: String {
    let preview = prDigestPreview(entry.body)
    if !preview.isEmpty { return preview }
    switch entry.kind {
    case .review: return entry.reviewState == "approved" ? "Approved" : "Reviewed"
    case .comment: return "Comment"
    case .thread: return "Review comment"
    }
  }

  var body: some View {
    HStack(spacing: 7) {
      Image(systemName: glyph.0).font(.system(size: 11, weight: .semibold)).foregroundStyle(glyph.1).frame(width: 14)
      if let location = entry.location {
        Text(verbatim: location).font(.adeMono(10.5)).foregroundStyle(ADEColor.textMuted).lineLimit(1).fixedSize()
      }
      Text(text).font(.caption).foregroundStyle(ADEColor.textSecondary).lineLimit(1)
      Spacer(minLength: 0)
    }
    .contentShape(Rectangle())
  }
}

/// A person's review or comment, in full.
struct PrHumanEntryRow: View {
  let entry: PrDigestEntry
  let identity: PrAuthorIdentity

  private var verb: String {
    switch entry.kind {
    case .review:
      switch entry.reviewState {
      case "approved": return "approved"
      case "changes_requested": return "requested changes"
      case "dismissed": return "review dismissed"
      default: return "reviewed"
      }
    case .comment: return "commented"
    case .thread: return "commented on a line"
    }
  }

  var body: some View {
    let body = prCleanBody(entry.body).body
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 7) {
        PrAvatar(login: entry.author, isBot: entry.authorIsBot, avatarUrl: entry.avatarUrl, size: 20)
        Text(identity.displayName).font(.footnote.weight(.semibold)).foregroundStyle(ADEColor.textPrimary)
        Text(verb)
          .font(.footnote)
          .foregroundStyle(entry.reviewState == "approved" ? ADEColor.success : entry.reviewState == "changes_requested" ? ADEColor.danger : ADEColor.textSecondary)
        Spacer(minLength: 0)
        Text(prCompactRelativeTime(entry.at)).font(.adeMono(10.5)).foregroundStyle(ADEColor.textMuted)
      }
      if !body.isEmpty {
        PrMarkdownRenderer(markdown: body)
          .padding(.leading, 27)
      }
    }
  }
}

/// A lifecycle event as one quiet line.
struct PrStoryRow: View {
  let event: PrTimelineEvent

  private var symbol: String {
    switch event.kind {
    case .deployment: return "shippingbox"
    case .label: return "tag"
    case .reviewRequest: return "person.crop.circle.badge.questionmark"
    case .stateChange: return event.title.hasPrefix("Merged") ? "arrow.triangle.merge" : "circle.dotted"
    default: return "circle.fill"
    }
  }

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: symbol)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(event.title.hasPrefix("Merged") ? ADEColor.accent : ADEColor.textMuted)
        .frame(width: 20)
      Text(event.title).font(.caption).foregroundStyle(ADEColor.textSecondary).lineLimit(2)
      Spacer(minLength: 6)
      Text(prCompactRelativeTime(event.timestamp)).font(.adeMono(10.5)).foregroundStyle(ADEColor.textMuted)
    }
    .accessibilityElement(children: .combine)
  }
}

// MARK: - Thread page

/// One review thread: every comment, a reply box, and Resolve.
struct PrThreadPage: View {
  let thread: PrReviewThread
  let canAct: Bool
  let onReply: (String) -> Void
  let onResolve: (Bool) -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var draft = ""
  @State private var sentCount = 0
  @FocusState private var composerFocused: Bool

  private var location: String {
    guard let path = thread.path else { return "Conversation" }
    let line = thread.line ?? thread.originalLine
    return line.map { "\(path):\($0)" } ?? path
  }

  var body: some View {
    List {
      Section {
        HStack(spacing: 8) {
          Text(verbatim: location)
            .font(.adeMono(12))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
            .truncationMode(.middle)
          Spacer(minLength: 6)
          if thread.isResolved {
            ADEFlatBadge(text: "resolved", tint: ADEColor.success)
          } else if thread.isOutdated {
            ADEFlatBadge(text: "outdated", tint: ADEColor.textMuted)
          } else {
            ADEFlatBadge(text: "open", tint: ADEColor.warning)
          }
        }
        .adeFlatRow(separator: .hidden)
      }
      Section {
        ForEach(thread.comments) { comment in
          VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
              PrAvatar(login: comment.author, isBot: comment.authorIsBot, avatarUrl: comment.authorAvatarUrl, size: 20)
              Text(PrAuthorIdentity.classify(comment.author, accountIsBot: comment.authorIsBot).displayName)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
              Spacer(minLength: 0)
              Text(prCompactRelativeTime(comment.createdAt)).font(.adeMono(10.5)).foregroundStyle(ADEColor.textMuted)
            }
            let body = prCleanBody(comment.body).body
            if !body.isEmpty {
              PrMarkdownRenderer(markdown: body)
            }
          }
          .adeFlatRow(insets: EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
        }
      }
    }
    .adeFlatList()
    .navigationTitle(thread.path.map(prFileName) ?? "Thread")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button(thread.isResolved ? "Reopen" : "Resolve") {
          ADEHaptics.success()
          onResolve(!thread.isResolved)
          dismiss()
        }
        .disabled(!canAct)
      }
    }
    .safeAreaInset(edge: .bottom) {
      HStack(spacing: 8) {
        TextField(canAct ? "Reply…" : "Connect to reply", text: $draft, axis: .vertical)
          .lineLimit(1...5)
          .font(.subheadline)
          .focused($composerFocused)
          .disabled(!canAct)
        Button {
          let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !text.isEmpty else { return }
          onReply(text)
          draft = ""
          composerFocused = false
          sentCount += 1
        } label: {
          Image(systemName: "arrow.up")
            .font(.system(size: 14, weight: .bold))
            .frame(width: 30, height: 30)
        }
        .buttonStyle(.glassProminent)
        .buttonBorderShape(.circle)
        .tint(ADEColor.accent)
        .disabled(!canAct || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .accessibilityLabel("Send reply")
      }
      .padding(.leading, 16)
      .padding(.trailing, 6)
      .padding(.vertical, 6)
      .glassEffect(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
      .padding(.horizontal, 12)
      .padding(.bottom, 6)
    }
    .sensoryFeedback(.success, trigger: sentCount)
  }
}
