import Cocoa
import SwiftUI

// MARK: - Split-Pane Attention-First Chats Detail View

struct ChatsDetailView: View {
    @ObservedObject var state: AppState
    @Environment(\.colorScheme) private var effectiveColorScheme
    let showSettings: Bool
    var onCloseSettings: () -> Void
    var onOpenLogin: () -> Void
    var onAskAboutChat: (String) -> Void
    var onOpenCopilot: () -> Void
    var onOpenIntegrations: () -> Void
    var onOpenSettings: () -> Void
    @State private var conversationSearch = ""
    @State private var searchMatchIndex = 0

    var attentionChats: [LineChatItem] {
        return state.chats.filter { $0.needsAttention }
    }

    private var normalizedSearchQuery: String {
        conversationSearch.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var searchMatches: [LineChatItem] {
        guard !normalizedSearchQuery.isEmpty else { return [] }
        return state.chats.filter { item in
            searchTextMatches(value: item.title, query: normalizedSearchQuery)
                || searchTextMatches(value: item.lastMessage, query: normalizedSearchQuery)
        }
    }

    var displayedChats: [LineChatItem] {
        if !normalizedSearchQuery.isEmpty {
            return searchMatches
        }
        if state.showAttentionOnly {
            return attentionChats
        }
        let priorityIds = Set(attentionChats.map(\.id))
        return attentionChats + state.chats.filter { !priorityIds.contains($0.id) }
    }

    var selectedChat: LineChatItem? {
        if let id = state.selectedChatId {
            return state.chats.first(where: { $0.id == id })
        }
        return nil
    }

    private var syncTooltip: String {
        if state.isSyncing { return state.i18n.t("syncing_status") }
        if state.syncError != nil { return state.i18n.t("sync_failed") }
        if !state.lastSyncTimeString.isEmpty { return "\(state.i18n.t("synced_at")) \(state.lastSyncTimeString)" }
        return state.i18n.t("refresh")
    }

    var body: some View {
        HStack(spacing: 0) {
            // Left Column: Chat List (Attention First)
            VStack(spacing: 0) {
                // Header & Filter Toggle
                VStack(spacing: 8) {
                    // Attention vs All Filter Pills
                    HStack(spacing: 6) {
                        Button(action: {
                            withAnimation(.spring(response: 0.25, dampingFraction: 0.8)) {
                                state.showAttentionOnly = true
                            }
                        }) {
                            HStack(spacing: 4) {
                                Image(systemName: "bolt.fill")
                                    .font(.system(size: 12))
                                Text(state.i18n.t("attention_only"))
                                    .font(.system(size: 13, weight: state.showAttentionOnly ? .bold : .medium))
                                    .lineLimit(1)
                                if !attentionChats.isEmpty {
                                    Text("\(attentionChats.count)")
                                        .font(.system(size: 11, weight: .bold))
                                        .foregroundColor(state.showAttentionOnly ? EnterpriseTheme.selectedText : EnterpriseTheme.accent)
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 1)
                                        .background(state.showAttentionOnly ? EnterpriseTheme.accent : EnterpriseTheme.accent.opacity(0.18))
                                        .clipShape(Capsule())
                                }
                            }
                            .frame(maxWidth: .infinity)
                            .frame(height: 40)
                            .background(state.showAttentionOnly ? EnterpriseTheme.selected : EnterpriseTheme.raisedSurface)
                            .foregroundColor(state.showAttentionOnly ? EnterpriseTheme.selectedText : EnterpriseTheme.secondaryText)
                            .cornerRadius(7)
                        }
                        .buttonStyle(PlainButtonStyle())

                        Button(action: {
                            withAnimation(.spring(response: 0.25, dampingFraction: 0.8)) {
                                state.showAttentionOnly = false
                            }
                        }) {
                            HStack(spacing: 4) {
                                Image(systemName: "bubble.left.and.bubble.right")
                                    .font(.system(size: 12))
                                Text(state.i18n.t("all_chats"))
                                    .font(.system(size: 13, weight: !state.showAttentionOnly ? .bold : .medium))
                                    .lineLimit(1)
                            }
                            .frame(maxWidth: .infinity)
                            .frame(height: 40)
                            .background(!state.showAttentionOnly ? EnterpriseTheme.selected : EnterpriseTheme.raisedSurface)
                            .foregroundColor(!state.showAttentionOnly ? EnterpriseTheme.selectedText : EnterpriseTheme.secondaryText)
                            .cornerRadius(7)
                        }
                        .buttonStyle(PlainButtonStyle())
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .padding(.bottom, 10)

                HStack(spacing: 7) {
                    Image(systemName: "magnifyingglass")
                        .foregroundColor(.secondary)
                    TextField(state.i18n.t("search_conversations"), text: $conversationSearch)
                        .textFieldStyle(.plain)
                        .font(.system(size: 14))
                        .onSubmit { moveSearchMatch(1) }
                        .accessibilityLabel(state.i18n.t("search_conversations"))
                    if !conversationSearch.isEmpty {
                        Button {
                            conversationSearch = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundColor(.secondary)
                        }
                        .buttonStyle(.plain)
                        .help(state.i18n.t("clear_search"))
                        .accessibilityLabel(state.i18n.t("clear_search"))
                    }
                }
                .padding(.horizontal, 10)
                .frame(height: 34)
                .background(EnterpriseTheme.raisedSurface)
                .clipShape(RoundedRectangle(cornerRadius: 7))
                .padding(.horizontal, 12)
                .padding(.bottom, 8)

                if !conversationSearch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    HStack(spacing: 6) {
                        Text(
                            searchMatches.isEmpty
                                ? state.i18n.t("no_search_results")
                                : "\(min(searchMatchIndex + 1, searchMatches.count))/\(searchMatches.count)"
                        )
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.secondary)
                        .accessibilityLabel(
                            Text(
                                searchMatches.isEmpty
                                    ? state.i18n.t("no_search_results")
                                    : "搜尋結果第 \(min(searchMatchIndex + 1, searchMatches.count)) 項，共 \(searchMatches.count) 項")
                        )
                        Spacer()
                        Button(action: { moveSearchMatch(-1) }) {
                            Image(systemName: "chevron.up")
                        }
                        .buttonStyle(.plain)
                        .disabled(searchMatches.isEmpty || searchMatchIndex == 0)
                        .accessibilityLabel(state.i18n.t("previous_search_result"))
                        Button(action: { moveSearchMatch(1) }) {
                            Image(systemName: "chevron.down")
                        }
                        .buttonStyle(.plain)
                        .disabled(searchMatches.isEmpty || searchMatchIndex >= searchMatches.count - 1)
                        .accessibilityLabel(state.i18n.t("next_search_result"))
                    }
                    .padding(.horizontal, 14)
                    .padding(.bottom, 6)
                }

                Divider().opacity(0.3)

                // List Items or Empty Attention State
                if let loadError = state.chatLoadError, state.chats.isEmpty {
                    VStack(spacing: 12) {
                        Spacer()
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: EnterpriseTheme.Typography.stateIcon, weight: .semibold))
                            .foregroundColor(EnterpriseTheme.accent)
                        Text(state.i18n.t("chat_load_failed"))
                            .font(.system(size: EnterpriseTheme.Typography.status, weight: .semibold))
                            .foregroundColor(.primary)
                        Text(loadError)
                            .font(.system(size: EnterpriseTheme.Typography.description))
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                            .lineLimit(3)
                        Button(action: { state.loadRecentChats() }) {
                            HStack(spacing: 5) {
                                Image(systemName: "arrow.clockwise")
                                Text(state.i18n.t("retry"))
                            }
                            .font(.system(size: EnterpriseTheme.Typography.action, weight: .semibold))
                            .foregroundColor(.white)
                            .padding(.horizontal, 13)
                            .frame(minHeight: EnterpriseTheme.Typography.actionHitHeight)
                            .padding(.vertical, 4)
                            .background(EnterpriseTheme.accent)
                            .cornerRadius(7)
                        }
                        .buttonStyle(PlainButtonStyle())
                        Spacer()
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity)
                } else if !state.hasLoadedChatsOnce || (state.isLoadingChats && state.chats.isEmpty) {
                    // Keep loading content as one top-anchored group. Do not use
                    // vertical Spacers here: at the minimum window height they
                    // push the status below the visible list area.
                    VStack(spacing: 18) {
                        VStack(spacing: 10) {
                            ForEach(0..<3, id: \.self) { index in
                                HStack(spacing: 10) {
                                    Circle()
                                        .fill(EnterpriseTheme.secondaryText.opacity(0.16))
                                        .frame(width: 42, height: 42)
                                    VStack(alignment: .leading, spacing: 7) {
                                        RoundedRectangle(cornerRadius: 4)
                                            .fill(EnterpriseTheme.secondaryText.opacity(0.16))
                                            .frame(width: index == 1 ? 132 : 172, height: 12)
                                        RoundedRectangle(cornerRadius: 4)
                                            .fill(EnterpriseTheme.secondaryText.opacity(0.11))
                                            .frame(width: index == 2 ? 96 : 146, height: 9)
                                    }
                                    Spacer(minLength: 0)
                                }
                                .frame(height: 54)
                            }
                        }
                        .accessibilityHidden(true)

                        VStack(spacing: 10) {
                            ProgressView()
                                .controlSize(.small)
                            Text(state.isConnected ? state.i18n.t("loading_chats") : state.i18n.t("not_connected"))
                                .font(.system(size: EnterpriseTheme.Typography.status, weight: .semibold))
                                .foregroundColor(EnterpriseTheme.secondaryText)
                                .multilineTextAlignment(.center)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel(Text(state.isConnected ? state.i18n.t("loading_chats") : state.i18n.t("not_connected")))
                    }
                    .padding(.horizontal, 12)
                    .padding(.top, 28)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                } else if state.showAttentionOnly && attentionChats.isEmpty && conversationSearch.isEmpty {
                    VStack(spacing: 12) {
                        Spacer()
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: EnterpriseTheme.Typography.stateIcon))
                            .foregroundColor(.green.opacity(0.85))

                        VStack(spacing: 4) {
                            Text(state.i18n.t("all_caught_up"))
                                .font(.system(size: EnterpriseTheme.Typography.status, weight: .semibold))
                                .foregroundColor(.primary)
                            Text(state.i18n.t("all_caught_up_sub"))
                                .font(.system(size: EnterpriseTheme.Typography.description))
                                .foregroundColor(.secondary)
                        }

                        Button(action: {
                            withAnimation {
                                state.showAttentionOnly = false
                            }
                        }) {
                            Text(state.i18n.t("show_all_chats"))
                                .font(.system(size: EnterpriseTheme.Typography.action, weight: .semibold))
                                .foregroundColor(EnterpriseTheme.accent)
                                .padding(.horizontal, 12)
                                .frame(minHeight: EnterpriseTheme.Typography.actionHitHeight)
                                .padding(.vertical, 4)
                                .background(EnterpriseTheme.accent.opacity(0.12))
                                .cornerRadius(6)
                        }
                        .buttonStyle(PlainButtonStyle())

                        Spacer()
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity)
                } else if displayedChats.isEmpty {
                    VStack(spacing: 10) {
                        Spacer()
                        Image(systemName: "tray")
                            .font(.system(size: EnterpriseTheme.Typography.stateIcon))
                            .foregroundColor(.secondary.opacity(0.5))
                        Text(conversationSearch.isEmpty ? state.i18n.t("no_messages") : state.i18n.t("no_search_results"))
                            .font(.system(size: EnterpriseTheme.Typography.status, weight: .semibold))
                            .foregroundColor(.secondary)
                        Spacer()
                    }
                    .frame(maxWidth: .infinity)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 3) {
                            ForEach(displayedChats) { item in
                                ChatRowView(
                                    state: state,
                                    item: item,
                                    isSelected: state.selectedChatId == item.id,
                                    searchQuery: conversationSearch.trimmingCharacters(in: .whitespacesAndNewlines),
                                    onSelect: {
                                        // Only an explicit user selection marks
                                        // the conversation read. Background
                                        // polling and auto-selection stay pure.
                                        state.loadChatMessages(chatId: item.id, markReadOnSuccess: true)
                                    }
                                )
                            }
                        }
                        // Indicators are hidden, so rows use the same content
                        // width in every filter state without a fake gutter.
                        .padding(.leading, 6)
                        .padding(.trailing, 6)
                        .padding(.vertical, 6)
                    }
                    .scrollIndicators(.hidden)
                }

                Divider().opacity(0.3)
                Button(action: onOpenSettings) {
                    HStack(spacing: 10) {
                        UserAvatarView(pictureUrl: state.pictureUrl, displayName: state.displayName, mid: state.mid)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(state.displayName.isEmpty ? "LINE User" : state.displayName)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundColor(.primary)
                                .lineLimit(1)
                            Text(state.hasLoadedChatsOnce ? "\(state.chats.count) 個對話" : "正在載入對話…")
                                .font(.system(size: 11))
                                .foregroundColor(.secondary)
                        }
                        Spacer()
                        if !showSettings {
                            Circle()
                                .fill(state.isConnected ? Color.green : Color.secondary)
                                .frame(width: 7, height: 7)
                        }
                        Image(systemName: showSettings ? "xmark" : "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(showSettings ? EnterpriseTheme.accent : .secondary)
                    }
                    .padding(.horizontal, 12)
                    .frame(height: 54)
                    .background(showSettings ? EnterpriseTheme.accent.opacity(0.07) : .clear)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .keyboardShortcut(",", modifiers: .command)
                .help(state.i18n.t("tab_settings"))
            }
            .frame(width: EnterpriseTheme.conversationListWidth)
            .background(EnterpriseTheme.surface)

            Divider().opacity(0.3)

            // Right Column: Conversation Detail & Messages
            ZStack(alignment: .bottomTrailing) {
                if showSettings {
                    SettingsDetailView(state: state, onOpenLogin: onOpenLogin, onBack: onCloseSettings)
                } else if let chat = selectedChat {
                    ConversationDetailView(
                        state: state,
                        chat: chat,
                        onAskAboutChat: onAskAboutChat,
                        onOpenYomi: onOpenCopilot
                    )
                } else {
                    BriefingView(
                        state: state,
                        attentionChats: attentionChats,
                        onSelect: { item in
                            state.loadChatMessages(chatId: item.id, markReadOnSuccess: true)
                        },
                        onOpenYomi: onOpenCopilot
                    )
                }

                if !showSettings {
                    YomiGuardiansWatermark()
                        .padding(.trailing, 34)
                        .padding(.bottom, 76)
                }
            }
        }
        .onAppear {
            if state.chats.isEmpty && state.isConnected {
                state.loadRecentChats()
            } else if let sel = state.selectedChatId, state.currentChatMessages.isEmpty {
                state.loadChatMessages(chatId: sel)
            }
        }
        .onChange(of: conversationSearch) { _, _ in
            searchMatchIndex = 0
        }
    }

    private func moveSearchMatch(_ delta: Int) {
        guard !searchMatches.isEmpty else { return }
        let next = min(max(searchMatchIndex + delta, 0), searchMatches.count - 1)
        searchMatchIndex = next
        let item = searchMatches[next]
        // Search navigation changes the open detail pane, but does not mark
        // neighbouring results read. Only the row's explicit click does that.
        state.loadChatMessages(chatId: item.id)
    }

    private func inboxToolbarButton(icon: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(.secondary)
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(PlainButtonStyle())
        .help(help)
    }
}

