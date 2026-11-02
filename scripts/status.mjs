#!/usr/bin/env node
/**
 * Read-only status of one bundle package inside one dsh profile.
 *
 * Never writes anything: no backup, no pnpm, no server. It answers "is this
 * package installed, selected, composed and loadable" so a broken install is
 * visible before a boot turns it into a startup failure.
 *
 * Usage:
 *   node scripts/status.mjs --profile explore-scratch
 *   node scripts/status.mjs --profile web --name dsh-explore-tree
 *   node scripts/status.mjs --profile web --json --no-dump
 */

import { existsSync, lstatSync, readlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  REPO_ROOT,
  bundlePatchFiles,
  clientEntry,
  die,
  dsh,
  insertRowIds,
  line,
  listNodeProcesses,
  parseArgs,
  printJson,
  profileDir,
  readJson,
  resolveDsh,
  sizeOf,
} from './lib.mjs'

const SPEC = {
  profile: 'string',
  name: 'string',
  package: 'string',
  json: 'boolean',
  'no-dump': 'boolean',
  'no-processes': 'boolean',
}
const USAGE = "usage: node scripts/status.mjs --profile <name> [--name <pkg>] [--package <dir>] [--json] [--no-dump] [--no-processes]\nRead-only: is this bundle package installed, selected, composed and loadable in one profile?"

const { values: options } = parseArgs(process.argv.slice(2), SPEC, USAGE)
const profile = options.profile
if (!profile) die('missing --profile <name>')

const dir = profileDir(profile)
const manifestPath = join(dir, 'package.json')
const json = options.json === true
const checks = []
const facts = { profile, profileDir: dir, name: undefined, installed: false }

function check(ok, label, detail = '') {
  checks.push({ ok, label, detail })
  if (!json) line(ok, label, detail)
}

try {
  resolveDsh()
  check(true, 'dsh', 'found')
} catch {
  check(false, 'dsh', 'not found (set DSH_BIN_JS)')
}

if (!existsSync(manifestPath)) {
  check(false, 'profile', `${dir} has no package.json`)
  finish()
}

const manifest = readJson(manifestPath)
let name = options.name
if (name === undefined) {
  const packageManifest = join(options.package ?? REPO_ROOT, 'package.json')
  if (!existsSync(packageManifest)) die('missing --name <package-name> (or --package <dir>)')
  name = readJson(packageManifest).name
}
facts.name = name
check(true, 'profile', dir)

const spec = manifest.dependencies?.[name]
const bundles = manifest.dsh?.profile?.bundles ?? []
const index = bundles.indexOf(name)
facts.spec = spec ?? null
facts.bundles = bundles.length
facts.bundleIndex = index
facts.installed = spec !== undefined && index >= 0

if (spec === undefined) check(false, 'dependency', `dependencies["${name}"] missing`)
else {
  const linkTarget = typeof spec === 'string' && spec.startsWith('link:') ? spec.slice(5) : undefined
  if (linkTarget === undefined) check(true, 'dependency', spec)
  else if (!existsSync(linkTarget)) check(false, 'dependency', `${spec} — link target is gone`)
  else check(true, 'dependency', `${spec} (${sizeOf(join(linkTarget, 'package.json'))} B manifest)`)
}

if (index < 0) check(false, 'dsh.profile.bundles', `${name} is not selected`)
else check(true, 'dsh.profile.bundles', `${name} at position ${index + 1}/${bundles.length}${index === bundles.length - 1 ? ' (last)' : ''}`)

// Resolve the package on disk: the link target when present, else node_modules.
const installedDir = join(dir, 'node_modules', ...name.split('/'))
let packageDir
if (typeof spec === 'string' && spec.startsWith('link:')) packageDir = resolve(spec.slice(5))
else if (existsSync(installedDir)) packageDir = installedDir

