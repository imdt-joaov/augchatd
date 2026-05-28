import type { Context } from "hono";

/**
 * GET /demo/ — the demo "integrator" wrapper page.
 *
 * Per contract-demo-mode + contract-ui-handshake, the demo unifies with
 * production by exercising the same iframe + postMessage handshake in
 * dev that an integrator will exercise in prod:
 *
 *   1. This wrapper boots in the browser.
 *   2. It iframes the bundled UI at "/" (the chat SPA).
 *   3. iframe → parent: postMessage({type:'augchatd:ready'})
 *   4. parent (this script) → POST /demo/sessions to mint a fresh
 *      session from the boot-time env, then postMessage(
 *      {type:'augchatd:jwt', jwt, theme}, origin) to the iframe.
 *
 * Each `augchatd:ready` triggers a fresh session — that's how the iframe
 * recovers from a 401 (e.g. server restart invalidates the previous
 * JWT). It just re-emits `augchatd:ready` and gets a new JWT back.
 *
 * In production the same handshake runs against the integrator's parent
 * page; the integrator's backend supplies the JWT instead of /demo/sessions.
 */

const DEMO_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>augchatd — demo</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; height: 100%; background: #000; }
  iframe { border: 0; width: 100vw; height: 100vh; display: block; }
  .err { padding: 1rem; font-family: ui-monospace, monospace; color: #f88; white-space: pre-wrap; }
</style>
</head>
<body>
<iframe id="app" title="augchatd demo"></iframe>
<script>
(() => {
  const PREFIX = '/demo';
  const iframe = document.getElementById('app');
  const origin = window.location.origin;
  function showFatalError(msg) {
    const el = document.createElement('div');
    el.className = 'err';
    el.textContent = 'augchatd demo: ' + msg;
    iframe.replaceWith(el);
  }
  async function mintAndSend() {
    let session;
    try {
      const r = await fetch('/demo/sessions', { method: 'POST' });
      if (!r.ok) throw new Error('POST /demo/sessions HTTP ' + r.status);
      session = await r.json();
    } catch (e) {
      console.error('demo: failed to mint session', e);
      showFatalError('failed to mint session — ' + (e && e.message ? e.message : e));
      return;
    }
    iframe.contentWindow.postMessage(
      { type: 'augchatd:jwt', jwt: session.jwt, theme: session.theme },
      origin,
    );
  }
  // Real path (not fragment) so the conversation id shows up in server logs.
  // ?parent_origin= lets the iframe enforce a strict origin check on the
  // postMessage handshake (same as production embedders should set).
  function iframePathFromParent() {
    const p = window.location.pathname;
    const qs = '?parent_origin=' + encodeURIComponent(origin);
    if (p === PREFIX || p === PREFIX + '/') return '/' + qs;
    if (p.indexOf(PREFIX + '/') === 0) return p.slice(PREFIX.length) + qs;
    return '/' + qs;
  }
  window.addEventListener('message', (e) => {
    if (e.origin !== origin) return;
    const d = e.data;
    if (!d) return;
    if (d.type === 'augchatd:ready') {
      mintAndSend();
    } else if (d.type === 'augchatd:route' && typeof d.path === 'string') {
      const newPath = d.path === '/' ? PREFIX + '/' : PREFIX + d.path;
      if (newPath !== window.location.pathname) {
        window.history.replaceState(null, '', newPath);
      }
    }
  });
  iframe.src = iframePathFromParent();
})();
</script>
</body>
</html>`;

export function demoPageHandler(c: Context): Response {
  return c.html(DEMO_PAGE_HTML);
}
