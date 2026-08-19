// Newsletter — lists, double opt-in subscribe block, unsubscribe links,
// and simple markdown campaigns through the configured mail driver.

import type { PluginContext } from '../../blockhouse/src/core/plugin.ts'
import type { PluginManifest } from '../../blockhouse/src/core/types.ts'
import { checkToken, issueToken } from '../../blockhouse/src/auth/tokens.ts'
import { mdToHtml } from '../../blockhouse/src/core/markdown.ts'
import { escapeAttr as ea, escapeHtml as eh } from '../../blockhouse/src/core/util.ts'

export const manifest: PluginManifest = {
  id: 'newsletter', name: 'Newsletter', version: '0.1.0', builtin: true,
  description: 'Email lists with double opt-in, signup blocks and campaigns',
  permissions: ['blocks.register', 'routes.public', 'routes.api', 'secure.tables', 'settings.own', 'mail.send', 'events.emit'],
}

export function register(ctx: PluginContext) {
  ctx.resources.register({
    key: 'lists', label: 'Lists', labelSingular: 'List', icon: 'mail', storage: 'json', titleField: 'label',
    fields: [
      { key: 'label', type: 'text', label: 'List name', required: true },
      { key: 'description', type: 'text', label: 'Description' },
    ],
  })
  ctx.adminPanel({ label: 'Newsletter', icon: 'mail' })

  ctx.blocks.register({
    type: 'newsletter-signup', label: 'Newsletter signup', group: 'Interactive', icon: 'mail',
    fields: [
      { key: 'listId', type: 'select', label: 'List', options: [], ...( { optionsSource: 'res:newsletter/lists' } as any) },
      { key: 'title', type: 'text', label: 'Title', default: 'Stay in the loop' },
      { key: 'text', type: 'text', label: 'Text', default: 'No spam — unsubscribe any time.' },
      { key: 'buttonLabel', type: 'text', label: 'Button', default: 'Subscribe' },
    ],
    enhance: 'form',
    render: (_r, node) => {
      const p = node.props
      if (!p.listId) return `<div class="wb-newsletter is-empty">Pick a list…</div>`
      return `<div class="wb-newsletter"><div class="nl-copy"><h3>${eh(p.title)}</h3><p>${eh(p.text)}</p></div>` +
        `<form method="post" action="/x/newsletter/subscribe" data-blockhouse-form class="nl-form">` +
        `<input type="hidden" name="list" value="${ea(p.listId)}">` +
        `<input type="text" name="_hp" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px">` +
        `<label class="visually-hidden" for="nl-${ea(node.id)}">Email address</label>` +
        `<input id="nl-${ea(node.id)}" type="email" name="email" placeholder="you@example.com" required>` +
        `<button class="btn btn-primary" type="submit">${eh(p.buttonLabel)}</button>` +
        `<p class="form-status" role="status" aria-live="polite"></p></form></div>`
    },
  })

  ctx.routes.public(app => {
    app.post('/subscribe', async c => {
      const body = await c.req.parseBody()
      if (typeof body._hp === 'string' && body._hp !== '') return c.json({ ok: true })
      const email = String(body.email || '').toLowerCase().trim()
      const listId = String(body.list || '')
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'invalid email' }, 400)
      const list = await ctx.json.get('lists', listId).catch(() => null)
      if (!list) return c.json({ error: 'unknown list' }, 404)

      const existing = await ctx.env.secure.subscriberByEmail(listId, email)
      if (existing?.status === 'confirmed') return respond(c, "You're already subscribed — thank you!")

      await ctx.env.secure.subscriberUpsert(listId, email, 'pending')
      const { token } = await issueToken(ctx.env.secure, 'nl-confirm', { meta: { listId, email }, ttlMs: 3 * 864e5, maxUses: 1 })
      const site = await ctx.env.site()
      await ctx.mail.send({
        to: email, subject: `Confirm your subscription to ${site.name}`,
        text: `Hi!\n\nConfirm your subscription to "${list.label}" here:\n${site.url}/x/newsletter/confirm?t=${token}\n\nIf you didn't request this, just ignore this email.`,
      })
      return respond(c, 'Almost there — check your inbox to confirm.')
    })

    app.get('/confirm', async c => {
      const row = await checkToken(ctx.env.secure, 'nl-confirm', c.req.query('t') || '')
      if (!row) return c.html(tinyPage('Link expired', 'This confirmation link is no longer valid. Please subscribe again.'), 400)
      await ctx.env.secure.useToken(row.id)
      const { token: unsub } = await issueToken(ctx.env.secure, 'nl-unsub', { meta: row.meta })
      await ctx.env.secure.subscriberUpsert(row.meta.listId, row.meta.email, 'confirmed', { unsub })
      await ctx.env.events.emit('newsletter.subscribed', { listId: row.meta.listId, email: row.meta.email })
      return c.html(tinyPage('Subscribed ✓', "You're on the list. Welcome aboard!"))
    })

    app.get('/unsubscribe', async c => {
      const row = await checkToken(ctx.env.secure, 'nl-unsub', c.req.query('t') || '')
      if (!row) return c.html(tinyPage('Link invalid', 'This unsubscribe link is not valid.'), 400)
      await ctx.env.secure.subscriberUpsert(row.meta.listId, row.meta.email, 'unsubscribed')
      return c.html(tinyPage('Unsubscribed', "You've been removed from the list. Take care!"))
    })
  })

  ctx.routes.api(app => {
    app.get('/subscribers', async c => {
      const listId = c.req.query('list') || ''
      return c.json({ items: await ctx.env.secure.subscribers(listId) })
    })
    app.post('/campaign', async c => {
      const { listId, subject, md, test } = await c.req.json()
      if (!listId || !subject || !md) return c.json({ error: 'listId, subject, md required' }, 400)
      const site = await ctx.env.site()
      const html = mdToHtml(md)
      const targets = test ? [{ email: test, meta: { unsub: '' } }] : await ctx.env.secure.subscribers(listId, 'confirmed')
      let sent = 0
      for (const s of targets) {
        const unsubUrl = s.meta?.unsub ? `${site.url}/x/newsletter/unsubscribe?t=${s.meta.unsub}` : ''
        try {
          await ctx.mail.send({
            to: s.email, subject,
            html: `${html}${unsubUrl ? `<p style="font-size:12px;color:#888"><a href="${unsubUrl}">Unsubscribe</a></p>` : ''}`,
            text: `${md}${unsubUrl ? `\n\n—\nUnsubscribe: ${unsubUrl}` : ''}`,
          })
          sent++
        } catch (e) { ctx.log('campaign send failed for', s.email, e) }
      }
      return c.json({ sent, of: targets.length })
    })
  })
}

function respond(c: any, message: string) {
  if (c.req.header('accept')?.includes('application/json')) return c.json({ ok: true, message })
  return c.html(tinyPage('Thanks!', message))
}

function tinyPage(title: string, text: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:light-dark(#f5f5f7,#101014);color:light-dark(#1a1a1f,#eceaf4);color-scheme:light dark}main{text-align:center;padding:2rem;max-width:24rem}h1{font-size:1.3rem}</style></head><body><main><h1>${title}</h1><p>${text}</p><p><a href="/" style="color:#6d5df6">← back to the site</a></p></main></body></html>`
}
