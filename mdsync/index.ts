// Markdown sync — turn a folder of .md files (an Obsidian vault, a docs repo,
// a writer's directory) into site content. Frontmatter maps to fields; the
// body becomes a richtext block; re-syncing updates changed docs and reports
// exactly what it did. Point it at a folder on the server, or upload a zip.

import type { PluginContext } from '../../blockhouse/src/core/plugin.ts'
import type { PluginManifest } from '../../blockhouse/src/core/types.ts'

export const manifest: PluginManifest = {
  id: 'mdsync', name: 'Markdown sync', version: '0.1.0', builtin: true,
  description: 'Builds pages from plain text files you write elsewhere, such as an Obsidian notebook or a folder of documents.',
  permissions: ['routes.api', 'secure.tables', 'settings.own', 'content.read', 'content.write', 'events.emit'],
}

export function register(ctx: PluginContext) {
  ctx.adminPanel({ label: 'Markdown sync', icon: 'book' })

  ctx.settingsSection({
    key: 'mdsync', label: 'Markdown sync',
    description: 'Where markdown comes from and what it becomes.',
    fields: [
      { key: 'folder', label: 'Server folder', type: 'text', help: 'Absolute path, or relative to the project — e.g. notes/ or /home/me/vault/blog', width: 'half' },
      { key: 'concept', label: 'Content type', type: 'text', default: 'post', width: 'half' },
      { key: 'publish', label: 'Publish on sync (otherwise drafts)', type: 'boolean', default: false },
      { key: 'prune', label: 'Unpublish site docs whose file disappeared', type: 'boolean', default: false },
    ],
  })

  async function settings() {
    const site = await ctx.env.site()
    return { concept: 'post', publish: false, prune: false, folder: '', ...(site.plugins?.mdsync?.settings || {}) }
  }

  ctx.routes.api(app => {
    app.post('/sync', async c => {
      const s = await settings()
      const body = await c.req.raw.formData().catch(() => null)
      const report = { created: [] as string[], updated: [] as string[], unchanged: [] as string[], pruned: [] as string[], skipped: [] as string[] }

      // sources: uploaded zip beats configured folder
      let sources: { rel: string; text: string }[] = []
      const upload = body?.get('file') as File | null
      if (upload) {
        const { unzip } = await import('../../blockhouse/src/core/zip.ts')
        const entries = await unzip(new Uint8Array(await upload.arrayBuffer()))
        sources = entries.filter(e => e.name.endsWith('.md')).map(e => ({ rel: e.name, text: new TextDecoder().decode(e.data) }))
      } else if (s.folder) {
        const dir = (ctx.env as any).projectDir
        if (!dir) return c.json({ error: 'folder sync needs a filesystem project' }, 501)
        const { readdirSync, readFileSync, statSync } = await import('node:fs')
        const { join, isAbsolute } = await import('node:path')
        const base = isAbsolute(s.folder) ? s.folder : join(dir, s.folder)
        const walk = (d: string, prefix = ''): void => {
          let names: string[] = []
          try { names = readdirSync(d) } catch { return }
          for (const name of names) {
            if (name.startsWith('.')) continue
            const p = join(d, name)
            if (statSync(p).isDirectory()) walk(p, `${prefix}${name}/`)
            else if (name.endsWith('.md')) sources.push({ rel: prefix + name, text: readFileSync(p, 'utf8') })
          }
        }
        walk(base)
      } else return c.json({ error: 'configure a folder in Settings → Plugin settings, or upload a zip' }, 400)

      if (!(await ctx.env.content.concept(s.concept))) return c.json({ error: `unknown content type "${s.concept}"` }, 400)
      const existing = await ctx.content.listDocs(s.concept)
      const index: Record<string, string> = await ctx.store.kvGet('fileIndex', {})
      const seen = new Set<string>()

      for (const src of sources.slice(0, 500)) {
        const { meta, body: md } = frontmatter(src.text)
        if (meta.draft === true || meta.skip === true) { report.skipped.push(src.rel); continue }
        const title = String(meta.title || src.rel.split('/').pop()!.replace(/\.md$/, '').replace(/[-_]/g, ' '))
        const slug = String(meta.slug || src.rel.replace(/\.md$/, '').split('/').pop()).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        seen.add(src.rel)

        const hash = await digest(src.text)
        const knownId = index[src.rel]
        const doc = knownId ? existing.find((d: any) => d.id === knownId) : existing.find((d: any) => d.slug === slug)
        if (doc && index[src.rel + ':hash'] === hash) { report.unchanged.push(src.rel); continue }

        const fields: Record<string, any> = {}
        for (const [k, v] of Object.entries(meta)) {
          if (['title', 'slug', 'draft', 'skip', 'publish'].includes(k)) continue
          fields[k] = v
        }
        const blocks = [{
          id: 'md' + hash.slice(0, 8), type: 'section', props: {}, children: [
            { id: 'md' + hash.slice(8, 16), type: 'richtext', props: { md } },
          ],
        }]

        if (doc) {
          const full = await ctx.content.getDoc(doc.id)
          await ctx.content.saveDoc({ ...full, title, fields: { ...full.fields, ...fields }, blocks })
          index[src.rel] = doc.id
          report.updated.push(src.rel)
        } else {
          const created = await (ctx.env as any).content.createDoc({ concept: s.concept, title, slug, fields, blocks, status: 'draft' }, 'mdsync')
          index[src.rel] = created.id
          report.created.push(src.rel)
        }
        index[src.rel + ':hash'] = hash
        if (s.publish || meta.publish === true) {
          await (ctx.env as any).content.publish(index[src.rel]).catch(() => {})
        }
      }

      if (s.prune) {
        for (const [rel, docId] of Object.entries(index)) {
          if (rel.endsWith(':hash') || seen.has(rel)) continue
          await (ctx.env as any).content.unpublish?.(docId)?.catch?.(() => {})
          report.pruned.push(rel)
          delete index[rel]; delete index[rel + ':hash']
        }
      }

      await ctx.store.kvSet('fileIndex', index)
      await ctx.store.kvSet('lastSync', { at: Date.now(), report: summarize(report) })
      await ctx.events.emit('synced', summarize(report))
      return c.json({ ok: true, report })
    })

    app.get('/status', async c => c.json({
      last: await ctx.store.kvGet('lastSync', null),
      tracked: Object.keys(await ctx.store.kvGet('fileIndex', {})).filter(k => !k.endsWith(':hash')).length,
    }))
  })
}

function summarize(r: any) {
  return { created: r.created.length, updated: r.updated.length, unchanged: r.unchanged.length, pruned: r.pruned.length, skipped: r.skipped.length }
}

/** Tiny frontmatter parser: --- yaml-ish --- (strings, numbers, bools, [a, b] lists). */
export function frontmatter(text: string): { meta: Record<string, any>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta: Record<string, any> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim())
    if (!kv) continue
    let v: any = kv[2].trim()
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((s: string) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    else if (v === 'true') v = true
    else if (v === 'false') v = false
    else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v)
    else v = v.replace(/^["']|["']$/g, '')
    meta[kv[1]] = v
  }
  return { meta, body: text.slice(m[0].length) }
}

async function digest(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}
