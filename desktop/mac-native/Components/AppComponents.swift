import Cocoa
import SwiftUI

// MARK: - User Profile Avatar Component

struct UserAvatarView: View {
    let pictureUrl: String
    let displayName: String
    let mid: String

    var body: some View {
        CachedAvatarView(
            pictureUrl: pictureUrl,
            title: displayName,
            mid: mid,
            size: 38
        )
    }
}

// MARK: - SwiftUI Popover UI (Right-Click Menu)

struct PopoverContentView: View {
    @ObservedObject var state: AppState
    var onOpenLoginWindow: () -> Void
    var onOpenIntegrationWindow: () -> Void
    var onOpenChatSpotlight: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            // 1. Header (Brand + E2EE Status Indicator + Refresh)
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Yomi")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundColor(.primary)

                    HStack(spacing: 5) {
                        Circle()
                            .fill(
                                state.isConnected
                                    ? (state.hasUnreadAttention ? EnterpriseTheme.accent : Color.green) : Color.secondary.opacity(0.6)
                            )
                            .frame(width: 6.5, height: 6.5)

                        Text(
                            state.isConnected
                                ? (state.isSyncing
                                    ? "Syncing..." : (state.hasUnreadAttention ? "1 Item Needs Attention" : "Letter-Sealing E2EE Active"))
                                : "Not Connected"
                        )
                        .font(.system(size: 11.5))
                        .foregroundColor(state.hasUnreadAttention ? EnterpriseTheme.accent : .secondary)
                    }
                }

                Spacer()

                Button(action: {
                    state.syncNow()
                }) {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundColor(.secondary)
                        .rotationEffect(.degrees(state.isSyncing ? 360 : 0))
                        .animation(
                            state.isSyncing ? Animation.linear(duration: 0.8).repeatForever(autoreverses: false) : .default,
                            value: state.isSyncing
                        )
                        .padding(6)
                        .background(Color.white.opacity(0.06))
                        .clipShape(Circle())
                }
                .buttonStyle(PlainButtonStyle())
                .help("Refresh Status")
            }
            .padding(.horizontal, 14)
            .padding(.top, 14)
            .padding(.bottom, 10)

            // 2. Account Status Card (Connected vs Unauthenticated)
            if state.isConnected {
                Button(action: {
                    state.copyMidToClipboard()
                }) {
                    HStack(spacing: 11) {
                        UserAvatarView(
                            pictureUrl: state.pictureUrl,
                            displayName: state.displayName,
                            mid: state.mid
                        )

                        VStack(alignment: .leading, spacing: 2.5) {
                            HStack(spacing: 5) {
                                Text(state.displayName.isEmpty ? "LINE User" : state.displayName)
                                    .font(.system(size: 13.5, weight: .bold))
                                    .foregroundColor(.primary)
                                    .lineLimit(1)

                                Image(systemName: "checkmark.seal.fill")
                                    .font(.system(size: 11))
                                    .foregroundColor(.green)
                            }

                            Text("MID: \(state.mid)")
                                .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                                .foregroundColor(.secondary)
                                .lineLimit(1)
                        }

                        Spacer()

                        Image(systemName: "doc.on.doc")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(Color(NSColor.tertiaryLabelColor))
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(Color.white.opacity(0.04))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(PlainHoverButtonStyle())
                .padding(.horizontal, 6)
                .padding(.bottom, 6)
            } else {
                Button(action: {
                    onOpenLoginWindow()
                }) {
                    HStack(spacing: 11) {
                        ZStack {
                            Circle()
                                .fill(EnterpriseTheme.accent.opacity(0.18))
                                .frame(width: 36, height: 36)
                            Image(systemName: "shield.lefthalf.filled")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundColor(EnterpriseTheme.accent)
                        }

                        VStack(alignment: .leading, spacing: 2) {
                            Text("Connect LINE Account")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(EnterpriseTheme.accent)
                            Text("Click to sign in with phone PIN")
                                .font(.system(size: 11.5))
                                .foregroundColor(.secondary)
                        }

                        Spacer()

                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(EnterpriseTheme.accent)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 7)
                    .background(EnterpriseTheme.accent.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .contentShape(Rectangle())
                }
                .buttonStyle(PlainHoverButtonStyle())
                .padding(.horizontal, 6)
                .padding(.bottom, 6)
            }

            // 2.5 Attention Alert Banner (if any)
            if state.hasUnreadAttention {
                HStack(spacing: 9) {
                    Circle()
                        .fill(EnterpriseTheme.accent)
                        .frame(width: 8, height: 8)

                    VStack(alignment: .leading, spacing: 1) {
                        Text("New Attention Item")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundColor(.primary)
                        Text("Urgent mention waiting for review")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                    }

                    Spacer()

                    Button(action: {
                        state.clearAttentionAlert()
                    }) {
                        Text("Dismiss")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(EnterpriseTheme.accent)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(EnterpriseTheme.accent.opacity(0.12))
                            .clipShape(Capsule())
                    }
                    .buttonStyle(PlainButtonStyle())
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(EnterpriseTheme.accent.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .padding(.horizontal, 6)
                .padding(.bottom, 4)
            }

            Divider()
                .padding(.horizontal, 12)
                .padding(.vertical, 4)

            // 3. AI Copilot & Messaging Controls
            VStack(spacing: 1) {
                ActionRow(title: "Ask AI about LINE", icon: "sparkles", shortcut: "⌘ K", tag: "Spotlight", hasChevron: true) {
                    onOpenChatSpotlight()
                }

                ActionRow(title: "Claude & Codex Setup", icon: "arrow.triangle.swap", tag: "Primary", hasChevron: true) {
                    onOpenIntegrationWindow()
                }

                ActionRow(title: "Sync Mode", icon: "arrow.triangle.2.circlepath", tag: state.syncMode.shortLabel, hasChevron: false) {
                    switch state.syncMode {
                    case .realtime: state.syncMode = .interval1m
                    case .interval1m: state.syncMode = .interval5m
                    case .interval5m: state.syncMode = .realtime
                    }
                    state.sendNotification(title: "Yomi Sync Mode", body: "Mode updated to: \(state.syncMode.rawValue)")
                }

                ActionRow(title: "Sync Messages Now", icon: "arrow.clockwise", shortcut: "⌘ R", hasChevron: true) {
                    state.syncNow()
                }

                ActionRow(title: "Open AI Workspace", icon: "macwindow", shortcut: "⌘ O", hasChevron: true) {
                    state.openWorkspace()
                }
            }
            .padding(.horizontal, 6)

            Divider()
                .padding(.horizontal, 12)
                .padding(.vertical, 4)

            // 4. System & Settings
            VStack(spacing: 1) {
                ActionRow(title: "Setup Guide & Docs", icon: "book", hasChevron: false) {
                    state.openDocs()
                }

                if state.isConnected {
                    ActionRow(title: "Sign Out", icon: "rectangle.portrait.and.arrow.right", hasChevron: false) {
                        state.signOut()
                    }
                }

                ActionRow(title: "Quit Yomi", icon: "power", shortcut: "⌘ Q", hasChevron: false) {
                    NSApp.terminate(nil)
                }
            }
            .padding(.horizontal, 6)
            .padding(.bottom, 10)
        }
        .frame(width: 320)
        .background(
            ZStack {
                VisualEffectBackground()
                RoundedRectangle(cornerRadius: 14)
                    .stroke(Color.white.opacity(0.15), lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 14))
        )
        .padding(6)
    }
}

// MARK: - Components

struct ActionRow: View {
    let title: String
    let icon: String
    var shortcut: String? = nil
    var tag: String? = nil
    var hasChevron: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
                Image(systemName: icon)
                    .font(.system(size: 12.5))
                    .foregroundColor(.primary)
                    .frame(width: 16)

                Text(title)
                    .font(.system(size: 12.5))
                    .foregroundColor(.primary)

                Spacer()

                if let tag = tag {
                    Text(tag)
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundColor(
                            tag == "Spotlight" ? EnterpriseTheme.accent : (tag == "Primary" ? Color.green : EnterpriseTheme.accent)
                        )
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1.5)
                        .background(
                            (tag == "Spotlight" ? EnterpriseTheme.accent : (tag == "Primary" ? Color.green : EnterpriseTheme.accent))
                                .opacity(0.15)
                        )
                        .clipShape(Capsule())
                } else if let sc = shortcut {
                    Text(sc)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(Color(NSColor.tertiaryLabelColor))
                } else if hasChevron {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundColor(Color(NSColor.tertiaryLabelColor))
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(PlainHoverButtonStyle())
    }
}

struct PlainHoverButtonStyle: ButtonStyle {
    @State private var isHovered = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(
                        configuration.isPressed
                            ? Color(NSColor.selectedContentBackgroundColor).opacity(0.4)
                            : (isHovered ? EnterpriseTheme.accent.opacity(0.12) : Color.clear))
            )
            .onHover { isHovered = $0 }
    }
}

