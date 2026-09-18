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
// Branches reuse plain git branches rather than inventing a parallel
// "draft" concept: abandoning in-progress work commits it onto a new branch
// (nothing is lost, it's just not live any more) and switches the working
// tree back to whichever branch is the site's actual current state. Picking
// that branch back up later is an ordinary checkout.
//
// Backups are a plain tar.gz of .blockhouse/ (users, sessions) + media/,
// written to backups/ under the project directory by default — restore
// always takes a safety snapshot of the current state first, so a bad
// restore is itself one more restore away from undone. Governed by a small
// settings section (enable/disable, retention count, skip-if-unchanged) so
// a site that leans entirely on git sync can turn them down without losing
// the mechanism.

import type { PluginContext } from '../../blockhouse/src/core/plugin.ts'
import type { PluginManifest } from '../../blockhouse/src/core/types.ts'
import { can } from '../../blockhouse/src/core/permissions.ts'

export const manifest: PluginManifest = {
  id: 'ops', name: 'Sync & backups', version: '0.1.0', builtin: true,
  description: 'Commit the current state to git, branch off in-progress work, and back up/restore this site’s own data, from Studio.',
  permissions: ['routes.api', 'settings.own'],
}

function run(cmd: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      .then(([out, err, code]) => resolve({ ok: code === 0, out: (out + err).trim() }))
  })
}

