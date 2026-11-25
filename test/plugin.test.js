import assert from 'node:assert/strict'
import test from 'node:test'
import { name, inject } from '../src/index.js'
import { apply, buildWorker, injectIndex, registrationScript } from '../src/plugin.js'

function makeCtx() {
  const routes = new Map()
  const taps = []
  const logs = []
  const cleanups = []
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
      tapIndex(fn) {
        taps.push(fn)
        return () => {
          const at = taps.indexOf(fn)
          if (at !== -1) taps.splice(at, 1)
        }
      },
    },
    logger: {
      info(message) { logs.push(message) },
    },
    effect(fn) {
      const dispose = fn()
      cleanups.push(dispose)
      return dispose
    },
  }
  return { ctx, routes, taps, logs, cleanups }
}

function makeRes() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers = {}) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body
    },
  }
}

test('exports a stable identity and injects the Web carrier', () => {
  assert.equal(name, 'dsh-pwa')
  assert.deepEqual(inject, ['webServer'])
})

test('registers one anonymous exact /sw.js route and one index tap', () => {
  const { ctx, routes, taps } = makeCtx()
  apply(ctx)
  assert.deepEqual([...routes.keys()], ['/sw.js'])
  assert.equal(routes.get('/sw.js').kind, 'exact')
  assert.equal(routes.get('/sw.js').auth, 'anonymous', 'the worker script must load before sign-in')
  assert.equal(taps.length, 1)
})

test('serves the worker script with update-proof headers', () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const res = makeRes()
  routes.get('/sw.js').handler({ method: 'GET' }, res)
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /javascript/u)
  assert.match(res.headers['cache-control'], /no-store/u)
  assert.equal(res.headers['service-worker-allowed'], '/')
  assert.match(res.body, /const VERSION = '0\.1\.0-[0-9a-f]{8}'/u)
  assert.match(res.body, /const OFFLINE = 'true' === 'true'/u)
  assert.doesNotMatch(res.body, /__DSH_PWA_/u)
})

test('answers HEAD without a body and refuses other methods', () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const head = makeRes()
  routes.get('/sw.js').handler({ method: 'HEAD' }, head)
  assert.equal(head.status, 200)
  assert.equal(head.body, undefined)

  const post = makeRes()
  routes.get('/sw.js').handler({ method: 'POST' }, post)
  assert.equal(post.status, 405)
  assert.equal(post.headers.allow, 'GET, HEAD')
})

test('injects a relative registration that never reloads by default', () => {
  const script = registrationScript()
  assert.match(script, /register\('\.\/sw\.js', \{ scope: '\.\/', updateViaCache: 'none' \}\)/u)
  assert.match(script, /window\.isSecureContext/u)
  assert.doesNotMatch(script, /controllerchange/u)
})

test('injects the update reload only when configured', () => {
  const script = registrationScript({ autoReload: true })
  assert.match(script, /controllerchange/u)
  assert.match(script, /hadController/u)
})

test('appends the snippet before the last closing body tag', () => {
  const script = '<script>1</script>'
  assert.equal(
    injectIndex('<!doctype html><body><p>x</p></body></html>', script),
    `<!doctype html><body><p>x</p>${script}</body></html>`,
  )
  assert.equal(injectIndex('<!doctype html><p>x</p>', script), `<!doctype html><p>x</p>${script}`)
})

test('buildWorker honours the offline switch', () => {
  assert.match(buildWorker({ offline: false }), /const OFFLINE = 'false' === 'true'/u)
  assert.match(buildWorker({ offline: true }), /const OFFLINE = 'true' === 'true'/u)
})

test('the effect cleanup removes the route and the tap', () => {
  const { ctx, routes, taps, cleanups } = makeCtx()
  apply(ctx)
  assert.equal(cleanups.length, 1)
  cleanups[0]()
  assert.equal(routes.size, 0)
  assert.equal(taps.length, 0)
})
