// Automations — zapier-style recipes: when <event> [matching filter] → run
// actions. Registers the base action set; other plugins add their own
// (data.insert, ai.generate…). Inbound webhooks can trigger recipes too.

import type { PluginContext } from '../../blockhouse/src/core/plugin.ts'
import type { PluginManifest } from '../../blockhouse/src/core/types.ts'

export const manifest: PluginManifest = {
  id: 'automations', name: 'Automations', version: '0.1.0', builtin: true,
  description: 'Event-driven recipes: webhooks, emails, content ops, inbound triggers',
  permissions: ['events.listen', 'events.emit', 'routes.public', 'routes.api', 'secure.tables', 'settings.own', 'mail.send', 'net.fetch', 'actions.register', 'content.read', 'content.write'],
}

/** '{data.email}' style interpolation from the event payload. */
export function interpolate(template: string, payload: Record<string, any>): string {
  return String(template ?? '').replace(/\{([\w.]+)\}/g, (_, path) => {
    let cur: any = payload
    for (const part of path.split('.')) cur = cur?.[part]
    return cur == null ? '' : typeof cur === 'object' ? JSON.stringify(cur) : String(cur)
  })
}

function matches(filter: any, payload: Record<string, any>): boolean {
  if (!filter || typeof filter !== 'object') return true
  return Object.entries(filter).every(([k, v]) => {
    let cur: any = payload
    for (const part of k.split('.')) cur = cur?.[part]
    return String(cur) === String(v)
  })
}

