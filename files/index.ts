// Files — a private delivery area on top of media/private/:
// magic links (expiring / one-time), optional signature-required flow,
// or "any logged-in user" gating. Every download is an event.

import type { PluginContext } from '../../blockhouse/src/core/plugin.ts'
import type { PluginManifest } from '../../blockhouse/src/core/types.ts'
import { checkToken, issueToken } from '../../blockhouse/src/auth/tokens.ts'
import { mimeOf } from '../../blockhouse/src/images/exif.ts'
import { escapeHtml as eh } from '../../blockhouse/src/core/util.ts'

export const manifest: PluginManifest = {
  id: 'files', name: 'File delivery', version: '0.1.0', builtin: true,
  description: 'Private files with magic links, one-time links and signature flows',
  permissions: ['routes.root', 'routes.public', 'routes.api', 'secure.tables', 'settings.own', 'mail.send', 'events.emit', 'files.private'],
}

export function register(ctx: PluginContext) {
  ctx.adminPanel({ label: 'File delivery', icon: 'download' })

  // ---------- admin API ----------

  ctx.routes.api(app => {
    app.get('/files', async c => {
      const keys: string[] = await ctx.env.driver.list('media/private')
      const files = []
      for (const k of keys) {
        const s = await ctx.env.driver.stat(k)
        files.push({ key: k.slice('media/private/'.length), size: s?.size || 0, mtime: s?.mtime })
      }
      return c.json({ files })
    })

    app.post('/links', async c => {
      const body = await c.req.json()
      if (!body.file) return c.json({ error: 'file required' }, 400)
      if (!(await ctx.env.driver.stat(`media/private/${body.file}`))) return c.json({ error: 'file not found in private area' }, 404)
      const { token } = await issueToken(ctx.env.secure, 'filelink', {
        meta: {
          file: body.file, label: body.label || body.file,
          requireSignature: !!body.requireSignature, requireLogin: !!body.requireLogin,
          email: body.email || null,
        },
        ttlMs: body.expiresDays ? body.expiresDays * 864e5 : undefined,
        maxUses: body.oneTime ? 1 : (body.maxUses || 0),
      })
      const site = await ctx.env.site()
      const url = `${site.url}/f/${token}`
      if (body.email) {
        await ctx.mail.send({
          to: body.email, subject: `${site.name}: ${body.label || body.file}`,
          text: `You've been sent a file: ${body.label || body.file}\n\nDownload it here: ${url}\n${body.oneTime ? '\nThis link works once.' : ''}${body.expiresDays ? `\nExpires in ${body.expiresDays} days.` : ''}`,
        })
      }
      return c.json({ url, token })
    })

    app.get('/links', async c => {
      const rows = await ctx.env.secure.listTokens('filelink')
      return c.json({
        links: rows.map((r: any) => ({
          id: r.id, label: r.meta.label, file: r.meta.file, uses: r.uses, maxUses: r.maxUses,
          expiresAt: r.expiresAt || null, requireSignature: r.meta.requireSignature,
          signatures: r.meta.signatures || [], createdAt: r.createdAt,
        })),
      })
    })

    app.delete('/links/:id', async c => { await ctx.env.secure.deleteToken(c.req.param('id')); return c.json({ ok: true }) })
  })

  // The member portal asks this to render “Your files”: links issued to the
  // member's email, still alive. Downloads go through /x/files/portal/<id>,
  // which re-checks the member session — no plain tokens are ever stored.
  ;(ctx.env as any).memberFiles = async (email: string) => {
    const rows = await ctx.env.secure.listTokens('filelink')
    return rows
      .filter((r: any) => r.meta.email === email && (!r.maxUses || r.uses < r.maxUses) && (!r.expiresAt || r.expiresAt > Date.now()))
      .map((r: any) => ({ id: r.id, label: r.meta.label, file: r.meta.file, createdAt: r.createdAt, uses: r.uses, maxUses: r.maxUses }))
  }

  // ---------- member portal downloads (session-checked, tokenless) ----------

  ctx.routes.public(app => {
    app.get('/mine', async c => {
      const gate = (ctx.env as any).memberGate
      const member = gate ? await gate.resolve(c) : null
      if (!member) return c.json({ files: [] })
      return c.json({ files: await (ctx.env as any).memberFiles(member.email) })
    })

    app.get('/portal/:id', async c => {
      const gate = (ctx.env as any).memberGate
      const member = gate ? await gate.resolve(c) : null
      if (!member) return c.html(page('Sign in required', '<p>Sign in to your account to download your files.</p>'), 401)
      const rows = await ctx.env.secure.listTokens('filelink')
      const row = rows.find((r: any) => r.id === c.req.param('id'))
      if (!row || row.meta.email !== member.email) return c.html(page('Not found', '<p>No such file on your account.</p>'), 404)
      if (row.maxUses && row.uses >= row.maxUses) return c.html(page('Used up', '<p>This delivery has reached its download limit.</p>'), 410)
      if (row.expiresAt && row.expiresAt < Date.now()) return c.html(page('Expired', '<p>This delivery has expired.</p>'), 410)
      return deliver(c, row)
    })
  })

  // ---------- public delivery ----------

  ctx.routes.root(app => {
    app.get('/f/:token', async c => {
      const row = await checkToken(ctx.env.secure, 'filelink', c.req.param('token'))
      if (!row) return c.html(page('Link unavailable', '<p>This link has expired, been used up, or never existed.</p>'), 404)
      if (row.meta.requireLogin) {
        // Members first (site visitors), studio users as a fallback.
        const gate = (ctx.env as any).memberGate
        const member = gate ? await gate.resolve(c) : null
        const studioUser = c.get('user' as never) as any
        if (!member && !studioUser) {
          const login = gate ? await gate.loginPath() : '/admin/'
          return c.redirect(`${login}?next=${encodeURIComponent('/f/' + c.req.param('token'))}`, 302)
        }
        if (row.meta.email && member && member.email !== row.meta.email && !studioUser) {
          return c.html(page('Not your file', `<p>This link was issued to a different account. Sign in with the address it was sent to.</p>`), 403)
        }
      }
      if (row.meta.requireSignature) {
        return c.html(page(`Receive “${eh(row.meta.label)}”`, `
          <form method="post" action="/f/${eh(c.req.param('token'))}">
            <label>Your full name<br><input name="name" required style="width:100%"></label>
            <label class="chk"><input type="checkbox" name="agree" value="yes" required> I confirm I'm the intended recipient and accept receipt of this file.</label>
            <button type="submit">Sign &amp; download</button>
          </form>`))
      }
      return deliver(c, row)
    })

    app.post('/f/:token', async c => {
      const row = await checkToken(ctx.env.secure, 'filelink', c.req.param('token'))
      if (!row) return c.html(page('Link unavailable', '<p>This link has expired or been used up.</p>'), 404)
      const body = await c.req.parseBody()
      if (row.meta.requireSignature) {
        if (!body.name || body.agree !== 'yes') return c.html(page('Signature required', '<p>Please provide your name and tick the confirmation.</p>'), 400)
        const sigs = row.meta.signatures || []
        sigs.push({ name: String(body.name).slice(0, 120), at: new Date().toISOString(), ip: c.req.header('x-forwarded-for') || '' })
        row.meta.signatures = sigs
        await ctx.env.secure.sql.run('UPDATE tokens SET meta = ? WHERE id = ?', [JSON.stringify(row.meta), row.id])
      }
      return deliver(c, row)
    })
  })

  async function deliver(c: any, row: any) {
    const data = await ctx.env.driver.read(`media/private/${row.meta.file}`)
    if (!data) return c.html(page('File missing', '<p>The file behind this link has been removed.</p>'), 410)
    await ctx.env.secure.useToken(row.id)
    await ctx.events.emit('downloaded', { file: row.meta.file, label: row.meta.label })
    await ctx.env.events.emit('file.downloaded', { file: row.meta.file, tokenId: row.id })
    const name = row.meta.file.split('/').pop()
    return c.body(data, 200, {
      'content-type': mimeOf(name),
      'content-disposition': `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"`,
      'cache-control': 'no-store',
    })
  }
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
  body{font-family:system-ui;background:light-dark(#f5f5f7,#101014);color:light-dark(#1a1a1f,#eceaf4);color-scheme:light dark;display:grid;place-items:center;min-height:100vh;margin:0}
  main{max-width:26rem;padding:2.2rem;background:light-dark(#fff,#191922);border-radius:16px;box-shadow:0 10px 40px #0002;margin:1rem}
  h1{font-size:1.25rem;margin-top:0}label{display:block;margin:1rem 0;font-size:.92rem}
  input:not([type=checkbox]){padding:.55rem .7rem;border-radius:8px;border:1px solid light-dark(#d5d5dd,#33333f);background:transparent;color:inherit;font:inherit;margin-top:.3rem}
  .chk{display:flex;gap:.5rem;align-items:flex-start}
  button{background:#6d5df6;border:0;color:#fff;font:inherit;font-weight:600;padding:.6rem 1.2rem;border-radius:10px;cursor:pointer}
  a{color:#6d5df6}</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`
}
