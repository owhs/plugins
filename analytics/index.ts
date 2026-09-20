// Analytics — first-party, cookieless, privacy-first page-view counting.
// A tiny beacon posts {path, ref} on navigation; the server keeps daily
// aggregates (per-path counts, referrer host counts, unique salted-hash count).
// No cookies, no cross-site identifiers, no PII stored. Studio shows a chart.

import type { PluginContext } from '../../blockhouse/src/core/plugin.ts'
import type { PluginManifest } from '../../blockhouse/src/core/types.ts'
import { sha256hex } from '../../blockhouse/src/core/util.ts'

export const manifest: PluginManifest = {
  id: 'analytics', name: 'Analytics', version: '0.1.0', builtin: true,
  description: 'Counts visits to your pages without cookies or tracking, and shows the numbers here.',
  permissions: ['routes.public', 'routes.api', 'secure.tables', 'settings.own'],
}

function today(): string { return new Date().toISOString().slice(0, 10) }

export function register(ctx: PluginContext) {
  ctx.adminPanel({ label: 'Analytics', icon: 'chart' })

  // rolling daily salt (rotates so hashes can't be correlated across days)
  async function daySalt(day: string): Promise<string> {
    let salt = await ctx.store.kvGet<string>(`salt:${day}`, '')
    if (!salt) { salt = ctx.util.id('') + ctx.util.id(''); await ctx.store.kvSet(`salt:${day}`, salt) }
    return salt
  }

  ctx.routes.public(app => {
    // beacon endpoint — returns 204, never sets a cookie
    app.post('/hit', async c => {
      let body: any = {}
      try { body = await c.req.json() } catch {}
      const path = String(body.p || '/').slice(0, 300)
      if (path.startsWith('/admin') || path.startsWith('/api')) return c.body(null, 204)
      const day = today()
      const stats = await ctx.store.kvGet<any>(`day:${day}`, { views: 0, paths: {}, refs: {}, visitors: [] })
      stats.views++
      stats.paths[path] = (stats.paths[path] || 0) + 1
      const ref = String(body.r || '').slice(0, 200)
      if (ref) {
        try { const host = new URL(ref).host; if (host && host !== new URL(c.req.url).host) stats.refs[host] = (stats.refs[host] || 0) + 1 } catch {}
      }
      // unique-ish visitor: salted hash of ip+ua, truncated, deduped per day
      const salt = await daySalt(day)
      const vh = (await sha256hex(salt + (c.req.header('x-forwarded-for') || 'local') + (c.req.header('user-agent') || ''))).slice(0, 12)
      if (!stats.visitors.includes(vh)) { stats.visitors.push(vh); if (stats.visitors.length > 100000) stats.visitors.shift() }
      await ctx.store.kvSet(`day:${day}`, stats)
      return c.body(null, 204)
    })
  })

  ctx.routes.api(app => {
    app.get('/summary', async c => {
      const days = Math.min(parseInt(c.req.query('days') || '30', 10), 90)
      const series = []
      const pathTotals: Record<string, number> = {}
      const refTotals: Record<string, number> = {}
      let totalViews = 0, totalVisitors = 0
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10)
        const s = await ctx.store.kvGet<any>(`day:${d}`, { views: 0, paths: {}, refs: {}, visitors: [] })
        series.push({ day: d, views: s.views, visitors: s.visitors.length })
        totalViews += s.views; totalVisitors += s.visitors.length
        for (const [k, v] of Object.entries(s.paths)) pathTotals[k] = (pathTotals[k] || 0) + (v as number)
        for (const [k, v] of Object.entries(s.refs)) refTotals[k] = (refTotals[k] || 0) + (v as number)
      }
      const top = (obj: Record<string, number>) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => ({ k, n }))
      return c.json({ series, totalViews, totalVisitors, topPages: top(pathTotals), topReferrers: top(refTotals) })
    })

    app.get('/export.csv', async c => {
      const days = Math.min(parseInt(c.req.query('days') || '90', 10), 365)
      const lines = ['day,views,visitors']
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10)
        const s2 = await ctx.store.kvGet<any>(`day:${d}`, { views: 0, visitors: [] })
        lines.push(`${d},${s2.views},${s2.visitors.length}`)
      }
      return c.body(lines.join('\n'), 200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="analytics.csv"' })
    })
  })
}

/** Beacon script injected on live pages (see page.ts wiring). */
export const BEACON = `<script>(function(){try{if(location.pathname.startsWith('/admin'))return;var b=function(){navigator.sendBeacon('/x/analytics/hit',JSON.stringify({p:location.pathname,r:document.referrer}))};if(document.readyState!=='loading')b();else addEventListener('DOMContentLoaded',b);addEventListener('visibilitychange',function(){},{once:true})}catch(e){}})()</script>`