const BACKUP_NAME = /^\d{8}-\d{6}(-prerestore-\d{8}-\d{6}|-[a-z0-9][a-z0-9-]{0,39})?\.tar\.gz$/
const LABEL = /^[a-z0-9][a-z0-9-]{0,39}$/
// Git ref rules, kept conservative rather than exhaustive: no "..", no
// "@{", no leading/trailing dash or slash, no ".lock" suffix.
const BRANCH_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,50}[a-zA-Z0-9]$/
function validBranch(name: string) {
  return BRANCH_NAME.test(name) && !name.includes('..') && !name.includes('@{') && !name.endsWith('.lock')
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

export function register(ctx: PluginContext) {
  // env.driver is the StorageDriver for this site's project root (site/, media/).
  // Only the local filesystem driver (FsDriver) actually has an on-disk root —
  // R2/memory/FSA-backed sites have no such path, hence the guard below.
  const dir: string | undefined = (ctx.env.driver as any)?.root
  const backupsDir = `${dir}/backups`

  ctx.adminPanel({ label: 'Sync & Backups', icon: 'db' })

  ctx.settingsSection({
    key: 'backups', label: 'Backups',
    description: 'Automatic tar.gz snapshots of this site’s users, sessions and media. Git sync (above) covers content — this covers what git doesn’t.',
    fields: [
      { key: 'enabled', label: 'Enable backups', type: 'boolean', default: true },
      { key: 'maxBackups', label: 'Keep at most this many', type: 'number', default: 30, help: 'Oldest backups are deleted first once this is exceeded. Pre-restore safety snapshots count too.' },
      { key: 'skipIfUnchanged', label: 'Skip a backup run if nothing changed since the last one', type: 'boolean', default: true },
    ],
  })

  async function backupSettings() {
    const site = await ctx.env.site()
    const s = site.plugins?.ops?.settings || {}
    const max = Math.floor(Number(s.maxBackups))
    return {
      enabled: s.enabled !== false,
      maxBackups: Number.isFinite(max) && max > 0 ? max : 30,
      skipIfUnchanged: s.skipIfUnchanged !== false,
    }
  }

  // Cheap change-detection: sum of mtimes + file count under the backed-up
  // directories. Not a content hash — doesn't need to be, it only has to
  // notice "nothing touched these since last time".
  async function contentSignature(): Promise<string> {
    const { readdir, stat } = await import('node:fs/promises')
    let sig = 0, count = 0
    const walk = async (base: string) => {
      let entries
      try { entries = await readdir(base, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const full = `${base}/${e.name}`
        if (e.isDirectory()) await walk(full)
        else { try { const s = await stat(full); sig += s.mtimeMs; count++ } catch {} }
      }
    }
    await walk(`${dir}/.blockhouse`)
    await walk(`${dir}/media`)
    return `${count}:${Math.round(sig)}`
  }

  async function pruneBackups(max: number) {
    const { readdir, stat, unlink } = await import('node:fs/promises')
    let entries: string[]
    try { entries = await readdir(backupsDir) } catch { return }
    const withStat = []
    for (const name of entries) {
      if (!BACKUP_NAME.test(name)) continue
      try { withStat.push({ name, mtime: (await stat(`${backupsDir}/${name}`)).mtimeMs }) } catch {}
    }
    withStat.sort((a, b) => a.mtime - b.mtime)
    while (withStat.length > max) {
      const oldest = withStat.shift()!
      await unlink(`${backupsDir}/${oldest.name}`).catch(() => {})
    }
  }

  ctx.routes.api(app => {
    // ---------- git sync ----------

    app.get('/status', async c => {
      if (!dir) return c.json({ error: 'no filesystem project directory (not available on Workers)' }, 501)
      const git = await run(['git', 'rev-parse', '--is-inside-work-tree'], dir)
      if (!git.ok) return c.json({ git: false })
      const log = await run(['git', 'log', '-1', '--format=%H%n%s%n%ad', '--date=relative'], dir)
      const [hash, message, date] = log.ok ? log.out.split('\n') : []
      const dirty = await run(['git', 'status', '--porcelain'], dir)
      const branch = await run(['git', 'branch', '--show-current'], dir)
      return c.json({
        git: true,
        branch: branch.ok ? branch.out : null,
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

    // ---------- branches ----------
    // A branch is just a checkpoint you can come back to. "Cancel" doesn't
    // delete anything — it commits whatever's currently on disk onto its
    // own branch, then puts the working tree back on the one the site is
    // actually meant to be running.

    app.get('/branches', async c => {
      if (!dir) return c.json({ error: 'no filesystem project directory' }, 501)
      const isRepo = await run(['git', 'rev-parse', '--is-inside-work-tree'], dir)
      if (!isRepo.ok) return c.json({ git: false, branches: [] })
      const current = (await run(['git', 'branch', '--show-current'], dir)).out
      const list = await run(['git', 'for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%09%(objectname:short)%09%(subject)%09%(committerdate:relative)', 'refs/heads'], dir)
      const branches = list.ok
        ? list.out.split('\n').filter(Boolean).map(line => {
            const [name, hash, message, date] = line.split('\t')
            return { name, hash, message, date, current: name === current }
          })
        : []
      const dirty = await run(['git', 'status', '--porcelain'], dir)
      return c.json({ git: true, current, dirty: dirty.ok ? dirty.out.split('\n').filter(Boolean).length : 0, branches })
    })

    // Save whatever's on disk right now as a new named checkpoint. Leaves
    // the site running on that branch (nothing on disk changes to do this —
    // it's the same content, just labelled and switched to).
    app.post('/branches', async c => {
      if (!dir) return c.json({ error: 'no filesystem project directory' }, 501)
      const body = await c.req.json().catch(() => ({}))
      const name = String(body.name || '').trim().toLowerCase().replace(/\s+/g, '-')
      if (!validBranch(name)) return c.json({ error: 'invalid branch name — letters, numbers, dot, dash, slash, underscore only' }, 400)
      const message = String(body.message || '').trim() || `checkpoint: ${name}`
      const isRepo = await run(['git', 'rev-parse', '--is-inside-work-tree'], dir)
      if (!isRepo.ok) return c.json({ error: 'not a git repository' }, 400)
      const exists = await run(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`], dir)
      if (exists.ok) return c.json({ error: `branch "${name}" already exists` }, 409)
      const checkout = await run(['git', 'checkout', '-b', name], dir)
      if (!checkout.ok) return c.json({ error: checkout.out }, 500)
      await run(['git', 'add', '-A'], dir)
      const diff = await run(['git', 'diff', '--cached', '--quiet'], dir)
      if (!diff.ok) {
        const commit = await run(
          ['git', '-c', 'user.email=studio@weft.local', '-c', 'user.name=Blockhouse Studio', 'commit', '-q', '-m', message],
          dir
        )
        if (!commit.ok) return c.json({ error: commit.out }, 500)
      }
      return c.json({ ok: true, branch: name })
    })

    // Switch the live site to an existing branch. Refuses over uncommitted
    // changes rather than guessing what to do with them — save a checkpoint
    // (or sync) first.
    app.post('/branches/:name/checkout', async c => {
      if (!dir) return c.json({ error: 'no filesystem project directory' }, 501)
      const name = c.req.param('name')
      if (!validBranch(name)) return c.json({ error: 'invalid branch name' }, 400)
      const exists = await run(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`], dir)
      if (!exists.ok) return c.json({ error: `no such branch "${name}"` }, 404)
      const dirty = await run(['git', 'status', '--porcelain'], dir)
      if (dirty.ok && dirty.out.trim()) return c.json({ error: 'uncommitted changes on disk — save a checkpoint or sync first' }, 409)
      const checkout = await run(['git', 'checkout', name], dir)
      if (!checkout.ok) return c.json({ error: checkout.out }, 500)
      ctx.env.invalidate?.()
      return c.json({ ok: true, branch: name })
    })

    // The actual "I don't like this, cancel it, but don't throw it away"
    // flow: auto-saves any dirty work to its own branch, then puts the
    // working tree back on the target branch (the site's real state).
    app.post('/branches/cancel', async c => {
      if (!dir) return c.json({ error: 'no filesystem project directory' }, 501)
      const body = await c.req.json().catch(() => ({}))
      const revertTo = String(body.revertTo || 'master').trim()
      if (!validBranch(revertTo)) return c.json({ error: 'invalid target branch name' }, 400)
      const revertExists = await run(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${revertTo}`], dir)
      if (!revertExists.ok) return c.json({ error: `no such branch "${revertTo}" to revert to` }, 400)

      const dirty = await run(['git', 'status', '--porcelain'], dir)
      let savedBranch: string | null = null
      if (dirty.ok && dirty.out.trim()) {
        const name = String(body.saveAs || '').trim().toLowerCase().replace(/\s+/g, '-') || `wip-${stamp()}`
        if (!validBranch(name)) return c.json({ error: 'invalid branch name for the saved work' }, 400)
        const exists = await run(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`], dir)
        if (exists.ok) return c.json({ error: `branch "${name}" already exists — choose another name` }, 409)
        const checkout = await run(['git', 'checkout', '-b', name], dir)
        if (!checkout.ok) return c.json({ error: checkout.out }, 500)
        await run(['git', 'add', '-A'], dir)
        const commit = await run(
          ['git', '-c', 'user.email=studio@weft.local', '-c', 'user.name=Blockhouse Studio', 'commit', '-q', '-m', 'cancelled — auto-saved before revert'],
          dir
        )
        if (!commit.ok) return c.json({ error: commit.out }, 500)
        savedBranch = name
      }

      const checkout = await run(['git', 'checkout', revertTo], dir)
      if (!checkout.ok) return c.json({ error: checkout.out }, 500)
      ctx.env.invalidate?.()
      return c.json({ ok: true, savedBranch, revertedTo: revertTo })
    })

    // ---------- backups ----------

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
        const settings = await backupSettings()
        return c.json({ backups: out, settings })
      } catch {
        return c.json({ backups: [], settings: await backupSettings() })
      }
    })

    app.post('/backups/run', async c => {
      const settings = await backupSettings()
      if (!settings.enabled) return c.json({ error: 'backups are disabled — Settings → Plugin settings → Backups' }, 400)

      const body = await c.req.json().catch(() => ({}))
      const label = String(body.label || '').trim().toLowerCase().replace(/\s+/g, '-')
      if (label && !LABEL.test(label)) return c.json({ error: 'invalid label — lowercase letters, numbers, dashes only' }, 400)

      if (settings.skipIfUnchanged) {
        const sig = await contentSignature()
        const last = await ctx.settings.get<string | null>('lastBackupSignature', null)
        if (last === sig) return c.json({ ok: true, skipped: true, detail: 'nothing changed since the last backup' })
      }

      const { mkdir } = await import('node:fs/promises')
      await mkdir(backupsDir, { recursive: true })
      const name = `${stamp()}${label ? '-' + label : ''}.tar.gz`
      const args = ['tar', '-czf', `${backupsDir}/${name}`, '-C', dir]
      const { existsSync } = await import('node:fs')
      if (existsSync(`${dir}/.blockhouse`)) args.push('.blockhouse')
      if (existsSync(`${dir}/media`)) args.push('media')
      if (args.length <= 5) return c.json({ error: 'nothing to back up — no .blockhouse or media directory' }, 400)
      const res = await run(args, dir)
      if (!res.ok) return c.json({ error: res.out }, 500)

      await ctx.settings.set('lastBackupSignature', await contentSignature())
      await pruneBackups(settings.maxBackups)
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
      const s = stamp()
      const safety = `${s}-prerestore-${s}.tar.gz`
      const safetyArgs = ['tar', '-czf', `${backupsDir}/${safety}`, '-C', dir]
      if (existsSync(`${dir}/.blockhouse`)) safetyArgs.push('.blockhouse')
      if (existsSync(`${dir}/media`)) safetyArgs.push('media')
      if (safetyArgs.length > 5) await run(safetyArgs, dir)

      const res = await run(['tar', '-xzf', archive, '-C', dir], dir)
      if (!res.ok) return c.json({ error: res.out }, 500)
      ctx.env.invalidate?.()

      const settings = await backupSettings()
      await pruneBackups(settings.maxBackups)
      return c.json({ ok: true, safetySnapshot: safetyArgs.length > 5 ? safety : null })
    })
  })
}
