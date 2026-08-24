import AVFoundation
import Cocoa
import SwiftUI

struct RemoteMediaImageView: View {
    let url: String
    let label: String
    @StateObject private var loader = ImageLoader()

    var body: some View {
        Group {
            if let image = loader.image {
                ZoomableMessageImage(image: image)
                    .frame(maxWidth: 280, maxHeight: 280)
            } else {
                VStack(spacing: 7) {
                    Image(systemName: "photo")
                        .font(.system(size: 24))
                    Text(label)
                        .font(.system(size: 13, weight: .medium))
                }
                .foregroundColor(.secondary)
                .frame(width: 170, height: 110)
                .background(EnterpriseTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
        .onAppear { loader.load(urlStr: url) }
    }
}

struct ImageViewerView: View {
    let image: NSImage
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Button("關閉") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(12)
            ScrollView([.horizontal, .vertical]) {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(minWidth: 320, minHeight: 240)
                    .padding(20)
            }
        }
        .frame(minWidth: 560, minHeight: 420)
    }
}

struct ZoomableMessageImage: View {
    let image: NSImage
    var onOpen: () -> Void = {}
    @State private var isPresented = false

    var body: some View {
        Button {
            onOpen()
            isPresented = true
        } label: {
            Image(nsImage: image)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: 320, maxHeight: 320)
                .clipShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .help("點擊放大圖片")
        .accessibilityLabel("圖片，點擊放大")
        .sheet(isPresented: $isPresented) {
            ImageViewerView(image: image)
        }
    }
}

final class AudioPreviewController: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published private(set) var isPlaying = false
    private var player: AVAudioPlayer?

    func toggle(data: Data) {
        if let player, player.isPlaying {
            player.pause()
            isPlaying = false
            return
        }
        do {
            if player == nil {
                let next = try AVAudioPlayer(data: data)
                next.delegate = self
                next.prepareToPlay()
                player = next
            }
            player?.play()
            isPlaying = true
        } catch {
            isPlaying = false
        }
    }

    func stop() {
        player?.stop()
        isPlaying = false
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        isPlaying = false
    }

    deinit {
        player?.stop()
    }
}

struct AudioMessageView: View {
    @ObservedObject var state: AppState
    let chatId: String
    let msg: LineChatMessage
    @StateObject private var controller = AudioPreviewController()

    private var data: Data? { state.mediaPreviewAudioData[msg.id] }

    private var statusText: String {
        if state.mediaPreviewFailures.contains(msg.id) {
            return "語音無法播放"
        }
        return data == nil ? "正在載入語音…" : "點一下播放"
    }

