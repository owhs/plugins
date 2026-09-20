// Drive — a private document area for customers and partners: spec sheets,
// CAD drawings, guides, price lists. Areas map to member groups; visitors
// self-register (role + company captured), request access to locked areas,
// and every download is tracked. Think "client portal", not "file dump".

import type { PluginContext } from '../../blockhouse/src/core/plugin.ts'
import type { PluginManifest } from '../../blockhouse/src/core/types.ts'
import { mimeOf } from '../../blockhouse/src/images/exif.ts'
import { escapeHtml as eh } from '../../blockhouse/src/core/util.ts'

export const manifest: PluginManifest = {
  id: 'drive', name: 'Drive (client portal)', version: '0.1.0', builtin: true,
  description: 'A private download area for clients. They sign in, you choose who sees which folder, and you can see what was downloaded.',
  permissions: ['routes.public', 'routes.api', 'secure.tables', 'settings.own', 'mail.send', 'events.emit', 'files.private', 'blocks.register'],
}

const AREA_DIR = 'areas'

export function register(ctx: PluginContext) {
  ctx.adminPanel({ label: 'Drive', icon: 'folder' })

  ctx.settingsSection({
    key: 'drive', label: 'Drive portal',
    description: 'Self-signup fields and notifications for the client document portal.',
    fields: [
      { key: 'notify', label: 'Notify on access requests (email)', type: 'text', width: 'half' },
      { key: 'roles', label: 'Roles offered at signup', type: 'text', default: 'Architect|Developer|Contractor|Distributor|Press|Other', help: 'Pipe-separated — shows as a dropdown on the request form' },
      { key: 'autoApprove', label: 'Auto-approve requests for open areas', type: 'boolean', default: true },
    ],
  })

  // ---------- admin API ----------

  ctx.routes.api(app => {
    app.get('/areas', async c => {
      const areas = await ctx.json.list(AREA_DIR)
      const out = []
      for (const a of areas) {
        const files = await ctx.env.driver.list(`media/private/drive/${a.id}`)
        out.push({ ...a, fileCount: files.length })
      }
      return c.json({ areas: out })
    })

    app.put('/areas/:id', async c => {
      const id = c.req.param('id')
      if (!/^[a-z0-9-]+$/.test(id)) return c.json({ error: 'area id must be a slug' }, 400)
      const body = await c.req.json()
      await ctx.json.save(AREA_DIR, id, {
        id, label: body.label || id,
        description: body.description || '',
        groups: Array.isArray(body.groups) ? body.groups : [],   // member groups with access ([] = any signed-in member)
        requestable: body.requestable !== false,                 // may visitors ask for access?
      })
      return c.json({ ok: true })
    })

    app.delete('/areas/:id', async c => { await ctx.json.remove(AREA_DIR, c.req.param('id')); return c.json({ ok: true }) })

    app.get('/areas/:id/files', async c => {
      const id = c.req.param('id')
      const keys = await ctx.env.driver.list(`media/private/drive/${id}`)
      const stats = await ctx.store.kvGet('downloads', {})
      const files = []
      for (const k of keys) {
        const rel = k.slice(`media/private/drive/${id}/`.length)
        const s = await ctx.env.driver.stat(k)
        files.push({ rel, size: s?.size || 0, downloads: stats[`${id}/${rel}`] || 0 })
      }
      return c.json({ files })
    })

    app.get('/requests', async c => c.json({ requests: await ctx.store.rows('requests').list(200) }))

    app.post('/requests/:rid/approve', async c => {
      const row = await ctx.store.rows('requests').get(c.req.param('rid'))
      if (!row) return c.json({ error: 'not found' }, 404)
      const members = (ctx.env as any).memberAdmin
      if (!members) return c.json({ error: 'the Members plugin must be enabled' }, 400)
      await members.addToGroup(row.email, row.group)
      await ctx.store.rows('requests').update(row.id, { ...row, status: 'approved', decidedAt: Date.now() })
      await ctx.mail.send({
        to: row.email, subject: 'Access approved',
        text: `Your access to "${row.areaLabel}" is ready. Sign in with this email to view the files.`,
      }).catch(() => {})
      await ctx.events.emit('access.approved', { email: row.email, area: row.area })
      return c.json({ ok: true })
    })

    app.post('/requests/:rid/decline', async c => {
      const row = await ctx.store.rows('requests').get(c.req.param('rid'))
      if (!row) return c.json({ error: 'not found' }, 404)
      await ctx.store.rows('requests').update(row.id, { ...row, status: 'declined', decidedAt: Date.now() })
      return c.json({ ok: true })
    })

    app.get('/activity', async c => {
      const log = await ctx.store.rows('activity').list(100)
      const stats = await ctx.store.kvGet('downloads', {})
      const top = Object.entries(stats).map(([file, n]) => ({ file, n })).sort((a: any, b: any) => b.n - a.n).slice(0, 12)
      return c.json({ recent: log, top })
    })
  })

  // ---------- member-facing (mounted at /x/drive) ----------

  ctx.routes.public(app => {
    const member = async (c: any) => {
      const gate = (ctx.env as any).memberGate
      return gate ? await gate.resolve(c) : null
    }

    // areas + files visible to this member
    app.get('/mine', async c => {
      const m = await member(c)
      const areas = await ctx.json.list(AREA_DIR)
      const out = []
      for (const a of areas) {
        const allowed = m && (!a.groups.length || (m.groups || []).some((g: string) => a.groups.includes(g)))
        const entry: any = { id: a.id, label: a.label, description: a.description, allowed: !!allowed, requestable: a.requestable !== false }
        if (allowed) {
          const keys = await ctx.env.driver.list(`media/private/drive/${a.id}`)
          entry.files = keys.map((k: string) => {
            const rel = k.slice(`media/private/drive/${a.id}/`.length)
            return { rel, href: `/x/drive/file/${a.id}/${rel.split('/').map(encodeURIComponent).join('/')}` }
          })
        }
        out.push(entry)
      }
      return c.json({ signedIn: !!m, email: m?.email || null, areas: out })
    })

    // gated download + tracking
    app.get('/file/:area/*', async c => {
      const m = await member(c)
      if (!m) return c.redirect('/account?next=' + encodeURIComponent(c.req.path), 302)
      const area = (await ctx.json.list(AREA_DIR)).find((a: any) => a.id === c.req.param('area'))
      if (!area) return c.notFound()
      const allowed = !area.groups.length || (m.groups || []).some((g: string) => area.groups.includes(g))
      if (!allowed) return c.json({ error: 'no access to this area' }, 403)
      const rel = decodeURIComponent(c.req.path.split(`/file/${area.id}/`)[1] || '')
      if (!rel || rel.includes('..')) return c.notFound()
      const data = await ctx.env.driver.read(`media/private/drive/${area.id}/${rel}`)
      if (!data) return c.notFound()
      const stats = await ctx.store.kvGet('downloads', {})
      stats[`${area.id}/${rel}`] = (stats[`${area.id}/${rel}`] || 0) + 1
      await ctx.store.kvSet('downloads', stats)
      await ctx.store.rows('activity').insert({ email: m.email, area: area.id, file: rel, at: Date.now() })
      await ctx.events.emit('download', { email: m.email, area: area.id, file: rel })
      return c.body(data as any, 200, {
        'content-type': mimeOf(rel),
        'content-disposition': `attachment; filename="${rel.split('/').pop()}"`,
        'cache-control': 'private, no-store',
      })
    })

    // access request — works signed-in or not (captures role/company either way)
    app.post('/request', async c => {
      const body = await c.req.json()
      const email = String(body.email || '').toLowerCase().trim()
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'valid email required' }, 400)
      const area = (await ctx.json.list(AREA_DIR)).find((a: any) => a.id === body.area)
      if (!area || area.requestable === false) return c.json({ error: 'this area does not take requests' }, 400)
      const settings = await allSettings(ctx)
      const row = await ctx.store.rows('requests').insert({
        email, area: area.id, areaLabel: area.label, group: area.groups[0] || 'drive',
        role: String(body.role || '').slice(0, 60), company: String(body.company || '').slice(0, 120),
        note: String(body.note || '').slice(0, 500), status: 'pending', at: Date.now(),
      })
      await ctx.events.emit('access.requested', { email, area: area.id, role: row.role, company: row.company })
      if (settings.notify) {
        await ctx.mail.send({
          to: settings.notify, subject: `Drive access request — ${area.label}`,
          text: `${email} (${row.role || 'no role'}${row.company ? `, ${row.company}` : ''}) asked for access to "${area.label}".\n\nNote: ${row.note || '—'}\n\nApprove it in the studio → Drive.`,
        }).catch(() => {})
      }
      // open areas ([] groups) with auto-approve just tell them to sign up/in
      if (!area.groups.length && settings.autoApprove !== false) {
        await ctx.store.rows('requests').update(row.id, { ...row, status: 'approved', decidedAt: Date.now() })
        return c.json({ ok: true, open: true, message: 'This area is open to signed-in members — create your account with this email and the files are yours.' })
      }
      return c.json({ ok: true, message: 'Request received — you will get an email when it is approved.' })
    })
  })

  // ---------- the portal block ----------

  ctx.blocks.register({
    type: 'drive', label: 'Document portal', group: 'Interactive', icon: 'folder',
    description: 'Member-gated file areas with request-access flows — put it on a “Downloads” or “Partner area” page',
    fields: [
      { key: 'title', type: 'text', label: 'Title', default: 'Document portal' },
      { key: 'intro', type: 'textarea', label: 'Intro', default: 'Sign in to access technical documents. No account? Request access below.' },
    ],
    render: async (c, n) => {
      c.collect.enhancers.add('drive')
      const settings = await allSettings(ctx)
      const roles = String(settings.roles || 'Architect|Developer|Other').split('|').map((r: string) => r.trim()).filter(Boolean)
      return `<div class="wb-drive" data-blockhouse-enhance="drive">
        <h2>${eh(n.props.title || 'Document portal')}</h2>
        <p class="drive-intro">${eh(n.props.intro || '')}</p>
        <div class="drive-areas" data-drive-areas><p class="drive-note">Loading…</p></div>
        <template data-drive-request>
          <form class="drive-request wb-form">
            <h4>Request access: <span data-area-label></span></h4>
            <div class="form-grid">
              <label>Email<input type="email" name="email" required></label>
              <label>Role<select name="role">${roles.map((r: string) => `<option>${eh(r)}</option>`).join('')}</select></label>
              <label>Company<input name="company"></label>
              <label class="span2">What do you need?<textarea name="note" rows="2"></textarea></label>
            </div>
            <button class="btn btn-primary" type="submit">Request access</button>
            <p class="drive-status" role="status"></p>
          </form>
        </template>
      </div>`
    },
  })
}

async function allSettings(ctx: PluginContext) {
  // settingsSection values are saved into site.json under plugins.drive.settings
  const site = await ctx.env.site()
  const s = site.plugins?.drive?.settings || {}
  return {
    notify: s.notify || '',
    roles: s.roles || 'Architect|Developer|Contractor|Distributor|Press|Other',
    autoApprove: s.autoApprove !== false,
  }
}