export function register(ctx: PluginContext) {
  // ---------- base actions ----------

  ctx.actions.register({
    type: 'webhook', label: 'Call a webhook',
    fields: [
      { key: 'url', label: 'URL', required: true, help: 'Supports {field} from the payload' },
      { key: 'method', label: 'Method', type: 'select', options: [{ value: 'POST' }, { value: 'GET' }, { value: 'PUT' }] },
      { key: 'payload', label: 'Body (JSON)', type: 'json', help: 'Blank sends the whole event payload' },
    ],
    run: async (o, payload) => {
      if (!o.url) throw new Error('webhook: url required')
      const res = await ctx.fetch(interpolate(o.url, payload), {
        method: o.method || 'POST',
        headers: { 'content-type': 'application/json', ...(o.headers || {}) },
        body: o.method === 'GET' ? undefined : JSON.stringify(o.payload ? JSON.parse(interpolate(JSON.stringify(o.payload), payload)) : payload),
      })
      return { status: res.status }
    },
  })

  ctx.actions.register({
    type: 'email', label: 'Send an email',
    fields: [
      { key: 'to', label: 'To', required: true, help: '{data.email} pulls from the payload' },
      { key: 'subject', label: 'Subject' },
      { key: 'body', label: 'Body', type: 'textarea' },
    ],
    run: async (o, payload) => {
      await ctx.mail.send({
        to: interpolate(o.to || '', payload),
        subject: interpolate(o.subject || 'Notification', payload),
        text: interpolate(o.body || JSON.stringify(payload, null, 2), payload),
      })
    },
  })

  ctx.actions.register({
    type: 'log', label: 'Write to the log',
    fields: [{ key: 'note', label: 'Note' }],
    run: async (o, payload) => { await ctx.store.kvSet(`log:${Date.now()}`, { note: o.note, payload }) },
  })

  ctx.actions.register({
    type: 'content.publish', label: 'Publish a document',
    fields: [{ key: 'docId', label: 'Document id', help: 'Default {docId} from the payload' }],
    run: async (o, payload) => {
      const docId = interpolate(o.docId || '{docId}', payload)
      if (docId) await ctx.env.content.publish(docId)
    },
  })

  ctx.actions.register({
    type: 'emit', label: 'Emit a custom event',
    fields: [{ key: 'event', label: 'Event name' }],
    run: async (o, payload) => { await ctx.events.emit(o.event || 'custom', payload) },
  })

  // ---------- recipes ----------

  ctx.resources.register({
    key: 'recipes', label: 'Recipes', labelSingular: 'Recipe', icon: 'bolt', storage: 'json', titleField: 'label',
    fields: [
      { key: 'label', type: 'text', label: 'Name', required: true },
      { key: 'on', type: 'text', label: 'Trigger event', help: 'e.g. form.submitted, content.published, webhook.received, data.rows.created — * suffix matches prefixes', required: true },
      { key: 'filter', type: 'json', label: 'Filter (payload must match)', help: '{"formId":"contact"}' },
      {
        key: 'actions', type: 'list', label: 'Actions',
        item: [
          { key: 'type', type: 'text', label: 'Action type', help: 'webhook · email · log · data.insert · ai.generate · content.publish · emit' },
          { key: 'options', type: 'json', label: 'Options' },
        ],
      },
      { key: 'enabled', type: 'boolean', label: 'Enabled', default: true },
    ],
  })
  ctx.adminPanel({ label: 'Automations', icon: 'bolt' })

  /** Run one recipe against a payload. Shared by real events and studio test runs. */
  async function execute(r: any, payload: Record<string, any>, event: string, opts: { test?: boolean } = {}) {
    const run: any = { recipe: r.id, label: r.label, event, startedAt: Date.now(), steps: [], ...(opts.test ? { test: true } : {}) }
    for (const a of r.actions || []) {
      const impl = ctx.env.registry.actions.get(a.type)
      if (!impl) { run.steps.push({ type: a.type, error: 'unknown action' }); continue }
      try {
        const result = await impl.run(parseJson(a.options) || {}, { event, ...payload }, ctx)
        run.steps.push({ type: a.type, ok: true, ...(result ? { result } : {}) })
      } catch (e: any) {
        run.steps.push({ type: a.type, error: String(e?.message || e) })
      }
    }
    run.ms = Date.now() - run.startedAt
    await ctx.env.secure.log('automation', run)
    return run
  }

  ctx.events.on('*', async (payload, event) => {
    if (event.startsWith('automations.')) return // avoid loops on our own events
    const recipes = await ctx.json.list('recipes')
    for (const r of recipes) {
      if (!r.enabled) continue
      const on = String(r.on || '')
      const hit = on === event || (on.endsWith('*') && event.startsWith(on.slice(0, -1)))
      if (!hit || !matches(parseJson(r.filter), payload)) continue
      await execute(r, payload, event)
    }
  })

  // ---------- inbound webhook trigger ----------

  ctx.routes.public(app => {
    app.post('/hook/:key', async c => {
      const key = c.req.param('key')
      const secret = c.req.query('s') || c.req.header('x-blockhouse-secret') || ''
      const expected = await ctx.settings.get<Record<string, string>>('hookSecrets', {})
      if (!expected[key] || expected[key] !== secret) return c.json({ error: 'unauthorized' }, 401)
      let body: any = {}
      try { body = await c.req.json() } catch {}
      await ctx.env.events.emit('webhook.received', { key, body })
      return c.json({ ok: true })
    })
  })

  ctx.routes.api(app => {
    app.get('/runs', async c => c.json({ items: await ctx.env.secure.logsList('automation', 100) }))

    // Everything the recipe builder needs: registered actions with their forms.
    app.get('/actions', async c => c.json({
      actions: [...ctx.env.registry.actions.values()].map((a: any) => ({ type: a.type, label: a.label, fields: a.fields || [] })),
    }))

    // Dry run: interpolate every step against a sample payload WITHOUT executing.
    // Shows exactly what would be sent where, so you can check before firing.
    app.post('/dryrun', async c => {
      const { recipe, payload } = await c.req.json()
      const merged = { event: recipe?.on || 'test', ...(payload || {}) }
      const condition = matches(parseJson(recipe?.filter), merged)
      const steps = (recipe?.actions || []).map((a: any) => {
        const impl = ctx.env.registry.actions.get(a.type)
        const opts = parseJson(a.options) || {}
        const resolved: Record<string, any> = {}
        for (const [k, v] of Object.entries(opts)) {
          resolved[k] = typeof v === 'string' ? interpolate(v, merged) : v
        }
        return { type: a.type, known: !!impl, label: (impl as any)?.label || a.type, resolved }
      })
      return c.json({ condition, steps })
    })

    // Test run: executes the actions for real (emails send, webhooks fire) and
    // returns the run record. Marked test:true in the history.
    app.post('/testrun', async c => {
      const { recipe, payload } = await c.req.json()
      const run = await execute(recipe, payload || {}, recipe?.on || 'test', { test: true })
      return c.json({ run })
    })
    app.get('/hooks', async c => c.json({ hooks: await ctx.settings.get('hookSecrets', {}) }))
    app.post('/hooks', async c => {
      const { key } = await c.req.json()
      if (!/^[a-z0-9-]+$/.test(key || '')) return c.json({ error: 'key must be a-z0-9-' }, 400)
      const secrets = await ctx.settings.get<Record<string, string>>('hookSecrets', {})
      secrets[key] = ctx.util.id('') + ctx.util.id('')
      await ctx.settings.set('hookSecrets', secrets)
      return c.json({ key, secret: secrets[key], url: `/x/automations/hook/${key}?s=${secrets[key]}` })
    })
  })
}

function parseJson(v: any): any {
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return undefined }
}
