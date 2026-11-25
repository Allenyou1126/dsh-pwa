/** Host plugin entry: stable identity, required services, and the apply export. */
import { apply as applyPlugin } from './plugin.js'

/** Stable plugin name used by the bundle patch. */
export const name = 'dsh-pwa'

/** The service worker route and the index tap both need the HTTP carrier. */
export const inject = ['webServer']

/**
 * Register the service worker route and the index injection.
 * @param ctx - plugin context carrying `webServer`.
 * @param config - optional row config: `offline`, `autoReload`.
 */
export function apply(ctx, config) {
  applyPlugin(ctx, config)
}
