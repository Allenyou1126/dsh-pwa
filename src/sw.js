/**
 * DSH PWA service worker.
 *
 * Served as `<mount>/sw.js` by the dsh-pwa Host plugin and registered from the
 * Web UI index with a relative script URL and scope. It owns exactly two
 * things: the offline app shell and a cache-first layer for content-hashed
 * static assets.
 *
 * Everything that carries identity or live state stays on the network: the
 * OIDC endpoints (`auth/`), the DSH API and plugin/WebSocket routes are never
 * intercepted, and a response is only stored when it is a same-origin, 200,
 * non-redirected reply the server allows caching. In particular the
 * `/` → `auth/login` → IdP redirect chain is followed by the browser as a
 * normal navigation, so signing in works exactly as without a worker.
 */

/** Replaced by the Host plugin with `<package version>-<source digest>`. */
const VERSION = '__DSH_PWA_VERSION__'

/** Whether runtime caching is enabled; the Host plugin replaces `true`/`false`. */
const OFFLINE = '__DSH_PWA_OFFLINE__' === 'true'

const CACHE_PREFIX = 'dsh-pwa-'
const CACHE = CACHE_PREFIX + VERSION

/** The page's mount root, e.g. `https://dsh.example.com/` or `.../ui/`. */
const SCOPE_PATH = new URL(self.registration.scope).pathname
const SHELL_URL = new URL('./', self.registration.scope).href

/**
 * Paths relative to the mount that must always reach the network. Identity,
 * live state, plugin bundles and WebSocket upgrades have no business in a
 * cache: a stale reply here is a wrong reply.
 */
const BYPASS = [
  'auth/',
  'api/',
  'auth-api/',
  'connect',
  'pairing/',
  'oauth/',
  'open-in-app/',
  'hooks/',
  'inspector/',
  'plugins/',
  'ws',
  'dsh-pwa/',
]

/** Extensions safe to keep across reloads: they are content-addressed or static. */
const STATIC_EXT = /\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|webp|svg|ico|map)$/iu

/** A path relative to the mount root, e.g. `/ui/auth/login` → `auth/login`. */
function relativePath(url) {
  const path = url.pathname
  if (path.startsWith(SCOPE_PATH)) return path.slice(SCOPE_PATH.length)
  return path.replace(/^\/+/u, '')
}

/** Whether an entry matches `rel` exactly or as a directory prefix. */
function matches(rel, entry) {
  if (rel === entry) return true
  return rel.startsWith(entry.endsWith('/') ? entry : `${entry}/`)
}

/** Whether a request must bypass the worker entirely. */
function bypasses(url, request) {
  if (request.headers.get('upgrade') === 'websocket') return true
  const rel = relativePath(url)
  return BYPASS.some((entry) => matches(rel, entry))
}

/**
 * Whether a response may enter the cache: same-origin, complete, not a
 * followed redirect, and not marked `no-store`. A 401/403/503, an IdP page
 * reached through the sign-in redirect, and an opaque cross-origin response
 * all fail this test.
 */
function storable(response, request) {
  if (!response || response.status !== 200 || response.type !== 'basic') return false
  if (response.redirected) return false
  const url = new URL(response.url || request.url)
  if (url.origin !== self.location.origin) return false
  const cacheControl = response.headers.get('cache-control') || ''
  return !/(?:^|,)\s*no-store\b/iu.test(cacheControl)
}

/** Whether an asset is static enough to cache-first. */
function isStatic(request) {
  if (request.mode === 'navigate') return false
  const destination = request.destination
  if (destination === 'script' || destination === 'style' || destination === 'font' || destination === 'image') {
    return true
  }
  return STATIC_EXT.test(new URL(request.url).pathname)
}

/** Store a response when it is safe; a storage failure never fails the request. */
async function remember(request, response) {
  if (!storable(response, request)) return
  try {
    const cache = await caches.open(CACHE)
    await cache.put(request, response.clone())
  } catch {
    // Quota, unsupported scheme, or a body already used: the network reply stands.
  }
}

/** The offline page shown when a navigation has neither network nor shell. */
function offlinePage() {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH 离线</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; }
  main { max-width: 22rem; padding: 2rem; text-align: center; }
  h1 { margin: 0 0 .5rem; font-size: 1.25rem; }
  p { margin: 0 0 1.25rem; color: #94a3b8; }
  button { font: inherit; padding: .55rem 1.2rem; border-radius: .5rem; border: 1px solid #334155; background: #1e293b; color: inherit; cursor: pointer; }
  button:hover { background: #273449; }
  code { color: #cbd5e1; }
</style>
</head>
<body>
<main>
  <h1>当前离线</h1>
  <p>DeepSeek Harness 需要连接到服务器才能工作。请检查网络后重试。</p>
  <button type="button" onclick="location.reload()">重试</button>
</main>
</body>
</html>`
  return new Response(html, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Network-first for documents: fresh HTML wins, the cached shell covers offline. */
async function navigate(event) {
  const { request } = event
  try {
    const response = await fetch(request)
    await remember(request, response)
    return response
  } catch {
    const cached = (await caches.match(request)) || (await caches.match(SHELL_URL))
    return cached || offlinePage()
  }
}

/** Cache-first for static assets: hashed filenames make staleness impossible. */
async function asset(event) {
  const { request } = event
  const cached = await caches.match(request)
  if (cached) return cached
  const response = await fetch(request)
  await remember(request, response)
  return response
}

self.addEventListener('install', (event) => {
  // No pre-cache: the document requires the OIDC session, so there is nothing
  // safe to fetch before the user signs in. The shell is cached on first load.
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE)
      .map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return

  const rel = relativePath(url)

  // Signing out ends the session this cache was built under: drop it.
  if (rel === 'auth/logout' || rel.startsWith('auth/logout/')) {
    event.waitUntil(clearCaches())
    return
  }

  if (!OFFLINE) return
  if (bypasses(url, request)) return

  if (request.mode === 'navigate') {
    event.respondWith(navigate(event))
    return
  }
  if (isStatic(request)) event.respondWith(asset(event))
})

self.addEventListener('message', (event) => {
  const data = event.data
  if (data && data.type === 'SKIP_WAITING') self.skipWaiting()
  if (data && data.type === 'CLEAR_CACHES') event.waitUntil(clearCaches())
})

/** Delete every cache this worker owns. */
async function clearCaches() {
  const names = await caches.keys()
  await Promise.all(names
    .filter((name) => name.startsWith(CACHE_PREFIX))
    .map((name) => caches.delete(name)))
}
