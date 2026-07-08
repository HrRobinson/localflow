/// <reference types="vite/client" />

// The <webview> tag is enabled via webviewTag: true (main). React has no
// intrinsic for it; typed here once. Methods (goBack, loadURL, …) come from
// Electron.WebviewTag via the ref cast in BrowserPane.
declare namespace React {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string
          partition?: string
          allowpopups?: boolean
        },
        HTMLElement
      >
    }
  }
}
