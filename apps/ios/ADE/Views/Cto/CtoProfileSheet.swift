import SwiftUI

// The CTO's profile: its big live avatar, name and status, then Activity
// (what it is doing now, what it has scheduled, its open work, what it
// remembers) and Library (what its chats produced). Desktop `CtoSidePanel`
// and `CtoLibrary`, as an iPhone sheet.

enum CtoProfileTab: String, Hashable { case activity, library }

/// Where a push inside the CTO's sheets goes.
enum CtoSettingsRoute: Hashable {
  case home, look, brain, memory, routines, instructions
}

// MARK: - Small parts

/// A section's title: sentence case, an optional count, an optional link.
struct CtoSectionTitle<Trailing: View>: View {
  let title: String
  var count: Int? = nil
  @ViewBuilder var trailing: () -> Trailing

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      if let count, count > 0 {
        Text("\(count)")
          .font(.footnote.monospacedDigit())
          .foregroundStyle(ADEColor.textMuted)
      }
      Spacer(minLength: 8)
      trailing()
    }
    .padding(.top, 22)
    .padding(.bottom, 6)
    .accessibilityAddTraits(.isHeader)
  }
}

extension CtoSectionTitle where Trailing == EmptyView {
  init(title: String, count: Int? = nil) {
    self.init(title: title, count: count, trailing: { EmptyView() })
  }
}

/// A quiet one-line empty state, with an optional hint under it.
struct CtoEmptyLine: View {
  let symbol: String
  let text: String
  var hint: String? = nil

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: symbol)
        .font(.system(size: 14, weight: .regular))
        .foregroundStyle(ADEColor.textMuted)
        .frame(width: 28)
      VStack(alignment: .leading, spacing: 1) {
        Text(text)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
        if let hint {
          Text(hint)
            .font(.footnote)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 0)
    }
    .frame(minHeight: 44)
  }
}

/// A hairline between rows, inset past the glyph column.
struct CtoRowDivider: View {
  var inset: CGFloat = 38
  var body: some View {
    Rectangle().fill(ADEFlat.hairline).frame(height: 0.5).padding(.leading, inset)
  }
}

// MARK: - Routines

struct CtoRoutineRow: View {
  let item: AgentChatScheduledWorkItem
  @ObservedObject var store: CtoStore
  var accent: Color
  /// Settings rows open in place to show the prompt, the check and the last run.
  var detailed = false

  @State private var confirmingCancel = false
  @State private var open = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var pending: Bool { ctoRoutineIsPending(item) }
  private var title: String { ctoRoutineTitle(item) }
  private var canRunNow: Bool { item.source == nil && item.cancellable && store.canRunRoutines }
  private var canCancel: Bool { item.cancellable && store.canCancelRoutines }
  private var check: String? {
    let value = item.check?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return value.isEmpty ? nil : value
  }
  // A one-shot that never reported done stays "fired"; only a cron's fired is a run in progress.
  private var running: Bool { store.runningIds.contains(item.id) || (item.status == "fired" && item.kind == "cron") }
  private var failing: Bool { check != nil && item.checkFailing == true }
  private var off: Bool { !pending || ctoRoutineRowPaused(item) }

