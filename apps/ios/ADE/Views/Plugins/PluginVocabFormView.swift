import SwiftUI

/// The `form` component: a small settings-shaped form whose submit sends every
/// field value as the action payload.
///
/// Field values live in this view rather than the store on purpose. They are
/// draft state — typing in a text field must not be a reason to redraw the rest
/// of the panel, and an in-flight panel reload (a `plugin_collections` write on
/// the owning machine, which happens whenever the plugin feels like it) must not
/// wipe what someone is halfway through typing.
struct PluginVocabFormView: View {
  let form: PluginVocabForm
  @ObservedObject var store: PluginPaneStore

  @State private var values: [String: PluginFormValue] = [:]

  private var isBusy: Bool { form.submit.map(store.isInFlight) ?? false }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      ForEach(form.fields) { field in
        PluginVocabFieldView(
          field: field,
          value: binding(for: field),
          isEnabled: store.canInvoke && !isBusy,
          onCommit: form.applyOnChange == nil ? nil : { apply() }
        )
      }

      // A form that applies as it is edited has no button to draw, and drawing
      // one would say the opposite of what it does.
      if let submit = form.submit, let submitLabel = form.submitLabel {
        Button {
          ADEHaptics.light()
          store.perform(submit, extraArgs: payload, label: submitLabel)
        } label: {
          HStack(spacing: 6) {
            if isBusy {
              ProgressView().controlSize(.mini)
            }
            Text(submitLabel)
              .font(.subheadline.weight(.semibold))
          }
          .foregroundStyle(ADEColor.accent)
          .frame(maxWidth: .infinity, minHeight: 44)
          .background(ADEColor.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          .glassEffect(in: .rect(cornerRadius: 12))
        }
        .buttonStyle(ADEScaleButtonStyle())
        .disabled(!store.canInvoke || isBusy)
        .opacity(store.canInvoke ? 1 : 0.5)
      }
    }
    .task(id: form.fields.map(\.id).joined(separator: "|")) {
      seedValues()
    }
  }

  /// Send the whole form without a button press.
  ///
  /// The same full values map a submit sends, so a plugin reads one shape
  /// whichever way the values reached it. The edit is already on screen — the
  /// binding wrote it before this ran — so a plugin that refuses cannot leave
  /// the control showing the old value; the store's own message line carries
  /// the refusal, exactly as it does for a `segmented` `onChange`.
  private func apply() {
    guard let action = form.applyOnChange else { return }
    store.perform(action, extraArgs: payload, label: form.submitLabel ?? "Settings")
  }

  /// Field values merged into the action's declared args. Named by field id, so
  /// the plugin reads back exactly the ids it wrote into the schema.
  private var payload: [String: Any] {
    var payload: [String: Any] = [:]
    for field in form.fields {
      payload[field.id] = (values[field.id] ?? PluginFormValue(field: field)).jsonValue
    }
    return payload
  }

  private func binding(for field: PluginVocabField) -> Binding<PluginFormValue> {
    Binding(
      get: { values[field.id] ?? PluginFormValue(field: field) },
      set: { values[field.id] = $0 }
    )
  }

  /// Seeds only fields that have no value yet, so a schema refresh cannot
  /// overwrite in-progress input with the plugin's defaults.
  private func seedValues() {
    for field in form.fields where values[field.id] == nil {
      values[field.id] = PluginFormValue(field: field)
    }
  }
}

/// One field's current value. A single type rather than three parallel
/// dictionaries so the submit payload cannot disagree with what is on screen.
struct PluginFormValue: Equatable {
  var kind: PluginVocabField.Kind
  var text: String = ""
  var flag: Bool = false
  var number: String = ""

  init(field: PluginVocabField) {
    kind = field.kind
    switch field.kind {
    case .text, .secret, .select:
      text = field.initialText ?? ""
    case .toggle:
      flag = field.initialFlag ?? false
    case .number:
      number = field.initialNumber.map(PluginPanelParser.formatNumber) ?? ""
    }
  }

  /// The value as the plugin receives it. Typed off the field's kind rather
  /// than off which property happens to be populated: an empty text field is a
  /// `""`, not a `false`, and a plugin branching on the type would read the
  /// second as a deliberate answer.
  var jsonValue: Any {
    switch kind {
    case .toggle:
      return flag
    case .number:
      // An unparseable or empty number stays a string so the owning machine can
      // reject it with its own message instead of silently receiving a zero.
      return Double(number) ?? number
    case .text, .secret, .select:
      return text
    }
  }
}

private struct PluginVocabFieldView: View {
  let field: PluginVocabField
  @Binding var value: PluginFormValue
  let isEnabled: Bool
  /// The form applying this field, or nil when it has no `applyOnChange`.
  ///
  /// A toggle and a select commit on the change itself. A text, secret or number
  /// field commits when editing ENDS — otherwise the plugin is invoked once per
  /// keystroke, which for a settings write is once per letter.
  var onCommit: (() -> Void)? = nil

  /// Whether this field's text control holds the keyboard. Losing it is what
  /// "the reader finished with this field" means for a number, whose decimal pad
  /// has no return key to submit from.
  @FocusState private var isFocused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if field.kind != .toggle {
        Text(field.label)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
      }
      control
      if let help = field.help {
        Text(help)
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .disabled(!isEnabled)
    .opacity(isEnabled ? 1 : 0.6)
    .onChange(of: isFocused) { wasFocused, focused in
      if wasFocused, !focused { onCommit?() }
    }
  }

  @ViewBuilder
  private var control: some View {
    switch field.kind {
    case .text:
      LaneTextField(field.placeholder ?? field.label, text: $value.text)
        .focused($isFocused)
        .onSubmit { onCommit?() }

    case .secret:
      // A secret is write-only on this surface: the host redacts stored values
      // and never echoes one back into a schema, so the field always starts
      // empty and what is typed goes straight to the owning machine.
      SecureField(field.placeholder ?? field.label, text: $value.text)
        .textFieldStyle(.plain)
        .textContentType(.password)
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        .padding(12)
        .frame(minHeight: 44)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ADEColor.recessedBackground.opacity(0.78), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .stroke(ADEColor.glassBorder, lineWidth: 0.5)
        )
        .accessibilityLabel(field.label)
        .focused($isFocused)
        .onSubmit { onCommit?() }

    case .number:
      // A decimal pad has no return key, so this field only ever commits on the
      // focus change above.
      LaneTextField(field.placeholder ?? field.label, text: $value.number)
        .keyboardType(.decimalPad)
        .focused($isFocused)

    case .toggle:
      Toggle(isOn: Binding(
        get: { value.flag },
        set: { flag in
          value.flag = flag
          onCommit?()
        }
      )) {
        Text(field.label)
          .font(.subheadline.weight(.medium))
          .foregroundStyle(ADEColor.textPrimary)
      }
      .tint(ADEColor.accent)

    case .select:
      VStack(spacing: 8) {
        ForEach(field.options) { option in
          ADEOptionButton(
            title: option.label ?? option.value,
            isSelected: value.text == option.value
          ) {
            value.text = option.value
            onCommit?()
          }
        }
      }
    }
  }
}
