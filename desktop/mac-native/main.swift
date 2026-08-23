import AVFoundation
import Cocoa
import Combine
import PhotosUI
import Security
import Speech
import SwiftUI
import UniformTypeIdentifiers

// MARK: - App Entry Point

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.setActivationPolicy(.regular)
    app.delegate = delegate
    app.run()
}