  private var tint: Color {
    if running { return accent }
    if failing { return ADEColor.danger }
    return off ? ADEColor.textMuted : accent
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .center, spacing: 12) {
        tile
        Button {
          guard detailed else { return }
          withAnimation(reduceMotion ? nil : .snappy(duration: 0.28)) { open.toggle() }
        } label: {
          summary.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .allowsHitTesting(detailed)
        .accessibilityHint(detailed ? (open ? "Hides details" : "Shows details") : "")
        if pending, store.canPauseRoutines {
          Toggle("", isOn: Binding(
            get: { !ctoRoutineRowPaused(item) },
            set: { on in Task { await store.setPaused(item, paused: !on) } }
          ))
          .labelsHidden()
          .tint(accent)
          .disabled(store.busyIds.contains(item.id))
          .accessibilityLabel(ctoRoutineRowPaused(item) ? "Turn on \(title)" : "Turn off \(title)")
        }
      }
      if detailed && open {
        details
          .padding(.leading, 42)
          .padding(.top, 10)
          .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
    .padding(.vertical, 10)
    .frame(minHeight: 56)
    .opacity(pending ? 1 : 0.6)
    .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: running)
    .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: failing)
    .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: off)
    .contentShape(Rectangle())
    .contextMenu {
      if pending, canRunNow {
        Button { Task { await store.runNow(item) } } label: { Label("Run now", systemImage: "bolt") }
      }
      if pending, canCancel {
        Button(role: .destructive) { confirmingCancel = true } label: { Label("Cancel routine", systemImage: "trash") }
      }
    }
    .confirmationDialog("Cancel “\(title)”?", isPresented: $confirmingCancel, titleVisibility: .visible) {
      Button("Cancel routine", role: .destructive) { Task { await store.cancel(item) } }
      Button("Keep it", role: .cancel) {}
    } message: {
      Text("It won't run again.")
    }
    .accessibilityIdentifier("Cto.Routine.\(item.id)")
  }

  private var tile: some View {
    RoundedRectangle(cornerRadius: 9, style: .continuous)
      .fill(tint.opacity(off && !running && !failing ? 0.08 : 0.14))
      .frame(width: 30, height: 30)
      .overlay {
        Image(systemName: check != nil ? "binoculars" : item.kind == "wakeup" ? "alarm" : "arrow.triangle.2.circlepath")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(tint)
          .symbolEffect(.pulse, isActive: running && !reduceMotion)
      }
      .overlay(alignment: .topTrailing) {
        if running || failing {
          Circle()
            .fill(running ? accent : ADEColor.danger)
            .frame(width: 7, height: 7)
            .overlay(Circle().stroke(ADEColor.pageBackground, lineWidth: 1.5))
            .offset(x: 2, y: -2)
            .transition(.scale.combined(with: .opacity))
        }
      }
      .accessibilityHidden(true)
  }

  private var summary: some View {
    TimelineView(.everyMinute) { context in
      VStack(alignment: .leading, spacing: 2) {
        // An open row shows its title and note in full.
        Text(title)
          .font(.body.weight(.medium))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(open ? nil : 1)
        Text(ctoRoutineScheduleLine(item, now: context.date, compact: !detailed))
          .font(.footnote)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
        // The panel keeps rows to two lines; only a run in progress earns a third.
        if let note = ctoRoutineNote(item, now: context.date, running: running), detailed || running {
          Text(note.text)
            .font(.footnote)
            .foregroundStyle(noteColor(note.tone))
            .lineLimit(open ? nil : 1)
            .id(note.text)
            .transition(.opacity)
        }
      }
    }
  }

  private var details: some View {
    TimelineView(.everyMinute) { context in
      VStack(alignment: .leading, spacing: 10) {
        let prompt = item.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        // A title made from a long prompt clips, so the details show the prompt in full.
        if !prompt.isEmpty, prompt != title || prompt.count > 32 {
          Text(prompt)
            .font(.footnote)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        if let check {
          VStack(alignment: .leading, spacing: 4) {
            Text("WAKES WHEN THIS CHANGES")
              .font(.caption2.weight(.semibold))
              .tracking(1.2)
              .foregroundStyle(ADEColor.textMuted)
            Text(check)
              .font(.caption.monospaced())
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(3)
              .textSelection(.enabled)
            if item.checkFailing == true {
              Text("Failing. It wakes again when it passes with new output.")
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
            } else if let status = ctoDescribeRoutineCheck(item, now: context.date) {
              Text(status.prefix(1).uppercased() + status.dropFirst())
                .font(.caption)
                .foregroundStyle(item.checkFailing == true ? ADEColor.danger : ADEColor.textMuted)
            }
          }
          .padding(10)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(ADEColor.textPrimary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
          .accessibilityElement(children: .combine)
        }
        if let lastRan = ctoRoutineLastRan(item, now: context.date) {
          Text(lastRan)
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
        }
      }
    }
  }

  private func noteColor(_ tone: CtoRoutineNoteTone) -> Color {
    switch tone {
    case .accent: return accent
    case .danger: return ADEColor.danger
    case .plain: return ADEColor.textSecondary
    }
  }
}

struct CtoRoutineList: View {
  @ObservedObject var store: CtoStore
  var accent: Color
  var detailed = false
  var name: String

  var body: some View {
    let upcoming = store.upcomingRoutines
    let finished = detailed ? Array(store.finishedRoutines.prefix(8)) : []
    VStack(alignment: .leading, spacing: 0) {
      if !store.routinesLoaded {
        CtoEmptyLine(symbol: "calendar", text: "Loading…")
      } else if upcoming.isEmpty && finished.isEmpty {
        CtoEmptyLine(symbol: "calendar", text: "Nothing scheduled", hint: "Ask \(name) to check in later")
      } else {
        ForEach(Array(upcoming.enumerated()), id: \.element.id) { index, item in
          if index > 0 { CtoRowDivider(inset: 42) }
          CtoRoutineRow(item: item, store: store, accent: accent, detailed: detailed)
        }
        if !finished.isEmpty {
          Text("RECENTLY RAN")
            .font(.caption2.weight(.semibold))
            .tracking(1.2)
            .foregroundStyle(ADEColor.textMuted)
            .padding(.top, 16)
            .padding(.bottom, 2)
          ForEach(Array(finished.enumerated()), id: \.element.id) { index, item in
            if index > 0 { CtoRowDivider(inset: 42) }
            CtoRoutineRow(item: item, store: store, accent: accent, detailed: detailed)
          }
        }
      }
    }
    // A check can change a row with no CTO turn (a quiet recovery clears
    // "failing"), so an open list reloads once just after the next check is due.
    .task(id: store.nextCheckReloadAt) {
      await store.reloadRoutinesAtNextCheck(includeTerminal: detailed)
    }
  }
}

// MARK: - Open work

/// The CTO's open work as a checklist: tick to complete, untick to reopen,
/// × to remove, "Add" for a new item.
struct CtoOpenWorkList: View {
  @ObservedObject var store: CtoStore
  var accent: Color
  var compact = false

  @State private var adding = false
  @State private var draft = ""
  @FocusState private var fieldFocused: Bool

  var body: some View {
    let items = store.memory?.openWork ?? []
    let open = items.filter { !$0.isDone }
    let doneAll = items.filter(\.isDone)
    let done = compact ? Array(doneAll.prefix(3)) : doneAll
    let editable = store.canEditOpenWork
    VStack(alignment: .leading, spacing: 0) {
      if open.isEmpty && done.isEmpty && !adding {
        CtoEmptyLine(symbol: "checklist", text: "No open work")
      }
      ForEach(Array((open + done).enumerated()), id: \.element.id) { index, item in
        if index > 0 { CtoRowDivider() }
        row(item, editable: editable)
      }
      if editable {
        if !(open.isEmpty && done.isEmpty) || adding { CtoRowDivider() }
        if adding {
          HStack(spacing: 10) {
            Image(systemName: "circle")
              .font(.system(size: 17))
              .foregroundStyle(ADEColor.textMuted.opacity(0.6))
              .frame(width: 28)
            TextField("Add open work", text: $draft)
              .font(.body)
              .focused($fieldFocused)
              .submitLabel(.done)
              .onSubmit { submit() }
          }
          .frame(minHeight: 44)
        } else {
          Button {
            adding = true
            fieldFocused = true
          } label: {
            HStack(spacing: 10) {
              Image(systemName: "plus")
                .font(.system(size: 14, weight: .semibold))
                .frame(width: 28)
              Text("Add")
                .font(.body)
              Spacer(minLength: 0)
            }
            .foregroundStyle(accent)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .disabled(open.count >= 20)
          .accessibilityLabel("Add open work")
        }
      }
    }
    .onChange(of: fieldFocused) { _, focused in
      if !focused && draft.trimmingCharacters(in: .whitespaces).isEmpty { adding = false }
    }
  }

  private func submit() {
    let text = draft
    Task {
      if await store.addOpenWork(text) {
        draft = ""
        fieldFocused = true
      }
    }
  }

  private func row(_ item: CtoOpenWorkItem, editable: Bool) -> some View {
    HStack(spacing: 10) {
      Button {
        Task { await store.toggleOpenWork(item) }
      } label: {
        Image(systemName: item.isDone ? "checkmark.circle.fill" : "circle")
          .font(.system(size: 19))
          .foregroundStyle(item.isDone ? accent : ADEColor.textMuted)
          .frame(width: 28, height: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(!editable || store.busyIds.contains(item.id))
      .accessibilityLabel(item.isDone ? "Reopen \(item.text)" : "Complete \(item.text)")
      Text(item.text)
        .font(.body)
        .foregroundStyle(item.isDone ? ADEColor.textMuted : ADEColor.textPrimary)
        .strikethrough(item.isDone, color: ADEColor.textMuted)
        .lineLimit(2)
      Spacer(minLength: 8)
      if editable {
        Button {
          Task { await store.removeOpenWork(item) }
        } label: {
          Image(systemName: "xmark")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted.opacity(0.8))
            .frame(width: 32, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Remove \(item.text)")
      }
    }
    .frame(minHeight: 44)
  }
}

// MARK: - Profile

struct CtoProfileView: View {
  @ObservedObject var live: CtoLiveModel
  @ObservedObject var store: CtoStore
  @State var tab: CtoProfileTab = .activity
  @State private var libraryFilter: CtoLibraryItem.Kind? = nil

  private var accent: Color { live.look.ctoAccent }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        header
        if let error = store.errorText {
          Text(error)
            .font(.footnote)
            .foregroundStyle(ADEColor.warning)
            .lineLimit(1)
            .frame(maxWidth: .infinity)
            .padding(.top, 10)
            .task(id: error) {
              try? await Task.sleep(nanoseconds: 3_000_000_000)
              if store.errorText == error { store.errorText = nil }
            }
        }
        if tab == .activity {
          activity
        } else {
          libraryContent
        }
        Color.clear.frame(height: 32)
      }
      .padding(.horizontal, 20)
    }
    .scrollIndicators(.hidden)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .tint(accent)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        NavigationLink(value: CtoSettingsRoute.home) {
          Image(systemName: "gearshape")
        }
        .accessibilityLabel("\(live.name) settings")
        .accessibilityIdentifier("Cto.Profile.Settings")
      }
    }
    .navigationBarTitleDisplayMode(.inline)
  }

  private var header: some View {
    VStack(spacing: 4) {
      ZStack {
        CtoAvatarHalo(color: accent, diameter: 230)
        CtoAvatarView(
          look: live.look,
          state: live.avatarState,
          size: 116,
          motion: .live,
          label: "\(live.name), \(live.statusPhrase.lowercased())"
        )
      }
      .frame(height: 150)
      Text(live.name)
        .font(.system(.title2, design: .rounded).weight(.bold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      Text(live.statusPhrase)
        .font(.system(.subheadline, design: .rounded).weight(.medium))
        .foregroundStyle(live.avatarState == .waiting ? accent : ADEColor.textSecondary)
        .lineLimit(1)
        .contentTransition(.opacity)
      Picker("Show", selection: $tab) {
        Text("Activity").tag(CtoProfileTab.activity)
        Text("Library").tag(CtoProfileTab.library)
      }
      .pickerStyle(.segmented)
      .frame(maxWidth: 260)
      .padding(.top, 14)
      .accessibilityIdentifier("Cto.Profile.Tabs")
    }
    .frame(maxWidth: .infinity)
  }

  // MARK: Activity

  @ViewBuilder
  private var activity: some View {
    let openChildren = store.children.filter(\.isOpen)
    CtoSectionTitle(title: "Now")
    VStack(alignment: .leading, spacing: 0) {
      if live.turnActive {
        HStack(spacing: 10) {
          CtoAvatarView(look: live.look, state: live.streamingText ? .thinking : .working, size: 28, motion: .lazy, blips: false)
          Text(live.liveStep ?? (live.streamingText ? "Writing" : "Working"))
            .font(.body)
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          Spacer(minLength: 0)
        }
        .frame(minHeight: 44)
      }
      ForEach(Array(openChildren.prefix(6).enumerated()), id: \.element.id) { index, child in
        if index > 0 || live.turnActive { CtoRowDivider() }
        childRow(child)
      }
      if openChildren.count > 6 {
        Text("+\(openChildren.count - 6) more")
          .font(.footnote)
          .foregroundStyle(ADEColor.textMuted)
          .padding(.leading, 38)
          .frame(minHeight: 32)
      }
      if !live.turnActive && openChildren.isEmpty {
        CtoEmptyLine(symbol: "cup.and.saucer", text: "Nothing running")
      }
    }

    CtoSectionTitle(title: "Upcoming", count: store.upcomingRoutines.count)
    CtoRoutineList(store: store, accent: accent, name: live.name)

    CtoSectionTitle(title: "Open work", count: (store.memory?.openWork ?? []).filter { !$0.isDone }.count)
    CtoOpenWorkList(store: store, accent: accent, compact: true)

    let notes = store.memory?.noteLines ?? []
    CtoSectionTitle(title: "Remembers", count: notes.count) {
      NavigationLink(value: CtoSettingsRoute.memory) {
        HStack(spacing: 3) {
          Text("See all")
          Image(systemName: "chevron.right").font(.system(size: 10, weight: .bold))
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(accent)
      }
      .accessibilityIdentifier("Cto.Profile.SeeAllNotes")
    }
    VStack(alignment: .leading, spacing: 0) {
      if notes.isEmpty {
        CtoEmptyLine(
          symbol: "bookmark",
          text: store.memoryLoaded ? "No notes yet" : "Loading…",
          hint: store.memoryLoaded ? "Tell \(live.name) something worth keeping" : nil
        )
      } else {
        ForEach(Array(notes.prefix(3).enumerated()), id: \.offset) { index, note in
          if index > 0 { CtoRowDivider() }
          HStack(spacing: 10) {
            Image(systemName: "bookmark")
              .font(.system(size: 13))
              .foregroundStyle(ADEColor.textMuted)
              .frame(width: 28)
            Text(note)
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(1)
            Spacer(minLength: 0)
          }
          .frame(minHeight: 40)
        }
      }
    }
  }

  private func childRow(_ child: CtoChildRow) -> some View {
    Button {
      store.openChat(child.id, laneId: child.laneId)
    } label: {
      HStack(spacing: 10) {
        WorkProviderLogo(provider: ctoProviderKey(child.provider), size: 28)
        VStack(alignment: .leading, spacing: 1) {
          Text(child.title)
            .font(.body)
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          if let lane = child.laneName {
            Text(lane)
              .font(.footnote)
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          }
        }
        Spacer(minLength: 8)
        Text(child.statusWord)
          .font(.footnote.weight(.medium))
          .foregroundStyle(child.status == .needsYou ? ADEColor.warning : child.status == .working ? accent : ADEColor.textMuted)
          .lineLimit(1)
          .fixedSize()
      }
      .frame(minHeight: 48)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(child.title), \(child.statusWord)")
  }

  // MARK: Library

  @ViewBuilder
  private var libraryContent: some View {
    let items = store.library
    let shown = libraryFilter.map { kind in items.filter { $0.kind == kind } } ?? items
    HStack(spacing: 8) {
      filterChip("All", kind: nil, count: items.count)
      filterChip("PRs", kind: .prs, count: items.filter { $0.kind == .prs }.count)
      filterChip("Lanes", kind: .lanes, count: items.filter { $0.kind == .lanes }.count)
      Spacer(minLength: 0)
    }
    .padding(.top, 20)
    .padding(.bottom, 6)
    VStack(alignment: .leading, spacing: 0) {
      if !store.libraryLoaded {
        CtoEmptyLine(symbol: "tray", text: "Loading…")
      } else if shown.isEmpty {
        CtoEmptyLine(
          symbol: "tray",
          text: libraryFilter == .prs ? "No PRs yet" : libraryFilter == .lanes ? "No lanes yet" : "Nothing yet",
          hint: "PRs and lanes from its chats"
        )
      } else {
        ForEach(Array(shown.enumerated()), id: \.element.id) { index, item in
          if index > 0 { CtoRowDivider() }
          libraryRow(item)
        }
      }
    }
  }

  private func filterChip(_ title: String, kind: CtoLibraryItem.Kind?, count: Int) -> some View {
    let selected = libraryFilter == kind
    return Button {
      libraryFilter = kind
    } label: {
      HStack(spacing: 4) {
        Text(title)
        if count > 0 {
          Text("\(count)").monospacedDigit().foregroundStyle(selected ? ADEColor.textPrimary.opacity(0.7) : ADEColor.textMuted)
        }
      }
      .font(.footnote.weight(.medium))
      .foregroundStyle(selected ? ADEColor.textPrimary : ADEColor.textSecondary)
      .padding(.horizontal, 12)
      .frame(height: 30)
      .background(selected ? accent.opacity(0.18) : ADEKit.track, in: Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  private func libraryRow(_ item: CtoLibraryItem) -> some View {
    Button {
      switch item.kind {
      case .prs: store.openPullRequest(item)
      case .lanes: if let sessionId = item.sessionId { store.openChat(sessionId, laneId: item.laneId) }
      }
    } label: {
      HStack(spacing: 10) {
        Image(systemName: item.kind == .prs ? "arrow.triangle.pull" : "arrow.triangle.branch")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(item.prState.map { lanePullRequestTint($0) } ?? ADEColor.textMuted)
          .frame(width: 28)
        VStack(alignment: .leading, spacing: 1) {
          Text(item.title)
            .font(.body)
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          Text(item.prState.map { "\(lanePrStateLabel($0)) · \(item.detail)" } ?? item.detail)
            .font(.footnote)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
        Spacer(minLength: 8)
        Text(ctoRelativeDay(item.at))
          .font(.footnote.monospacedDigit())
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
          .fixedSize()
      }
      .frame(minHeight: 52)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

/// `claude-chat` → `claude`: the provider a tool type names.
func ctoProviderKey(_ toolType: String?) -> String? {
  guard let toolType = toolType?.lowercased(), !toolType.isEmpty else { return nil }
  for suffix in ["-chat", "-orchestrated", "-cli"] where toolType.hasSuffix(suffix) {
    return String(toolType.dropLast(suffix.count))
  }
  return toolType
}

/// The profile sheet: its own stack, so settings push inside it.
struct CtoProfileSheet: View {
  @ObservedObject var live: CtoLiveModel
  @ObservedObject var store: CtoStore
  var initialTab: CtoProfileTab = .activity
  var initialRoute: CtoSettingsRoute? = nil

  @State private var path: [CtoSettingsRoute] = []

  var body: some View {
    NavigationStack(path: $path) {
      CtoProfileView(live: live, store: store, tab: initialTab)
        .navigationDestination(for: CtoSettingsRoute.self) { route in
          CtoSettingsDestination(route: route, store: store, live: live)
        }
    }
    .tint(live.look.ctoAccent)
    .onAppear {
      if let initialRoute, path.isEmpty { path = [initialRoute] }
    }
    .task {
      guard !store.isFixture else { return }
      await store.loadAll()
    }
  }
}
