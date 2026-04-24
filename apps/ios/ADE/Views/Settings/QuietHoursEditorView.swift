import SwiftUI

/// Daily do-not-disturb window editor.
///
/// Only the time-of-day components are meaningful — the caller persists the
/// raw `Date`s but every evaluator across the codebase calls
/// `Calendar.current.dateComponents([.hour, .minute], from:)` and ignores the
/// day portion.
struct QuietHoursEditorView: View {
  @Binding var start: Date?
  @Binding var end: Date?

  private var enabled: Binding<Bool> {
    Binding(
      get: { start != nil && end != nil },
      set: { newValue in
        if newValue {
          if start == nil { start = QuietHoursEditorView.defaultStart }
          if end == nil { end = QuietHoursEditorView.defaultEnd }
        } else {
          start = nil
          end = nil
        }
      }
    )
  }

  var body: some View {
    Form {
      Section {
        Toggle(isOn: enabled) {
          Text("Enable quiet hours")
            .font(.body)
        }
        .tint(ADEColor.purpleAccent)
        .accessibilityHint("Suppress push alerts during a daily window")
      }

      if start != nil || end != nil {
        Section {
          DatePicker(
            "Start",
            selection: Binding(
              get: { start ?? QuietHoursEditorView.defaultStart },
              set: { start = $0 }
            ),
            displayedComponents: .hourAndMinute
          )
          .accessibilityHint("Time each day when quiet hours begin")

          DatePicker(
            "End",
            selection: Binding(
              get: { end ?? QuietHoursEditorView.defaultEnd },
              set: { end = $0 }
            ),
            displayedComponents: .hourAndMinute
          )
          .accessibilityHint("Time each day when quiet hours end")
        }

        Section {
          Button(role: .destructive) {
            start = nil
            end = nil
          } label: {
            HStack {
              Image(systemName: "xmark.circle")
              Text("Clear quiet hours")
            }
          }
          .accessibilityHint("Remove the configured quiet-hours window")
        }
      }
    }
    .navigationTitle("Quiet hours")
    .navigationBarTitleDisplayMode(.inline)
    .safeAreaInset(edge: .bottom) {
      Text("Critical alerts — like CI failing on a PR you own — still break through quiet hours.")
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 24)
        .padding(.bottom, 12)
    }
  }

  private static var defaultStart: Date {
    var components = DateComponents()
    components.hour = 22
    components.minute = 0
    return Calendar.current.date(from: components) ?? Date()
  }

  private static var defaultEnd: Date {
    var components = DateComponents()
    components.hour = 7
    components.minute = 0
    return Calendar.current.date(from: components) ?? Date()
  }
}
