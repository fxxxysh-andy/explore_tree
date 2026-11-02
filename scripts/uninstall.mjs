#!/usr/bin/env node
/**
 * Revert `scripts/install.mjs`: drop the bundle from the profile.
 *
 * The official command is the only writer:
 *   dsh plugin --profile <profile> remove <package-name>
 * `dsh plugin` runs pnpm in the profile and then reconciles the manifest,
 * which also drops the package from `dsh.profile.bundles`. This script adds
 * backups, a dry run, verification against the reconciled manifest and an
 * optional lockfile restore.
 *
 * Usage:
 *   node scripts/uninstall.mjs --profile explore-scratch --dry-run
 *   node scripts/uninstall.mjs --profile explore-scratch
 *   node scripts/uninstall.mjs --profile web            # live, backs up first
 *   node scripts/uninstall.mjs --profile web --restore-lockfile
 */

import { existsSync, lstatSync, readlinkSync, rmdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  REPO_ROOT,
  backup,
  die,
  dsh,
  dshPlugin,
  line,
  parseArgs,
  printJson,
  profileDir,
  readJson,
  resolve as resolvePath,
  restoreFile,
  run,
  sha256,
  timestamp,
  writeJson,
} from './lib.mjs'

const SPEC = {
  profile: 'string',
  name: 'string',
  package: 'string',
  'dry-run': 'boolean',
  'restore-lockfile': 'boolean',
  'skip-verify': 'boolean',
  json: 'boolean',
}

const USAGE = "usage: node scripts/uninstall.mjs --profile <name> [--name <pkg>] [--package <dir>] [--dry-run] [--restore-lockfile] [--skip-verify] [--json]\nReverts install.mjs via `dsh plugin remove`, removes the leftover node_modules link, verifies the reconciled manifest."

const { values: options } = parseArgs(process.argv.slice(2), SPEC, USAGE)
const profile = options.profile
if (!profile) die('missing --profile <name>')

const dir = profileDir(profile)
const manifestPath = join(dir, 'package.json')
const lockPath = join(dir, 'pnpm-lock.yaml')
if (!existsSync(manifestPath)) die(`profile ${JSON.stringify(profile)} does not exist at ${dir}`)

let name = options.name
if (name === undefined) {
  const manifestFile = join(options.package ?? REPO_ROOT, 'package.json')
  if (!existsSync(manifestFile)) die('missing --name <package-name> (or --package <dir>)')
  name = readJson(manifestFile).name
}

const dryRun = options['dry-run'] === true
const json = options.json === true
const stamp = timestamp()
const report = { profile, name, dryRun, stamp, steps: [], backups: {}, commands: [] }

function step(ok, label, detail = '') {
  report.steps.push({ ok, label, detail })
  if (!json) line(ok, label, detail)
}

