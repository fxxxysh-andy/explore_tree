#!/usr/bin/env node
/**
 * Install dsh-explore-tree (or any local bundle package) into a dsh profile as
 * a `link:` dependency plus a `dsh.profile.bundles` entry.
 *
 * The official command is the only writer:
 *   dsh plugin --profile <profile> add link:<absolute package dir>
 * `dsh plugin` runs pnpm in the profile and then reconciles the profile
 * manifest, appending the package to `dsh.profile.bundles` when — and only
 * when — the package declares `dsh.bundle.patch`. This script adds the
 * pre-flight refusals, backups, idempotency and post-verification around it.
 *
 * Usage:
 *   node scripts/install.mjs --profile explore-scratch --create --dry-run
 *   node scripts/install.mjs --profile explore-scratch --create
 *   node scripts/install.mjs --profile web            # live, backs up first
 */

import { existsSync, lstatSync, readlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  REPO_ROOT,
  SHIPPED_PROFILES,
  backup,
  bundlePatchFiles,
  clientEntry,
  die,
  dsh,
  dshPlugin,
  insertRowIds,
  linkSpec,
  parseArgs,
  printJson,
  profileDir,
  readJson,
  resolve as resolvePath,
  sha256,
  timestamp,
  writeJson,
} from './lib.mjs'

const SPEC = {
  profile: 'string',
  package: 'string',
  create: 'boolean',
  'dry-run': 'boolean',
  'allow-missing-client': 'boolean',
  'skip-verify': 'boolean',
  json: 'boolean',
}

const USAGE = "usage: node scripts/install.mjs --profile <name> [--create] [--package <dir>] [--dry-run] [--allow-missing-client] [--skip-verify] [--json]\nInstalls this package into a dsh profile as a link: dependency + dsh.profile.bundles entry, with timestamped backups.\n--create builds a scratch profile from the web template."

const { values: options } = parseArgs(process.argv.slice(2), SPEC, USAGE)
const profile = options.profile
if (!profile) die('missing --profile <name> (use --profile web for the live GUI, or a scratch name such as explore-scratch)')

const packageDir = resolvePath(options.package ?? REPO_ROOT)
const dryRun = options['dry-run'] === true
const json = options.json === true
const stamp = timestamp()
const report = { profile, packageDir, dryRun, stamp, steps: [], backups: {}, commands: [] }

function step(ok, name, detail = '') {
  report.steps.push({ ok, name, detail })
  if (!json) process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`)
}

const dir = profileDir(profile)

// ── 1. package pre-flight (before anything is written) ───────────────────────
const manifestPath = join(packageDir, 'package.json')
if (!existsSync(manifestPath)) die(`no package.json in ${packageDir}`)
const manifest = readJson(manifestPath)
const name = manifest.name
if (typeof name !== 'string' || name.length === 0) die(`package.json in ${packageDir} has no "name"`)
const patches = bundlePatchFiles(manifest, packageDir)
if (patches.length === 0) {
  die(
    `${name} declares no dsh.bundle.patch, so a profile install would only add a plain dependency.\n` +
      `  add "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } to ${manifestPath}`,
  )
}
const missingPatches = patches.filter((file) => !existsSync(file))
if (missingPatches.length > 0) die(`${name} declares patch files that do not exist: ${missingPatches.join(', ')}`)
const rowIds = patches.flatMap((file) => insertRowIds(file))
step(
  true,
  'bundle patch',
  patches.map((file) => file.slice(packageDir.length + 1)).join(', ') + (rowIds.length ? ` (rows: ${rowIds.join(', ')})` : ''),
)

// A declared client bundle that is missing does not fail the install — it fails
// the NEXT BOOT of the whole profile (client-modules is a required plugin).
const client = clientEntry(manifest, packageDir)
if (manifest.dsh?.client !== undefined) {
  if (client === undefined) {
    step(false, 'client bundle', 'dsh.client is set but does not export ./client via a web platform')
    if (!options['allow-missing-client']) die('refusing to install: fix the exports map or pass --allow-missing-client')
  } else if (!existsSync(client)) {
    step(false, 'client bundle', `missing: ${client}`)
    if (!options['allow-missing-client']) {
      die(
        `${name} declares dsh.client but ${client} does not exist.\n` +
          `  This is fatal at the NEXT BOOT of the profile — client-modules is a required plugin and\n` +
          `  refuses to compose ("client bundles not found; run \`pnpm run build\` before launch").\n` +
          `  Build it first (pnpm run build / node scripts/build-client.mjs), or pass --allow-missing-client.`,
      )
    }
  } else {
    step(true, 'client bundle', client.slice(packageDir.length + 1))
  }
}

