// Webview preload — first-pass fake fullscreen injection at document-start.
// Injects a <script> tag into the main world that replaces the Fullscreen API
// with a CSS-based fake.  Sites with a strict CSP may block this tag; the main
// process re-injects the same code via executeJavaScript (bypasses CSP) at dom-ready.

(function () {
  'use strict';

  const injectedCode = require('./fake-fullscreen-code');

  const script = document.createElement('script');
  script.textContent = injectedCode;
  (document.head || document.documentElement).prepend(script);
  script.remove();
})();