/**
 * pnpm `remove` leaves the `link:` entry in node_modules behind (verified with
 * pnpm 11.22; even `dsh plugin prune` keeps it). Remove it ourselves, and only
 * when the link points at the package directory this script targets.
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
async function removeLeftoverLink() {
  const leftover = join(dir, 'node_modules', ...name.split('/'))
  if (!existsSync(leftover)) return { ok: true, detail: 'no leftover node_modules entry' }
  const expected = typeof spec === 'string' && spec.startsWith('link:')
    ? resolvePath(dir, spec.slice(5))
    : resolvePath(options.package ?? REPO_ROOT)
  let stat
  try {
    stat = lstatSync(leftover)
  } catch (error) {
    return { ok: false, detail: String(error) }
  }
  if (stat.isSymbolicLink()) {
    const target = resolvePath(dir, readlinkSync(leftover))
    if (target.toLowerCase() !== expected.toLowerCase()) {
      return { ok: false, detail: `${leftover} points at ${target}, expected ${expected}` }
    }
    // `rmdir`/RemoveDirectoryW deletes a directory junction itself and never
    // its target; `cmd` is only a fallback when Node refuses the reparse point.
    try {
      rmdirSync(leftover)
    } catch {
      const result = await run('cmd.exe', ['/c', 'rmdir', leftover], { timeoutMs: 30_000 })
      if (result.code !== 0) return { ok: false, detail: `could not remove ${leftover} (cmd exit ${result.code})` }
    }
    if (!existsSync(leftover)) return { ok: true, detail: `removed the leftover pnpm link to ${target}` }
    return { ok: false, detail: `could not remove ${leftover}` }
  }
  if (stat.isDirectory()) {
    const pkgFile = join(leftover, 'package.json')
    if (existsSync(pkgFile) && readJson(pkgFile).name === name) {
      rmSync(leftover, { recursive: true, force: true })
      if (!existsSync(leftover)) return { ok: true, detail: 'removed the copied package directory' }
    }
    return { ok: false, detail: `left ${leftover} in place (not recognisably a copy of ${name})` }
  }
  return { ok: true, detail: 'node_modules entry is neither a link nor a directory' }
}

const before = readJson(manifestPath)
const beforeHash = sha256(manifestPath)
const spec = before.dependencies?.[name]
const bundlesBefore = before.dsh?.profile?.bundles ?? []
const listed = bundlesBefore.includes(name)
report.before = { spec, listed, bundles: bundlesBefore.length, hash: beforeHash }

if (spec === undefined && !listed) {
  const leftover = dryRun
    ? { ok: true, detail: existsSync(join(dir, 'node_modules', ...name.split('/'))) ? 'leftover node_modules link present' : 'no leftovers' }
    : await removeLeftoverLink()
  step(leftover.ok, 'not installed', `${name} is not a dependency and not in dsh.profile.bundles; ${leftover.detail}`)
  if (json) printJson(report)
  else process.stdout.write(`\nnothing to uninstall — ${name} is not installed in profile ${JSON.stringify(profile)}.\n`)
  process.exit(leftover.ok ? 0 : 1)
}
step(true, 'current state', `${spec ?? 'no dependency'}; ${listed ? 'listed in dsh.profile.bundles' : 'not in dsh.profile.bundles'}`)

if (dryRun) {
  if (spec !== undefined) {
    report.commands = [`dsh plugin --profile ${profile} remove ${name}`]
    step(true, 'dry run', `would run: ${report.commands[0]}`)
  } else {
    step(true, 'dry run', `would only drop ${name} from dsh.profile.bundles (no dependency to uninstall)`)
  }
  step(true, 'dry run', `would write package.json.${stamp}.bak${existsSync(lockPath) ? ` + pnpm-lock.yaml.${stamp}.bak` : ''}`)
  if (json) printJson(report)
  else process.stdout.write('\ndry run complete; nothing was written.\n')
  process.exit(0)
}

for (const file of [manifestPath, lockPath]) {
  if (!existsSync(file)) continue
  report.backups[file.replace(dir, '<profile>')] = backup(file, stamp).replace(dir, '<profile>')
}
step(true, 'backup', `package.json.${stamp}.bak${existsSync(lockPath) ? ` + pnpm-lock.yaml.${stamp}.bak` : ''}`)

if (spec !== undefined) {
  report.commands = [`dsh plugin --profile ${profile} remove ${name}`]
  process.stdout.write(`running: ${report.commands[0]}\n`)
  const removed = await dshPlugin(profile, ['remove', name], { timeoutMs: 600_000, echo: !json })
  if (removed.code !== 0) {
    process.stderr.write(removed.stderr)
    const diagnostics = /diagnostics: (.+)$/m.exec(removed.stdout + removed.stderr)?.[1]
    step(false, 'dsh plugin remove', `exit ${removed.code}${diagnostics ? `, diagnostics: ${diagnostics}` : ''}`)
    if (json) printJson(report)
    die(`remove failed; backups kept in ${dir}`, removed.code)
  }
  step(true, 'dsh plugin remove', 'exit 0')
} else {
  // Repair a manifest that lists a bundle without a dependency: nothing is
  // installed, so pnpm has nothing to uninstall; rewrite the bundles list.
  const repaired = structuredClone(before)
  repaired.dsh.profile.bundles = bundlesBefore.filter((entry) => entry !== name)
  writeJson(manifestPath, repaired)
  step(true, 'manifest repair', `dropped ${name} from dsh.profile.bundles (no dependency existed)`)
}

if (!options['skip-verify']) {
  const after = readJson(manifestPath)
  const afterHash = sha256(manifestPath)
  report.after = {
    hash: afterHash,
    spec: after.dependencies?.[name],
    bundles: (after.dsh?.profile?.bundles ?? []).length,
  }
  const problems = []
  if (after.dependencies?.[name] !== undefined) problems.push(`dependency ${name} still present`)
  if ((after.dsh?.profile?.bundles ?? []).includes(name)) problems.push(`${name} still listed in dsh.profile.bundles`)

  const leftover = await removeLeftoverLink()
  if (leftover.ok) step(true, 'node_modules link', leftover.detail)
  else problems.push(leftover.detail)

  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const dumped = await dsh(['--profile', profile, '--dump-config'], { timeoutMs: 180_000 })
  if (dumped.code !== 0) problems.push(`--dump-config exited ${dumped.code}`)
  else {
    const refs = (dumped.stdout.match(new RegExp(escaped, 'g')) ?? []).length
    if (refs > 0) problems.push(`${refs} reference(s) to ${name} left in the composed config`)
  }

  for (const problem of problems) step(false, 'verify', problem)
  if (problems.length === 0) {
    step(true, 'verify', `dependency, bundle entry and node_modules entry are gone; composed config has no ${name} row`)
  }

  if (options['restore-lockfile'] && existsSync(lockPath)) {
    const backupLock = `${lockPath}.${stamp}.bak`
    if (existsSync(backupLock)) {
      const backupHash = sha256(backupLock)
      const currentHash = sha256(lockPath)
      if (backupHash === currentHash) step(true, 'lockfile', 'already identical to the pre-remove backup')
      else {
        restoreFile(backupLock, lockPath)
        step(true, 'lockfile', `restored pre-remove lockfile (was ${currentHash.slice(0, 12)}, now ${backupHash.slice(0, 12)})`)
      }
    }
  } else if (existsSync(lockPath)) {
    step(true, 'lockfile', 'left as pnpm rewrote it (pass --restore-lockfile for byte identity)')
  }

  if (problems.length > 0) {
    if (json) printJson(report)
    die(`uninstall verification failed for ${name}; restore package.json.${stamp}.bak if needed`)
  }
}

if (json) printJson(report)
else {
  process.stdout.write(`\nremoved ${name} from profile ${JSON.stringify(profile)}.\n`)
  process.stdout.write(`  backups: ${Object.values(report.backups).filter((value) => typeof value === 'string' && value.endsWith('.bak')).map((value) => value.split(/[\\/]/).pop()).join(', ') || 'none'}\n`)
  process.stdout.write(`  check:   dsh --profile ${profile} --dump-config | Select-String '${name}'\n`)
  process.stdout.write(`note: a running dsh web drops the plugin live (HMR), usually within a few seconds.\n`)
}