struct VisualEffectBackground: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .popover
    var blendingMode: NSVisualEffectView.BlendingMode = .behindWindow

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = blendingMode
        view.state = .active
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}

// MARK: - Native Dynamic Status Icon Generator (Official Yomi Logo)

func createStatusIcon(hasUnread: Bool = false) -> NSImage {
    let size = NSSize(width: 18, height: 18)
    let image = NSImage(size: size, flipped: false) { rect in
        let strokeColor = NSColor.labelColor
        strokeColor.setStroke()

        // Left chevron: (30, 24) -> (48, 50) -> (30, 76) mapped to 18x18
        let leftPath = NSBezierPath()
        leftPath.lineWidth = 1.7
        leftPath.lineCapStyle = .round
        leftPath.lineJoinStyle = .round
        leftPath.move(to: NSPoint(x: 5.2, y: 14.0))
        leftPath.line(to: NSPoint(x: 8.3, y: 9.0))
        leftPath.line(to: NSPoint(x: 5.2, y: 4.0))
        leftPath.stroke()

        // Right chevron: (70, 24) -> (52, 50) -> (70, 76) mapped to 18x18
        let rightPath = NSBezierPath()
        rightPath.lineWidth = 1.7
        rightPath.lineCapStyle = .round
        rightPath.lineJoinStyle = .round
        rightPath.move(to: NSPoint(x: 12.8, y: 14.0))
        rightPath.line(to: NSPoint(x: 9.7, y: 9.0))
        rightPath.line(to: NSPoint(x: 12.8, y: 4.0))
        rightPath.stroke()

        // Signature Yomi accent center dot (#B23A28).
        let dotRect = NSRect(x: 7.6, y: 7.6, width: 2.8, height: 2.8)
        let dotPath = NSBezierPath(ovalIn: dotRect)
        NSColor(red: 178 / 255, green: 58 / 255, blue: 40 / 255, alpha: 1.0).setFill()
        dotPath.fill()

        if hasUnread {
            let unreadRect = NSRect(x: 12.5, y: 12.5, width: 4.5, height: 4.5)
            let unreadPath = NSBezierPath(ovalIn: unreadRect)
            NSColor(red: 178 / 255, green: 58 / 255, blue: 40 / 255, alpha: 1.0).setFill()
            unreadPath.fill()

            unreadPath.lineWidth = 0.8
            NSColor.white.setStroke()
            unreadPath.stroke()
        }

        return true
    }
    image.isTemplate = false
    return image
}
