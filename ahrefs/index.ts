// Ahrefs — the site's backlinks, rankings, keywords and audit health from the
// Ahrefs API v3, inside the studio, next to the pages they are about.
//
//   Overview      Domain Rating, referring domains, organic traffic, and their history
//   Backlinks     new / lost / all links, referring domains, anchors
//   Broken links  other sites linking to addresses that no longer exist here —
//                 the studio turns each into a redirect in one click
//   Keywords      what the site ranks for, with movement over 30 days
//   Pages         top pages by search traffic, matched to the page in the studio
//   Research      Keywords Explorer: volume, difficulty, ideas, questions, SERP
//   Projects      Site Audit health + issues, Rank Tracker, Web Analytics
//   Page lookups  the editor's SEO tab asks for one URL and one focus keyword
//
// Every Ahrefs call costs API units — max(50, rows × the sum of the columns'
// costs), where some columns cost 10 each — so: columns are chosen for what the
// studio shows and nothing more, list reports fetch `rows` rows (default 50),
// every answer is cached (default 24h), an optional cap stops fresh calls
// before the account overruns, nothing is fetched until a report is opened,
// and each answer records what Ahrefs says it actually cost.
//
// The API key lives in the secure store. Everything else (target, country, the
// public Web Analytics key and the verification tag) is written to
// site.json → plugins.ahrefs.settings, because the page renderer reads the last
// two to put them in <head>. This panel is the only writer of those fields.

import type { PluginContext } from '../../blockhouse/src/core/plugin.ts'
import type { PluginManifest } from '../../blockhouse/src/core/types.ts'
import { sha256hex } from '../../blockhouse/src/core/util.ts'

export const manifest: PluginManifest = {
  id: 'ahrefs', name: 'Ahrefs', version: '0.1.0', builtin: true,
  description: 'Backlinks, rankings, keyword research and site-audit health from your Ahrefs account, shown next to your pages.',
  permissions: ['routes.api', 'settings.own', 'net.fetch', 'secure.tables', 'content.read', 'actions.register', 'events.emit'],
}

/** Overridable for tests and local mocks only; there is no studio setting for it. */
const API = ((globalThis as any).process?.env?.AHREFS_API_BASE || 'https://api.ahrefs.com/v3').replace(/\/$/, '')

export const MODES = ['subdomains', 'domain', 'prefix', 'exact'] as const
const SNAPSHOT_EVERY_MS = 20 * 3600e3

export interface AhrefsSettings {
  target: string          // domain or URL Ahrefs reports on; empty = the site's own address
  mode: typeof MODES[number]
  country: string         // two-letter code, for keyword and traffic reports
  cacheHours: number
  rows: number            // rows per list report — the main lever on unit spend
  unitCap: number         // 0 = no cap; otherwise stop fresh calls past this many units this cycle
  autoSnapshot: boolean   // record a daily snapshot and fire change events
  projectId: string       // Ahrefs project for Site Audit / Rank Tracker / Web Analytics
  analyticsKey: string    // public data-key for Ahrefs Web Analytics
  loadAnalytics: boolean
  verification: string    // ahrefs-site-verification meta content
}

export const DEFAULTS: AhrefsSettings = {
  target: '', mode: 'subdomains', country: 'gb', cacheHours: 24, rows: 50, unitCap: 0,
  autoSnapshot: true, projectId: '', analyticsKey: '', loadAnalytics: false, verification: '',
}

/** "https://www.example.com/path" → "www.example.com" for domain modes; the URL itself for prefix/exact. */
export function normaliseTarget(raw: string, mode: string): string {
  let t = String(raw || '').trim()
  if (!t) return ''
  if (mode === 'prefix' || mode === 'exact') return /^https?:\/\//.test(t) ? t : `https://${t}`
  t = t.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '')
  return t.toLowerCase()
}

const day = (offset = 0) => new Date(Date.now() - offset * 864e5).toISOString().slice(0, 10)
const clampInt = (v: any, lo: number, hi: number, dflt: number) => {
  const n = parseInt(String(v), 10)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}
