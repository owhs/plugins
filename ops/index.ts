// Sync & backups — lets a site sync its own current state into git and
// back up/restore its own data, from inside Studio itself, instead of
// needing separate VPS-level tooling and SSH access for either. Built-in,
// so it ships with every Blockhouse install rather than being specific to
// this one deployment.
//
// Git sync just runs `git add -A && git commit` in the project directory —
// if that directory (or a parent of it) has its own .git, this works with
// zero configuration. A deployment that keeps a site's working tree checked
// out against a *separate* bare repo (GIT_DIR/GIT_WORK_TREE, rather than an
// in-place .git) still works transparently, since git itself honours those
// as environment variables — this plugin never needs to know that scheme
// exists, the process environment just needs to carry them.
//
// Backups are a plain tar.gz of .blockhouse/ (users, sessions) + media/,
// written to backups/ under the project directory by default — restore
// always takes a safety snapshot of the current state first, so a bad
// restore is itself one more restore away from undone.

import type { PluginContext } from '../../blockhouse/src/core/plugin.ts'
import type { PluginManifest } from '../../blockhouse/src/core/types.ts'
import { can } from '../../blockhouse/src/core/permissions.ts'

export const manifest: PluginManifest = {
  id: 'ops', name: 'Sync & backups', version: '0.1.0', builtin: true,
  description: 'Commit the current state to git, and back up/restore this site’s own data, from Studio.',
  permissions: ['routes.api', 'settings.own'],
}

function run(cmd: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      .then(([out, err, code]) => resolve({ ok: code === 0, out: (out + err).trim() }))
  })
}

const BACKUP_NAME = /^\d{8}-\d{6}(-prerestore-\d{8}-\d{6})?\.tar\.gz$/

export function register(ctx: PluginContext) {
  // env.driver is the StorageDriver for this site's project root (site/, media/).
  // Only the local filesystem driver (FsDriver) actually has an on-disk root —
  // R2/memory/FSA-backed sites have no such path, hence the guard below.
  const dir: string | undefined = (ctx.env.driver as any)?.root
  const backupsDir = `${dir}/backups`

  ctx.adminPanel({ label: 'Sync & Backups', icon: 'db' })

  ctx.routes.api(app => {
    app.get('/status', async c => {
      if (!dir) return c.json({ error: 'no filesystem project directory (not available on Workers)' }, 501)
      const git = await run(['git', 'rev-parse', '--is-inside-work-tree'], dir)
      if (!git.ok) return c.json({ git: false })
      const log = await run(['git', 'log', '-1', '--format=%H%n%s%n%ad', '--date=relative'], dir)
      const [hash, message, date] = log.ok ? log.out.split('\n') : []
      const dirty = await run(['git', 'status', '--porcelain'], dir)
      return c.json({
        git: true,
        lastCommit: hash ? { hash: hash.slice(0, 7), message, date } : null,
        dirty: dirty.ok ? dirty.out.split('\n').filter(Boolean).length : null,
      })
    })

    app.post('/sync', async c => {
      if (!dir) return c.json({ error: 'no filesystem project directory' }, 501)
      const body = await c.req.json().catch(() => ({}))
      const message = String(body.message || '').trim() || `sync from Studio — ${new Date().toISOString()}`
      const isRepo = await run(['git', 'rev-parse', '--is-inside-work-tree'], dir)
      if (!isRepo.ok) return c.json({ error: 'not a git repository (and no GIT_DIR/GIT_WORK_TREE set)' }, 400)
      await run(['git', 'add', '-A'], dir)
      const diff = await run(['git', 'diff', '--cached', '--quiet'], dir)
      if (diff.ok) return c.json({ ok: true, synced: false, detail: 'nothing to sync' })
      const commit = await run(
        ['git', '-c', 'user.email=studio@weft.local', '-c', 'user.name=Blockhouse Studio', 'commit', '-q', '-m', message],
        dir
      )
      if (!commit.ok) return c.json({ error: commit.out }, 500)
      const rev = await run(['git', 'rev-parse', '--short', 'HEAD'], dir)
      return c.json({ ok: true, synced: true, hash: rev.out })
    })

    app.get('/backups', async c => {
      const { readdir, stat } = await import('node:fs/promises')
      try {
        const entries = await readdir(backupsDir)
        const out = []
        for (const name of entries) {
          if (!BACKUP_NAME.test(name)) continue
          const s = await stat(`${backupsDir}/${name}`)
          out.push({ name, sizeBytes: s.size, at: s.mtime, kind: name.includes('-prerestore-') ? 'prerestore' : 'backup' })
        }
        out.sort((a, b) => b.at.getTime() - a.at.getTime())
        return c.json({ backups: out })
      } catch {
        return c.json({ backups: [] })
      }
    })

    app.post('/backups/run', async c => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(backupsDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
      const name = `${stamp}.tar.gz`
      const args = ['tar', '-czf', `${backupsDir}/${name}`, '-C', dir]
      const { existsSync } = await import('node:fs')
      if (existsSync(`${dir}/.blockhouse`)) args.push('.blockhouse')
      if (existsSync(`${dir}/media`)) args.push('media')
      if (args.length <= 5) return c.json({ error: 'nothing to back up — no .blockhouse or media directory' }, 400)
      const res = await run(args, dir)
      if (!res.ok) return c.json({ error: res.out }, 500)
      return c.json({ ok: true, name })
    })

    // Restoring overwrites live user accounts/sessions and uploaded media —
    // require settings.write on top of the plugin's own manage grant, so
    // "can sync/back up" doesn't silently imply "can restore".
    app.post('/backups/restore', async c => {
      const user = (c as any).get('user')
      if (!can(user, 'settings.write')) return c.json({ error: 'permission required: settings.write' }, 403)
      const body = await c.req.json().catch(() => ({}))
      const name = String(body.name || '')
      if (!BACKUP_NAME.test(name)) return c.json({ error: 'invalid backup name' }, 400)
      const { existsSync } = await import('node:fs')
      const archive = `${backupsDir}/${name}`
      if (!existsSync(archive)) return c.json({ error: 'no such backup' }, 404)

      const { mkdir } = await import('node:fs/promises')
      await mkdir(backupsDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
      const safety = `${stamp}-prerestore-${stamp}.tar.gz`
      const safetyArgs = ['tar', '-czf', `${backupsDir}/${safety}`, '-C', dir]
      if (existsSync(`${dir}/.blockhouse`)) safetyArgs.push('.blockhouse')
      if (existsSync(`${dir}/media`)) safetyArgs.push('media')
      if (safetyArgs.length > 5) await run(safetyArgs, dir)

      const res = await run(['tar', '-xzf', archive, '-C', dir], dir)
      if (!res.ok) return c.json({ error: res.out }, 500)
      ctx.env.invalidate?.()
      return c.json({ ok: true, safetySnapshot: safetyArgs.length > 5 ? safety : null })
    })
  })
}
