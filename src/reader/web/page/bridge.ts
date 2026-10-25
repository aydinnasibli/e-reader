// Talking to the reader screen. The screen calls window.__nec(message) through
// injectJavaScript; the page answers with window.ReactNativeWebView.postMessage.

import type { FromPage, ToPage } from '../protocol';

type Host = { ReactNativeWebView?: { postMessage(data: string): void }; __nec?: (m: ToPage) => void };

export function send(m: FromPage) {
  (window as unknown as Host).ReactNativeWebView?.postMessage(JSON.stringify(m));
}

export function listen(handle: (m: ToPage) => void) {
  (window as unknown as Host).__nec = (m) => {
    try {
      handle(m);
    } catch (e) {
      send({ t: 'error', message: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) });
    }
  };
  window.addEventListener('error', (e) => send({ t: 'error', message: `${e.message} (${e.filename}:${e.lineno})` }));
  window.addEventListener('unhandledrejection', (e) => send({ t: 'error', message: String((e as PromiseRejectionEvent).reason) }));
}
