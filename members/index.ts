// Members — website visitor accounts, entirely separate from studio (admin)
// users. Members sign up / sign in with a password or a magic link, belong to
// groups, and unlock pages whose `access` is set to members-only.
//
// Gating is enforced in the site router (see src/server/site.ts) via the
// `members.gate` hook this plugin installs on the env.

import type { PluginContext } from '../../blockhouse/src/core/plugin.ts'
import type { PluginManifest } from '../../blockhouse/src/core/types.ts'
import { hashPassword, verifyPassword } from '../../blockhouse/src/auth/hash.ts'
import { issueToken, checkToken } from '../../blockhouse/src/auth/tokens.ts'
import { escapeAttr as ea, escapeHtml as eh, id as genId, now, randomToken, sha256hex, timingSafeEqual } from '../../blockhouse/src/core/util.ts'

export const manifest: PluginManifest = {
  id: 'members', name: 'Members', version: '0.1.0', builtin: true,
  description: 'Visitor accounts, magic-link login, member-only pages and an account portal',
  permissions: ['blocks.register', 'routes.root', 'routes.public', 'routes.api', 'secure.tables', 'settings.own', 'mail.send', 'events.emit', 'content.read'],
}

const COOKIE = 'blockhouse_m'

export function register(ctx: PluginContext) {
  ctx.adminPanel({ label: 'Members', icon: 'users' })

  const members = ctx.store.rows('accounts')

  ctx.resources.register({
    key: 'groups', label: 'Member groups', labelSingular: 'Group', icon: 'users', storage: 'json', titleField: 'label',
    fields: [
      { key: 'label', type: 'text', label: 'Group name', required: true },
      { key: 'description', type: 'text', label: 'Description' },
    ],
  })

  // ---------- helpers ----------

  async function settings() {
    return {
      allowSignup: await ctx.settings.get('allowSignup', true),
      requireApproval: await ctx.settings.get('requireApproval', false),
      loginPath: await ctx.settings.get('loginPath', '/account'),
      welcomeSubject: await ctx.settings.get('welcomeSubject', 'Your sign-in link'),
    }
  }

  const cookieOf = (c: any): string | undefined => {
    const header = c.req.header('cookie')
    if (!header) return undefined
    for (const part of header.split(/;\s*/)) {
      const eq = part.indexOf('=')
      if (eq > 0 && part.slice(0, eq) === COOKIE) return decodeURIComponent(part.slice(eq + 1))
    }
  }

  async function memberFromRequest(c: any) {
    const raw = cookieOf(c)
    if (!raw) return null
    const i = raw.lastIndexOf('.')
    if (i < 1) return null
    const memberId = raw.slice(0, i)
    const sig = raw.slice(i + 1)
    const expect = (await sha256hex(ctx.env.secret + memberId)).slice(0, 32)
    if (!timingSafeEqual(sig, expect)) return null
    const m = await members.get(memberId)
    if (!m || m.status === 'blocked') return null
    return m
  }

  async function setMemberCookie(c: any, memberId: string) {
    const sig = (await sha256hex(ctx.env.secret + memberId)).slice(0, 32)
    const secure = new URL(c.req.url).protocol === 'https:'
    c.resHeaders.append('set-cookie',
      `${COOKIE}=${encodeURIComponent(memberId + '.' + sig)}; Path=/; Max-Age=${60 * 60 * 24 * 60}; SameSite=Lax; HttpOnly${secure ? '; Secure' : ''}`)
  }
  function clearMemberCookie(c: any) {
    c.resHeaders.append('set-cookie', `${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`)
  }

  // other plugins (Drive, Commerce) manage membership through this — never raw rows
  ;(ctx.env as any).memberAdmin = {
    /** Put an email into a group; creates an active account if none exists (they sign in by magic link). */
    async addToGroup(email: string, group: string) {
      const norm = String(email).toLowerCase().trim()
      const all = await members.list(2000)
      const m = all.find((x: any) => x.email === norm)
      if (m) {
        const groups = [...new Set([...(m.groups || []), group])]
        await members.update(m.id, { ...m, groups, status: m.status === 'blocked' ? 'blocked' : 'active' })
        return m.id
      }
      return members.insert({ email: norm, name: '', pass: '', groups: [group], status: 'active', createdAt: now() })
    },
    async byEmail(email: string) {
      return (await members.list(2000)).find((x: any) => x.email === String(email).toLowerCase().trim()) || null
    },
  }

  // the site router consults this to gate pages
  ctx.env.memberGate = {
    async resolve(c: any) {
      const m = await memberFromRequest(c)
      // Only active accounts count as "signed in" for gating purposes.
      return m && m.status === 'active' ? m : null
    },
    allowed(member: any, access: any): boolean {
      const mode = access?.mode || 'public'
      if (mode === 'public') return true
      if (!member || member.status !== 'active') return false
      if (mode === 'members') return true
      const groups: string[] = access.groups || []
      if (!groups.length) return true
      return (member.groups || []).some((g: string) => groups.includes(g))
    },
    loginPath: async () => (await settings()).loginPath,
  }

  // ---------- public auth routes ----------

  ctx.routes.public(app => {
    app.post('/signup', async c => {
      const s = await settings()
      if (!s.allowSignup) return respond(c, { error: 'Sign-ups are closed' }, 403)
      const body = await c.req.parseBody()
      const email = String(body.email || '').toLowerCase().trim()
      const password = String(body.password || '')
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return respond(c, { error: 'Enter a valid email' }, 400)
      if (password && password.length < 8) return respond(c, { error: 'Password must be at least 8 characters' }, 400)
      const existing = (await members.list(2000)).find((m: any) => m.email === email)
      if (existing) return respond(c, { error: 'That email already has an account — try signing in.' }, 400)

      const memberId = await members.insert({
        email, name: String(body.name || '').slice(0, 120),
        pass: password ? await hashPassword(password) : '',
        groups: [], status: s.requireApproval ? 'pending' : 'active', createdAt: now(),
      })
      await ctx.env.events.emit('member.registered', { memberId, email })
      if (s.requireApproval) return respond(c, { ok: true, message: 'Thanks — your account is awaiting approval.' })
      await setMemberCookie(c, memberId)
      return respond(c, { ok: true, message: 'Welcome!', redirect: s.loginPath })
    })

    app.post('/login', async c => {
      const body = await c.req.parseBody()
      const email = String(body.email || '').toLowerCase().trim()
      const all = await members.list(2000)
      const m = all.find((x: any) => x.email === email)
      const s = await settings()

      // magic link path
      if (!body.password) {
        if (m) {
          const { token } = await issueToken(ctx.env.secure, 'member-link', { meta: { memberId: m.id }, ttlMs: 30 * 60_000, maxUses: 1 })
          const site = await ctx.env.site()
          await ctx.mail.send({
            to: email, subject: s.welcomeSubject,
            text: `Sign in to ${site.name}:\n\n${site.url}/x/members/magic?t=${token}\n\nThis link works once and expires in 30 minutes.`,
          })
        }
        // same response whether or not the account exists (no user enumeration)
        return respond(c, { ok: true, message: 'Check your inbox for a sign-in link.' })
      }

      if (!m || !m.pass || !(await verifyPassword(String(body.password), m.pass))) {
        return respond(c, { error: 'Invalid email or password' }, 401)
      }
      if (m.status === 'pending') return respond(c, { error: 'Your account is awaiting approval.' }, 403)
      if (m.status === 'blocked') return respond(c, { error: 'This account is disabled.' }, 403)
      await setMemberCookie(c, m.id)
      await ctx.env.events.emit('member.login', { memberId: m.id })
      return respond(c, { ok: true, redirect: String(body.next || s.loginPath) })
    })

    app.get('/magic', async c => {
      const row = await checkToken(ctx.env.secure, 'member-link', c.req.query('t') || '')
      const s = await settings()
      if (!row) return c.html(tiny('Link expired', 'Request a fresh sign-in link.', s.loginPath), 400)
      await ctx.env.secure.useToken(row.id)
      await setMemberCookie(c, row.meta.memberId)
      await ctx.env.events.emit('member.login', { memberId: row.meta.memberId, via: 'magic' })
      return c.redirect(s.loginPath, 302)
    })

    app.post('/logout', async c => { clearMemberCookie(c); return respond(c, { ok: true, redirect: '/' }) })
    app.get('/logout', async c => { clearMemberCookie(c); return c.redirect('/', 302) })

    app.get('/me', async c => {
      const m = await memberFromRequest(c)
      return c.json({ member: m ? { id: m.id, email: m.email, name: m.name, groups: m.groups, status: m.status } : null })
    })

    app.post('/profile', async c => {
      const m = await memberFromRequest(c)
      if (!m) return respond(c, { error: 'Not signed in' }, 401)
      const body = await c.req.parseBody()
      const patch: any = { ...m, name: String(body.name || m.name).slice(0, 120) }
      if (body.password) {
        if (String(body.password).length < 8) return respond(c, { error: 'Password must be at least 8 characters' }, 400)
        patch.pass = await hashPassword(String(body.password))
      }
      const { id: _i, createdAt: _c, updatedAt: _u, ...data } = patch
      await members.update(m.id, data)
      return respond(c, { ok: true, message: 'Saved' })
    })
  })

  // ---------- admin API ----------
  ctx.routes.api(app => {
    app.get('/list', async c => {
      const all = await members.list(2000)
      return c.json({ members: all.map(({ pass, ...m }: any) => m) })
    })
    app.patch('/:id', async c => {
      const m = await members.get(c.req.param('id'))
      if (!m) return c.json({ error: 'not found' }, 404)
      const body = await c.req.json()
      const { id: _i, createdAt: _c, updatedAt: _u, ...data } = { ...m, ...body }
      if (body.password) { data.pass = await hashPassword(body.password); delete data.password }
      await members.update(m.id, data)
      return c.json({ ok: true })
    })
    app.delete('/:id', async c => { await members.remove(c.req.param('id')); return c.json({ ok: true }) })
    app.get('/settings', async c => c.json(await settings()))
    app.put('/settings', async c => {
      const body = await c.req.json()
      for (const k of ['allowSignup', 'requireApproval', 'loginPath', 'welcomeSubject']) {
        if (body[k] !== undefined) await ctx.settings.set(k, body[k])
      }
      return c.json({ ok: true })
    })
  })

  // ---------- blocks ----------

  ctx.blocks.register({
    type: 'member-auth', label: 'Sign in / register', group: 'Members', icon: 'key',
    description: 'Login + registration form (magic link or password)',
    fields: [
      { key: 'mode', type: 'select', label: 'Mode', options: [{ value: 'both' }, { value: 'login' }, { value: 'signup' }], default: 'both' },
      { key: 'magic', type: 'boolean', label: 'Offer magic-link sign in', default: true },
      { key: 'redirect', type: 'text', label: 'After sign-in, go to', default: '/account' },
    ],
    enhance: 'form',
    render: (_c, n) => {
      const p = n.props
      const login = `<form method="post" action="/x/members/login" data-blockhouse-form class="member-form">
        <input type="hidden" name="next" value="${ea(p.redirect || '/account')}">
        <label class="ff"><span>Email</span><input type="email" name="email" required autocomplete="email"></label>
        ${p.magic === false ? '' : '<p class="member-hint">Leave the password blank to get a one-time sign-in link by email.</p>'}
        <label class="ff"><span>Password</span><input type="password" name="password" autocomplete="current-password"></label>
        <p class="form-actions"><button class="btn btn-primary" type="submit">Sign in</button></p>
        <p class="form-status" role="status" aria-live="polite"></p></form>`
      const signup = `<form method="post" action="/x/members/signup" data-blockhouse-form class="member-form">
        <label class="ff"><span>Name</span><input type="text" name="name" autocomplete="name"></label>
        <label class="ff"><span>Email</span><input type="email" name="email" required autocomplete="email"></label>
        <label class="ff"><span>Password</span><input type="password" name="password" autocomplete="new-password"></label>
        <p class="form-actions"><button class="btn btn-primary" type="submit">Create account</button></p>
        <p class="form-status" role="status" aria-live="polite"></p></form>`
      if (p.mode === 'login') return `<div class="wb-member-auth">${login}</div>`
      if (p.mode === 'signup') return `<div class="wb-member-auth">${signup}</div>`
      return `<div class="wb-member-auth wb-tabs" data-tabs>
        <div role="tablist" class="tabs-list">
          <button role="tab" id="tab-ma-0" aria-controls="panel-ma-0" aria-selected="true" tabindex="0">Sign in</button>
          <button role="tab" id="tab-ma-1" aria-controls="panel-ma-1" aria-selected="false" tabindex="-1">Create account</button>
        </div>
        <div role="tabpanel" class="tab-panel" id="panel-ma-0" aria-labelledby="tab-ma-0">${login}</div>
        <div role="tabpanel" class="tab-panel" id="panel-ma-1" aria-labelledby="tab-ma-1" hidden>${signup}</div>
      </div>`
    },
  })

  ctx.blocks.register({
    type: 'member-portal', label: 'Member portal', group: 'Members', icon: 'account',
    description: 'Shows the signed-in member their profile and sign-out link',
    fields: [{ key: 'title', type: 'text', label: 'Title', default: 'Your account' }],
    enhance: 'members',
    render: (_c, n) =>
      `<div class="wb-member-portal" data-member-portal>
        <div class="mp-signed-out" hidden><p>You're not signed in. <a href="/account">Sign in</a> to see your account.</p></div>
        <div class="mp-signed-in" hidden>
          <h3>${eh(n.props.title || 'Your account')}</h3>
          <p class="mp-identity"></p>
          <form method="post" action="/x/members/profile" data-blockhouse-form class="member-form">
            <label class="ff"><span>Name</span><input type="text" name="name"></label>
            <label class="ff"><span>New password</span><input type="password" name="password" autocomplete="new-password"></label>
            <p class="form-actions"><button class="btn btn-primary" type="submit">Save</button>
              <a class="btn btn-ghost" href="/x/members/logout">Sign out</a></p>
            <p class="form-status" role="status" aria-live="polite"></p>
          </form>
          <div class="mp-files" hidden><h4>Your files</h4><ul class="mp-file-list"></ul></div>
        </div>
      </div>`,
  })
}

function respond(c: any, body: any, status = 200) {
  if (c.req.header('accept')?.includes('application/json')) return c.json(body, status)
  if (body.redirect) return c.redirect(body.redirect, 303)
  return c.json(body, status)
}

function tiny(title: string, text: string, back = '/'): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;display:grid;place-content:center;justify-items:center;min-height:100vh;margin:0;color-scheme:light dark;text-align:center;padding:2rem}</style></head>
<body><main><h1>${title}</h1><p>${text}</p><p><a href="${back}">← Back</a></p></main></body></html>`
}
