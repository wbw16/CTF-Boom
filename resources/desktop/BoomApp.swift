import AppKit
import Darwin
import WebKit

private func effectivePort(_ url: URL) -> Int {
    if let port = url.port { return port }
    return url.scheme?.lowercased() == "https" ? 443 : 80
}

final class BoomAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
    WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private let startURL: URL
    private var window: NSWindow!
    private var webView: WKWebView!
    var exitCode: Int32 = 0

    init(startURL: URL) {
        self.startURL = startURL
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let iconURL = Bundle.main.url(forResource: "Boom", withExtension: "icns"),
           let icon = NSImage(contentsOf: iconURL) {
            NSApp.applicationIconImage = icon
            let iconView = NSImageView(frame: NSRect(x: 0, y: 0, width: 512, height: 512))
            iconView.image = icon
            iconView.imageScaling = .scaleProportionallyUpOrDown
            NSApp.dockTile.contentView = iconView
            NSApp.dockTile.display()
        }
        installMenus()

        let controller = WKUserContentController()
        controller.add(self, name: "boom")
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.websiteDataStore = .nonPersistent()

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsMagnification = true

        let visibleFrame = NSScreen.main?.visibleFrame
        let initialWidth = min(1280, visibleFrame?.width ?? 1280)
        let initialHeight = min(800, visibleFrame?.height ?? 800)
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: initialWidth, height: initialHeight),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Boom"
        window.minSize = NSSize(
            width: min(720, visibleFrame?.width ?? 720),
            height: min(520, visibleFrame?.height ?? 520)
        )
        window.collectionBehavior = [.fullScreenPrimary]
        window.contentView = webView
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("BoomMainWindow")
        fitWindowToVisibleScreen()
        window.makeKeyAndOrderFront(nil)

        webView.load(URLRequest(url: startURL, cachePolicy: .reloadIgnoringLocalCacheData))
        NSApp.activate(ignoringOtherApps: true)
    }

    private func fitWindowToVisibleScreen() {
        guard let screen = window.screen ?? NSScreen.main else { return }
        let visible = screen.visibleFrame
        window.minSize = NSSize(
            width: min(720, visible.width),
            height: min(520, visible.height)
        )
        var frame = window.frame
        frame.size.width = min(max(frame.width, window.minSize.width), visible.width)
        frame.size.height = min(max(frame.height, window.minSize.height), visible.height)
        frame.origin.x = min(max(frame.origin.x, visible.minX), visible.maxX - frame.width)
        frame.origin.y = min(max(frame.origin.y, visible.minY), visible.maxY - frame.height)
        window.setFrame(frame, display: false)
    }

    func windowDidChangeScreen(_ notification: Notification) {
        fitWindowToVisibleScreen()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func windowWillClose(_ notification: Notification) {
        DispatchQueue.main.async {
            NSApp.terminate(nil)
        }
    }

    private func installMenus() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(
            withTitle: "关于 Boom",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(.separator())
        let quit = NSMenuItem(
            title: "退出 Boom",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        appMenu.addItem(quit)

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editItem.submenu = editMenu
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(
            withTitle: "全选",
            action: #selector(NSText.selectAll(_:)),
            keyEquivalent: "a"
        )

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let viewMenu = NSMenu(title: "显示")
        viewItem.submenu = viewMenu
        let reload = NSMenuItem(title: "重新载入", action: #selector(reloadPage(_:)), keyEquivalent: "r")
        reload.target = self
        viewMenu.addItem(reload)
        viewMenu.addItem(.separator())
        viewMenu.addItem(
            withTitle: "进入全屏幕",
            action: #selector(NSWindow.toggleFullScreen(_:)),
            keyEquivalent: "f"
        ).keyEquivalentModifierMask = [.control, .command]

        NSApp.mainMenu = main
    }

    @objc private func reloadPage(_ sender: Any?) {
        webView.reload()
    }

    private func isAllowed(_ candidate: URL) -> Bool {
        candidate.scheme?.lowercased() == startURL.scheme?.lowercased()
            && candidate.host?.lowercased() == startURL.host?.lowercased()
            && effectivePort(candidate) == effectivePort(startURL)
    }

    private func openExternal(_ url: URL) {
        guard url.scheme == "http" || url.scheme == "https" else { return }
        NSWorkspace.shared.open(url)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if isAllowed(url) || url.scheme == "about" {
            decisionHandler(.allow)
        } else {
            if navigationAction.navigationType == .linkActivated { openExternal(url) }
            decisionHandler(.cancel)
        }
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            if isAllowed(url) {
                webView.load(navigationAction.request)
            } else {
                openExternal(url)
            }
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        exitCode = 1
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Boom 无法载入本地界面"
        alert.informativeText = error.localizedDescription
        alert.addButton(withTitle: "退出")
        alert.beginSheetModal(for: window) { _ in NSApp.terminate(nil) }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "boom",
              let body = message.body as? [String: Any] else { return }

        switch body["type"] as? String {
        case "setAppearance":
            applyAppearance(body["appearance"] as? String)
        case "pickDirectory":
            guard let requestID = body["id"] as? String else { return }
            presentDirectoryPanel(requestID: requestID, body: body)
        case "pickFiles":
            guard let requestID = body["id"] as? String else { return }
            presentFilePanel(requestID: requestID, body: body)
        default:
            return
        }
    }

    /// Keeps the native titlebar in sync with the in-app light/dark toggle;
    /// an unknown value falls back to following the system setting.
    private func applyAppearance(_ appearance: String?) {
        switch appearance {
        case "dark":
            NSApp.appearance = NSAppearance(named: .darkAqua)
        case "light":
            NSApp.appearance = NSAppearance(named: .aqua)
        default:
            NSApp.appearance = nil
        }
    }

    private func presentDirectoryPanel(requestID: String, body: [String: Any]) {
        let panel = NSOpenPanel()
        panel.title = body["title"] as? String ?? "选择目录"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        if let initial = body["initial"] as? String, !initial.isEmpty {
            var isDirectory: ObjCBool = false
            if FileManager.default.fileExists(atPath: initial, isDirectory: &isDirectory), isDirectory.boolValue {
                panel.directoryURL = URL(fileURLWithPath: initial)
            }
        }
        panel.beginSheetModal(for: window) { [weak self] response in
            self?.finishDirectoryRequest(
                id: requestID,
                path: response == .OK ? panel.url?.path : nil
            )
        }
    }

    /// Multi-select file panel, used to attach attachment files to a challenge.
    private func presentFilePanel(requestID: String, body: [String: Any]) {
        let panel = NSOpenPanel()
        panel.title = body["title"] as? String ?? "选择文件"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = body["multiple"] as? Bool ?? true
        panel.canCreateDirectories = false
        if let initial = body["initial"] as? String, !initial.isEmpty {
            var isDirectory: ObjCBool = false
            if FileManager.default.fileExists(atPath: initial, isDirectory: &isDirectory), isDirectory.boolValue {
                panel.directoryURL = URL(fileURLWithPath: initial)
            }
        }
        panel.beginSheetModal(for: window) { [weak self] response in
            let paths = response == .OK ? panel.urls.map { $0.path } : []
            self?.finishPickerRequest(id: requestID, path: paths.first, paths: paths)
        }
    }

    private func finishDirectoryRequest(id: String, path: String?) {
        finishPickerRequest(id: id, path: path, paths: [])
    }

    private func finishPickerRequest(id: String, path: String?, paths: [String]) {
        let payload: [String: Any] = ["id": id, "path": path ?? NSNull(), "paths": paths]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__boomNativePickerResult(\(json))")
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "确定")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn)
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        let input = NSTextField(string: defaultText ?? "")
        input.frame = NSRect(x: 0, y: 0, width: 360, height: 24)
        let alert = NSAlert()
        alert.messageText = prompt
        alert.accessoryView = input
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn ? input.stringValue : nil)
        }
    }
}

let arguments = CommandLine.arguments
guard arguments.count == 2,
      let startURL = URL(string: arguments[1]),
      startURL.scheme == "http",
      startURL.host == "127.0.0.1" else {
    fputs("Boom desktop client expects one loopback HTTP URL.\n", stderr)
    exit(64)
}

let application = NSApplication.shared
application.setActivationPolicy(.regular)
// The web UI reports its theme over the `boom` bridge and drives the titlebar from there.
let delegate = BoomAppDelegate(startURL: startURL)
application.delegate = delegate
application.run()
exit(delegate.exitCode)
