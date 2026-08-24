import Cocoa
import SwiftUI

enum ComposerHistoryStore {
    private static let limit = 50

    static func load(chatId: String, yomi: Bool) -> [String] {
        UserDefaults.standard.stringArray(forKey: key(chatId: chatId, yomi: yomi)) ?? []
    }

    static func append(_ value: String, chatId: String, yomi: Bool) {
        guard !value.isEmpty else { return }
        var values = load(chatId: chatId, yomi: yomi)
        if values.last != value { values.append(value) }
        UserDefaults.standard.set(Array(values.suffix(limit)), forKey: key(chatId: chatId, yomi: yomi))
    }

    private static func key(chatId: String, yomi: Bool) -> String {
        "composer.history.\(yomi ? "yomi" : "line").\(chatId)"
    }
}

struct ComposerActionButton: View {
    let title: String
    let icon: String
    var tint: Color = .secondary
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.system(size: 13, weight: .medium))
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, 9)
                .padding(.vertical, 7)
                .background(EnterpriseTheme.controlFill)
                .foregroundColor(tint)
                .cornerRadius(6)
        }
        .buttonStyle(PlainButtonStyle())
        .help(title)
        .accessibilityLabel(title)
    }
}

/// AppKit-backed multiline editor. SwiftUI's TextEditor modifier does not
/// consistently hide the enclosing NSScrollView's indicators on macOS.
struct HiddenScrollTextEditor: NSViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    var onSubmit: () -> Void
    var onHistoryPrevious: () -> String?
    var onHistoryNext: () -> String?

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        // Keep the editor scrollable for long replies, but never paint a
        // scrollbar in the composer.  `autohidesScrollers` alone still lets
        // AppKit create an overlay thumb on some macOS versions.
        scrollView.scrollerStyle = .overlay
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.verticalScroller = nil
        scrollView.horizontalScroller = nil
        scrollView.autohidesScrollers = false
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalRuler = false
        let textView = ComposerTextView()
        textView.onCommandReturn = context.coordinator.submit
        textView.onHistoryPrevious = context.coordinator.historyPrevious
        textView.onHistoryNext = context.coordinator.historyNext
        context.coordinator.textView = textView
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.isEditable = true
        textView.isSelectable = true
        textView.drawsBackground = false
        textView.font = NSFont.systemFont(ofSize: 15)
        textView.textColor = .labelColor
        textView.insertionPointColor = .controlAccentColor
        textView.allowsUndo = true
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainerInset = NSSize(width: 11, height: 7)
        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        textView.setAccessibilityLabel("回覆訊息")
        scrollView.documentView = textView
        scrollView.verticalScroller = nil
        scrollView.horizontalScroller = nil
        context.coordinator.installActivationObservers()
        context.coordinator.updateInsets(for: textView, in: scrollView)
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        if textView.string != text { textView.string = text }
        if let composer = textView as? ComposerTextView {
            composer.onCommandReturn = context.coordinator.submit
            composer.onHistoryPrevious = context.coordinator.historyPrevious
            composer.onHistoryNext = context.coordinator.historyNext
        }
        context.coordinator.parent = self
        context.coordinator.updateInsets(for: textView, in: scrollView)
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.verticalScroller = nil
        scrollView.horizontalScroller = nil
        scrollView.autohidesScrollers = false
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: HiddenScrollTextEditor
        weak var textView: NSTextView?
        private var observers: [NSObjectProtocol] = []
        private var wasFocusedBeforeDeactivation = false
        init(_ parent: HiddenScrollTextEditor) { self.parent = parent }

        func updateInsets(for textView: NSTextView, in scrollView: NSScrollView) {
            let lineHeight = textView.layoutManager?.defaultLineHeight(for: textView.font ?? NSFont.systemFont(ofSize: 15)) ?? 18
            let hasMultipleLines = textView.string.contains("\n")
            let availableHeight = max(44, scrollView.bounds.height)
            let verticalInset: CGFloat
            if hasMultipleLines {
                verticalInset = 8
            } else {
                // Focus must never alter the perceived field height.
                verticalInset = max(7, (availableHeight - lineHeight) / 2)
            }
            let inset = NSSize(width: 11, height: verticalInset)
            if textView.textContainerInset != inset {
                textView.textContainerInset = inset
            }
        }

        func installActivationObservers() {
            guard observers.isEmpty else { return }
            let center = NotificationCenter.default
            observers.append(
                center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
                    Task { @MainActor [weak self] in
                        guard let self, let textView = self.textView else { return }
                        self.wasFocusedBeforeDeactivation = textView.window?.firstResponder === textView
                        if self.wasFocusedBeforeDeactivation { self.parent.isFocused = true }
                    }
                })
            observers.append(
                center.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                    Task { @MainActor [weak self] in
                        guard let self, self.wasFocusedBeforeDeactivation, let textView = self.textView else { return }
                        guard let window = textView.window else { return }
                        window.makeFirstResponder(textView)
                        self.parent.isFocused = true
                        self.wasFocusedBeforeDeactivation = false
                        if let scrollView = textView.enclosingScrollView {
                            self.updateInsets(for: textView, in: scrollView)
                        }
                    }
                })
        }

        func textDidBeginEditing(_ notification: Notification) {
            parent.isFocused = true
            if let textView { updateInsets(for: textView, in: textView.enclosingScrollView ?? NSScrollView()) }
        }

        func textDidEndEditing(_ notification: Notification) {
            parent.isFocused = false
            if let textView { updateInsets(for: textView, in: textView.enclosingScrollView ?? NSScrollView()) }
        }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            parent.text = view.string
            if let scrollView = view.enclosingScrollView { updateInsets(for: view, in: scrollView) }
        }

        func submit() {
            parent.onSubmit()
        }

        func historyPrevious() -> String? { parent.onHistoryPrevious() }
        func historyNext() -> String? { parent.onHistoryNext() }

        deinit {
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
        }
    }
}