/// Global attention overview shown on launch and whenever no conversation is
/// selected. It keeps the user's first action at the inbox level instead of
/// silently opening whichever row happens to sort first.
private struct BriefingView: View {
    @ObservedObject var state: AppState
    let attentionChats: [LineChatItem]
    let onSelect: (LineChatItem) -> Void
    let onOpenYomi: () -> Void

    private var now: [LineChatItem] { attentionChats.filter { $0.attentionEvaluation.tier == .now } }
    private var today: [LineChatItem] { attentionChats.filter { $0.attentionEvaluation.tier == .today } }
    private var know: [LineChatItem] { attentionChats.filter { $0.attentionEvaluation.tier == .know } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text("今日 Briefing")
                            .font(.system(size: 27, weight: .bold))
                        Spacer()
                        Button(action: onOpenYomi) {
                            HStack(spacing: 6) {
                                YomiGuardiansMark(size: 17)
                                Text("交代 Yomi").font(.system(size: 13, weight: .semibold))
                                Text("⌘J").font(.system(size: 10, weight: .medium)).foregroundColor(.secondary)
                            }
                            .padding(.horizontal, 10)
                            .frame(height: 44)
                            .background(EnterpriseTheme.raisedSurface)
                            .overlay(RoundedRectangle(cornerRadius: 9).stroke(EnterpriseTheme.hairline))
                            .clipShape(RoundedRectangle(cornerRadius: 9))
                        }
                        .buttonStyle(.plain)
                        .help("開啟完整 Yomi 工作區")
                        .accessibilityLabel("交代 Yomi；開啟完整 Yomi 工作區")
                        .keyboardShortcut("j", modifiers: .command)
                    }
                    Text("Yomi 先整理需要你處理的訊息；未讀不等於需要注意。")
                        .font(.system(size: 14))
                        .foregroundColor(.secondary)
                }

                if state.hasLoadedChatsOnce {
                    HStack(spacing: 10) {
                        briefingMetric("現在處理", value: now.count, color: EnterpriseTheme.attentionNow)
                        briefingMetric("今天處理", value: today.count, color: EnterpriseTheme.attentionToday)
                        briefingMetric("值得知道", value: know.count, color: EnterpriseTheme.attentionKnow)
                    }
                }

                if !state.hasLoadedChatsOnce {
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text("正在準備今天的重點…")
                            .font(.system(size: 14, weight: .medium))
                    }
                    .padding(18)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(EnterpriseTheme.raisedSurface)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                } else if attentionChats.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Image(systemName: "checkmark.circle.fill").foregroundColor(.green).font(.system(size: 28))
                        Text("目前沒有需要處理的訊息").font(.system(size: 16, weight: .semibold))
                        Text("可切換左側「所有對話」查看已過濾或僅供參考的內容。")
                            .font(.system(size: 13)).foregroundColor(.secondary)
                    }
                    .padding(18)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(EnterpriseTheme.raisedSurface)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("需要你的注意").font(.system(size: 17, weight: .semibold))
                        ForEach(attentionChats.prefix(8)) { item in
                            Button(action: { onSelect(item) }) {
                                HStack(spacing: 10) {
                                    CachedAvatarView(pictureUrl: item.pictureUrl, title: item.title, size: 34, isMuted: item.effectiveMuted)
                                    VStack(alignment: .leading, spacing: 3) {
                                        HStack(spacing: 6) {
                                            Text(item.title).font(.system(size: 14, weight: .semibold))
                                            Text(item.attentionEvaluation.tier.label)
                                                .font(.system(size: 11, weight: .medium))
                                                .foregroundColor(tierColor(item.attentionEvaluation.tier))
                                        }
                                        Text(item.attentionEvaluation.reason)
                                            .font(.system(size: 12)).foregroundColor(.secondary).lineLimit(1)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right").foregroundColor(.secondary)
                                }
                                .padding(.vertical, 8)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(18)
                    .background(EnterpriseTheme.raisedSurface)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                Spacer(minLength: 20)
            }
            .padding(34)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(EnterpriseTheme.canvas)
    }

    private func briefingMetric(_ title: String, value: Int, color: Color) -> some View {
        let displayColor = value == 0 ? EnterpriseTheme.secondaryText.opacity(0.5) : color
        return VStack(alignment: .leading, spacing: 4) {
            Text("\(value)").font(.system(size: 25, weight: .bold)).foregroundColor(displayColor)
            Text(title).font(.system(size: 12, weight: .medium)).foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(EnterpriseTheme.raisedSurface)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func tierColor(_ tier: AttentionTier) -> Color {
        switch tier {
        case .now: return EnterpriseTheme.attentionNow
        case .today: return EnterpriseTheme.attentionToday
        case .know: return EnterpriseTheme.attentionKnow
        case .filtered: return EnterpriseTheme.secondaryText
        }
    }
}

struct IntegrationsDetailView: View {
    @ObservedObject var state: AppState

    var body: some View {
        IdeIntegrationSheetView(state: state, onClose: {})
            .padding(10)
    }
}
