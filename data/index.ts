// Data suite — a small relational app builder.
//
// Tables have rich field schemas: text/number/date/select/multiselect/boolean/
// currency, computed (safe expressions incl. sum/count/avg over line-items),
// relation (link to rows of another table), and line-items (a repeating group
// with per-row and aggregate calculations — the heart of the quote calculator).
// Rows move through a workflow (states + role-gated transitions → kanban), can
// be cloned, imported from CSV, exposed via scoped API keys, and rendered to a
// printable report via a Liquid template (quote/invoice/spec sheet).

import type { PluginContext } from '../../blockhouse/src/core/plugin.ts'
import type { PluginManifest, FieldDef } from '../../blockhouse/src/core/types.ts'
import { tryEvaluate } from '../../blockhouse/src/core/expr.ts'
import { checkApiKey, hasScope, issueApiKey } from '../../blockhouse/src/auth/tokens.ts'
import { escapeHtml as eh } from '../../blockhouse/src/core/util.ts'
import { mdToHtml } from '../../blockhouse/src/core/markdown.ts'

export const manifest: PluginManifest = {
  id: 'data', name: 'Data & apps', version: '0.2.0', builtin: true,
  description: 'Relational tables, line-item calculators, workflows, reports and scoped API keys',
  permissions: ['routes.public', 'routes.api', 'secure.tables', 'settings.own', 'actions.register', 'events.emit', 'content.read'],
}

export interface DataField extends FieldDef {
  relation?: string          // table id for relation fields
  aggregate?: string         // for computed over a line-items field
  validate?: string          // expression that must be truthy
  showIf?: string            // conditional visibility
  requireIf?: string         // conditional requirement
  currency?: string          // symbol for currency type
  multi?: boolean            // multiselect
  group?: string             // group heading
}

export interface DataTable {
  id: string
  label: string
  fields: DataField[]
  titleField?: string
  workflow?: { states: { key: string; label: string; color?: string }[]; transitions?: { from: string; to: string; roles?: string[] }[] }
  dateField?: string         // for gantt/calendar
  endDateField?: string
  report?: string            // liquid template for printable reports
  publicRead?: boolean
  publicWrite?: boolean
}

