// Sync & backups — lets a site sync its own current state into git and
// back up/restore its own data, from inside Studio itself, instead of
// needing separate VPS-level tooling and SSH access for either. Built-in,
// so it ships with every Blockhouse install rather than being specific to
// this one deployment.
//
// Git sync stages everything and commits it (commit-tree, so no edit-message
// file is needed in the repo) in the project directory —
// if that directory (or a parent of it) has its own .git, this works with
// zero configuration. A deployment that keeps a site's working tree checked
// out against a *separate* bare repo (GIT_DIR/GIT_WORK_TREE, rather than an
// in-place .git) still works transparently, since git itself honours those
// as environment variables — this plugin never needs to know that scheme
// exists, the process environment just needs to carry them.
//
// Versions are plain commits on the site's one branch; a named version is a
// tag. Going back to a version restores its files and saves that as a new
// version, so the branch is never switched and nothing is ever lost.
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
import { privateStateDir } from '../../blockhouse/src/secure/sql.ts'

export const manifest: PluginManifest = {
  id: 'ops', name: 'Versions & backups', version: '0.1.0', builtin: true,
  description: 'Keeps a history of this site and backs it up, so you can put things back the way they were.',
  permissions: ['routes.api', 'settings.own'],
}

// A shared bare repo (core.sharedRepository) makes git chmod every object
// directory it creates to include the setgid bit. A hardened service
// (systemd RestrictSUIDSGID=yes, which the weft site units use) is forbidden to
// set that bit, so the chmod fails and the write dies with "unable to create
// temporary file: Operation not permitted" — whenever a new object lands in a
// directory that doesn't exist yet. The repo's directories are already setgid
// (inherited from their parent), so skip git's chmod and take the group-shared
// permissions from the umask instead: 007 keeps everything group-writable for
// the deploy user and closed to the world.
function gitCmd(cmd: string[]): string[] {
  if (cmd[0] !== 'git' || process.platform === 'win32') return cmd
  return ['sh', '-c', 'umask 007; exec "$@"', 'sh', 'git', '-c', 'core.sharedRepository=false', ...cmd.slice(1)]
}

function run(cmd: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    const proc = Bun.spawn(gitCmd(cmd), { cwd, stdout: 'pipe', stderr: 'pipe' })
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      .then(([out, err, code]) => resolve({ ok: code === 0, out: (out + err).trim() }))
  })
}

const BACKUP_NAME = /^\d{8}-\d{6}(-prerestore-\d{8}-\d{6}|-[a-z0-9][a-z0-9-]{0,39})?\.tar\.gz$/
const LABEL = /^[a-z0-9][a-z0-9-]{0,39}$/
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

