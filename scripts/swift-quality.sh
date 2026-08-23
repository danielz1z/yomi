#!/usr/bin/env bash
set -euo pipefail

while IFS= read -r source; do
  lines=$(wc -l < "$source")
  if (( lines > 1000 )); then
    echo "$source exceeds the 1000-line Swift source limit ($lines lines)" >&2
    exit 1
  fi
done < <(find desktop/mac-native -name '*.swift' -type f -not -path '*/Yomi.app/*' | sort)

xcrun swift-format lint --recursive --parallel --strict --no-color-diagnostics --configuration .swift-format desktop/mac-native

swiftc \
  -target "$(uname -m)-apple-macos14.0" \
  -warnings-as-errors \
  -warn-concurrency \
  -strict-concurrency=complete \
  -typecheck \
  -framework Cocoa \
  -framework SwiftUI \
  -framework Security \
  -framework Speech \
  -framework AVFoundation \
  -framework PhotosUI \
  desktop/mac-native/App/AppDelegate.swift \
  desktop/mac-native/Components/NativeControls.swift \
  desktop/mac-native/Components/AppComponents.swift \
  desktop/mac-native/Features/Login/LoginViews.swift \
  desktop/mac-native/Features/Integrations/IntegrationViews.swift \
  desktop/mac-native/Features/Onboarding/GuardianIntroductionView.swift \
  desktop/mac-native/Features/Agent/ElicitationView.swift \
  desktop/mac-native/App/MainWindowView.swift \
  desktop/mac-native/Core/DesktopChatSnapshotStore.swift \
  desktop/mac-native/Core/I18n.swift \
  desktop/mac-native/Core/AppModels.swift \
  desktop/mac-native/Core/AppState.swift \
  desktop/mac-native/Core/AppStateAgent.swift \
  desktop/mac-native/Agent/CodexAppServerBackend.swift \
  desktop/mac-native/Design/YomiGuardiansMark.swift \
  desktop/mac-native/Features/Settings/SettingsViews.swift \
  desktop/mac-native/Features/Media/MessageViews.swift \
  desktop/mac-native/Features/Media/MessageContentViews.swift \
  desktop/mac-native/Features/Conversation/ConversationSupport.swift \
  desktop/mac-native/Features/Conversation/ConversationView.swift \
  desktop/mac-native/Features/Conversation/ComposerViews.swift \
  desktop/mac-native/Features/Inbox/InboxView.swift \
  desktop/mac-native/SearchSupport.swift \
  desktop/mac-native/main.swift