export function register(ctx: PluginContext) {
  // ----- table designer (rich, nested field schema) -----
  ctx.resources.register({
    key: 'tables', label: 'Tables & apps', labelSingular: 'Table', icon: 'db', storage: 'json', titleField: 'label',
    fields: [
      { key: 'label', type: 'text', label: 'Table name', required: true },
      { key: 'titleField', type: 'text', label: 'Title field key', help: 'Which field labels a row', width: 'half' },
      {
        key: 'fields', type: 'list', label: 'Fields',
        item: [
          { key: 'key', type: 'text', label: 'Key' },
          { key: 'label', type: 'text', label: 'Label' },
          { key: 'type', type: 'select', label: 'Type', options: ['text', 'textarea', 'number', 'currency', 'boolean', 'date', 'select', 'multiselect', 'relation', 'computed', 'lineitems'].map(v => ({ value: v })) },
          { key: 'group', type: 'text', label: 'Group', help: 'Optional heading' },
          { key: 'options', type: 'text', label: 'Options (a|b|c)' },
          { key: 'relation', type: 'text', label: 'Relation table id' },
          { key: 'currency', type: 'text', label: 'Currency symbol' },
          { key: 'computed', type: 'text', label: 'Computed expression', help: 'e.g. round(sum(lines,"total")*1.2, 2)' },
          { key: 'default', type: 'text', label: 'Default' },
          { key: 'required', type: 'boolean', label: 'Required' },
          { key: 'validate', type: 'text', label: 'Validation expr' },
          { key: 'suggest', type: 'text', label: 'Autocomplete from', help: 'table:<id>.<field> · concept:<name>.<field> · title:<concept> · or a|b|c preset' },
          { key: 'showIf', type: 'text', label: 'Show if (expr)' },
          {
            key: 'item', type: 'list', label: 'Line-item columns (for lineitems)',
            item: [
              { key: 'key', type: 'text', label: 'Key' },
              { key: 'label', type: 'text', label: 'Label' },
              { key: 'type', type: 'select', label: 'Type', options: ['text', 'number', 'currency', 'computed', 'select'].map(v => ({ value: v })) },
              { key: 'options', type: 'text', label: 'Options (a|b|c)' },
              { key: 'computed', type: 'text', label: 'Computed', help: 'e.g. qty*price' },
            ],
          },
        ],
      },
      {
        key: 'workflow', type: 'json', label: 'Workflow (states + transitions)',
        help: '{"states":[{"key":"draft","label":"Draft"},{"key":"sent","label":"Sent","color":"#c90"}],"transitions":[{"from":"draft","to":"sent"}]}',
      },
      { key: 'dateField', type: 'text', label: 'Date field (gantt/calendar)', width: 'half' },
      { key: 'endDateField', type: 'text', label: 'End-date field (gantt)', width: 'half' },
      { key: 'report', type: 'code', label: 'Report template (Liquid)', help: 'Rendered at /x/data/report/<table>/<row>. Vars: row, table, site' },
      { key: 'publicRead', type: 'boolean', label: 'Public API read (with key)', width: 'half' },
      { key: 'publicWrite', type: 'boolean', label: 'Public API write (with key)', width: 'half' },
    ],
  })
  ctx.adminPanel({ label: 'Data & apps', icon: 'db' })

  const schema = (id: string): Promise<DataTable | null> => ctx.json.get('tables', id).catch(() => null)
  const rowsOf = (id: string) => ctx.store.rows(`t:${id}`)

  // resolve relation labels + compute all derived values for a row
  async function decorate(table: DataTable, row: Record<string, any>) {
    const out: Record<string, any> = { ...row }
    for (const f of table.fields) {
      if (f.type === 'relation' && f.relation && row[f.key]) {
        const rel = await schema(f.relation)
        const relRow = rel ? await rowsOf(f.relation).get(row[f.key]) : null
        out[`${f.key}__label`] = relRow ? (relRow[rel!.titleField || 'id'] || relRow.id) : row[f.key]
      }
    }
    return computeRow(table, out)
  }

  // ----- admin API -----
  ctx.routes.api(app => {
    app.get('/rows/:table', async c => {
      const t = await schema(c.req.param('table'))
      if (!t) return c.json({ error: 'unknown table' }, 404)
      const items = await rowsOf(t.id).list(2000)
      const decorated = await Promise.all(items.map((r: any) => decorate(t, r)))
      if (c.req.query('format') === 'csv') {
        const cols = ['id', ...t.fields.filter(f => f.type !== 'lineitems').map(f => f.key), 'createdAt']
        const csv = [cols.join(','), ...decorated.map((r: any) => cols.map(k => csvCell(r[k])).join(','))].join('\n')
        return c.body(csv, 200, { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${t.id}.csv"` })
      }
      return c.json({ table: t, items: decorated })
    })
    app.get('/row/:table/:id', async c => {
      const t = await schema(c.req.param('table'))
      if (!t) return c.json({ error: 'unknown table' }, 404)
      const r = await rowsOf(t.id).get(c.req.param('id'))
      return c.json({ item: r ? await decorate(t, r) : null })
    })
    app.post('/rows/:table', async c => {
      const t = await schema(c.req.param('table'))
      if (!t) return c.json({ error: 'unknown table' }, 404)
      const body = await c.req.json()
      const err = validateRow(t, body)
      if (err) return c.json({ error: err }, 400)
      const row = computeRow(t, coerce(t, body))
      if (t.workflow?.states?.length && !row._state) row._state = t.workflow.states[0].key
      const rid = await rowsOf(t.id).insert(row)
      await ctx.env.events.emit('data.row.created', { table: t.id, id: rid, row })
      return c.json({ item: { id: rid, ...row } })
    })
    app.put('/rows/:table/:id', async c => {
      const t = await schema(c.req.param('table'))
      if (!t) return c.json({ error: 'unknown table' }, 404)
      const body = await c.req.json()
      const err = validateRow(t, body)
      if (err) return c.json({ error: err }, 400)
      const row = computeRow(t, coerce(t, body))
      await rowsOf(t.id).update(c.req.param('id'), row)
      await ctx.env.events.emit('data.row.updated', { table: t.id, id: c.req.param('id'), row })
      return c.json({ item: { id: c.req.param('id'), ...row } })
    })
    app.post('/rows/:table/:id/clone', async c => {
      const t = await schema(c.req.param('table'))
      if (!t) return c.json({ error: 'unknown table' }, 404)
      const src = await rowsOf(t.id).get(c.req.param('id'))
      if (!src) return c.json({ error: 'not found' }, 404)
      const { id: _i, createdAt: _c, updatedAt: _u, ...data } = src
      if (t.workflow?.states?.length) data._state = t.workflow.states[0].key
      const rid = await rowsOf(t.id).insert(computeRow(t, data))
      return c.json({ item: { id: rid, ...data } })
    })
    app.post('/rows/:table/:id/state', async c => {
      const t = await schema(c.req.param('table'))
      if (!t?.workflow) return c.json({ error: 'no workflow' }, 400)
      const { to } = await c.req.json()
      const row = await rowsOf(t.id).get(c.req.param('id'))
      if (!row) return c.json({ error: 'not found' }, 404)
      const from = row._state || t.workflow.states[0]?.key
      const trans = (t.workflow.transitions || []).find(x => x.from === from && x.to === to)
      // if transitions are declared, enforce them + role gates; else allow any state
      if ((t.workflow.transitions || []).length) {
        const user = c.get('user' as never) as any
        if (!trans) return c.json({ error: `transition ${from}→${to} not allowed` }, 400)
        if (trans.roles?.length && !trans.roles.includes(user?.role)) return c.json({ error: 'your role cannot make this transition' }, 403)
      }
      row._state = to
      await rowsOf(t.id).update(c.req.param('id'), row)
      await ctx.env.events.emit('data.state.changed', { table: t.id, id: c.req.param('id'), from, to })
      return c.json({ ok: true, state: to })
    })
    app.get('/rows/:table/export.csv', async c => {
      const t = await schema(c.req.param('table'))
      if (!t) return c.json({ error: 'unknown table' }, 404)
      const rows = await rowsOf(t.id).list(5000)
      const cols = t.fields.filter((f: any) => f.type !== 'lineitems').map((f: any) => f.key)
      const esc = (v: any) => { const s2 = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s2) ? `"${s2.replace(/"/g, '""')}"` : s2 }
      const lines = [['id', ...cols, '_state'].join(',')]
      for (const r of rows) lines.push([r.id, ...cols.map((k: string) => esc(r[k])), r._state || ''].join(','))
      return c.body(lines.join('\n'), 200, { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${t.id}.csv"` })
    })

    app.delete('/rows/:table/:id', async c => {
      await rowsOf(c.req.param('table')).remove(c.req.param('id'))
      return c.json({ ok: true })
    })
    app.post('/import/:table', async c => {
      const t = await schema(c.req.param('table'))
      if (!t) return c.json({ error: 'unknown table' }, 404)
      const { rows } = await c.req.json()
      let n = 0
      for (const r of rows || []) { await rowsOf(t.id).insert(computeRow(t, coerce(t, r))); n++ }
      return c.json({ imported: n })
    })

    // options for relation pickers
    app.get('/options/:table', async c => {
      const t = await schema(c.req.param('table'))
      if (!t) return c.json({ options: [] })
      const items = await rowsOf(t.id).list(1000)
      return c.json({ options: items.map((r: any) => ({ value: r.id, label: r[t.titleField || 'id'] || r.id })) })
    })

    // API keys
    app.get('/keys', async c => c.json({
      keys: (await ctx.env.secure.listTokens('apikey')).map((k: any) => ({ id: k.id, name: k.meta.name, scopes: k.meta.scopes, createdAt: k.createdAt })),
    }))
    app.post('/keys', async c => {
      const { name, scopes } = await c.req.json()
      if (!name || !Array.isArray(scopes)) return c.json({ error: 'name and scopes[] required' }, 400)
      const { key, id } = await issueApiKey(ctx.env.secure, name, scopes)
      return c.json({ key, id })
    })
    app.delete('/keys/:id', async c => { await ctx.env.secure.deleteToken(c.req.param('id')); return c.json({ ok: true }) })
  })

  // ----- printable report -----
  ctx.routes.public(app => {
    app.get('/report/:table/:id', async c => {
      const t = await schema(c.req.param('table'))
      if (!t?.report) return c.json({ error: 'no report template' }, 404)
      const raw = await rowsOf(t.id).get(c.req.param('id'))
      if (!raw) return c.json({ error: 'not found' }, 404)
      const row = await decorate(t, raw)
      const site = await ctx.env.site()
      try {
        const inner = await ctx.env.liquid.parseAndRender(t.report, { row, table: t, site, id: c.req.param('id') })
        return c.html(reportShell(t.label, site.name, inner))
      } catch (e: any) {
        return c.html(reportShell(t.label, site.name, `<p style="color:#c00">Report template error: ${eh(String(e.message || e))}</p>`), 500)
      }
    })

    // scoped public API
    app.use('/api/*', async (c, next) => {
      const key = await checkApiKey(ctx.env.secure, c.req.header('authorization'))
      if (!key) return c.json({ error: 'api key required' }, 401)
      ;(c as any).set('apikey', key)
      await next()
    })
    app.get('/api/:table', async c => {
      const t = await schema(c.req.param('table'))
      if (!t?.publicRead) return c.json({ error: 'not available' }, 404)
      if (!hasScope((c as any).get('apikey'), `data:${t.id}:read`)) return c.json({ error: 'missing scope' }, 403)
      const items = await rowsOf(t.id).list(2000)
      return c.json({ items: await Promise.all(items.map((r: any) => decorate(t, r))) })
    })
    app.post('/api/:table', async c => {
      const t = await schema(c.req.param('table'))
      if (!t?.publicWrite) return c.json({ error: 'not available' }, 404)
      if (!hasScope((c as any).get('apikey'), `data:${t.id}:write`)) return c.json({ error: 'missing scope' }, 403)
      const body = await c.req.json()
      const err = validateRow(t, body)
      if (err) return c.json({ error: err }, 400)
      const row = computeRow(t, coerce(t, body))
      const rid = await rowsOf(t.id).insert(row)
      await ctx.env.events.emit('data.row.created', { table: t.id, id: rid, row })
      return c.json({ item: { id: rid, ...row } })
    })
  })

  // ----- automation action -----
  ctx.actions.register({
    type: 'data.insert', label: 'Insert a data row',
    run: async (o, payload) => {
      const t = await schema(o.table)
      if (!t) throw new Error(`data.insert: unknown table "${o.table}"`)
      const source = o.map ? Object.fromEntries(Object.entries(o.map).map(([k, path]) => {
        let cur: any = payload
        for (const part of String(path).replace(/[{}]/g, '').split('.')) cur = cur?.[part]
        return [k, cur]
      })) : (payload.data || payload)
      const row = computeRow(t, coerce(t, source))
      if (t.workflow?.states?.length) row._state = t.workflow.states[0].key
      const rid = await rowsOf(t.id).insert(row)
      await ctx.env.events.emit('data.row.created', { table: t.id, id: rid, row })
      return { id: rid }
    },
  })
}

// ---------- helpers ----------

function coerce(table: DataTable, body: any): Record<string, any> {
  const out: Record<string, any> = {}
  if (body._state) out._state = body._state
  for (const f of table.fields) {
    let v = body[f.key]
    if (f.type === 'number' || f.type === 'currency') v = v === '' || v == null ? null : Number(v)
    else if (f.type === 'boolean') v = !!v && v !== 'false'
    else if (f.type === 'multiselect') v = Array.isArray(v) ? v : (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : [])
    else if (f.type === 'lineitems') v = Array.isArray(v) ? v.map(li => computeLineItem(f, li)) : []
    if (v !== undefined) out[f.key] = v ?? null
  }
  return out
}

function computeLineItem(field: any, li: Record<string, any>): Record<string, any> {
  const row: Record<string, any> = {}
  for (const col of field.item || []) {
    let v = li[col.key]
    if (col.type === 'number' || col.type === 'currency') v = v === '' || v == null ? 0 : Number(v)
    row[col.key] = v ?? (col.type === 'number' || col.type === 'currency' ? 0 : '')
  }
  for (const col of field.item || []) if (col.computed) row[col.key] = tryEvaluate(col.computed, row, 0)
  return row
}

function computeRow(table: DataTable, row: Record<string, any>): Record<string, any> {
  const out = { ...row }
  // recompute line-items first (so aggregates see fresh totals)
  for (const f of table.fields) {
    if (f.type === 'lineitems' && Array.isArray(out[f.key])) out[f.key] = out[f.key].map((li: any) => computeLineItem(f, li))
  }
  for (const f of table.fields) {
    if (f.type === 'computed' && f.computed) out[f.key] = tryEvaluate(f.computed, out, null)
  }
  return out
}

function validateRow(table: DataTable, body: any): string | null {
  const vars = coerce(table, body)
  for (const f of table.fields) {
    if (f.showIf && !tryEvaluate(f.showIf, vars, 1)) continue
    const required = f.required || (f.requireIf && tryEvaluate(f.requireIf, vars, 0))
    if (required && (vars[f.key] == null || vars[f.key] === '' || (Array.isArray(vars[f.key]) && !vars[f.key].length))) {
      return `${f.label || f.key} is required`
    }
    if (f.validate && vars[f.key] != null && vars[f.key] !== '' && !tryEvaluate(f.validate, vars, 1)) {
      return `${f.label || f.key} failed validation`
    }
  }
  return null
}

function csvCell(v: any): string {
  if (v == null) return ''
  const s = Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function reportShell(title: string, siteName: string, inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${eh(title)} — ${eh(siteName)}</title>
<style>
  :root{color-scheme:light}
  body{font-family:ui-sans-serif,system-ui,sans-serif;color:#1a1a1f;background:#f4f4f6;margin:0;padding:2rem;line-height:1.6}
  .report{max-width:48rem;margin:0 auto;background:#fff;padding:3rem;box-shadow:0 2px 20px #0001;border-radius:6px}
  h1{font-size:1.6rem;margin:0 0 0.3rem} h2{font-size:1.1rem;margin:1.6rem 0 0.5rem}
  table{width:100%;border-collapse:collapse;margin:1rem 0}
  th,td{text-align:left;padding:0.5rem 0.7rem;border-bottom:1px solid #e5e5ea}
  th{font-size:0.72rem;text-transform:uppercase;letter-spacing:0.05em;color:#888}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
  .totals td{border:0;padding:0.25rem 0.7rem} .totals .grand{font-weight:700;font-size:1.15rem;border-top:2px solid #1a1a1f}
  .muted{color:#888} .right{text-align:right}
  .print-btn{position:fixed;top:1rem;right:1rem;padding:0.5rem 1rem;border:0;border-radius:8px;background:#163527;color:#fff;font-weight:600;cursor:pointer}
  @media print{.print-btn{display:none}body{background:#fff;padding:0}.report{box-shadow:none;max-width:none}}
</style></head><body>
<button class="print-btn" onclick="print()">Print / Save PDF</button>
<div class="report">${inner}</div></body></html>`
}
