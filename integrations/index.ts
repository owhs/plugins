// Integrations — the connector runtime: OAuth2 dance, encrypted-at-rest token
// storage with automatic refresh, connection testing, and automation actions
// registered as `<connector>.<action>` (e.g. google.sendEmail, xero.createInvoice).
//
// Adding a service = one entry in connectors.ts. Everything else is generic.

import type { PluginContext } from '../../blockhouse/src/core/plugin.ts'
import type { PluginManifest } from '../../blockhouse/src/core/types.ts'
import { CONNECTORS, byId, type ConnectorDef, type ConnectorRunCtx } from './connectors.ts'
import { interpolate } from '../automations/index.ts'
import { randomToken } from '../../blockhouse/src/core/util.ts'

export const manifest: PluginManifest = {
  id: 'integrations', name: 'Integrations', version: '0.1.0', builtin: true,
  description: 'OAuth2 + API connectors: Google (Gmail/Drive), Xero, Zapier/Make, and any REST API',
  permissions: ['routes.api', 'routes.public', 'secure.tables', 'settings.own', 'net.fetch', 'actions.register', 'events.emit'],
}

interface StoredToken {
  access_token?: string
  refresh_token?: string
  expires_at?: number
  identity?: string
  connectedAt?: string
}

export async function register(ctx: PluginContext) {
  ctx.adminPanel({ label: 'Integrations', icon: 'plug' })

  // ---------- custom connectors (defined in the studio, stored as JSON) ----------
  // site/integrations/custom/<id>.json → a full ConnectorDef via a generic REST
  // executor: url/headers/body templates interpolated from {opts.*}, {payload.*},
  // {config.*}. Same admin card, same automation actions as built-ins.

  const CUSTOM_DIR = 'site/integrations/custom'

  function customToConnector(def: any): ConnectorDef {
    const baseSettings = def.auth === 'apikey'
      ? [
        { key: 'apiKey', label: 'API key', secret: true, required: true },
        { key: 'authStyle', label: 'Auth style', help: 'bearer · header · basic' },
        { key: 'headerName', label: 'Header name (for header style)' },
      ]
      : []
    return {
      id: def.id, name: def.name || def.id, description: def.description || 'Custom connector',
      icon: def.icon || 'plug', auth: def.auth || 'none', docs: def.docs,
      settings: [...baseSettings, ...(def.settings || [])],
      test: def.testUrl ? async rc => {
        const res = await rc.fetch(interpolate(String(def.testUrl), { config: rc.config } as any))
        return { ok: res.ok, detail: `${res.status} ${res.statusText}` }
      } : undefined,
      actions: (def.actions || []).map((a: any) => ({
        key: a.key, label: a.label || a.key, description: a.description, fields: a.fields || [],
        run: async (rc: ConnectorRunCtx, opts: Record<string, any>, payload: Record<string, any>) => {
          const scope: any = { opts, payload, config: rc.config }
          const url = interpolate(String(a.url || ''), scope)
          if (!url) throw new Error(`${def.id}.${a.key}: url template missing`)
          const headers: Record<string, string> = {}
          for (const [k, v] of Object.entries(a.headers || {})) headers[k] = interpolate(String(v), scope)
          const body = a.body ? interpolate(String(a.body), scope) : undefined
          const res = await rc.fetch(url, { method: a.method || 'POST', headers, body })
          const text = await res.text()
          let parsed: any; try { parsed = JSON.parse(text) } catch { parsed = text.slice(0, 2000) }
          if (!res.ok) throw new Error(`${def.id}.${a.key}: HTTP ${res.status} — ${typeof parsed === 'string' ? parsed.slice(0, 200) : JSON.stringify(parsed).slice(0, 200)}`)
          return { status: res.status, body: parsed }
        },
      })),
    }
  }

  async function loadCustomDefs(): Promise<any[]> {
    const out: any[] = []
    try {
      for (const key of await ctx.env.driver.list(CUSTOM_DIR)) {
        if (!key.endsWith('.json')) continue
        try {
          const def = JSON.parse((await ctx.env.driver.readText(key)) || '')
          if (def?.id) out.push(def)
        } catch {}
      }
    } catch {}
    return out
  }

  let customRaw = await loadCustomDefs()
  let customConnectors = customRaw.map(customToConnector)
  const allConnectors = () => [...CONNECTORS, ...customConnectors]
  const findDef = (id: string) => allConnectors().find(d => d.id === id)

  const cfgKey = (id: string) => `cfg:${id}`
  const tokKey = (id: string) => `tok:${id}`

  const getConfig = (id: string) => ctx.store.kvGet<Record<string, any>>(cfgKey(id), {})
  const setConfig = (id: string, v: Record<string, any>) => ctx.store.kvSet(cfgKey(id), v)
  const getToken = (id: string) => ctx.store.kvGet<StoredToken>(tokKey(id), {})
  const setToken = (id: string, v: StoredToken) => ctx.store.kvSet(tokKey(id), v)

  async function redirectUri(): Promise<string> {
    const site = await ctx.env.site()
    return `${site.url}/x/integrations/callback`
  }

  /** Refresh an OAuth token when it's within 60s of expiry. */
  async function ensureToken(def: ConnectorDef, id: string): Promise<StoredToken> {
    const tok = await getToken(id)
    if (def.auth !== 'oauth2' || !tok.refresh_token) return tok
    if (tok.expires_at && tok.expires_at - 60_000 > Date.now()) return tok
    const cfg = await getConfig(id)
    const res = await ctx.fetch(def.oauth!.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tok.refresh_token,
        client_id: cfg.clientId || '',
        client_secret: cfg.clientSecret || '',
      }).toString(),
    })
    const data: any = await res.json().catch(() => ({}))
    if (!res.ok || !data.access_token) { ctx.log(`token refresh failed for ${id}`, data); return tok }
    const next: StoredToken = {
      ...tok,
      access_token: data.access_token,
      refresh_token: data.refresh_token || tok.refresh_token,
      expires_at: Date.now() + (Number(data.expires_in || 3600) * 1000),
    }
    await setToken(id, next)
    return next
  }

  /** Authenticated fetch for a connector — applies the right auth automatically. */
  async function runCtxFor(def: ConnectorDef): Promise<ConnectorRunCtx> {
    const config = await getConfig(def.id)
    const token = await ensureToken(def, def.id)
    const authedFetch = async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers as any)
      if (def.auth === 'oauth2' && token.access_token) headers.set('authorization', `Bearer ${token.access_token}`)
      if (def.auth === 'apikey' && config.apiKey) {
        const style = config.authStyle || 'bearer'
        if (style === 'bearer') headers.set('authorization', `Bearer ${config.apiKey}`)
        else if (style === 'header') headers.set(config.headerName || 'X-API-Key', config.apiKey)
        else if (style === 'basic') headers.set('authorization', `Basic ${btoa(config.apiKey)}`)
      }
      return ctx.fetch(url, { ...init, headers })
    }
    return { fetch: authedFetch, config, token, interpolate, log: ctx.log }
  }

  // ---------- register automation actions for every connector ----------
  function registerConnectorActions(def: ConnectorDef) {
    for (const action of def.actions) {
      ctx.actions.register({
        type: `${def.id}.${action.key}`,
        label: `${def.name}: ${action.label}`,
        fields: action.fields || [],
        run: async (opts, payload) => {
          const rc = await runCtxFor(def)
          if (def.auth === 'oauth2' && !rc.token.access_token) throw new Error(`${def.name} is not connected — connect it in Studio → Integrations`)
          const result = await action.run(rc, opts, payload)
          await ctx.env.events.emit('integration.ran', { connector: def.id, action: action.key })
          return result
        },
      })
    }
  }
  for (const def of allConnectors()) registerConnectorActions(def)

  // ---------- admin API ----------
  ctx.routes.api(app => {
    app.get('/connectors', async c => {
      const out = []
      for (const def of allConnectors()) {
        const cfg = await getConfig(def.id)
        const tok = await getToken(def.id)
        const connected = def.auth === 'oauth2'
          ? !!tok.access_token
          : def.auth === 'webhook' ? !!cfg.hookUrl
          : def.auth === 'apikey' ? !!cfg.baseUrl
          : true
        out.push({
          id: def.id, name: def.name, description: def.description, icon: def.icon,
          auth: def.auth, docs: def.docs,
          settings: def.settings.map(s => ({ ...s, value: s.secret ? (cfg[s.key] ? '••••••••' : '') : (cfg[s.key] ?? '') })),
          scopes: def.oauth?.scopes || [],
          actions: def.actions.map(a => ({ key: `${def.id}.${a.key}`, label: a.label, description: a.description, fields: a.fields })),
          connected, identity: tok.identity || '', connectedAt: tok.connectedAt || '',
          redirectUri: await redirectUri(),
          custom: customConnectors.some(cc => cc.id === def.id),
        })
      }
      return c.json({ connectors: out })
    })

    app.put('/connectors/:id', async c => {
      const def = findDef(c.req.param('id'))
      if (!def) return c.json({ error: 'unknown connector' }, 404)
      const body = await c.req.json()
      const cfg = await getConfig(def.id)
      for (const s of def.settings) {
        const v = body[s.key]
        if (v === undefined) continue
        if (s.secret && (v === '' || v === '••••••••')) continue   // keep existing secret
        cfg[s.key] = v
      }
      await setConfig(def.id, cfg)
      return c.json({ ok: true })
    })

    app.post('/connectors/:id/test', async c => {
      const def = findDef(c.req.param('id'))
      if (!def?.test) return c.json({ ok: false, detail: 'no test available' })
      try {
        const rc = await runCtxFor(def)
        return c.json(await def.test(rc))
      } catch (e: any) {
        return c.json({ ok: false, detail: String(e?.message || e) })
      }
    })

    app.post('/connectors/:id/disconnect', async c => {
      await setToken(c.req.param('id'), {})
      return c.json({ ok: true })
    })

    // begin the OAuth dance — returns the URL for the studio to open
    app.post('/connectors/:id/connect', async c => {
      const def = findDef(c.req.param('id'))
      if (!def?.oauth) return c.json({ error: 'connector does not use OAuth' }, 400)
      const cfg = await getConfig(def.id)
      if (!cfg.clientId) return c.json({ error: 'Set the client ID and secret first' }, 400)
      const stateTok = randomToken(16)
      await ctx.store.kvSet(`state:${stateTok}`, { id: def.id, at: Date.now() })
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: cfg.clientId,
        redirect_uri: await redirectUri(),
        scope: def.oauth.scopes.join(' '),
        state: stateTok,
        ...(def.oauth.extraAuthParams || {}),
      })
      return c.json({ url: `${def.oauth.authUrl}?${params.toString()}` })
    })

    // Run any connector action by hand — the tester behind every action's
    // “Run…” button. Executes for real against the connected account.
    app.post('/connectors/:id/run', async c => {
      const def = findDef(c.req.param('id'))
      if (!def) return c.json({ error: 'unknown connector' }, 404)
      const { action, options, payload } = await c.req.json()
      const act = def.actions.find(a => a.key === action)
      if (!act) return c.json({ error: 'unknown action' }, 404)
      try {
        const rc = await runCtxFor(def)
        if (def.auth === 'oauth2' && !rc.token.access_token) return c.json({ error: `${def.name} is not connected` }, 400)
        const started = Date.now()
        const result = await act.run(rc, options || {}, payload || {})
        return c.json({ ok: true, ms: Date.now() - started, result })
      } catch (e: any) {
        return c.json({ ok: false, error: String(e?.message || e) })
      }
    })

    // ----- custom connector definitions -----
    app.get('/custom', async c => c.json({ defs: customRaw }))
    app.put('/custom/:id', async c => {
      const id = c.req.param('id')
      if (!/^[a-z][a-z0-9-]*$/.test(id)) return c.json({ error: 'id must be lowercase letters/numbers/dashes' }, 400)
      if (CONNECTORS.some(d => d.id === id)) return c.json({ error: 'that id belongs to a built-in connector' }, 400)
      const { def } = await c.req.json()
      if (!def || def.id !== id) return c.json({ error: 'bad definition' }, 400)
      await ctx.env.driver.write(`${CUSTOM_DIR}/${id}.json`, JSON.stringify(def, null, 2))
      customRaw = customRaw.filter(d => d.id !== id).concat([def])
      customConnectors = customRaw.map(customToConnector)
      // hot-register its automation actions (re-registering overwrites cleanly)
      registerConnectorActions(customConnectors.find(d => d.id === id)!)
      return c.json({ ok: true })
    })
    app.delete('/custom/:id', async c => {
      const id = c.req.param('id')
      await ctx.env.driver.delete(`${CUSTOM_DIR}/${id}.json`).catch?.(() => {})
      customRaw = customRaw.filter(d => d.id !== id)
      customConnectors = customRaw.map(customToConnector)
      return c.json({ ok: true, note: 'existing automations using its actions keep working until restart' })
    })
  })

  // ---------- OAuth callback (public route the provider redirects to) ----------
  ctx.routes.public(app => {
    app.get('/callback', async c => {
      const code = c.req.query('code'), stateTok = c.req.query('state')
      if (!code || !stateTok) return c.html(page('Missing code', 'The provider did not return an authorization code.'), 400)
      const stored = await ctx.store.kvGet<any>(`state:${stateTok}`, null)
      if (!stored || Date.now() - stored.at > 10 * 60_000) return c.html(page('Expired', 'This authorization link expired — start again from Studio → Integrations.'), 400)
      const def = findDef(stored.id)
      if (!def?.oauth) return c.html(page('Unknown connector', ''), 400)
      const cfg = await getConfig(def.id)

      const res = await ctx.fetch(def.oauth.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: await redirectUri(),
          client_id: cfg.clientId || '',
          client_secret: cfg.clientSecret || '',
        }).toString(),
      })
      const data: any = await res.json().catch(() => ({}))
      if (!res.ok || !data.access_token) {
        return c.html(page('Could not connect', String(data.error_description || data.error || `HTTP ${res.status}`)), 400)
      }
      const tok: StoredToken = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + Number(data.expires_in || 3600) * 1000,
        connectedAt: new Date().toISOString(),
      }
      await setToken(def.id, tok)

      // resolve a human label, and for Xero capture the tenant id
      try {
        const rc = await runCtxFor(def)
        if (def.oauth.identify) tok.identity = await def.oauth.identify(rc)
        if (def.id === 'xero') {
          const r = await rc.fetch('https://api.xero.com/connections')
          const conns: any = await r.json().catch(() => [])
          if (Array.isArray(conns) && conns[0]) { cfg.tenantId = conns[0].tenantId; await setConfig(def.id, cfg) }
        }
        await setToken(def.id, tok)
      } catch {}

      await ctx.store.kvSet(`state:${stateTok}`, null)
      await ctx.env.events.emit('integration.connected', { connector: def.id, identity: tok.identity })
      return c.html(page(`${def.name} connected`, `${tok.identity ? `Signed in as ${tok.identity}. ` : ''}You can close this window and return to the studio.`))
    })
  })
}

function page(title: string, text: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;display:grid;place-content:center;justify-items:center;min-height:100vh;margin:0;background:light-dark(#f4f6f5,#12160f);color:light-dark(#1b1f1c,#e8efe9);color-scheme:light dark;text-align:center;padding:2rem}
main{max-width:26rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#7a8a80}a{color:#3e7d5f}</style></head>
<body><main><h1>${title}</h1><p>${text}</p><p><a href="/admin/#/p/integrations">← Back to the studio</a></p></main></body></html>`
}
