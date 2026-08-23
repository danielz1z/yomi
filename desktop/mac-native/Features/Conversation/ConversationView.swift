import AVFoundation
import Cocoa
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ConversationDetailView: View {
    @ObservedObject var state: AppState
    let chat: LineChatItem
    var onAskAboutChat: (String) -> Void
    var onOpenYomi: () -> Void

    @State private var composerInput: String = ""
    @StateObject private var voiceInput = VoiceInputController()
    @StateObject private var camera = CameraCaptureController()
    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var stagedAttachments: [ComposerAttachment] = []
    @State private var yomiStagedAttachments: [ComposerAttachment] = []
    @State private var isDropTargeted = false
    @State private var composerFocused = false
    @State private var isYomiMode = false
    @State private var yomiPromptDraft = ""
    @State private var yomiSessionStartIndex = 0
    @State private var yomiThreadExpanded = true
    @State private var mentionTargets: [LineMentionTarget] = []
    @State private var lineHistoryIndex: Int?
    @State private var yomiHistoryIndex: Int?
    @State private var lineHistoryDraft = ""
    @State private var yomiHistoryDraft = ""

    var body: some View {
        VStack(spacing: 0) {
            // 1. Chat Top Header Bar
            HStack(spacing: 10) {
                CachedAvatarView(
                    pictureUrl: chat.pictureUrl,
                    title: chat.title,
                    size: 32,
                    isMuted: chat.isMuted
                )

                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(chat.title)
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(.primary)
                            .lineLimit(1)
                            .truncationMode(.tail)

                        if chat.isGroup {
                            Image(systemName: "person.2.fill")
                                .font(.system(size: 12))
                                .foregroundColor(.secondary)
                        }
                    }

                    HStack(spacing: 5) {
                        Circle()
                            .fill(Color.green)
                            .frame(width: 5, height: 5)
                        Text(state.i18n.t("e2ee_protected"))
                            .font(.system(size: 12))
                            .foregroundColor(.secondary)
                    }
                }

                Spacer()

                // Native-style compact toolbar. AI actions live in the composer;
                // the header only owns conversation state actions.
                HStack(spacing: 6) {
                    Button(action: onOpenYomi) {
                        HStack(spacing: 5) {
                            YomiGuardiansMark(mode: .yomi, size: 18)
                            Text("Yomi").font(.system(size: 12, weight: .semibold))
                        }
                        .padding(.horizontal, 8)
                        .frame(height: 36)
                        .background(EnterpriseTheme.raisedSurface)
                        .cornerRadius(6)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .help("開啟完整 Yomi 對話")
                    .accessibilityLabel("開啟完整 Yomi 對話")
                    Button(action: {
                        state.setYomiMuted(chatId: chat.id, enabled: !chat.effectiveMuted)
                    }) {
                        Image(systemName: chat.effectiveMuted ? "bell" : "bell.slash")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundColor(chat.effectiveMuted ? EnterpriseTheme.accent : .secondary)
                            .frame(width: 36, height: 36)
                            .background(EnterpriseTheme.raisedSurface)
                            .cornerRadius(6)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .help(chat.effectiveMuted ? "恢復 Yomi 關注" : "Yomi 暫不關注")
                    Button(action: {
                        state.loadChatMessages(chatId: chat.id)
                    }) {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(.secondary)
                            .rotationEffect(.degrees(state.isLoadingMessages ? 360 : 0))
                            .animation(
                                state.isLoadingMessages ? Animation.linear(duration: 0.8).repeatForever(autoreverses: false) : .default,
                                value: state.isLoadingMessages
                            )
                            .frame(width: 36, height: 36)
                            .background(EnterpriseTheme.raisedSurface)
                            .cornerRadius(6)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .help(state.i18n.t("refresh"))
                }
                .fixedSize(horizontal: true, vertical: false)
            }
            .padding(.horizontal, EnterpriseTheme.contentPadding)
            .padding(.vertical, 12)
            .background(EnterpriseTheme.canvas)

            Divider().opacity(0.3)

            // 2. Message History Area
            if state.isLoadingMessages && state.currentChatMessages.isEmpty {
                VStack(spacing: 10) {
                    Spacer()
                    ProgressView()
                        .scaleEffect(0.8)
                    Text(state.i18n.t("loading_messages"))
                        .font(.system(size: EnterpriseTheme.Typography.status, weight: .semibold))
                        .foregroundColor(.secondary)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let loadError = state.messageLoadError, state.currentChatMessages.isEmpty {
                VStack(spacing: 10) {
                    Spacer()
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 30))
                        .foregroundColor(EnterpriseTheme.accent)
                    Text(loadError)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(.secondary)
                    Button("重試") {
                        state.loadChatMessages(chatId: chat.id, markReadOnSuccess: true)
                    }
                    .buttonStyle(.borderedProminent)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if state.currentChatMessages.isEmpty {
                VStack(spacing: 8) {
                    Spacer()
                    Image(systemName: "message")
                        .font(.system(size: EnterpriseTheme.Typography.stateIcon))
                        .foregroundColor(.secondary.opacity(0.4))
                    Text(state.i18n.t("no_messages"))
                        .font(.system(size: EnterpriseTheme.Typography.status, weight: .semibold))
                        .foregroundColor(.secondary)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollViewReader { proxy in
                    ScrollView(.vertical, showsIndicators: false) {
                        LazyVStack(spacing: 10) {
                            ForEach(state.currentChatMessages) { msg in
                                ChatMessageBubbleRow(
                                    state: state,
                                    chatId: chat.id,
                                    msg: msg,
                                    onMention: mentionMember
                                )
                                .id(msg.id)
                            }
                        }
                        .padding(.horizontal, EnterpriseTheme.contentPadding)
                        .padding(.vertical, EnterpriseTheme.contentPadding)
                    }
                    .onAppear {
                        if let lastId = state.currentChatMessages.last?.id {
                            proxy.scrollTo(lastId, anchor: .bottom)
                        }
                    }
                    .onChange(of: state.currentChatMessages.count) { _, _ in
                        if let lastId = state.currentChatMessages.last?.id {
                            withAnimation {
                                proxy.scrollTo(lastId, anchor: .bottom)
                            }
                        }
                    }
                }
            }

            Divider().opacity(0.3)

            // 3. One composer, two unmistakable destinations. Only this local
            // area changes; the conversation remains visible as context.
            VStack(spacing: 0) {
                if isYomiMode && (!contextYomiMessages.isEmpty || state.isAiThinking) {
                    DisclosureGroup(isExpanded: $yomiThreadExpanded) {
                        VStack(alignment: .leading, spacing: 7) {
                            ForEach(contextYomiMessages) { message in
                                Text(message.text)
                                    .font(.system(size: 12.5))
                                    .foregroundColor(message.isUser ? EnterpriseTheme.accent : .primary)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            if let approval = state.codexApprovalRequest {
                                AgentApprovalView(request: approval) { decision in
                                    state.respondToCodexApproval(decision: decision)
                                }
                            }
                            if let elicitation = state.codexElicitationRequest {
                                AgentElicitationView(request: elicitation) { action, content in
                                    state.respondToCodexElicitation(action: action, content: content)
                                }
                            }
                            if state.isAiThinking && state.codexApprovalRequest == nil
                                && state.codexElicitationRequest == nil
                            {
                                HStack(spacing: 6) {
                                    ProgressView().controlSize(.small)
                                    Text(state.codexStatus).font(.system(size: 12)).foregroundColor(.secondary)
                                }
                            }
                        }
                        .padding(.top, 6)
                    } label: {
                        HStack(spacing: 6) {
                            YomiGuardiansMark(size: 14)
                            Text("Yomi 對話")
                        }
                        .font(.system(size: 12, weight: .semibold))
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(EnterpriseTheme.accent.opacity(0.05))
                }

                HStack(spacing: 7) {
                    YomiGuardiansMark(mode: isYomiMode ? .yomi : .line, size: 18)
                        .frame(width: 22, height: 22, alignment: .center)
                    Text(isYomiMode ? "問 Yomi" : "回覆 \(chat.title)")
                        .font(.system(size: 12, weight: .semibold))
                    if isYomiMode {
                        Text("這個對話")
                            .font(.system(size: 10, weight: .medium))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 3)
                            .background(EnterpriseTheme.accent.opacity(0.11))
                            .clipShape(Capsule())
                    }
                    Spacer()
                    Text(isYomiMode ? "AI" : "LINE")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(isYomiMode ? EnterpriseTheme.accent : .secondary)
                }
                .padding(.horizontal, 14)
                .frame(height: 30, alignment: .center)
                .background(isYomiMode ? EnterpriseTheme.accent.opacity(0.055) : EnterpriseTheme.canvas)

                let activeAttachments = isYomiMode ? yomiStagedAttachments : stagedAttachments
                if !activeAttachments.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(activeAttachments) { attachment in
                                HStack(spacing: 5) {
                                    Image(systemName: attachment.isImage ? "photo" : "doc.fill")
                                        .foregroundColor(EnterpriseTheme.accent)
                                    Text(attachment.fileName)
                                        .lineLimit(1)
                                        .font(.system(size: 12, weight: .medium))
                                    Button {
                                        removeAttachment(attachment.id)
                                    } label: {
                                        Image(systemName: "xmark.circle.fill")
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("移除附件 \(attachment.fileName)")
                                }
                                .padding(.horizontal, 8)
                                .padding(.vertical, 5)
                                .background(EnterpriseTheme.raisedSurface)
                                .clipShape(Capsule())
                            }
                        }
                        .padding(.horizontal, 12)
                    }
                    .frame(height: 30)
                    .background(isYomiMode ? EnterpriseTheme.accent.opacity(0.055) : EnterpriseTheme.canvas)
                }
                HStack(spacing: 6) {
                    Button(action: { showAttachmentMenu.toggle() }) {
                        Image(systemName: "plus")
                            .font(.system(size: 17, weight: .semibold))
                            .frame(width: 34, height: 38)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .foregroundColor(EnterpriseTheme.secondaryText)
                    .help("新增附件")
                    .accessibilityLabel("新增附件")
                    .popover(isPresented: $showAttachmentMenu, arrowEdge: .bottom) {
                        VStack(alignment: .leading, spacing: 4) {
                            Button(action: {
                                showAttachmentMenu = false
                                chooseFile()
                            }) {
                                Label("檔案", systemImage: "doc")
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                            .padding(8)
                            .accessibilityLabel("選擇檔案附件")
                        }
                        .padding(6)
                        .frame(width: 170)
                    }
                    Button(action: { showCameraPopover = true }) {
                        Image(systemName: "camera.fill")
                            .font(.system(size: 15, weight: .medium))
                            .frame(width: 32, height: 38)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .foregroundColor(EnterpriseTheme.secondaryText)
                    .help("拍攝圖片")
                    .accessibilityLabel("拍攝圖片")
                    .popover(isPresented: $showCameraPopover, arrowEdge: .bottom) {
                        CameraCapturePopover(
                            controller: camera,
                            onSend: { data in
                                stageImageData(data)
                            }, onClose: { showCameraPopover = false })
                    }

                    PhotosPicker(selection: $selectedPhotoItem, matching: .images, photoLibrary: .shared()) {
                        Image(systemName: "photo")
                            .font(.system(size: 16, weight: .medium))
                            .frame(width: 32, height: 38)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .foregroundColor(EnterpriseTheme.secondaryText)
                    .help("從圖庫選擇圖片")
                    .accessibilityLabel("從圖庫選擇圖片")

                    let activeText = isYomiMode ? yomiPromptDraft : composerInput
                    let hasText = !activeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    let hasAttachments = !activeAttachments.isEmpty
                    ZStack(alignment: .trailing) {
                        HiddenScrollTextEditor(
                            text: isYomiMode ? $yomiPromptDraft : $composerInput,
                            isFocused: $composerFocused,
                            onSubmit: isYomiMode ? submitYomiPrompt : submitComposer,
                            onHistoryPrevious: previousComposerHistory,
                            onHistoryNext: nextComposerHistory
                        )
                        .font(.system(size: 15))
                        .frame(height: composerEditorHeight)
                        .contentShape(Rectangle())
                        .accessibilityLabel(isYomiMode ? "問 Yomi" : "回覆 \(chat.title)")
                        .accessibilityHint(isYomiMode ? "內容只會交給 Yomi，不會送到 LINE" : "訊息會送給目前 LINE 對話")

                        HStack(spacing: 2) {
                            Button {
                                composerFocused = true
                                DispatchQueue.main.async {
                                    NSApp.orderFrontCharacterPalette(nil)
                                }
                            } label: {
                                Image(systemName: "face.smiling")
                                    .font(.system(size: 16, weight: .medium))
                                    .frame(width: 30, height: 34)
                            }
                            .buttonStyle(PlainButtonStyle())
                            .foregroundColor(EnterpriseTheme.accent)
                            .help("插入表情符號")
                            .accessibilityLabel("插入表情符號")

                            if !isYomiMode {
                                Button(action: {
                                    state.loadOwnedStickers()
                                    showStickerPicker = true
                                }) {
                                    Image(systemName: "square.grid.2x2")
                                        .font(.system(size: 16, weight: .medium))
                                        .frame(width: 30, height: 34)
                                }
                                .buttonStyle(PlainButtonStyle())
                                .foregroundColor(EnterpriseTheme.accent)
                                .help("選擇 LINE 貼圖")
                                .accessibilityLabel(state.i18n.t("open_sticker_picker"))
                                .popover(isPresented: $showStickerPicker, arrowEdge: .bottom) {
                                    StickerPickerView(state: state, chatId: chat.id)
                                }
                            }

                            Button {
                                voiceInput.toggle(currentText: activeText)
                            } label: {
                                Image(systemName: voiceInput.status.isRecording ? "stop.fill" : "mic.fill")
                                    .font(.system(size: 17, weight: .semibold))
                                    .frame(width: 30, height: 34)
                            }
                            .buttonStyle(PlainButtonStyle())
                            .foregroundColor(voiceInput.status.isRecording ? EnterpriseTheme.accent : EnterpriseTheme.secondaryText)
                            .disabled(state.isSendingReply || (isYomiMode && state.isAiThinking))
                            .help("語音輸入")
                            .accessibilityLabel("語音輸入")

                            if hasText || hasAttachments {
                                Button {
                                    if isYomiMode { submitYomiPrompt() } else { submitComposer() }
                                } label: {
                                    Image(systemName: "paperplane.fill")
                                        .font(.system(size: 17, weight: .semibold))
                                        .frame(width: 30, height: 34)
                                }
                                .buttonStyle(PlainButtonStyle())
                                .foregroundColor(EnterpriseTheme.accent)
                                .disabled(state.isSendingReply || (isYomiMode && state.isAiThinking))
                                .help(isYomiMode ? "交給 Yomi" : "送出 LINE 回覆")
                                .accessibilityLabel(isYomiMode ? "交給 Yomi" : "送出 LINE 回覆")
                            }
                        }
                        .padding(.trailing, 6)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .frame(minHeight: 44)
                    .background(EnterpriseTheme.raisedSurface)
                    .overlay(RoundedRectangle(cornerRadius: EnterpriseTheme.cornerRadius).stroke(EnterpriseTheme.hairline))
                    .clipShape(RoundedRectangle(cornerRadius: EnterpriseTheme.cornerRadius))

                    Button(action: { toggleYomiMode() }) {
                        YomiGuardiansMark(mode: isYomiMode ? .yomi : .line, size: 30)
                            .frame(width: 44, height: 44, alignment: .center)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .foregroundColor(isYomiMode ? EnterpriseTheme.accent : EnterpriseTheme.secondaryText)
                    .help(isYomiMode ? "回到 LINE 回覆" : "切換為 Yomi")
                    .accessibilityLabel(isYomiMode ? "回到 LINE 回覆" : "切換為 Yomi")
                    .keyboardShortcut("j", modifiers: .command)
                }
                .frame(height: 50, alignment: .center)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(isYomiMode ? EnterpriseTheme.accent.opacity(0.055) : EnterpriseTheme.canvas)
                .overlay(
                    RoundedRectangle(cornerRadius: EnterpriseTheme.cornerRadius).stroke(
                        isDropTargeted ? EnterpriseTheme.accent : .clear, lineWidth: 2)
                )
                .onDrop(of: [UTType.fileURL.identifier, UTType.image.identifier], isTargeted: $isDropTargeted) { providers in
                    return stageDroppedProviders(providers)
                }
                .onExitCommand {
                    if isYomiMode { toggleYomiMode() }
                }
                .onReceive(voiceInput.$transcript) { value in
                    if isYomiMode {
                        if value != yomiPromptDraft { yomiPromptDraft = value }
                    } else if value != composerInput {
                        composerInput = value
                    }
                }
                .onDisappear { voiceInput.stop() }
                .onChange(of: chat.id) { _, _ in
                    voiceInput.stop()
                    camera.stop()
                    composerInput = ""
                    yomiPromptDraft = ""
                    stagedAttachments = []
                    yomiStagedAttachments = []
                    isYomiMode = false
                    lineHistoryIndex = nil
                    yomiHistoryIndex = nil
                }
                .onChange(of: selectedPhotoItem) { _, item in handlePhotoSelection(item) }

                if voiceStatusMessage != nil || state.isSendingReply || state.replyFeedback != nil {
                    VStack(spacing: 8) {
                        if case .denied(let message) = voiceInput.status {
                            Text(message)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundColor(EnterpriseTheme.accent)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 14)
                        } else if case .failed(let message) = voiceInput.status {
                            Text(message)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundColor(EnterpriseTheme.accent)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 14)
                        }

                        if state.isSendingReply {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.small)
                                Text("正在送出…").font(.system(size: 13)).foregroundColor(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 14)
                        }

                        if let feedback = state.replyFeedback {
                            HStack(spacing: 5) {
                                Image(systemName: state.replyFeedbackIsError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                                Text(feedback)
                            }
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(state.replyFeedbackIsError ? EnterpriseTheme.accent : .green)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 14)
                            .accessibilityLabel(feedback)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(EnterpriseTheme.canvas)
                }
            }
        }

    }

    @State private var showStickerPicker: Bool = false
    @State private var showAttachmentMenu: Bool = false
    @State private var showCameraPopover: Bool = false

    private var contextYomiMessages: [ChatMessageItem] {
        guard yomiSessionStartIndex < state.chatMessages.count else { return [] }
        return Array(state.chatMessages.dropFirst(yomiSessionStartIndex))
    }

    private var voiceStatusMessage: String? {
        if case .denied(let message) = voiceInput.status { return message }
        if case .failed(let message) = voiceInput.status { return message }
        return nil
    }

    private var composerEditorHeight: CGFloat {
        // The destination changes, not the geometry. Keeping one fixed editor
        // height prevents focus, draft length, and LINE/Yomi mode switches
        // from making the composer jump. Long drafts remain scrollable inside
        // the AppKit-backed editor.
        44
    }

    private func toggleYomiMode() {
        if !isYomiMode {
            yomiSessionStartIndex = state.chatMessages.count
            yomiThreadExpanded = true
        }
        withAnimation(.easeInOut(duration: 0.16)) { isYomiMode.toggle() }
        voiceInput.stop()
        composerFocused = true
    }

    private func submitYomiPrompt() {
        let prompt = yomiPromptDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty || !yomiStagedAttachments.isEmpty, !state.isAiThinking else { return }
        ComposerHistoryStore.append(prompt, chatId: chat.id, yomi: true)
        yomiHistoryIndex = nil
        voiceInput.stop()
        let fileContext =
            yomiStagedAttachments.isEmpty
            ? ""
            : "；使用者附上本機檔案：" + yomiStagedAttachments.map(\.url.path).joined(separator: "、")
        yomiPromptDraft = ""
        yomiStagedAttachments = []
        yomiThreadExpanded = true
        state.sendAiQuery(prompt: "目前對話：\(chat.title)；使用者請 Yomi 處理：\(prompt)\(fileContext)")
    }

    private func chooseFile() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowedContentTypes = [.item]
        panel.prompt = "選擇"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            stage(url: url)
        }
    }

    private func handlePhotoSelection(_ item: PhotosPickerItem?) {
        guard let item else { return }
        Task {
            guard let data = try? await item.loadTransferable(type: Data.self) else { return }
            await MainActor.run { stageImageData(data) }
        }
        selectedPhotoItem = nil
    }

    private func stageImageData(_ data: Data) {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("yomi-image-\(UUID().uuidString).jpg")
        do {
            try data.write(to: url, options: .atomic)
            stage(url: url)
            showCameraPopover = false
            camera.stop()
            camera.capturedData = nil
        } catch {
            state.replyFeedbackIsError = true
            state.replyFeedback = "圖片讀取失敗，尚未送出。"
        }
    }

    private func stage(url: URL) {
        let isImage = (try? url.resourceValues(forKeys: [.contentTypeKey]).contentType?.conforms(to: .image)) ?? false
        let count = isYomiMode ? yomiStagedAttachments.count : stagedAttachments.count
        guard count < 8 else {
            state.replyFeedbackIsError = true
            state.replyFeedback = "最多可同時準備 8 個附件。"
            return
        }
        let attachment = ComposerAttachment(url: url, isImage: isImage)
        if isYomiMode { yomiStagedAttachments.append(attachment) } else { stagedAttachments.append(attachment) }
    }

    private func removeAttachment(_ id: UUID) {
        let url: URL?
        if isYomiMode, let index = yomiStagedAttachments.firstIndex(where: { $0.id == id }) {
            url = yomiStagedAttachments.remove(at: index).url
        } else if let index = stagedAttachments.firstIndex(where: { $0.id == id }) {
            url = stagedAttachments.remove(at: index).url
        } else {
            url = nil
        }
        guard let url else { return }
        if url.path.hasPrefix(NSTemporaryDirectory()) { try? FileManager.default.removeItem(at: url) }
    }

    private func stageDroppedProviders(_ providers: [NSItemProvider]) -> Bool {
        let count = isYomiMode ? yomiStagedAttachments.count : stagedAttachments.count
        for provider in providers.prefix(max(0, 8 - count)) {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                    let url: URL?
                    if let value = item as? URL {
                        url = value
                    } else if let data = item as? Data {
                        url = URL(dataRepresentation: data, relativeTo: nil)
                    } else {
                        url = nil
                    }
                    guard let url else { return }
                    DispatchQueue.main.async { stage(url: url) }
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                    guard let data else { return }
                    DispatchQueue.main.async { stageImageData(data) }
                }
            }
        }
        return true
    }

    private func submitComposer() {
        let trimmed = composerInput.trimmingCharacters(in: .whitespacesAndNewlines)
        voiceInput.stop()
        var sendAttachments: (() -> Void)!
        sendAttachments = {
            guard !stagedAttachments.isEmpty else {
                composerInput = ""
                composerFocused = false
                state.loadChatMessages(chatId: chat.id)
                return
            }
            let attachment = stagedAttachments[0]
            let finish: (Bool) -> Void = { success in
                if success {
                    stagedAttachments.removeFirst()
                    if attachment.url.path.hasPrefix(NSTemporaryDirectory()) { try? FileManager.default.removeItem(at: attachment.url) }
                    sendAttachments()
                }
            }
            if attachment.isImage {
                state.sendLineImage(chatId: chat.id, fileURL: attachment.url, completion: finish)
            } else {
                state.sendLineFile(chatId: chat.id, fileURL: attachment.url, completion: finish)
            }
        }
        if !trimmed.isEmpty {
            state.sendLineReply(chatId: chat.id, text: trimmed, mentions: mentionTargets) { success in
                if success {
                    ComposerHistoryStore.append(trimmed, chatId: chat.id, yomi: false)
                    lineHistoryIndex = nil
                    composerInput = ""
                    mentionTargets = []
                    composerFocused = false
                    sendAttachments()
                }
            }
        } else {
            sendAttachments()
        }
    }

    private func mentionMember(_ mid: String, _ name: String) {
        guard chat.isGroup else { return }
        isYomiMode = false
        let mention = "@\(name) "
        if !composerInput.contains(mention) {
            composerInput += mention
            mentionTargets.append(LineMentionTarget(mid: mid, name: name))
        }
        composerFocused = true
    }

    private func previousComposerHistory() -> String? {
        let values = ComposerHistoryStore.load(chatId: chat.id, yomi: isYomiMode)
        guard !values.isEmpty else { return nil }
        if isYomiMode {
            if yomiHistoryIndex == nil { yomiHistoryDraft = yomiPromptDraft }
            let next = max(0, (yomiHistoryIndex ?? values.count) - 1)
            yomiHistoryIndex = next
            return values[next]
        }
        if lineHistoryIndex == nil { lineHistoryDraft = composerInput }
        let next = max(0, (lineHistoryIndex ?? values.count) - 1)
        lineHistoryIndex = next
        return values[next]
    }

    private func nextComposerHistory() -> String? {
        let values = ComposerHistoryStore.load(chatId: chat.id, yomi: isYomiMode)
        if isYomiMode, let index = yomiHistoryIndex {
            guard index + 1 < values.count else {
                yomiHistoryIndex = nil
                return yomiHistoryDraft
            }
            yomiHistoryIndex = index + 1
            return values[index + 1]
        }
        if !isYomiMode, let index = lineHistoryIndex {
            guard index + 1 < values.count else {
                lineHistoryIndex = nil
                return lineHistoryDraft
            }
            lineHistoryIndex = index + 1
            return values[index + 1]
        }
        return nil
    }
}
