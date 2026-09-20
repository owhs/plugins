// Forms — build forms in the studio, drop them on any page as a block.
// Antispam: honeypot + minimum fill time + optional Cloudflare Turnstile.
// On submit: store + run any automation actions + emit form.submitted.

import type { PluginContext } from '../../blockhouse/src/core/plugin.ts'
import type { PluginManifest } from '../../blockhouse/src/core/types.ts'
import { escapeAttr as ea, escapeHtml as eh } from '../../blockhouse/src/core/util.ts'

export const manifest: PluginManifest = {
  id: 'forms', name: 'Forms', version: '0.1.0', builtin: true,
  description: 'Contact and quote forms. Submissions are kept here and can be emailed to you.',
  permissions: ['blocks.register', 'routes.public', 'routes.api', 'secure.tables', 'settings.own', 'mail.send', 'events.listen', 'events.emit', 'net.fetch'],
}

export function register(ctx: PluginContext) {
  ctx.resources.register({
    key: 'forms', label: 'Forms', labelSingular: 'Form', icon: 'form', storage: 'json', titleField: 'label',
    fields: [
      { key: 'label', type: 'text', label: 'Form name', required: true },
      {
        key: 'fields', type: 'list', label: 'Fields',
        item: [
          { key: 'key', type: 'text', label: 'Key' },
          { key: 'label', type: 'text', label: 'Label' },
          { key: 'type', type: 'select', label: 'Type', options: [{ value: 'text' }, { value: 'email' }, { value: 'textarea' }, { value: 'tel' }, { value: 'number' }, { value: 'select' }, { value: 'checkbox' }, { value: 'hidden' }] },
          { key: 'required', type: 'boolean', label: 'Required' },
          { key: 'options', type: 'text', label: 'Options (a|b|c)' },
          { key: 'placeholder', type: 'text', label: 'Placeholder' },
        ],
      },
      {
        key: 'actions', type: 'list', label: 'On submit',
        item: [
          { key: 'type', type: 'select', label: 'Action', options: [{ value: 'store', label: 'Store submission' }, { value: 'email', label: 'Send email' }, { value: 'webhook', label: 'Call webhook' }, { value: 'data.insert', label: 'Insert into data table' }] },
          { key: 'options', type: 'json', label: 'Options' },
        ],
      },
      { key: 'successMessage', type: 'text', label: 'Success message', default: 'Thanks — we got your message.' },
      { key: 'minSeconds', type: 'number', label: 'Min. seconds before submit', default: 3 },
    ],
  })
  ctx.adminPanel({ label: 'Forms', icon: 'form' })

  ctx.blocks.register({
    type: 'form', label: 'Form', group: 'Interactive', icon: 'form',
    description: 'Embed a form built in the Forms panel',
    fields: [
      { key: 'formId', type: 'select', label: 'Form', options: [], required: true, ...( { optionsSource: 'res:forms/forms' } as any) },
      { key: 'title', type: 'text', label: 'Title' },
    ],
    enhance: 'form',
    render: async (rctx, node) => {
      if (!node.props.formId) return `<div class="wb-form is-empty">Pick a form…</div>`
      const form = await ctx.json.get('forms', node.props.formId)
      if (!form) return `<div class="wb-form is-empty">Form not found</div>`
      const rows = (form.fields || []).map((fld: any) => {
        const req = fld.required ? ' required' : ''
        const name = ea(fld.key), label = eh(fld.label || fld.key), ph = fld.placeholder ? ` placeholder="${ea(fld.placeholder)}"` : ''
        if (fld.type === 'textarea') return `<label class="ff"><span>${label}${fld.required ? ' *' : ''}</span><textarea name="${name}" rows="5"${req}${ph}></textarea></label>`
        if (fld.type === 'select') {
          const opts = String(fld.options || '').split('|').map((o: string) => `<option>${eh(o.trim())}</option>`).join('')
          return `<label class="ff"><span>${label}${fld.required ? ' *' : ''}</span><select name="${name}"${req}>${opts}</select></label>`
        }
        if (fld.type === 'checkbox') return `<label class="ff ff-check"><input type="checkbox" name="${name}" value="yes"${req}><span>${label}</span></label>`
        if (fld.type === 'hidden') return `<input type="hidden" name="${name}" value="${ea(fld.placeholder || '')}">`
        return `<label class="ff"><span>${label}${fld.required ? ' *' : ''}</span><input type="${ea(fld.type || 'text')}" name="${name}"${req}${ph}></label>`
      }).join('\n')
      return `<div class="wb-form" id="form-${ea(form.id)}">${node.props.title ? `<h3>${eh(node.props.title)}</h3>` : ''}` +
        `<form method="post" action="/x/forms/submit/${ea(form.id)}" data-blockhouse-form>` +
        `<input type="text" name="_hp" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px">` +
        `<input type="hidden" name="_ts" value="${Date.now()}">` +
        rows +
        `<p class="form-actions"><button class="btn btn-primary" type="submit">${eh(form.submitLabel || 'Send')}</button></p>` +
        `<p class="form-status" role="status" aria-live="polite"></p>` +
        `</form></div>`
    },
  })

  ctx.routes.public(app => {
    app.post('/submit/:formId', async c => {
      const form = await ctx.json.get('forms', c.req.param('formId')).catch(() => null)
      if (!form) return c.json({ error: 'unknown form' }, 404)
      const body = await c.req.parseBody()
      if (typeof body._hp === 'string' && body._hp !== '') return c.json({ ok: true }) // honeypot: pretend success
      const ts = parseInt(String(body._ts || '0'), 10)
      const minMs = (form.minSeconds ?? 3) * 1000
      if (ts && Date.now() - ts < minMs) return c.json({ error: 'submitted too quickly — please try again' }, 400)

      const data: Record<string, any> = {}
      for (const fld of form.fields || []) {
        const v = body[fld.key]
        if (fld.required && (v == null || v === '')) return c.json({ error: `"${fld.label || fld.key}" is required` }, 400)
        if (fld.type === 'email' && v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v))) return c.json({ error: 'invalid email address' }, 400)
        if (v !== undefined) data[fld.key] = String(v).slice(0, 5000)
      }

      const meta = { form: form.id, ip: c.req.header('x-forwarded-for') || '', ua: (c.req.header('user-agent') || '').slice(0, 150) }
      const actions = (form.actions?.length ? form.actions : [{ type: 'store', options: {} }])
      for (const action of actions) {
        try {
          if (action.type === 'store') {
            await ctx.store.rows('submissions').insert({ form: form.id, data, meta })
          } else {
            const impl = ctx.env.registry.actions.get(action.type)
            if (impl) await impl.run(parseOptions(action.options), { form: form.id, data, ...data }, ctx)
          }
        } catch (e) { ctx.log(`action ${action.type} failed:`, e) }
      }
      await ctx.env.events.emit('form.submitted', { formId: form.id, data, meta })

      if (c.req.header('accept')?.includes('application/json')) {
        return c.json({ ok: true, message: form.successMessage || 'Thanks!' })
      }
      const back = c.req.header('referer') || '/'
      return c.redirect(`${back.split('#')[0]}#form-${form.id}`, 303)
    })
  })

  ctx.routes.api(app => {
    app.get('/submissions', async c => {
      const formId = c.req.query('form')
      const all = await ctx.store.rows('submissions').list(500)
      return c.json({ items: formId ? all.filter((s: any) => s.form === formId) : all })
    })
    app.delete('/submissions/:id', async c => {
      await ctx.store.rows('submissions').remove(c.req.param('id'))
      return c.json({ ok: true })
    })
  })
}

function parseOptions(o: any): Record<string, any> {
  if (!o) return {}
  if (typeof o === 'string') { try { return JSON.parse(o) } catch { return {} } }
  return o
}