if (packageDir !== undefined && existsSync(join(packageDir, 'package.json'))) {
  const pkg = readJson(join(packageDir, 'package.json'))
  facts.packageDir = packageDir
  facts.version = pkg.version ?? null
  const patches = bundlePatchFiles(pkg, packageDir)
  if (patches.length === 0) check(false, 'dsh.bundle.patch', 'not declared — the profile would never load it as a layer')
  else if (patches.some((file) => !existsSync(file))) check(false, 'dsh.bundle.patch', `missing file(s): ${patches.join(', ')}`)
  else {
    const ids = patches.flatMap((file) => insertRowIds(file))
    facts.rowIds = ids
    check(true, 'dsh.bundle.patch', `${patches.map((file) => file.replace(packageDir, '.')).join(', ')} (insert rows: ${ids.join(', ') || 'none'})`)
  }
  const client = clientEntry(pkg, packageDir)
  if (pkg.dsh?.client !== undefined) {
    if (client === undefined) check(false, 'client bundle', 'dsh.client set but exports["\./client"] is not a web entry')
    else if (!existsSync(client)) check(false, 'client bundle', `${client} missing — the NEXT BOOT of this profile fails (required modules plugin)`)
    else check(true, 'client bundle', `${client.replace(packageDir, '.')} (${sizeOf(client)} B)`)
  }
} else {
  check(false, 'package on disk', 'neither the link target nor node_modules/<name> exists')
}

// node_modules link identity (pnpm links a `link:` dependency to its target).
if (existsSync(installedDir)) {
  try {
    if (lstatSync(installedDir).isSymbolicLink()) {
      const target = resolve(dir, readlinkSync(installedDir))
      const expected = packageDir ? resolve(packageDir) : undefined
      if (expected !== undefined && target.toLowerCase() !== expected.toLowerCase()) check(false, 'node_modules link', `points at ${target}`)
      else check(true, 'node_modules link', `-> ${target}`)
    } else check(true, 'node_modules entry', 'real directory (pnpm copied)')
  } catch (error) {
    check(false, 'node_modules entry', String(error))
  }
} else if (spec !== undefined) {
  check(false, 'node_modules entry', `${installedDir} missing`)
}

// Composed config: the only check that proves the patch was accepted.
if (!options['no-dump'] && facts.installed) {
  const dumped = await dsh(['--profile', profile, '--dump-config'], { timeoutMs: 180_000 })
  if (dumped.code !== 0) check(false, '--dump-config', `exit ${dumped.code}`)
  else {
    const ids = facts.rowIds ?? []
    const missing = ids.filter((id) => !new RegExp(`^\\s*- id: ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(dumped.stdout))
    const lines = dumped.stdout.split(/\r?\n/).length
    facts.dumpLines = lines
    if (ids.length === 0) check(false, '--dump-config', 'no insert row id found in the patch, cannot verify composition')
    else if (missing.length > 0) check(false, '--dump-config', `rows missing from the composed config: ${missing.join(', ')}`)
    else check(true, '--dump-config', `${lines} lines, row(s) ${ids.join(', ')} compose`)
  }
}

// Running servers for this profile are informational: HMR means a live server
// picks the change up without a restart.
if (!options['no-processes']) {
  const processes = (await listNodeProcesses('dsh')).filter((row) => {
    if (row.pid === process.pid) return false
    if (!/dsh[\\/]lib[\\/]bin\.js/.test(row.commandLine)) return false
    if (row.commandLine.includes(`--profile ${profile}`)) return true
    if (profile === 'web' && /\bbin\.js["']?\s+web\b/.test(row.commandLine)) return true
    return row.commandLine.includes(`profiles\\${profile}`) || row.commandLine.includes(`profiles/${profile}`)
  })
  facts.processes = processes.map((row) => row.pid)
  if (processes.length === 0) check(true, 'running server', 'none for this profile (a fresh boot is needed to load the plugin)')
  else check(true, 'running server', `pid ${processes.map((row) => row.pid).join(', ')} — picks up install/remove live; no restart needed`)
}

finish()

function finish() {
  const ok = checks.every((entry) => entry.ok)
  if (json) printJson({ ok, facts, checks })
  else {
    process.stdout.write(`\n${ok ? 'status: ready' : 'status: NOT ready'}`)
    if (facts.installed) process.stdout.write(` — ${facts.name}@${facts.version ?? '?'} in ${profile}`)
    process.stdout.write('\n')
  }
  process.exit(ok ? 0 : 1)
}