final class ComposerTextView: NSTextView {
    var onCommandReturn: (() -> Void)?
    var onHistoryPrevious: (() -> String?)?
    var onHistoryNext: (() -> String?)?

    override func keyDown(with event: NSEvent) {
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if event.keyCode == 36, modifiers.contains(.command) {
            onCommandReturn?()
            return
        }
        let cursor = selectedRange().location
        if event.keyCode == 126, cursor == 0, let value = onHistoryPrevious?() {
            replace(with: value)
            return
        }
        if event.keyCode == 125, cursor == (string as NSString).length, let value = onHistoryNext?() {
            replace(with: value)
            return
        }
        super.keyDown(with: event)
    }

    private func replace(with value: String) {
        string = value
        setSelectedRange(NSRange(location: (value as NSString).length, length: 0))
        delegate?.textDidChange?(Notification(name: NSText.didChangeNotification, object: self))
    }
}

struct StickerPickerView: View {
    @ObservedObject var state: AppState
    let chatId: String
    @State private var selected: StickerPreviewItem?

    private let columns = [GridItem(.adaptive(minimum: 64, maximum: 82), spacing: 8)]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("貼圖")
                .font(.system(size: 15, weight: .semibold))
            if !state.stickerPackages.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(state.stickerPackages) { package in
                            Button(package.title.isEmpty ? package.packageId : package.title) {
                                selected = nil
                                state.loadStickerPreviews(packageId: package.packageId)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .accessibilityLabel("貼圖包 \(package.title)")
                        }
                    }
                }
            }
            if state.isLoadingStickers {
                ProgressView("載入貼圖…")
                    .frame(maxWidth: .infinity, minHeight: 120)
            } else if let error = state.stickerLoadError {
                VStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle")
                    Text(error).font(.system(size: 13))
                    Button("重試") { state.loadOwnedStickers() }
                }
                .frame(maxWidth: .infinity, minHeight: 120)
            } else if state.stickerPreviews.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "face.smiling")
                    Text("沒有可用貼圖").font(.system(size: 13))
                }
                .frame(maxWidth: .infinity, minHeight: 120)
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 8) {
                        ForEach(state.stickerPreviews) { sticker in
                            Button {
                                selected = sticker
                            } label: {
                                if let data = Data(base64Encoded: sticker.data), let image = NSImage(data: data) {
                                    Image(nsImage: image)
                                        .resizable()
                                        .aspectRatio(contentMode: .fit)
                                        .frame(width: 64, height: 64)
                                } else {
                                    Image(systemName: "photo")
                                        .frame(width: 64, height: 64)
                                }
                            }
                            .buttonStyle(.plain)
                            .padding(4)
                            .background(selected?.id == sticker.id ? EnterpriseTheme.accent.opacity(0.18) : Color.clear)
                            .clipShape(RoundedRectangle(cornerRadius: 7))
                            .accessibilityLabel("貼圖 \(sticker.stickerId)")
                        }
                    }
                }
                .frame(minHeight: 130, maxHeight: 220)
            }
            if let selected {
                HStack {
                    Text("已選擇貼圖 \(selected.stickerId)")
                        .font(.system(size: 13))
                    Spacer()
                    Button("送出") {
                        state.sendLineSticker(chatId: chatId, sticker: selected)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(state.isSendingReply)
                    .accessibilityLabel("確認送出貼圖")
                }
            }
        }
        .padding(14)
        .frame(width: 330)
        .onAppear {
            if state.stickerPackages.isEmpty { state.loadOwnedStickers() }
        }
    }
}