export function register(ctx: PluginContext) {
  // env.driver is the StorageDriver for this site's project root (site/, media/).
  // Only the local filesystem driver (FsDriver) actually has an on-disk root —
  // R2/memory/FSA-backed sites have no such path, hence the guard below.
  const dir: string | undefined = (ctx.env.driver as any)?.root
  const backupsDir = `${dir}/backups`
  // Archives carry a full copy of .blockhouse/ (password hashes, sessions,
  // sealed secrets), so they get the same owner-only treatment as the original.
  const privateBackupsDir = async () => {
    const { mkdir, chmod } = await import('node:fs/promises')
    await mkdir(backupsDir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(backupsDir, 0o700).catch(() => {})
  }
  const privateArchive = async (path: string) => {
    if (process.platform === 'win32') return
    const { chmod } = await import('node:fs/promises')
    await chmod(path, 0o600).catch(() => {})
  }

  ctx.adminPanel({ label: 'Versions & backups', icon: 'db' })

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
    // ---------- versions ----------
    // One timeline. "Save a version" is a commit; naming it adds a tag; "go
    // back" restores that version's files and saves THAT as a new version, so
    // the history only ever moves forward and the site never leaves its branch.
    // Commits are made with commit-tree + update-ref rather than `git commit`,
    // which needs to write COMMIT_EDITMSG in the repo — a file a stricter
    // deployment may not let this process touch.

    const AUTHOR = ['-c', 'user.email=studio@weft.local', '-c', 'user.name=Blockhouse Studio']
    const VERSION_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
    const isRepo = async () => (await run(['git', 'rev-parse', '--is-inside-work-tree'], dir!)).ok
    const branchOf = async () => (await run(['git', 'branch', '--show-current'], dir!)).out || 'master'

    // Accounts, keys and sessions (.blockhouse), uploads and backups live inside
    // the site folder but are never part of a version: backups cover them.
    const NEVER_VERSIONED = ['.blockhouse/', 'backups/', 'media/_var/']
    const isProtected = (path: string) => NEVER_VERSIONED.some(p => path === p.slice(0, -1) || path.startsWith(p))
    async function keepPrivateOutOfGit() {
      const gd = (await run(['git', 'rev-parse', '--git-dir'], dir!)).out
      if (!gd) return
      const { readFile, writeFile, mkdir } = await import('node:fs/promises')
      const path = `${gd.startsWith('/') || /^[A-Za-z]:/.test(gd) ? gd : `${dir}/${gd}`}/info/exclude`
      const cur = await readFile(path, 'utf8').catch(() => '')
      const missing = NEVER_VERSIONED.filter(p => !cur.split('\n').some(l => l.trim() === p))
      if (!missing.length) return
      await mkdir(path.replace(/[\\/]exclude$/, ''), { recursive: true }).catch(() => {})
      await writeFile(path, `${cur.trimEnd()}\n${missing.join('\n')}\n`.trimStart()).catch(() => {})
      // anything of theirs that an older setup had already versioned stops being tracked
      await run(['git', 'rm', '-r', '-q', '--cached', '--ignore-unmatch', ...NEVER_VERSIONED.map(p => p.slice(0, -1))], dir!)
    }

    async function dirtyCount(): Promise<number> {
      const st = await run(['git', 'status', '--porcelain'], dir!)
      return st.ok ? st.out.split('\n').filter(Boolean).length : 0
    }

    // On the weft server a saved version goes straight on to GitHub as well,
    // via the server's own mirror script (which holds the GitHub sign-in).
    // Anywhere else — a laptop, a different host — there is nothing to do.
    function mirrorToGithub() {
      const script = '/srv/weft/infra/bin/github-mirror.ts'
      const gitDir = process.env.GIT_DIR || ''
      const repo = gitDir.split('/').pop()?.replace(/\.git$/, '')
      if (!repo || process.platform === 'win32') return
      import('node:fs').then(({ existsSync }) => {
        if (!existsSync(script)) return
        Bun.spawn([process.execPath, script, repo], { cwd: '/srv/weft/infra', stdout: 'ignore', stderr: 'ignore' })
      }).catch(() => {})
    }

    // A bare "Operation not permitted" says nothing about which step or which
    // file. Name the step and, for permission failures, who the studio is running
    // as and who owns the version history, so whoever looks after the server can
    // fix it from the message alone.
    async function failed(step: string, out: string): Promise<string> {
      let msg = `${step}: ${out}`
      if (!/not permitted|permission denied|EPERM|EACCES/i.test(out)) return msg
      try {
        const { stat } = await import('node:fs/promises')
        const gd = (await run(['git', 'rev-parse', '--absolute-git-dir'], dir!)).out
        const me = typeof process.getuid === 'function' ? `uid ${process.getuid()}, gid ${process.getgid?.()}` : 'unknown user'
        const owner = async (p: string) => {
          const s = await stat(p).catch(() => null)
          return s ? `${p} owner ${s.uid}:${s.gid} mode ${(s.mode & 0o7777).toString(8)}` : `${p} missing`
        }
        const bits = gd ? [await owner(gd), await owner(`${gd}/index`), await owner(`${gd}/objects`), await owner(`${gd}/refs/heads`)] : []
        msg += ` [studio runs as ${me}; ${bits.join('; ')}]`
      } catch {}
      return msg
    }

    /** Commit whatever is on disk. Returns the new hash, or null when nothing changed. */
    async function saveVersion(message: string): Promise<{ hash: string | null; error?: string }> {
      await keepPrivateOutOfGit()
      const add = await run(['git', 'add', '-A'], dir!)
      if (!add.ok) return { hash: null, error: await failed('git add', add.out) }
      const branch = await branchOf()
      const head = (await run(['git', 'rev-parse', '--verify', '--quiet', 'HEAD'], dir!)).out
      const tree = await run(['git', 'write-tree'], dir!)
      if (!tree.ok) return { hash: null, error: await failed('git write-tree', tree.out) }
      if (head) {
        const same = await run(['git', 'diff-tree', '--quiet', head, tree.out], dir!)
        if (same.ok) return { hash: null }
      }
      const commit = await run(['git', ...AUTHOR, 'commit-tree', tree.out, ...(head ? ['-p', head] : []), '-m', message], dir!)
      if (!commit.ok) return { hash: null, error: await failed('git commit-tree', commit.out) }
      const up = await run(['git', 'update-ref', `refs/heads/${branch}`, commit.out, head || ''], dir!)
      if (!up.ok) return { hash: null, error: await failed('git update-ref', up.out) }
      mirrorToGithub()
      return { hash: commit.out }
    }

    app.get('/status', async c => {
      if (!dir) return c.json({ error: 'no filesystem project directory (not available on Workers)' }, 501)
      if (!(await isRepo())) return c.json({ git: false })
      const log = await run(['git', 'log', '-1', '--format=%H%n%s%n%ad', '--date=relative'], dir)
      const [hash, message, date] = log.ok ? log.out.split('\n') : []
      return c.json({ git: true, branch: await branchOf(), lastCommit: hash ? { hash: hash.slice(0, 7), message, date } : null, dirty: await dirtyCount() })
    })

    app.get('/versions', async c => {
      if (!dir) return c.json({ error: 'no filesystem project directory' }, 501)
      if (!(await isRepo())) return c.json({ git: false, versions: [] })
      const log = await run(['git', 'log', '-40', '--format=%H%x09%s%x09%ad%x09%ct%x09%D', '--date=relative', '--decorate=short', '--decorate-refs=refs/tags'], dir)
      const versions = log.ok ? log.out.split('\n').filter(Boolean).map(l => {
        const [hash, message, date, ts, deco] = l.split('\t')
        const names = (deco || '').split(',').map(x => x.trim().replace(/^tag: /, '')).filter(Boolean)
        return { hash, short: hash.slice(0, 7), message, date, at: Number(ts) * 1000, names }
      }) : []
      return c.json({ git: true, dirty: await dirtyCount(), versions })
    })

    // Save now, optionally under a name people can find again.
    app.post('/sync', async c => {
      if (!dir) return c.json({ error: 'no filesystem project directory' }, 501)
      if (!(await isRepo())) return c.json({ error: 'not a git repository (and no GIT_DIR/GIT_WORK_TREE set)' }, 400)
      const body = await c.req.json().catch(() => ({}))
      const name = String(body.name || '').trim().toLowerCase().replace(/\s+/g, '-')
      if (name && !VERSION_NAME.test(name)) return c.json({ error: 'invalid version name — lowercase letters, numbers and dashes only' }, 400)
      const message = String(body.message || '').trim() || (name ? `Version: ${name}` : `Saved from the studio — ${new Date().toISOString()}`)
      const res = await saveVersion(message)
      if (res.error) return c.json({ error: res.error }, 500)
      let hash = res.hash
      if (!hash) {
        if (!name) return c.json({ ok: true, synced: false, detail: 'nothing to sync' })
        hash = (await run(['git', 'rev-parse', 'HEAD'], dir)).out   // name the version that already exists
      }
      if (name) {
        const tag = await run(['git', 'update-ref', `refs/tags/${name}`, hash], dir)
        if (!tag.ok) return c.json({ error: tag.out }, 500)
      }
      return c.json({ ok: true, synced: !!res.hash, named: name || null, hash: hash.slice(0, 7) })
    })

    // Put the site's files back as they were in an older version. Unsaved
    // work is saved first so nothing is lost; the result is a new version.
    app.post('/versions/:hash/restore', async c => {
      if (!dir) return c.json({ error: 'no filesystem project directory' }, 501)
      const user = (c as any).get('user')
      if (!can(user, 'settings.write')) return c.json({ error: 'permission required: settings.write' }, 403)
      const target = c.req.param('hash')
      if (!/^[0-9a-f]{7,40}$/.test(target)) return c.json({ error: 'invalid version' }, 400)
      const ok = await run(['git', 'cat-file', '-e', `${target}^{commit}`], dir)
      if (!ok.ok) return c.json({ error: 'no such version' }, 404)
      const label = (await run(['git', 'log', '-1', '--format=%s', target], dir)).out
      let savedFirst: string | null = null
      if (await dirtyCount()) {
        const s = await saveVersion('Saved automatically before going back to an earlier version')
        if (s.error) return c.json({ error: s.error }, 500)
        savedFirst = s.hash
      }
      // Files become that version's: write every file it has, then remove the
      // ones only the current version has — except the private folders, which
      // no version is ever allowed to add or delete. HEAD does not move.
      const gone = (await run(['git', 'diff', '--name-only', '--diff-filter=D', 'HEAD', target], dir)).out.split('\n').filter(Boolean).filter(f => !isProtected(f))
      const rt = await run(['git', 'read-tree', '--reset', target], dir)
      if (!rt.ok) return c.json({ error: rt.out }, 500)
      await run(['git', 'rm', '-r', '-q', '--cached', '--ignore-unmatch', ...NEVER_VERSIONED.map(p => p.slice(0, -1))], dir)
      const co = await run(['git', 'checkout-index', '-a', '-f'], dir)
      if (!co.ok) return c.json({ error: co.out }, 500)
      const { rm } = await import('node:fs/promises')
      for (const f of gone) await rm(`${dir}/${f}`, { force: true }).catch(() => {})
      const s = await saveVersion(`Went back to: ${label}`)
      if (s.error) return c.json({ error: s.error }, 500)
      ctx.env.invalidate?.()
      return c.json({ ok: true, savedFirst: !!savedFirst, hash: (s.hash || target).slice(0, 7) })
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

      await privateBackupsDir()
      const name = `${stamp()}${label ? '-' + label : ''}.tar.gz`
      const args = ['tar', '-czf', `${backupsDir}/${name}`, '-C', dir]
      const { existsSync } = await import('node:fs')
      if (existsSync(`${dir}/.blockhouse`)) args.push('.blockhouse')
      if (existsSync(`${dir}/media`)) args.push('media')
      if (args.length <= 5) return c.json({ error: 'nothing to back up — no .blockhouse or media directory' }, 400)
      const res = await run(args, dir)
      await privateArchive(`${backupsDir}/${name}`)
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

      await privateBackupsDir()
      const s = stamp()
      const safety = `${s}-prerestore-${s}.tar.gz`
      const safetyArgs = ['tar', '-czf', `${backupsDir}/${safety}`, '-C', dir]
      if (existsSync(`${dir}/.blockhouse`)) safetyArgs.push('.blockhouse')
      if (existsSync(`${dir}/media`)) safetyArgs.push('media')
      if (safetyArgs.length > 5) { await run(safetyArgs, dir); await privateArchive(`${backupsDir}/${safety}`) }

      const res = await run(['tar', '-xzf', archive, '-C', dir], dir)
      // an archive taken before the lockdown carries .blockhouse/ as 755
      if (existsSync(`${dir}/.blockhouse`)) await privateStateDir(`${dir}/.blockhouse`)
      if (!res.ok) return c.json({ error: res.out }, 500)
      ctx.env.invalidate?.()

      const settings = await backupSettings()
      await pruneBackups(settings.maxBackups)
      return c.json({ ok: true, safetySnapshot: safetyArgs.length > 5 ? safety : null })
    })
  })
}
