/**
 * Serve the dsh-pwa service worker and register it from the Web UI index.
 *
 * The worker script and its registration are the whole Host surface: DSH
 * 0.2.3 already ships the Web App Manifest, the install icons and the
 * standalone display mode, so this bundle deliberately does not override
 * `/manifest.webmanifest` or any icon route. That keeps the deployment away
 * from the failure mode where an authenticated route shadows the manifest a
 * browser fetches without credentials.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
const workerTemplate = readFileSync(join(here, 'sw.js'), 'utf8')

/** Defaults for a row that names no config. */
const DEFAULTS = {
  /** Cache the app shell and static assets for offline opening. */
  offline: true,
  /** Reload the page once when an updated worker takes control. */
  autoReload: false,
}

/** A stable cache identity per worker source; any edit produces a new worker. */
function sourceVersion(source) {
  return `${manifest.version}-${createHash('sha1').update(source).digest('hex').slice(0, 8)}`
}

/** Build the served worker from the template and this row's config. */
export function buildWorker(config = {}) {
  const settings = { ...DEFAULTS, ...config }
  return workerTemplate
    .replaceAll('__DSH_PWA_VERSION__', sourceVersion(workerTemplate))
    .replaceAll('__DSH_PWA_OFFLINE__', settings.offline ? 'true' : 'false')
}

/**
 * The registration snippet injected before `</body>`.
 * `./sw.js` and `./` resolve against the mount root, so a deployment behind a
 * path prefix (`https://host/ui/`) registers `/ui/sw.js` with scope `/ui/`
 * without the plugin knowing the prefix.
 */
export function registrationScript(config = {}) {
  const settings = { ...DEFAULTS, ...config }
  const reload = settings.autoReload
    ? `  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!hadController) { hadController = true; return; }
    if (reloading) return;
    reloading = true;
    location.reload();
  });`
    : ''
  return `<script data-dsh-pwa>
(function () {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  var hadController = !!navigator.serviceWorker.controller;
  var reloading = false;
${reload}
  navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' })
    .then(function (registration) {
      setInterval(function () { registration.update().catch(function () {}); }, 3600000);
    })
    .catch(function (error) { console.warn('[dsh-pwa] service worker registration failed:', error); });
})();
</script>`
}

/** Insert the snippet before the closing body tag, or append when absent. */
export function injectIndex(html, script) {
  const at = html.toLowerCase().lastIndexOf('</body>')
  return at === -1 ? html + script : html.slice(0, at) + script + html.slice(at)
}

/**
 * Register the worker route and the index injection.
 * @param ctx - plugin context with `webServer`.
 * @param config - row config: `offline`, `autoReload`.
 */
export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config }
  const worker = buildWorker(settings)
  const script = registrationScript(settings)

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'exact',
      path: '/sw.js',
      // The browser fetches this script without a document session; it must
      // stay reachable before signing in, exactly like the built-in manifest.
      auth: 'anonymous',
      handler(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
          res.end()
          return
        }
        res.writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'no-cache, no-store, must-revalidate',
          'service-worker-allowed': '/',
          'x-content-type-options': 'nosniff',
        })
        res.end(req.method === 'HEAD' ? undefined : worker)
      },
    })
    const disposeTap = ctx.webServer.tapIndex((html) => injectIndex(html, script))
    return () => {
      disposeTap()
      disposeRoute()
    }
  }, 'dsh-pwa: service worker')

  ctx.logger.info(`[dsh-pwa] service worker active (offline=${settings.offline}, autoReload=${settings.autoReload})`)
}
