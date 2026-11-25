import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const template = readFileSync(new URL('../src/sw.js', import.meta.url), 'utf8')

function urlOf(request) {
  return typeof request === 'string' ? request : String(request.url)
}

function response({
  url = 'https://dsh.example.com/',
  status = 200,
  type = 'basic',
  redirected = false,
  cacheControl = null,
} = {}) {
  return {
    url,
    status,
    type,
    redirected,
    headers: { get: (name) => (name.toLowerCase() === 'cache-control' ? cacheControl : null) },
    clone() {
      return this
    },
  }
}

function request(url, overrides = {}) {
  return {
    url,
    method: 'GET',
    mode: 'navigate',
    destination: '',
    headers: { get: () => null },
    ...overrides,
  }
}

function load({ offline = true, scope = 'https://dsh.example.com/', fetchImpl } = {}) {
  const listeners = new Map()
  const store = new Map()
  const deleted = []
  const claimed = []
  let fetches = 0
  const caches = {
    async open() {
      return {
        async put(req, res) {
          store.set(urlOf(req), res)
        },
      }
    },
    async match(req) {
      return store.get(urlOf(req))
    },
    async keys() {
      return ['dsh-pwa-test-1', 'dsh-pwa-old', 'not-ours']
    },
    async delete(name) {
      deleted.push(name)
      return true
    },
  }
  const self = {
    registration: { scope },
    location: { origin: new URL(scope).origin },
    skipWaiting: async () => {},
    clients: { claim: async () => { claimed.push(true) } },
    addEventListener(type, fn) { listeners.set(type, fn) },
  }
  const fetch = async (req, init) => {
    fetches += 1
    if (!fetchImpl) throw new Error('offline')
    return fetchImpl(req, init)
  }
  const source = template
    .replaceAll('__DSH_PWA_VERSION__', 'test-1')
    .replaceAll('__DSH_PWA_OFFLINE__', offline ? 'true' : 'false')
  vm.runInContext(source, vm.createContext({ self, caches, fetch, Response, URL, console }))
  return {
    listeners,
    store,
    deleted,
    claimed,
    get fetches() { return fetches },
  }
}

function dispatch(scope, type, req) {
  const event = {
    request: req,
    responded: undefined,
    waits: [],
    respondWith(promise) { this.responded = Promise.resolve(promise) },
    waitUntil(promise) { this.waits.push(Promise.resolve(promise)) },
  }
  scope.listeners.get(type)(event)
  return event
}

test('bypasses every OIDC endpoint', () => {
  const scope = load({ fetchImpl: async () => response() })
  for (const path of ['/auth/login', '/auth/callback', '/auth/logout']) {
    const event = dispatch(scope, 'fetch', request(`https://dsh.example.com${path}`))
    assert.equal(event.responded, undefined, `${path} must reach the network`)
  }
})

test('bypasses the API, plugin bundles and WebSocket upgrades', () => {
  const scope = load({ fetchImpl: async () => response() })
  const api = dispatch(scope, 'fetch', request('https://dsh.example.com/api/session'))
  assert.equal(api.responded, undefined)
  const plugin = dispatch(scope, 'fetch', request('https://dsh.example.com/plugins/x/client.js'))
  assert.equal(plugin.responded, undefined)
  const upgrade = dispatch(scope, 'fetch', request('https://dsh.example.com/ws', {
    mode: 'no-cors',
    headers: { get: (name) => (name === 'upgrade' ? 'websocket' : null) },
  }))
  assert.equal(upgrade.responded, undefined)
})

test('caches the authenticated shell and serves it offline', async () => {
  let online = true
  const shell = response()
  const scope = load({
    fetchImpl: async () => {
      if (!online) throw new Error('offline')
      return shell
    },
  })
  const first = dispatch(scope, 'fetch', request('https://dsh.example.com/'))
  assert.equal(await first.responded, shell)
  assert.equal(scope.store.get('https://dsh.example.com/'), shell)

  online = false
  const second = dispatch(scope, 'fetch', request('https://dsh.example.com/'))
  assert.equal(await second.responded, shell)
})

test('never caches the IdP page reached through the sign-in redirect', async () => {
  const idp = response({ url: 'https://idp.example.com/login', status: 0, type: 'opaque', redirected: true })
  const scope = load({ fetchImpl: async () => idp })
  const first = dispatch(scope, 'fetch', request('https://dsh.example.com/'))
  assert.equal(await first.responded, idp)
  assert.equal(scope.store.size, 0)

  const offlineScope = load()
  const second = dispatch(offlineScope, 'fetch', request('https://dsh.example.com/'))
  const page = await second.responded
  assert.equal(page.status, 503)
  assert.match(await page.text(), /离线/u)
})

test('honours Cache-Control: no-store', async () => {
  const scope = load({ fetchImpl: async () => response({ cacheControl: 'private, no-store' }) })
  await dispatch(scope, 'fetch', request('https://dsh.example.com/')).responded
  assert.equal(scope.store.size, 0)
})

test('cache-firsts static assets without refetching', async () => {
  const asset = response({ url: 'https://dsh.example.com/assets/app-abc.js' })
  const scope = load({ fetchImpl: async () => asset })
  const req = request('https://dsh.example.com/assets/app-abc.js', { mode: 'no-cors', destination: 'script' })
  assert.equal(await dispatch(scope, 'fetch', req).responded, asset)
  assert.equal(await dispatch(scope, 'fetch', req).responded, asset)
  assert.equal(scope.fetches, 1)
})

test('keeps cross-origin assets out of the cache', async () => {
  const foreign = response({ url: 'https://cdn.example.com/app.js' })
  const scope = load({ fetchImpl: async () => foreign })
  const req = request('https://dsh.example.com/assets/app.js', { destination: 'script' })
  await dispatch(scope, 'fetch', req).responded
  assert.equal(scope.store.size, 0)
})

test('clears the shell when the browser signs out', async () => {
  const scope = load({ fetchImpl: async () => response() })
  const event = dispatch(scope, 'fetch', request('https://dsh.example.com/auth/logout'))
  assert.equal(event.responded, undefined)
  await Promise.all(event.waits)
  assert.deepEqual(scope.deleted.sort(), ['dsh-pwa-old', 'dsh-pwa-test-1'])
})

test('activate drops old caches and claims clients', async () => {
  const scope = load()
  const event = { waits: [], waitUntil(promise) { this.waits.push(Promise.resolve(promise)) } }
  scope.listeners.get('activate')(event)
  await Promise.all(event.waits)
  assert.deepEqual(scope.deleted, ['dsh-pwa-old'])
  assert.equal(scope.claimed.length, 1)
})

test('offline=false leaves navigations to the browser', () => {
  const scope = load({ offline: false, fetchImpl: async () => response() })
  const event = dispatch(scope, 'fetch', request('https://dsh.example.com/'))
  assert.equal(event.responded, undefined)
  assert.equal(scope.fetches, 0)
})

test('resolves bypass paths under a mount prefix', () => {
  const scope = load({ scope: 'https://dsh.example.com/ui/', fetchImpl: async () => response() })
  const login = dispatch(scope, 'fetch', request('https://dsh.example.com/ui/auth/login'))
  assert.equal(login.responded, undefined)
  const asset = dispatch(scope, 'fetch', request('https://dsh.example.com/ui/plugins/x/client.js'))
  assert.equal(asset.responded, undefined)
})
