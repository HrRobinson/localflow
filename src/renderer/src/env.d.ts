/// <reference types="vite/client" />

// No local <webview> JSX declaration on purpose: @types/react ships its own
// webview intrinsic (WebViewHTMLAttributes), and with jsx: react-jsx that
// module declaration is what JSX checking resolves — a global
// `declare namespace React` augmentation here never takes effect (verified:
// deleting the old one changed no diagnostics). Its allowpopups is typed
// boolean, but React 19 drops boolean values for non-boolean attributes on
// non-standard elements, so BrowserPane renders the tag through a locally
// string-typed host-element alias instead.