    var body: some View {
        HStack(spacing: 10) {
            Button {
                if let data { controller.toggle(data: data) }
            } label: {
                Image(systemName: controller.isPlaying ? "pause.fill" : "play.fill")
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.borderedProminent)
            .disabled(data == nil)
            VStack(alignment: .leading, spacing: 3) {
                Text(msg.fileName ?? "語音訊息")
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(1)
                Text(statusText)
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minWidth: 210, maxWidth: 320, alignment: .leading)
        .background(EnterpriseTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .onAppear {
            state.loadMediaPreview(chatId: chatId, messageId: msg.id, original: true)
        }
        .onDisappear {
            controller.stop()
        }
    }
}

struct RichMediaContentView: View {
    let msg: LineChatMessage

    @ViewBuilder
    private var richPreview: some View {
        if let url = msg.mediaUrl, !url.isEmpty {
            RemoteMediaImageView(url: url, label: "互動卡片載入中…")
                .overlay(alignment: .bottomTrailing) {
                    if msg.actionUrl != nil {
                        Image(systemName: "arrow.up.right.square.fill")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(.white)
                            .padding(7)
                            .background(.black.opacity(0.48), in: Circle())
                            .padding(8)
                    }
                }
        } else {
            MediaAttachmentCard(mediaType: "rich", fileName: "LINE 互動卡片")
        }
    }

    var body: some View {
        Group {
            if let actionUrl = msg.actionUrl, let url = URL(string: actionUrl),
                url.scheme == "http" || url.scheme == "https"
            {
                Link(destination: url) { richCard }
                    .buttonStyle(.plain)
                    .help("開啟互動卡片連結")
            } else {
                richCard
            }
        }
    }

    private var richCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            richPreview
            if !msg.text.isEmpty, msg.text != "[豐富訊息]", msg.text != "[互動卡片]" {
                Text(msg.text)
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)
                    .lineLimit(3)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(EnterpriseTheme.surface)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

struct MediaAttachmentCard: View {
    let mediaType: String
    let fileName: String?

    private var title: String {
        if let fileName, !fileName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return fileName
        }
        switch mediaType {
        case "video": return "影片附件"
        case "audio": return "語音附件"
        case "file": return "檔案附件"
        default: return "媒體附件"
        }
    }

    private var icon: String {
        switch mediaType {
        case "video": return "video.fill"
        case "audio": return "waveform"
        case "file": return "doc.fill"
        default: return "paperclip"
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 20, weight: .semibold))
                .foregroundColor(EnterpriseTheme.accent)
                .frame(width: 34, height: 34)
                .background(EnterpriseTheme.accent.opacity(0.14))
                .clipShape(RoundedRectangle(cornerRadius: 7))
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(2)
                Text(mediaType == "video" ? "影片" : mediaType == "audio" ? "語音訊息" : "附件")
                    .font(.system(size: 12))
                    .foregroundColor(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minWidth: 190, maxWidth: 300, alignment: .leading)
        .background(EnterpriseTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

struct LineMediaContentView: View {
    @ObservedObject var state: AppState
    let chatId: String
    let msg: LineChatMessage

    var body: some View {
        if msg.mediaType == "sticker", let url = msg.mediaUrl, !url.isEmpty {
            RemoteMediaImageView(url: url, label: "貼圖載入中…")
        } else if msg.mediaType == "rich" {
            RichMediaContentView(msg: msg)
        } else if msg.mediaType == "image" {
            if let image = state.mediaPreviewImages[msg.id] {
                ZoomableMessageImage(image: image) {
                    state.loadMediaPreview(chatId: chatId, messageId: msg.id, original: true)
                }
            } else if state.mediaPreviewFailures.contains(msg.id) {
                MediaAttachmentCard(mediaType: "image", fileName: msg.fileName ?? "圖片無法預覽")
            } else {
                VStack(spacing: 7) {
                    ProgressView()
                    Text("正在載入圖片…")
                        .font(.system(size: 13, weight: .medium))
                }
                .foregroundColor(.secondary)
                .frame(width: 190, height: 110)
                .background(EnterpriseTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .onAppear { state.loadMediaPreview(chatId: chatId, messageId: msg.id) }
            }
        } else if msg.mediaType == "audio" {
            AudioMessageView(state: state, chatId: chatId, msg: msg)
        } else {
            MediaAttachmentCard(mediaType: msg.mediaType ?? "file", fileName: msg.fileName)
        }
    }
}

private struct MessageEventRow: View {
    let msg: LineChatMessage
    let senderName: String
    let icon: String
    let description: String
    let tint: Color

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            CachedAvatarView(pictureUrl: msg.fromPictureUrl, title: msg.fromName, size: 28)
            VStack(alignment: .leading, spacing: 4) {
                Text(senderName)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.secondary)
                HStack(spacing: 7) {
                    Image(systemName: icon)
                        .foregroundColor(tint)
                    Text(description)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundColor(.secondary)
                    Text(msg.timeString)
                        .font(.system(size: 11))
                        .foregroundColor(.secondary.opacity(0.65))
                }
                .padding(.horizontal, 11)
                .padding(.vertical, 7)
                .background(tint.opacity(0.06))
                .clipShape(Capsule())
            }
            Spacer(minLength: 40)
        }
        .frame(maxWidth: .infinity)
    }
}

struct ChatMessageBubbleRow: View {
    @ObservedObject var state: AppState
    let chatId: String
    let msg: LineChatMessage
    var onMention: (String, String) -> Void = { _, _ in }

    private var hasMedia: Bool { msg.mediaType != nil }
    private var isSystemEvent: Bool { msg.contentType == 18 }
    private var isDecryptFailure: Bool { msg.isDecryptFailure == true }
    private var isUnsent: Bool { msg.isUnsent == true }

    private var eventSenderName: String {
        msg.isSelf ? "你" : msg.fromName
    }

    private var eventDescription: String {
        if isUnsent {
            return "\(eventSenderName)收回了一則訊息"
        }
        return "這則訊息無法解密"
    }

    @ViewBuilder
    private var content: some View {
        if hasMedia {
            LineMediaContentView(state: state, chatId: chatId, msg: msg)
        } else {
            LinkifiedMessageText(
                value: msg.text,
                color: msg.isSelf ? .white : .primary,
                mentionRanges: msg.mentionRanges ?? []
            )
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(msg.isSelf ? EnterpriseTheme.selected : EnterpriseTheme.surface)
            .cornerRadius(12)
        }
    }

    @ViewBuilder
    var body: some View {
        if isDecryptFailure {
            MessageEventRow(
                msg: msg,
                senderName: eventSenderName,
                icon: "info.circle.fill",
                description: eventDescription,
                tint: .red
            )
            .accessibilityLabel("\(eventSenderName)傳送的訊息無法解密")
        } else if isUnsent {
            MessageEventRow(
                msg: msg,
                senderName: eventSenderName,
                icon: "arrow.uturn.backward.circle",
                description: eventDescription,
                tint: .secondary
            )
            .accessibilityLabel(eventDescription)
        } else if isSystemEvent {
            HStack(spacing: 8) {
                Spacer(minLength: 32)
                Text(msg.text)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
                Text(msg.timeString)
                    .font(.system(size: 11))
                    .foregroundColor(.secondary.opacity(0.65))
                Spacer(minLength: 32)
            }
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity)
            .accessibilityLabel("聊天室活動：\(msg.text)")
        } else {
            HStack(alignment: hasMedia ? .top : .bottom, spacing: 8) {
                if msg.isSelf {
                    Spacer(minLength: 40)
                    Text(msg.timeString)
                        .font(.system(size: 12))
                        .foregroundColor(.secondary.opacity(0.7))
                        .padding(.bottom, 2)
                    content
                } else {
                    Button {
                        onMention(msg.fromMid, msg.fromName)
                    } label: {
                        CachedAvatarView(pictureUrl: msg.fromPictureUrl, title: msg.fromName, size: 28)
                    }
                    .buttonStyle(.plain)
                    .help("提及 \(msg.fromName)")
                    VStack(alignment: .leading, spacing: 3) {
                        Text(msg.fromName)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(.secondary)
                        HStack(alignment: .bottom, spacing: 6) {
                            content
                            Text(msg.timeString)
                                .font(.system(size: 12))
                                .foregroundColor(.secondary.opacity(0.7))
                                .padding(.bottom, 2)
                        }
                    }
                    Spacer(minLength: 40)
                }
            }
            .frame(maxWidth: .infinity, alignment: msg.isSelf ? .trailing : .leading)
        }
    }
}

/// A native AppKit text system for message bodies.
///
/// SwiftUI's `Text` can only provide hover state for the whole view. That made
/// an entire bubble use a pointing-hand cursor when it contained one URL, and
/// made cursor push/pop state leak when a view disappeared while hovered.
/// NSTextView owns the hit testing instead: only ranges carrying `.link` get
/// the link cursor, while ordinary text keeps the I-beam/arrow behaviour.
final class LinkMessageTextView: NSTextView {
    static let font = NSFont.systemFont(ofSize: 15)