const csvCell = (v: any) => {
  const s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export function toCsv(rows: Record<string, any>[]): string {
  if (!rows.length) return ''
  const cols = Object.keys(rows[0])
  return [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n')
}

export class AhrefsError extends Error {
  constructor(message: string, public status = 502, public code = 'ahrefs') { super(message) }
}

/** Ahrefs errors arrive as {error: "..."} or ["Error","Forbidden"]; say what they mean. */
export function explainError(status: number, body: string): string {
  let msg = body
  try {
    const j = JSON.parse(body)
    msg = Array.isArray(j) ? j.slice(1).join(' ') : j.error || j.message || body
  } catch {}
  msg = String(msg || '').slice(0, 240)
  if (status === 401 || status === 403) return `Ahrefs refused the API key (${msg || 'forbidden'}). Check it is an API v3 key and your plan includes API access.`
  if (status === 429) return 'Ahrefs is rate-limiting this key — wait a minute and try again.'
  if (status === 402 || /units|limit/i.test(msg)) return `Ahrefs says the API unit allowance is used up: ${msg}`
  return `Ahrefs error ${status}: ${msg}`
}

export function register(ctx: PluginContext) {
  ctx.adminPanel({ label: 'Ahrefs', icon: 'link', section: 'site' })

  // ---------- configuration ----------

  async function settings(): Promise<AhrefsSettings> {
    const site = await ctx.env.site()
    const s = { ...DEFAULTS, ...(site.plugins?.ahrefs?.settings || {}) }
    if (!MODES.includes(s.mode)) s.mode = 'subdomains'
    return s
  }
  async function siteTarget(s?: AhrefsSettings): Promise<string> {
    s ||= await settings()
    if (s.target) return normaliseTarget(s.target, s.mode)
    const site = await ctx.env.site()
    return normaliseTarget(site.url || '', s.mode)
  }
  const apiKey = () => ctx.settings.get<string>('apiKey', '')

  // ---------- the client: cache → cap → fetch ----------

  const usageKey = () => `calls:${day().slice(0, 7)}`
  const unitsKey = () => `units:${day().slice(0, 7)}`
  let usageCache: { at: number; data: any } | null = null

  /** One request. Resolves to { json, units } — units as Ahrefs reports it charged. */
  async function raw(path: string, params: Record<string, any>, key?: string): Promise<{ json: any; units: number }> {
    const k = key ?? await apiKey()
    if (!k) throw new AhrefsError('Add your Ahrefs API key first (Ahrefs → Setup).', 400, 'no_key')
    const qs = new URLSearchParams()
    for (const [p, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') qs.set(p, typeof v === 'object' ? JSON.stringify(v) : String(v))
    qs.set('output', 'json')
    let res: Response
    try {
      res = await ctx.fetch(`${API}${path}?${qs}`, { headers: { authorization: `Bearer ${k}`, accept: 'application/json' } })
    } catch (e: any) {
      throw new AhrefsError(`Could not reach Ahrefs: ${e?.message || e}`, 502, 'network')
    }
    const text = await res.text()
    if (!res.ok) throw new AhrefsError(explainError(res.status, text), res.status === 401 || res.status === 403 ? 400 : res.status === 429 ? 429 : 502, res.status === 401 || res.status === 403 ? 'bad_key' : 'ahrefs')
    const units = parseInt(res.headers.get('x-api-units-cost-total-actual') || res.headers.get('x-api-units-cost-total') || '0', 10) || 0
    await ctx.store.kvSet(usageKey(), (await ctx.store.kvGet<number>(usageKey(), 0)) + 1)
    if (units) await ctx.store.kvSet(unitsKey(), (await ctx.store.kvGet<number>(unitsKey(), 0)) + units)
    try { return { json: JSON.parse(text), units } } catch { throw new AhrefsError('Ahrefs sent something that is not JSON.') }
  }

  async function usage(force = false): Promise<any> {
    if (!force && usageCache && Date.now() - usageCache.at < 3600e3) return usageCache.data
    const { json: j } = await raw('/subscription-info/limits-and-usage', {})
    usageCache = { at: Date.now(), data: j.limits_and_usage || {} }
    return usageCache.data
  }

  async function guardCap(s: AhrefsSettings) {
    if (!s.unitCap) return
    const u = await usage().catch(() => null)
    const used = u?.units_usage_api_key ?? u?.units_usage_workspace ?? 0
    if (used >= s.unitCap) throw new AhrefsError(`Paused: this key has used ${used.toLocaleString()} of the ${s.unitCap.toLocaleString()} units you allowed this cycle. Raise the cap under Ahrefs → Setup, or wait for ${u?.usage_reset_date || 'the reset date'}.`, 429, 'cap')
  }

  /**
   * Cached call. `fresh` skips the cache; the cap still applies.
   * `units` is what this call spent now — 0 when the answer came from the cache.
   */
  async function call(path: string, params: Record<string, any>, opts: { fresh?: boolean; ttlHours?: number } = {}): Promise<{ data: any; cachedAt: number; units: number; cached: boolean }> {
    const s = await settings()
    const ck = `cache:${(await sha256hex(path + JSON.stringify(params))).slice(0, 24)}`
    const ttl = (opts.ttlHours ?? s.cacheHours) * 3600e3
    if (!opts.fresh) {
      const hit = await ctx.store.kvGet<any>(ck, null)
      if (hit && Date.now() - hit.at < ttl) return { data: hit.data, cachedAt: hit.at, units: 0, cached: true }
    }
    await guardCap(s)
    const { json: data, units } = await raw(path, params)
    const at = Date.now()
    await ctx.store.kvSet(ck, { at, data })
    const idx = await ctx.store.kvGet<string[]>('cacheIndex', [])
    if (!idx.includes(ck)) { idx.push(ck); await ctx.store.kvSet('cacheIndex', idx.slice(-2000)) }
    return { data, cachedAt: at, units, cached: false }
  }
  const spent = (...rs: ({ units: number } | null)[]) => rs.reduce((n, r) => n + (r?.units || 0), 0)
  const allCached = (...rs: ({ cached: boolean } | null)[]) => rs.filter(Boolean).every(r => r!.cached)
  const oldest = (...rs: ({ cachedAt: number } | null)[]) => Math.min(...rs.filter(Boolean).map(r => r!.cachedAt))

  async function clearCache() {
    const idx = await ctx.store.kvGet<string[]>('cacheIndex', [])
    for (const k of idx) await ctx.store.kvSet(k, null)
    await ctx.store.kvSet('cacheIndex', [])
    usageCache = null
    return idx.length
  }

  // ---------- reports ----------

  async function base(fresh: boolean) {
    const s = await settings()
    const target = await siteTarget(s)
    if (!target) throw new AhrefsError('Set the site’s address (Settings → General) or a target under Ahrefs → Setup.', 400, 'no_target')
    return { s, target, fresh }
  }

  async function overview(fresh = false) {
    const { s, target } = await base(fresh)
    const common = { target, mode: s.mode, protocol: 'both' }
    const from = day(365)
    const [dr, bl, m, drH, rdH, mH] = await Promise.all([
      call('/site-explorer/domain-rating', { target, date: day() }, { fresh }),
      call('/site-explorer/backlinks-stats', { ...common, date: day() }, { fresh }),
      call('/site-explorer/metrics', { ...common, date: day(), country: s.country || undefined }, { fresh }),
      call('/site-explorer/domain-rating-history', { target, date_from: from, history_grouping: 'weekly' }, { fresh }),
      call('/site-explorer/refdomains-history', { ...common, date_from: from, history_grouping: 'weekly' }, { fresh }),
      // monthly, and traffic only: org_traffic and org_cost are 10 units a row each
      call('/site-explorer/metrics-history', { ...common, date_from: from, history_grouping: 'monthly', select: 'date,org_traffic', country: s.country || undefined }, { fresh }),
    ])
    return {
      target, mode: s.mode, country: s.country,
      cachedAt: oldest(dr, bl, m, drH, rdH, mH), units: spent(dr, bl, m, drH, rdH, mH), cached: allCached(dr, bl, m, drH, rdH, mH),
      domainRating: dr.data.domain_rating?.domain_rating ?? null,
      ahrefsRank: dr.data.domain_rating?.ahrefs_rank ?? null,
      backlinks: bl.data.metrics || {},
      metrics: m.data.metrics || {},
      history: {
        domainRating: (drH.data.domain_ratings || []).map((r: any) => ({ date: r.date, value: r.domain_rating })),
        refdomains: (rdH.data.refdomains || []).map((r: any) => ({ date: r.date, value: r.refdomains })),
        traffic: (mH.data.metrics || []).map((r: any) => ({ date: r.date, value: r.org_traffic })),
      },
    }
  }

  // traffic_domain (10 units a row) is left out: DR says as much for a link list
  const BACKLINK_COLS = 'url_from,url_to,title,anchor,domain_rating_source,is_dofollow,first_seen_link,last_seen,lost_reason'
  async function backlinks(kind: string, fresh: boolean) {
    const { s, target } = await base(fresh)
    const common = { target, mode: s.mode, protocol: 'both', limit: s.rows }
    if (kind === 'broken') {
      const r = await call('/site-explorer/broken-backlinks', {
        ...common, aggregation: '1_per_domain', order_by: 'domain_rating_source:desc',
        select: 'url_from,url_to,title,anchor,domain_rating_source,is_dofollow,first_seen_link',
      }, { fresh })
      return { cachedAt: r.cachedAt, units: r.units, cached: r.cached, rows: r.data.backlinks || [] }
    }
    const since = day(30)
    const where = kind === 'new' ? { field: 'first_seen_link', is: ['gte', since] }
      : kind === 'lost' ? { field: 'last_seen', is: ['gte', since] }
      : undefined
    const r = await call('/site-explorer/all-backlinks', {
      ...common, select: BACKLINK_COLS, aggregation: '1_per_domain',
      history: kind === 'lost' ? `since:${since}` : 'live',
      where: kind === 'lost' ? { and: [where, { field: 'is_lost', is: ['eq', true] }] } : where,
      order_by: kind === 'all' ? 'domain_rating_source:desc' : kind === 'new' ? 'first_seen_link:desc' : 'last_seen:desc',
    }, { fresh })
    return { cachedAt: r.cachedAt, units: r.units, cached: r.cached, rows: r.data.backlinks || [] }
  }

  async function refdomains(fresh: boolean) {
    const { s, target } = await base(fresh)
    const r = await call('/site-explorer/refdomains', {
      target, mode: s.mode, protocol: 'both', limit: s.rows, history: 'live', order_by: 'domain_rating:desc',
      select: 'domain,domain_rating,links_to_target,dofollow_links,first_seen,is_spam',
    }, { fresh })
    return { cachedAt: r.cachedAt, units: r.units, cached: r.cached, rows: r.data.refdomains || [] }
  }

  async function anchors(fresh: boolean) {
    const { s, target } = await base(fresh)
    const r = await call('/site-explorer/anchors', {
      target, mode: s.mode, protocol: 'both', limit: s.rows, history: 'live', order_by: 'refdomains:desc',
      select: 'anchor,refdomains,links_to_target,dofollow_links',
    }, { fresh })
    return { cachedAt: r.cachedAt, units: r.units, cached: r.cached, rows: r.data.anchors || [] }
  }

  async function organicKeywords(fresh: boolean, url?: string, limit?: number) {
    const { s, target } = await base(fresh)
    const r = await call('/site-explorer/organic-keywords', {
      target: url || target, mode: url ? 'exact' : s.mode, protocol: 'both', limit: limit || s.rows,
      country: s.country || undefined, date: day(), date_compared: day(30), order_by: 'sum_traffic:desc',
      select: 'keyword,best_position,best_position_prev,best_position_url,volume,keyword_difficulty,sum_traffic,is_branded',
    }, { fresh })
    return { cachedAt: r.cachedAt, units: r.units, cached: r.cached, rows: r.data.keywords || [] }
  }

  /** Map an Ahrefs URL onto a studio document, when it is one of ours. */
  async function docIndex() {
    const map = new Map<string, { id: string; title: string; status: string }>()
    const docs = await ctx.content.listDocs()
    for (const d of docs) {
      try { map.set(await ctx.env.content.docPath(d), { id: d.id, title: d.title, status: d.status }) } catch {}
    }
    return map
  }
  const pathOf = (u: string) => { try { return new URL(u).pathname.replace(/\/$/, '') || '/' } catch { return '' } }

  async function topPages(fresh: boolean) {
    const { s, target } = await base(fresh)
    const r = await call('/site-explorer/top-pages', {
      target, mode: s.mode, protocol: 'both', limit: s.rows, country: s.country || undefined,
      date: day(), date_compared: day(30), order_by: 'sum_traffic:desc',
      select: 'url,sum_traffic,traffic_diff,keywords,top_keyword,top_keyword_best_position,referring_domains,ur',
    }, { fresh })
    const docs = await docIndex()
    const rows = (r.data.pages || []).map((p: any) => {
      const path = pathOf(p.url || '')
      const d = docs.get(path) || docs.get(path + '/')
      return { ...p, path, doc: d || null }
    })
    return { cachedAt: r.cachedAt, units: r.units, cached: r.cached, rows }
  }

  async function competitors(fresh: boolean) {
    const { s, target } = await base(fresh)
    const r = await call('/site-explorer/organic-competitors', {
      target, mode: s.mode, protocol: 'both', limit: Math.min(s.rows, 20), country: s.country || 'gb', date: day(),
      order_by: 'keywords_common:desc',
      select: 'competitor_domain,domain_rating,keywords_common,keywords_competitor,traffic',
    }, { fresh })
    return { cachedAt: r.cachedAt, units: r.units, cached: r.cached, rows: r.data.competitors || [] }
  }

  // global_volume is 10 units a row: the overview asks for it once, the idea lists don't
  const KW_COLS = 'keyword,volume,difficulty,traffic_potential'
  async function research(q: string, country: string, fresh: boolean) {
    const keyword = String(q || '').trim().slice(0, 200)
    if (!keyword) throw new AhrefsError('Type a keyword to research.', 400, 'no_keyword')
    const c = country || (await settings()).country || 'gb'
    const [ov, match, questions, related] = await Promise.all([
      call('/keywords-explorer/overview', { keywords: keyword, country: c, select: KW_COLS + ',cpc,global_volume,parent_topic' }, { fresh }),
      call('/keywords-explorer/matching-terms', { keywords: keyword, country: c, select: KW_COLS, limit: 20, order_by: 'volume:desc' }, { fresh }),
      call('/keywords-explorer/matching-terms', { keywords: keyword, country: c, select: KW_COLS, limit: 10, terms: 'questions', order_by: 'volume:desc' }, { fresh }),
      call('/keywords-explorer/related-terms', { keywords: keyword, country: c, select: KW_COLS, limit: 10, order_by: 'volume:desc' }, { fresh }),
    ])
    return {
      keyword, country: c, cachedAt: oldest(ov, match, questions, related), units: spent(ov, match, questions, related), cached: allCached(ov, match, questions, related),
      overview: ov.data.keywords?.[0] || null,
      matching: match.data.keywords || [], questions: questions.data.keywords || [], related: related.data.keywords || [],
    }
  }

  async function serp(q: string, country: string, fresh: boolean) {
    const keyword = String(q || '').trim().slice(0, 200)
    if (!keyword) throw new AhrefsError('Type a keyword.', 400, 'no_keyword')
    const c = country || (await settings()).country || 'gb'
    const r = await call('/serp-overview/serp-overview', {
      keyword, country: c, top_positions: 10,
      select: 'position,url,title,domain_rating,refdomains,traffic,type',
    }, { fresh })
    return { keyword, country: c, cachedAt: r.cachedAt, units: r.units, cached: r.cached, rows: r.data.positions || [] }
  }

  /** One URL (and optionally its focus keyword) — for the editor's SEO tab. */
  async function pageReport(path: string, keyword: string, fresh: boolean) {
    const s = await settings()
    const site = await ctx.env.site()
    const origin = (site.url || '').replace(/\/$/, '')
    if (!origin) throw new AhrefsError('Set the site’s address under Settings → General first.', 400, 'no_target')
    const url = origin + (path.startsWith('/') ? path : `/${path}`)
    const [bl, m, kws, kw] = await Promise.all([
      call('/site-explorer/backlinks-stats', { target: url, mode: 'exact', protocol: 'both', date: day() }, { fresh }),
      call('/site-explorer/metrics', { target: url, mode: 'exact', protocol: 'both', date: day(), country: s.country || undefined }, { fresh }),
      organicKeywords(fresh, url, 10),
      keyword ? call('/keywords-explorer/overview', { keywords: keyword, country: s.country || 'gb', select: KW_COLS + ',parent_topic' }, { fresh }) : null,
    ])
    return {
      url, cachedAt: oldest(bl, m, kws, kw), units: spent(bl, m, kws, kw), cached: allCached(bl, m, kws, kw),
      backlinks: bl.data.metrics || {}, metrics: m.data.metrics || {},
      keywords: kws.rows, focus: kw ? (kw.data.keywords?.[0] || null) : null,
    }
  }

  async function projects(fresh: boolean) {
    const r = await call('/management/projects', {}, { fresh, ttlHours: 6 })
    return { cachedAt: r.cachedAt, units: r.units, cached: r.cached, rows: r.data.projects || [] }
  }

  async function needProject() {
    const s = await settings()
    const id = parseInt(s.projectId, 10)
    if (!id) throw new AhrefsError('Choose your Ahrefs project under Ahrefs → Setup to see audits, rankings and visits.', 400, 'no_project')
    return id
  }

  async function audit(fresh: boolean) {
    const project_id = await needProject()
    const [hs, issues] = await Promise.all([
      call('/site-audit/projects', { project_id }, { fresh, ttlHours: 6 }),
      call('/site-audit/issues', { project_id }, { fresh, ttlHours: 6 }),
    ])
    const order: Record<string, number> = { Error: 0, Warning: 1, Notice: 2 }
    const rows = (issues.data.issues || [])
      .filter((i: any) => (i.crawled || 0) > 0)
      .sort((a: any, b: any) => (order[a.importance] ?? 3) - (order[b.importance] ?? 3) || (b.crawled || 0) - (a.crawled || 0))
    return { cachedAt: oldest(hs, issues), units: spent(hs, issues), cached: allCached(hs, issues), health: hs.data.healthscores?.[0] || null, issues: rows }
  }

  async function ranks(device: string, fresh: boolean) {
    const project_id = await needProject()
    const r = await call('/rank-tracker/overview', {
      project_id, device: device === 'mobile' ? 'mobile' : 'desktop', date: day(), date_compared: day(7),
      select: 'keyword,position,position_prev,position_diff,url,volume,keyword_difficulty,traffic,location,tags,serp_features',
      order_by: 'traffic:desc', limit: 500,
    }, { fresh, ttlHours: 6 })
    return { cachedAt: r.cachedAt, units: r.units, cached: r.cached, rows: r.data.overviews || [] }
  }

  async function visits(days: number, fresh: boolean) {
    const project_id = await needProject()
    const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 19)
    const to = new Date().toISOString().slice(0, 19)
    const [stats, chart, pages, sources] = await Promise.all([
      call('/web-analytics/stats', { project_id, from, to }, { fresh, ttlHours: 1 }),
      call('/web-analytics/chart', { project_id, from, to, granularity: days > 60 ? 'weekly' : 'daily' }, { fresh, ttlHours: 1 }),
      call('/web-analytics/top-pages', { project_id, from, to, limit: 15, order_by: 'visitors:desc' }, { fresh, ttlHours: 1 }),
      call('/web-analytics/sources', { project_id, from, to, limit: 15, order_by: 'visitors:desc' }, { fresh, ttlHours: 1 }),
    ])
    return {
      cachedAt: oldest(stats, chart, pages, sources), units: spent(stats, chart, pages, sources), cached: allCached(stats, chart, pages, sources),
      stats: stats.data.stats || {},
      series: (chart.data.points || []).map((p: any) => ({ date: String(p.timestamp).slice(0, 10), value: p.visitors })),
      pages: pages.data.stats || [],
      sources: sources.data.stats || [],
    }
  }

  // ---------- snapshots: a local record the Ahrefs history can't give you ----------

  async function snapshot(opts: { force?: boolean } = {}) {
    const last = await ctx.store.kvGet<any>('snapshot:last', null)
    if (!opts.force && last && Date.now() - last.at < SNAPSHOT_EVERY_MS) return { skipped: true, snapshot: last }
    const ov = await overview(true)
    const snap = {
      at: Date.now(), day: day(), target: ov.target,
      domainRating: ov.domainRating,
      refdomains: ov.backlinks.live_refdomains ?? null,
      backlinks: ov.backlinks.live ?? null,
      organicTraffic: ov.metrics.org_traffic ?? null,
      organicKeywords: ov.metrics.org_keywords ?? null,
      top3: ov.metrics.org_keywords_1_3 ?? null,
    }
    const hist = await ctx.store.kvGet<any[]>('snapshots', [])
    hist.push(snap)
    await ctx.store.kvSet('snapshots', hist.slice(-400))
    await ctx.store.kvSet('snapshot:last', snap)
    const changes = last && last.target === snap.target ? diffSnapshots(last, snap) : []
    await ctx.events.emit('snapshot', { ...snap, changes }).catch(() => {})
    if (changes.length) await ctx.events.emit('changed', { ...snap, previous: last, changes, summary: changes.map(c => c.text).join('; ') }).catch(() => {})
    return { skipped: false, snapshot: snap, changes }
  }

  // An in-process daily tick. Harmless where timers don't outlive a request
  // (Workers): the dashboard also takes a snapshot when it's stale.
  const tick = async () => {
    try {
      const s = await settings()
      if (s.autoSnapshot && await apiKey()) await snapshot()
    } catch (e: any) { ctx.log('snapshot skipped:', e?.message || e) }
  }
  const timer: any = (globalThis as any).setInterval?.(tick, 3600e3)
  timer?.unref?.()

  // ---------- routes (/api/x/ahrefs/…) ----------

  const fail = (c: any, e: any) => {
    const status = e instanceof AhrefsError ? e.status : 500
    return c.json({ error: String(e?.message || e), code: e?.code || 'error' }, status)
  }
  const wrap = (fn: (c: any) => Promise<any>) => async (c: any) => {
    try { return c.json(await fn(c)) } catch (e) { return fail(c, e) }
  }
  const fresh = (c: any) => c.req.query('fresh') === '1'
  const linkKind = (k: any) => (['new', 'lost', 'all', 'broken'].includes(k) ? k : 'all')

  ctx.routes.api(app => {
    app.get('/config', wrap(async () => {
      const s = await settings()
      const key = await apiKey()
      const month = day().slice(0, 7)
      return {
        ...s, hasKey: !!key, keyHint: key ? `…${key.slice(-4)}` : '',
        resolvedTarget: await siteTarget(s),
        callsThisMonth: await ctx.store.kvGet<number>(`calls:${month}`, 0),
        unitsThisMonth: await ctx.store.kvGet<number>(`units:${month}`, 0),
      }
    }))

    app.put('/config', async c => {
      const body = await c.req.json().catch(() => ({}))
      try {
        if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
          const k = body.apiKey.trim()
          // Prove the key works before keeping it — the cheapest call there is.
          const { json: j } = await raw('/subscription-info/limits-and-usage', {}, k)
          await ctx.settings.set('apiKey', k)
          usageCache = { at: Date.now(), data: j.limits_and_usage || {} }
        }
        const cur = await settings()
        const next: AhrefsSettings = { ...cur }
        if (body.target !== undefined) next.target = String(body.target).trim().slice(0, 300)
        if (body.mode !== undefined && MODES.includes(body.mode)) next.mode = body.mode
        if (body.country !== undefined) next.country = /^[a-z]{2}$/i.test(body.country) ? String(body.country).toLowerCase() : ''
        if (body.cacheHours !== undefined) next.cacheHours = clampInt(body.cacheHours, 1, 24 * 14, 24)
        if (body.rows !== undefined) next.rows = clampInt(body.rows, 10, 1000, 50)
        if (body.unitCap !== undefined) next.unitCap = clampInt(body.unitCap, 0, 1e9, 0)
        if (body.autoSnapshot !== undefined) next.autoSnapshot = !!body.autoSnapshot
        if (body.projectId !== undefined) next.projectId = String(body.projectId).replace(/\D/g, '')
        if (body.analyticsKey !== undefined) next.analyticsKey = String(body.analyticsKey).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100)
        if (body.loadAnalytics !== undefined) next.loadAnalytics = !!body.loadAnalytics
        if (body.verification !== undefined) {
          // Accept the whole <meta …> tag Ahrefs shows, or just its content value.
          const v = String(body.verification).trim()
          const m = /content=["']([^"']+)["']/.exec(v)
          next.verification = (m ? m[1] : v).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 200)
        }
        const site = await ctx.env.site()
        const entry = site.plugins?.ahrefs || { enabled: true, approved: [] }
        await ctx.env.content.saveSite({ plugins: { ...site.plugins, ahrefs: { ...entry, settings: next } } })
        return c.json({ ok: true })
      } catch (e) { return fail(c, e) }
    })

    app.delete('/config/key', async c => {
      await ctx.settings.set('apiKey', '')
      usageCache = null
      return c.json({ ok: true })
    })

    app.get('/usage', wrap(async c => ({ usage: await usage(fresh(c)) })))
    app.post('/cache/clear', wrap(async () => ({ cleared: await clearCache() })))

    app.get('/overview', wrap(async c => {
      const ov = await overview(fresh(c))
      // the dashboard keeps the local record going on hosts with no long-lived timer
      const s = await settings()
      if (s.autoSnapshot) snapshot().catch(() => {})
      return ov
    }))
    app.get('/backlinks', wrap(async c => backlinks(linkKind(c.req.query('kind')), fresh(c))))
    app.get('/refdomains', wrap(async c => refdomains(fresh(c))))
    app.get('/anchors', wrap(async c => anchors(fresh(c))))
    app.get('/keywords', wrap(async c => organicKeywords(fresh(c))))
    app.get('/pages', wrap(async c => topPages(fresh(c))))
    app.get('/competitors', wrap(async c => competitors(fresh(c))))
    app.get('/research', wrap(async c => research(c.req.query('q') || '', c.req.query('country') || '', fresh(c))))
    app.get('/serp', wrap(async c => serp(c.req.query('q') || '', c.req.query('country') || '', fresh(c))))
    app.get('/page', wrap(async c => pageReport(c.req.query('path') || '/', c.req.query('keyword') || '', fresh(c))))
    app.get('/projects', wrap(async c => projects(fresh(c))))
    app.get('/audit', wrap(async c => audit(fresh(c))))
    app.get('/ranks', wrap(async c => ranks(c.req.query('device') || 'desktop', fresh(c))))
    app.get('/visits', wrap(async c => visits(clampInt(c.req.query('days'), 1, 365, 30), fresh(c))))
    app.get('/snapshots', wrap(async () => ({ snapshots: await ctx.store.kvGet<any[]>('snapshots', []) })))
    app.post('/snapshots', wrap(async () => snapshot({ force: true })))

    // CSV of any list report — same rows and columns as the screen, so it's
    // normally answered from the cache and costs nothing
    app.get('/export/:report', async c => {
      const report = c.req.param('report').replace(/\.csv$/, '')
      const f = fresh(c)
      try {
        const rows =
          report === 'backlinks' ? (await backlinks(linkKind(c.req.query('kind')), f)).rows
          : report === 'refdomains' ? (await refdomains(f)).rows
          : report === 'anchors' ? (await anchors(f)).rows
          : report === 'keywords' ? (await organicKeywords(f)).rows
          : report === 'pages' ? (await topPages(f)).rows.map(({ doc, ...r }: any) => ({ ...r, studio_page: doc?.title || '' }))
          : report === 'competitors' ? (await competitors(f)).rows
          : report === 'ranks' ? (await ranks(c.req.query('device') || 'desktop', f)).rows
          : report === 'snapshots' ? await ctx.store.kvGet<any[]>('snapshots', [])
          : null
        if (!rows) return c.json({ error: 'unknown report' }, 404)
        return c.body(toCsv(rows), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="ahrefs-${report}-${day()}.csv"` })
      } catch (e) { return fail(c, e) }
    })
  })

  // ---------- automation actions ----------

  ctx.actions.register({
    type: 'ahrefs.snapshot', label: 'Ahrefs: record today’s numbers',
    fields: [{ key: 'force', label: 'Take one even if there is one from today', type: 'boolean' }],
    run: async o => {
      const r = await snapshot({ force: !!o.force })
      return { ...r.snapshot, skipped: r.skipped, changes: (r as any).changes?.map((c: any) => c.text).join('; ') || '' }
    },
  })

  ctx.actions.register({
    type: 'ahrefs.keyword', label: 'Ahrefs: look up a keyword',
    fields: [
      { key: 'keyword', label: 'Keyword', help: 'Can use {placeholders} from the event, e.g. {data.keyword}', required: true },
      { key: 'country', label: 'Country (two letters)', help: 'Defaults to the one set under Ahrefs → Setup' },
    ],
    run: async (o, payload) => {
      const kw = String(o.keyword || '').replace(/\{([\w.]+)\}/g, (_: string, p: string) => String(p.split('.').reduce((a: any, k: string) => a?.[k], payload) ?? ''))
      const s = await settings()
      const r = await call('/keywords-explorer/overview', { keywords: kw, country: o.country || s.country || 'gb', select: KW_COLS })
      const k = r.data.keywords?.[0] || {}
      return { keyword: kw, volume: k.volume ?? null, difficulty: k.difficulty ?? null, trafficPotential: k.traffic_potential ?? null, parentTopic: k.parent_topic ?? null }
    },
  })

  ctx.actions.register({
    type: 'ahrefs.domainRating', label: 'Ahrefs: Domain Rating of a site',
    fields: [{ key: 'target', label: 'Domain', help: 'e.g. example.com or {data.website}', required: true }],
    run: async (o, payload) => {
      const t = normaliseTarget(String(o.target || '').replace(/\{([\w.]+)\}/g, (_: string, p: string) => String(p.split('.').reduce((a: any, k: string) => a?.[k], payload) ?? '')), 'domain')
      const r = await call('/site-explorer/domain-rating', { target: t, date: day() })
      return { target: t, domainRating: r.data.domain_rating?.domain_rating ?? null, ahrefsRank: r.data.domain_rating?.ahrefs_rank ?? null }
    },
  })
}

/** What moved between two snapshots, in words an owner reads in an email. */
export function diffSnapshots(prev: any, next: any): { key: string; from: number; to: number; text: string }[] {
  const out: { key: string; from: number; to: number; text: string }[] = []
  const rule = (key: string, label: string, min: number, pct = 0) => {
    const a = prev?.[key], b = next?.[key]
    if (typeof a !== 'number' || typeof b !== 'number') return
    const d = b - a
    if (Math.abs(d) < min && (!pct || !a || Math.abs(d) / a < pct)) return
    if (d === 0) return
    out.push({ key, from: a, to: b, text: `${label} ${d > 0 ? 'rose' : 'fell'} from ${a.toLocaleString()} to ${b.toLocaleString()}` })
  }
  rule('domainRating', 'Domain Rating', 1)
  rule('refdomains', 'Referring domains', 5, 0.05)
  rule('organicTraffic', 'Estimated search traffic', 1e9, 0.15)
  rule('organicKeywords', 'Ranking keywords', 1e9, 0.1)
  rule('top3', 'Keywords in the top 3', 3, 0.1)
  return out
}

/** <head> additions for live pages — see render/page.ts. Empty unless configured. */
export function headHtml(settings: Partial<AhrefsSettings> | undefined, opts: { consentGate?: boolean } = {}): string {
  const s = { ...DEFAULTS, ...(settings || {}) }
  const out: string[] = []
  const ver = String(s.verification || '').replace(/[^A-Za-z0-9_-]/g, '')
  if (ver) out.push(`<meta name="ahrefs-site-verification" content="${ver}">`)
  const key = String(s.analyticsKey || '').replace(/[^A-Za-z0-9_-]/g, '')
  if (key && s.loadAnalytics) {
    // Cookieless, but a site running the consent banner has promised visitors
    // that analytics waits for a yes, so it waits.
    out.push(opts.consentGate
      ? `<script>(function(){try{var c=(document.cookie.match(/(?:^|; )blockhouse_consent=([^;]*)/)||[])[1];if(!c||c.indexOf('analytics')<0)return;var s=document.createElement('script');s.src='https://analytics.ahrefs.com/analytics.js';s.async=true;s.setAttribute('data-key',${JSON.stringify(key)});document.head.appendChild(s)}catch(e){}})()</script>`
      : `<script src="https://analytics.ahrefs.com/analytics.js" data-key="${key}" async></script>`)
  }
  return out.join('\n')
}
