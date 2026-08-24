import Cocoa
import SwiftUI

// MARK: - 1-Click AI Integration Sheet Window (Claude & Codex Priority)

struct IdeIntegrationSheetView: View {
    @ObservedObject var state: AppState
    var onClose: () -> Void

    @State private var statusMessage: String = ""
    @State private var isDone: Bool = false

    let integrations: [IdeIntegrationItem] = [
        IdeIntegrationItem(
            id: "claude-desktop", name: "Claude Desktop & Cowork", badge: "Primary", icon: "sparkles",
            details: "Anthropic Claude Desktop + Yomi LINE Skill", isIntegrated: true),
        IdeIntegrationItem(
            id: "codex", name: "Codex Desktop & CLI", badge: "Primary", icon: "terminal.fill",
            details: "OpenAI Codex Agent & Antigravity MCP Server", isIntegrated: true),
        IdeIntegrationItem(
            id: "cursor", name: "Cursor IDE", badge: "Ready", icon: "chevron.left.forwardslash.chevron.right",
            details: "Cursor Composer & Agent Tools (~/.cursor/mcp.json)", isIntegrated: true),
        IdeIntegrationItem(
            id: "windsurf", name: "Windsurf (Cascade)", badge: "Ready", icon: "wind", details: "Codeium Windsurf MCP Config",
            isIntegrated: true),
        IdeIntegrationItem(
            id: "cline", name: "VS Code (Cline / Roo)", badge: "Ready", icon: "macwindow", details: "VS Code Autonomous AI Agent Settings",
            isIntegrated: true),
    ]

    var body: some View {
        VStack(spacing: 18) {
            // Header
            HStack(spacing: 12) {
                ZStack {
                    Circle()
                        .fill(EnterpriseTheme.accent.opacity(0.18))
                        .frame(width: 44, height: 44)
                    Image(systemName: "sparkles")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundColor(EnterpriseTheme.accent)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text("Claude & Codex Desktop Integration")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundColor(.primary)
                    Text("Auto-configures Yomi LINE MCP server and injects Agent Skills.")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                }

                Spacer()
            }

            // Client Cards
            VStack(spacing: 8) {
                ForEach(integrations) { item in
                    HStack(spacing: 11) {
                        Image(systemName: item.icon)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(item.badge == "Primary" ? EnterpriseTheme.accent : .secondary)
                            .frame(width: 22)

                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(item.name)
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundColor(.primary)

                                if item.badge == "Primary" {
                                    Text("Primary")
                                        .font(.system(size: 9.5, weight: .bold))
                                        .foregroundColor(.white)
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 1)
                                        .background(EnterpriseTheme.accent)
                                        .clipShape(Capsule())
                                }
                            }

                            Text(item.details)
                                .font(.system(size: 11))
                                .foregroundColor(.secondary)
                        }

                        Spacer()

                        HStack(spacing: 4) {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 12))
                                .foregroundColor(.green)
                            Text("Ready")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundColor(.green)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(Color.white.opacity(item.badge == "Primary" ? 0.07 : 0.03))
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
            }

            if !statusMessage.isEmpty {
                Text(statusMessage)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(isDone ? .green : .primary)
                    .multilineTextAlignment(.center)
            }

            // Action Buttons
            HStack(spacing: 10) {
                Button(action: {
                    state.copyMcpConfigSnippet()
                    statusMessage = "Copied JSON configuration snippet to clipboard!"
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "doc.on.doc")
                        Text("Copy JSON Config")
                    }
                    .font(.system(size: 12.5, weight: .medium))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Color.white.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(PlainButtonStyle())

                Spacer()

                Button(action: {
                    state.perform1ClickMcpIntegration { success, msg in
                        Task { @MainActor in
                            self.statusMessage = msg
                            self.isDone = success
                        }
                    }
                }) {
                    HStack(spacing: 6) {
                        if state.isIntegrating {
                            ProgressView()
                                .scaleEffect(0.8)
                        } else {
                            Image(systemName: "arrow.triangle.2.circlepath")
                        }
                        Text(state.isIntegrating ? "Configuring & Injecting Skills..." : "1-Click Auto Configure All")
                    }
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundColor(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(
                        LinearGradient(
                            gradient: Gradient(colors: [
                                EnterpriseTheme.accent,
                                EnterpriseTheme.accent.opacity(0.88),
                            ]),
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .shadow(color: EnterpriseTheme.accent.opacity(0.35), radius: 6, x: 0, y: 2)
                }
                .buttonStyle(PlainButtonStyle())
                .disabled(state.isIntegrating)
            }
            .padding(.top, 4)
        }
        .padding(24)
        .frame(width: 450, height: 410)
    }
}
