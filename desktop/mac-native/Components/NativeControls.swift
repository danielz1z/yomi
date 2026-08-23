import Cocoa
import SwiftUI

// MARK: - Native Focusable AppKit Text Field Wrapper

struct FocusableTextField: NSViewRepresentable {
    var placeholder: String
    @Binding var text: String
    var onSubmit: () -> Void
    var onHistoryPrevious: () -> String? = { nil }
    var onHistoryNext: () -> String? = { nil }

    func makeNSView(context: Context) -> NSTextField {
        let textField = NSTextField()
        textField.placeholderString = placeholder
        textField.isBordered = false
        textField.drawsBackground = false
        textField.focusRingType = .none
        textField.font = NSFont.systemFont(ofSize: 13.5)
        textField.textColor = .labelColor
        textField.delegate = context.coordinator

        DispatchQueue.main.async {
            textField.window?.makeFirstResponder(textField)
        }
        return textField
    }

    func updateNSView(_ nsView: NSTextField, context: Context) {
        context.coordinator.parent = self
        if nsView.stringValue != text {
            nsView.stringValue = text
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    @MainActor
    final class Coordinator: NSObject, NSTextFieldDelegate {
        var parent: FocusableTextField

        init(_ parent: FocusableTextField) {
            self.parent = parent
        }

        func controlTextDidChange(_ obj: Notification) {
            if let tf = obj.object as? NSTextField {
                parent.text = tf.stringValue
            }
        }

        func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            if commandSelector == #selector(NSResponder.insertNewline(_:)) {
                parent.onSubmit()
                return true
            }
            if commandSelector == #selector(NSResponder.moveUp(_:)) {
                recall(parent.onHistoryPrevious(), in: textView)
                return true
            }
            if commandSelector == #selector(NSResponder.moveDown(_:)) {
                recall(parent.onHistoryNext(), in: textView)
                return true
            }
            return false
        }

        private func recall(_ value: String?, in textView: NSTextView) {
            guard let value else { return }
            parent.text = value
            textView.string = value
            textView.setSelectedRange(NSRange(location: (value as NSString).length, length: 0))
        }
    }
}

struct LocalAiEngineSelectorView: View {
    @ObservedObject var state: AppState
    var showsHeader: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if showsHeader {
                HStack {
                    Image(systemName: "cpu.fill")
                        .foregroundColor(EnterpriseTheme.accent)
                    Text(state.i18n.t("ai_engine_section"))
                        .font(.system(size: 13, weight: .bold))
                        .foregroundColor(.primary)
                    Spacer()
                    Text("Zero-Config Dynamic CLI")
                        .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                        .foregroundColor(.green)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.green.opacity(0.12))
                        .clipShape(Capsule())
                }
            }

            Text(state.i18n.t("ai_engine_desc"))
                .font(.system(size: 11.5))
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(spacing: 6) {
                ForEach(AiProviderType.allCases) { provider in
                    let isSelected = state.aiConfig.selectedProvider == provider
                    let health =
                        state.agentHealthMap[provider]
                        ?? (provider == .autoDetect || provider == .yomiZeroConfig
                            ? .ready : (isBinaryAvailable(provider: provider) ? .ready : .notInstalled))

                    Button(action: {
                        var cfg = state.aiConfig
                        cfg.selectedProvider = provider
                        state.updateAiConfig(cfg)
                    }) {
                        HStack(spacing: 10) {
                            Image(systemName: provider.iconName)
                                .font(.system(size: 14))
                                .foregroundColor(isSelected ? EnterpriseTheme.accent : .secondary)
                                .frame(width: 22)

                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(provider.displayName)
                                        .font(.system(size: 12.5, weight: isSelected ? .bold : .medium))
                                        .foregroundColor(isSelected ? EnterpriseTheme.selectedText : .secondary)

                                    if provider == .autoDetect {
                                        Text("智能自適應")
                                            .font(.system(size: 9.5, weight: .bold))
                                            .foregroundColor(.white)
                                            .padding(.horizontal, 5)
                                            .padding(.vertical, 1)
                                            .background(EnterpriseTheme.accent)
                                            .clipShape(Capsule())
                                    }
                                }

                                Text(provider.subtitle)
                                    .font(.system(size: 10.5))
                                    .foregroundColor(.secondary.opacity(0.8))
                                    .lineLimit(1)
                            }

                            Spacer()

                            Text(health.displayText)
                                .font(.system(size: 10.5, weight: .medium))
                                .foregroundColor(health.color)

                            Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                                .font(.system(size: 14))
                                .foregroundColor(isSelected ? EnterpriseTheme.accent : .secondary.opacity(0.4))
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(isSelected ? EnterpriseTheme.accent.opacity(0.12) : EnterpriseTheme.raisedSurface.opacity(0.35))
                        .cornerRadius(8)
                        .overlay(
                            RoundedRectangle(cornerRadius: 8)
                                .stroke(isSelected ? EnterpriseTheme.accent.opacity(0.35) : Color.clear, lineWidth: 1)
                        )
                        .contentShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(PlainButtonStyle())
                }
            }
        }
        .padding(14)
        .background(Color.white.opacity(0.04))
        .cornerRadius(10)
    }

    private func isBinaryAvailable(provider: AiProviderType) -> Bool {
        guard let bin = provider.cliBinaryName else { return true }
        return state.findCliBinary(named: bin) != nil
    }
}

struct PromptChip: View {
    let title: String
    let action: () -> Void
    @State private var isHovered: Bool = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 11.5, weight: .medium))
                .foregroundColor(isHovered ? .primary : .primary.opacity(0.85))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(isHovered ? Color.white.opacity(0.12) : Color.white.opacity(0.06))
                .clipShape(Capsule())
                .overlay(
                    Capsule()
                        .stroke(isHovered ? EnterpriseTheme.accent.opacity(0.4) : EnterpriseTheme.hairline, lineWidth: 1)
                )
                .contentShape(Capsule())
        }
        .buttonStyle(PlainButtonStyle())
        .onHover { hovering in
            isHovered = hovering
        }
    }
}