    override var isFlipped: Bool { true }

    func measuredSize(for width: CGFloat) -> NSSize {
        guard let textContainer, let layoutManager else { return NSSize(width: width, height: 20) }
        let measuredWidth = max(1, width)
        textContainer.containerSize = NSSize(width: measuredWidth, height: CGFloat.greatestFiniteMagnitude)
        textContainer.widthTracksTextView = false
        layoutManager.ensureLayout(for: textContainer)
        let used = layoutManager.usedRect(for: textContainer)
        let height = ceil(max(1, used.height + textContainerInset.height * 2))
        return NSSize(width: measuredWidth, height: height)
    }

    override var intrinsicContentSize: NSSize {
        let width = bounds.width > 1 ? bounds.width : 320
        return measuredSize(for: width)
    }

}

/// Renders only http/https URLs as links, preserving message text and line
/// breaks. NSDataDetector may identify other URL-like schemes; those ranges
/// deliberately remain ordinary text and are never clickable.
struct LinkifiedMessageText: NSViewRepresentable {
    let value: String
    let color: Color
    var mentionRanges: [MessageTextRange] = []

    private var foregroundColor: NSColor {
        NSColor(color)
    }

    private var linkColor: NSColor {
        NSColor(EnterpriseTheme.accent)
    }

    private func attributedString() -> NSAttributedString {
        let result = NSMutableAttributedString(
            string: value,
            attributes: [
                .font: LinkMessageTextView.font,
                .foregroundColor: foregroundColor,
            ]
        )
        for mention in mentionRanges {
            let range = NSRange(location: mention.location, length: mention.length)
            guard range.location >= 0, range.length > 0, NSMaxRange(range) <= result.length else { continue }
            result.addAttributes(
                [
                    .foregroundColor: NSColor.systemBlue,
                    .font: NSFont.systemFont(ofSize: 15, weight: .semibold),
                ],
                range: range
            )
        }
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
            return result
        }

