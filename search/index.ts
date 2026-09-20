// Search — an inverted index over published content, rebuilt on publish.
// Live mode: /x/search/api?q=… ranks by field-weighted term frequency.
// Static mode: the export writes search-index.json + the same client UI works
// against it (the search block ships a tiny fetch-and-rank runtime).

import type { PluginContext } from '../../blockhouse/src/core/plugin.ts'
import { isGated } from '../../blockhouse/src/core/access.ts'
import type { PluginManifest } from '../../blockhouse/src/core/types.ts'
import { escapeAttr as ea, escapeHtml as eh } from '../../blockhouse/src/core/util.ts'
import { mdText } from '../../blockhouse/src/core/markdown.ts'

export const manifest: PluginManifest = {
  id: 'search', name: 'Search', version: '0.1.0', builtin: true,
  description: 'A search box for your site, so visitors can find a page by typing part of its name.',
  permissions: ['blocks.register', 'routes.public', 'routes.api', 'settings.own', 'events.listen', 'content.read'],
}

interface Entry { path: string; title: string; excerpt: string; concept: string; text: string }

export function register(ctx: PluginContext) {
  let index: Entry[] | null = null

  async function build(): Promise<Entry[]> {
    const docs = await ctx.env.content.listDocs(undefined, { published: true })
    const out: Entry[] = []
    for (const d of docs) {
      if (d.status !== 'published' || d.seo?.noindex) continue
      if (isGated(d)) continue   // member-only pages never enter the public index
      out.push({
        path: await ctx.env.content.docPath(d),
        title: d.title,
        excerpt: (d.seo?.description || textOf(d).slice(0, 160)).trim(),
        concept: d.concept,
        text: (d.title + ' ' + (d.seo?.keyword || '') + ' ' + textOf(d)).toLowerCase(),
      })
    }
    return out
  }
  async function ensure() { return (index ??= await build()) }

  ctx.events.on('content.published', async () => { index = null })
  ctx.events.on('content.unpublished', async () => { index = null })
  ctx.events.on('content.saved', async () => { index = null })

  ctx.adminPanel({ label: 'Search', icon: 'search', settingsOnly: true })

  ctx.routes.public(app => {
    // OpenSearch target: /x/search/go?q=… — 302 to the best match, or render a
    // tiny results page when nothing is certain.
    app.get('/go', async c => {
      const q = String(c.req.query('q') || '').trim()
      const entries = await ensure()
      const list = rank(entries, q).slice(0, 10)
      if (list.length === 1) return c.redirect(list[0].path, 302)
      const site = await ctx.env.site()
      const items = list.map(r => `<li><a href="${r.path}">${esc(r.title)}</a><p>${esc(r.excerpt)}</p></li>`).join('')
      return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Search — ${esc(site.name)}</title><link rel="stylesheet" href="/assets/site/tokens.css"><link rel="stylesheet" href="/assets/site/base.css"><style>main{max-width:44rem;margin:3rem auto;padding:0 1.2rem}li{list-style:none;margin-bottom:1.1rem}ul{padding:0}</style></head><body><main><h1>Search: “${esc(q)}”</h1><ul>${items || '<li>No results.</li>'}</ul><p><a href="/">← ${esc(site.name)}</a></p></main></body></html>`)
    })

    app.get('/api', async c => {
      const q = (c.req.query('q') || '').toLowerCase().trim()
      if (!q) return c.json({ results: [] })
      const results = rank(await ensure(), q).slice(0, 20)
      return c.json({ results: results.map(({ text, ...r }) => r) })
    })
    // static index (also emitted at export time)
    app.get('/index.json', async c => c.json({ entries: (await ensure()).map(({ text, ...r }) => ({ ...r, text })) }))
  })

  ctx.routes.api(app => {
    app.post('/reindex', async c => { index = null; const e = await ensure(); return c.json({ ok: true, entries: e.length }) })
    app.get('/stats', async c => c.json({ entries: (await ensure()).length }))
  })

  ctx.blocks.register({
    type: 'search', label: 'Search', group: 'Interactive', icon: 'search',
    description: 'Site search — instant built-in results, or hand the query to a web engine',
    fields: [
      { key: 'placeholder', type: 'text', label: 'Placeholder', default: 'Search…' },
      {
        key: 'provider', type: 'select', label: 'Provider', default: 'builtin', options: [
          { value: 'builtin', label: 'Built-in — instant results, no third parties' },
          { value: 'duckduckgo', label: 'DuckDuckGo site search' },
          { value: 'google', label: 'Google site search' },
          { value: 'custom', label: 'Custom search URL' },
        ],
        help: 'Built-in works live and on static exports (prebuilt index). Engines need your site indexed publicly.',
      },
      { key: 'source', type: 'select', label: 'Built-in index', options: [{ value: 'api', label: 'Live API' }, { value: 'static', label: 'Static index.json' }], default: 'api', help: 'Static is chosen automatically in flat exports' },
      { key: 'customUrl', type: 'text', label: 'Custom URL', help: 'For provider “Custom” — {q} is replaced with the query, e.g. https://example.com/find?q={q}' },
    ],
    enhance: 'search',
    render: (c, n) => {
      const provider = n.props.provider || 'builtin'
      const ph = ea(n.props.placeholder || 'Search…')
      if (provider === 'builtin') {
        // flat exports have no live API — fall back to the prebuilt index
        const source = c.mode === 'export' ? 'static' : (n.props.source || 'api')
        return `<div class="wb-search" data-search data-source="${ea(source)}">` +
          `<div class="search-box">${SEARCH_ICON}<input type="search" placeholder="${ph}" aria-label="Search" autocomplete="off"></div>` +
          `<div class="search-results" role="listbox" hidden></div></div>`
      }
      const host = (() => { try { return new URL(c.site.url).hostname } catch { return '' } })()
      if (provider === 'duckduckgo') {
        // DDG supports the sites= parameter officially — no JS needed
        return `<form class="wb-search wb-search-ext" action="https://duckduckgo.com/" method="get" rel="noopener">` +
          `<div class="search-box">${SEARCH_ICON}<input type="search" name="q" placeholder="${ph}" aria-label="Search this site" autocomplete="off">` +
          `<input type="hidden" name="sites" value="${ea(host)}"><button class="btn btn-primary search-go" type="submit">Search</button></div>` +
          `<p class="search-note">Results open on DuckDuckGo, limited to ${ea(host)}.</p></form>`
      }
      if (provider === 'google') {
        // site: prefix is merged in by the enhancer; without JS the plain query still works
        return `<form class="wb-search wb-search-ext" action="https://www.google.com/search" method="get" data-sitesearch="${ea(host)}" rel="noopener">` +
          `<div class="search-box">${SEARCH_ICON}<input type="search" name="q" placeholder="${ph}" aria-label="Search this site" autocomplete="off">` +
          `<button class="btn btn-primary search-go" type="submit">Search</button></div>` +
          `<p class="search-note">Results open on Google, limited to ${ea(host)}.</p></form>`
      }
      const tpl = String(n.props.customUrl || '/?q={q}')
      return `<form class="wb-search wb-search-ext" data-searchurl="${ea(tpl)}">` +
        `<div class="search-box">${SEARCH_ICON}<input type="search" placeholder="${ph}" aria-label="Search" autocomplete="off">` +
        `<button class="btn btn-primary search-go" type="submit">Search</button></div></form>`
    },
  })
}

function esc(v: string): string { return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }

function textOf(doc: any): string {
  let out = ''
  const walk = (blocks: any[]) => {
    for (const b of blocks || []) {
      const p = b.props || {}
      if (p.md) out += ' ' + mdText(p.md)
      for (const k of ['title', 'text', 'question', 'label', 'eyebrow', 'caption']) if (p[k]) out += ' ' + p[k]
      walk(b.children)
    }
  }
  walk(doc.blocks)
  return out.replace(/\s+/g, ' ').trim()
}

export function rank(entries: Entry[], q: string): Entry[] {
  const terms = q.split(/\s+/).filter(Boolean)
  const scored = entries.map(e => {
    let score = 0
    const title = e.title.toLowerCase()
    for (const t of terms) {
      if (title.includes(t)) score += 10
      if (title.startsWith(t)) score += 5
      const hits = e.text.split(t).length - 1
      score += Math.min(hits, 8)
    }
    if (title === q) score += 50
    return { e, score }
  })
  return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).map(s => s.e)
}

const SEARCH_ICON = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5L21 21"/></svg>`