// ── 2. profile ───────────────────────────────────────────────────────────────
if (!existsSync(join(dir, 'package.json'))) {
  if (!options.create) {
    die(
      `profile ${JSON.stringify(profile)} does not exist at ${dir}\n` +
        `  create it first:  dsh --profile ${profile} --from-default-profile web --dump-config\n` +
        `  or re-run this script with --create`,
    )
  }
  if (dryRun) {
    step(true, 'profile', `absent; --create would run: dsh --profile ${profile} --from-default-profile web --dump-config`)
  } else {
    const created = await dsh(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], {
      timeoutMs: 180_000,
    })
    if (created.code !== 0) {
      process.stderr.write(created.stderr)
      die(`could not create profile ${JSON.stringify(profile)} (exit ${created.code})`)
    }
    step(true, 'profile created', `${dir} from the shipped web template (base + web-app)`)
  }
} else {
  step(true, 'profile', dir)
}

// ── 3. idempotency ───────────────────────────────────────────────────────────
const profileManifestPath = join(dir, 'package.json')
const profileExists = existsSync(profileManifestPath)
const before = profileExists ? readJson(profileManifestPath) : { dependencies: {}, dsh: { profile: { bundles: [] } } }
const beforeHash = profileExists ? sha256(profileManifestPath) : '(absent)'
const spec = linkSpec(packageDir)
const recordedSpec = before.dependencies?.[name]
const bundlesBefore = before.dsh?.profile?.bundles ?? []
const bundleListed = bundlesBefore.includes(name)

function sameLink(recorded) {
  if (typeof recorded !== 'string' || !recorded.startsWith('link:')) return false
  const target = recorded.slice('link:'.length)
  const normalized = target.split('\\').join('/')
  const absolute = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/') ? normalized : resolvePath(dir, normalized).split('\\').join('/')
  return absolute.replace(/\/+$/, '').toLowerCase() === resolve(packageDir).split('\\').join('/').replace(/\/+$/, '').toLowerCase()
}

if (recordedSpec !== undefined && sameLink(recordedSpec) && bundleListed) {
  step(true, 'already installed', `${name} -> ${recordedSpec}, listed in dsh.profile.bundles`)
  if (json) printJson(report)
  else process.stdout.write(`\nnothing to do — ${name} is already installed and selected in ${profile}\n`)
  process.exit(0)
}
if (recordedSpec !== undefined && !sameLink(recordedSpec)) {
  die(
    `${name} is already a dependency of profile ${JSON.stringify(profile)} with a different spec:\n` +
      `  recorded: ${recordedSpec}\n  wanted:   ${spec}\n` +
      `  run: node scripts/uninstall.mjs --profile ${profile}   (then install again)`,
  )
}
if (recordedSpec === undefined && bundleListed) {
  die(`dsh.profile.bundles already lists ${name} without a dependency; fix ${profileManifestPath} by hand first`)
}

// ── 4. backup ────────────────────────────────────────────────────────────────
for (const file of [profileManifestPath, join(dir, 'pnpm-lock.yaml')]) {
  const created = existsSync(file) ? (dryRun ? `${file}.${stamp}.bak (dry run: not written)` : backup(file, stamp)) : undefined
  if (created !== undefined) report.backups[file.replace(dir, '<profile>')] = created.replace(dir, '<profile>')
}
report.backups.hash = { before: beforeHash, after: null }
step(true, 'backup', dryRun ? `would write *.${stamp}.bak next to package.json and pnpm-lock.yaml` : `*.${stamp}.bak written`)

const commands = [
  ['dsh', 'plugin', '--profile', profile, 'add', spec],
]
report.commands = commands.map((command) => command.map((part) => (part.includes(' ') ? `"${part}"` : part)).join(' '))

if (dryRun) {
  step(true, 'dry run', `would run: ${report.commands[0]}`)
  if (json) printJson(report)
  else {
    process.stdout.write('\ndry run complete; nothing was written.\n')
    process.stdout.write(`re-run without --dry-run to install ${name} into ${profile}.\n`)
  }
  process.exit(0)
}