        let nsValue = value as NSString
        detector.enumerateMatches(
            in: value,
            options: [],
            range: NSRange(location: 0, length: nsValue.length)
        ) { match, _, _ in
            guard let match, let url = match.url,
                let scheme = url.scheme?.lowercased(),
                scheme == "http" || scheme == "https",
                match.range.location != NSNotFound,
                NSMaxRange(match.range) <= result.length
            else { return }
            result.addAttributes(
                [
                    .link: url,
                    .foregroundColor: linkColor,
                    .underlineStyle: NSUnderlineStyle.single.rawValue,
                ], range: match.range)
        }
        return result
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeNSView(context: Context) -> LinkMessageTextView {
        let textView = LinkMessageTextView(frame: .zero)
        textView.delegate = context.coordinator
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = true
        textView.allowsUndo = false
        textView.drawsBackground = false
        textView.backgroundColor = .clear
        textView.insertionPointColor = .clear
        textView.textContainerInset = .zero
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        textView.textStorage?.setAttributedString(attributedString())
        textView.linkTextAttributes = [
            .foregroundColor: linkColor,
            .underlineStyle: NSUnderlineStyle.single.rawValue,
            .cursor: NSCursor.pointingHand,
        ]
        textView.setAccessibilityLabel(value)
        return textView
    }

    func updateNSView(_ textView: LinkMessageTextView, context: Context) {
        context.coordinator.parent = self
        let next = attributedString()
        if textView.textStorage?.isEqual(to: next) != true {
            textView.textStorage?.setAttributedString(next)
        }
        textView.linkTextAttributes = [
            .foregroundColor: linkColor,
            .underlineStyle: NSUnderlineStyle.single.rawValue,
            .cursor: NSCursor.pointingHand,
        ]
        textView.setAccessibilityLabel(value)
        // NSTextView/AppKit will lay out after textStorage changes. Do not
        // invalidate intrinsic size from layout/update unconditionally: that
        // creates an AppKit-to-SwiftUI constraint recursion for long or link-rich
        // messages.
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: LinkMessageTextView, context: Context) -> CGSize? {
        let maximumWidth = min(proposal.width ?? 460, 460)
        let naturalWidth = ceil(
            nsView.attributedString().boundingRect(
                with: NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading]
            ).width
        )
        let width = min(maximumWidth, max(1, naturalWidth))
        return nsView.measuredSize(for: width)
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: LinkifiedMessageText

        init(parent: LinkifiedMessageText) {
            self.parent = parent
            super.init()
        }

        private func allowed(_ url: URL) -> Bool {
            guard let scheme = url.scheme?.lowercased() else { return false }
            return scheme == "http" || scheme == "https"
        }

        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            guard let url = link as? URL, allowed(url) else { return true }
            NSWorkspace.shared.open(url)
            return true
        }

        func textView(
            _ textView: NSTextView,
            shouldInteractWith url: URL,
            in characterRange: NSRange
        ) -> Bool {
            allowed(url)
        }
    }
}