// ── 5. install ───────────────────────────────────────────────────────────────
process.stdout.write(`running: ${report.commands[0]}\n`)
const added = await dshPlugin(profile, ['add', spec], { timeoutMs: 600_000, echo: !json })
if (added.code !== 0) {
  process.stderr.write(added.stderr)
  const diagnostics = /diagnostics: (.+)$/m.exec(added.stdout + added.stderr)?.[1]
  step(false, 'dsh plugin add', `exit ${added.code}${diagnostics ? `, diagnostics: ${diagnostics}` : ''}`)
  if (json) printJson(report)
  restartHint()
  die(`install failed; backups kept: ${Object.values(report.backups).filter((value) => value.endsWith('.bak')).join(', ')}`, added.code)
}
step(true, 'dsh plugin add', `exit 0`)

// ── 6. verify ────────────────────────────────────────────────────────────────
if (options['skip-verify']) {
  step(true, 'verify', 'skipped (--skip-verify)')
  if (json) printJson(report)
  else process.stdout.write(`\ninstalled ${name} into ${profile} (verification skipped).\n`)
  process.exit(0)
}

const after = readJson(profileManifestPath)
const problems = []
if (after.dependencies?.[name] === undefined) problems.push(`dependencies["${name}"] missing`)
else if (!sameLink(after.dependencies[name])) problems.push(`dependency spec is ${after.dependencies[name]}, expected ${spec}`)
if (!(after.dsh?.profile?.bundles ?? []).includes(name)) problems.push(`dsh.profile.bundles does not list ${name}`)
const installedDir = join(dir, 'node_modules', ...name.split('/'))
if (!existsSync(installedDir)) problems.push(`node_modules/${name} missing`)
else {
  try {
    const stat = lstatSync(installedDir)
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(installedDir)
      const targetPath = resolve(dir, target)
      if (targetPath.toLowerCase() !== resolve(packageDir).toLowerCase()) problems.push(`node_modules/${name} points at ${target}`)
    }
  } catch {
    /* a real directory is fine: pnpm copies when it cannot link */
  }
}
report.backups.hash.after = sha256(profileManifestPath)
report.bundleList = after.dsh?.profile?.bundles ?? []

if (problems.length > 0) {
  for (const problem of problems) step(false, 'verify', problem)
  if (json) printJson(report)
  die(`post-install verification failed for ${name}; restore ${report.backups[join(dir, 'package.json').replace(dir, '<profile>')]} if needed`)
}
step(true, 'verify', `dependency + bundle entry + node_modules link present (manifest ${beforeHash.slice(0, 12)} -> ${report.backups.hash.after.slice(0, 12)})`)

// The row must compose: --dump-config is a pure read and proves the patch is
// accepted without booting a server.
const dumped = await dsh(['--profile', profile, '--dump-config'], { timeoutMs: 180_000 })
const composed = dumped.code === 0 && dumped.stdout.includes(`name: ${name}`) && rowIds.some((id) => dumped.stdout.includes(`id: ${id}`))
step(composed, '--dump-config', composed ? `row ${rowIds.join(', ')} composes` : `row missing from the composed config (dump exit ${dumped.code})`)
if (!composed) {
  if (json) printJson(report)
  die(`the bundle patch did not compose; check ${patches.join(', ')}`)
}

if (json) printJson(report)
else {
  process.stdout.write(`\ninstalled ${name} into profile ${JSON.stringify(profile)}.\n`)
  process.stdout.write(`  dependency: ${name}: ${after.dependencies[name]}\n`)
  process.stdout.write(`  bundles:    ${report.bundleList.length} entries, ${name} last\n`)
  process.stdout.write(`  backups:    ${Object.entries(report.backups).filter(([, value]) => typeof value === 'string' && value.endsWith('.bak')).map(([key]) => key.split(/[\\/]/).pop()).join(', ')} (in ${dir})\n`)
  restartHint()
  process.stdout.write(`\nverify:\n  dsh --profile ${profile} --dump-config | Select-String 'id: ${rowIds[0] ?? name}'\n`)
  process.stdout.write(`  node scripts/status.mjs --profile ${profile}\n`)
}

function restartHint() {
  process.stdout.write(
    `\nnote: if a dsh web is already running on this profile it picks the bundle up live\n` +
      `      (HMR recomposition, usually within a few seconds) — do NOT restart the GUI.\n` +
      `      Otherwise the next boot loads it.\n`,
  )
}
