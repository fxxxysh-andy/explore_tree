/**
 * Shared helpers for the dsh-explore-tree packaging scripts.
 *
 * Every helper is dependency-free: these scripts must run on a bare Windows
 * machine that only has Node 20+ and the dsh installation with pnpm.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(SCRIPT_DIR, '..')

// These scripts get piped into Select-String / Select-Object -First, which
// closes the pipe early; an EPIPE must not crash an otherwise successful run.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error?.code === 'EPIPE') process.exit(0)
    throw error
  })
}

/** Shipped profile names may not be created or deleted by these scripts. */
export const SHIPPED_PROFILES = ['acp', 'web', 'headless', 'sdk', 'sdk-minimal', 'desktop']

/** `$DSH_HOME`, defaulting to `~/.dsh` exactly like the launcher. */
export function dshHome() {
  return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
}

/** Absolute directory of a profile. */
export function profileDir(name) {
  return join(dshHome(), 'profiles', name)
}

/** Fail loudly with a one-line, actionable message. */
export function die(message, code = 1) {
  process.stderr.write(`explore-tree: ${message}\n`)
  process.exit(code)
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Write JSON exactly like DSH does: 2-space indent plus a trailing newline. */
export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** `20261031-134521`, used for backup file names. */
export function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

export function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Copy a file next to itself as `<name>.<timestamp>.bak`.
 * @returns the backup path, or undefined when the file does not exist.
 */
export function backup(file, stamp = timestamp()) {
  if (!existsSync(file)) return undefined
  const target = `${file}.${stamp}.bak`
  copyFileSync(file, target)
  return target
}

/**
 * Locate the dsh launcher as a `node <bin.js>` command, which sidesteps every
 * Windows shell-quoting trap around `dsh.cmd` and paths with spaces.
 */
export function resolveDsh() {
  const override = process.env.DSH_BIN_JS
  if (override && existsSync(override)) return { node: process.execPath, bin: override }
  const candidates = []
  const pathDirs = (process.env.PATH ?? '').split(';').filter(Boolean)
  for (const dir of pathDirs) {
    candidates.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  candidates.push(join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  for (const bin of candidates) {
    if (existsSync(bin)) return { node: process.execPath, bin }
  }
  die('cannot locate the dsh installation; set DSH_BIN_JS to <...>/@deepseek-ai/dsh/lib/bin.js')
}

/**
 * Run a command and collect its output. Never rejects on a nonzero exit.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, timeoutMs?: number, echo?: boolean}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string, timedOut?: boolean}>}
 */
export function run(command, args, options = {}) {
  const { cwd, timeoutMs = 180_000, echo = false } = options
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (echo) process.stdout.write(chunk.replace(/^/gm, '  '))
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (echo) process.stderr.write(chunk.replace(/^/gm, '  '))
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ code: 1, stdout, stderr: `${stderr}${String(error)}`, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? 1, stdout, stderr, timedOut })
    })
  })
}

/** Run `dsh <args>` through the resolved installation. */
export function dsh(args, options = {}) {
  const { node, bin } = resolveDsh()
  return run(node, [bin, ...args], options)
}

/** `dsh plugin --profile <profile> <pnpm args...>`. */
export function dshPlugin(profile, args, options = {}) {
  return dsh(['plugin', '--profile', profile, ...args], options)
}

/**
 * Resolve the link spec pnpm records for a local package directory.
 * pnpm writes forward slashes on Windows, so normalize before comparing.
 */
export function linkSpec(directory) {
  return `link:${resolve(directory).split(sep).join('/')}`
}

/** The `dsh` manifest block of a package, or undefined. */
export function dshBlock(manifest) {
  return manifest?.dsh ?? undefined
}

/** Patch files a bundle declares, in order (`string | string[]`). */
export function bundlePatchFiles(manifest, packageDir) {
  const patch = dshBlock(manifest)?.bundle?.patch
  if (patch === undefined) return []
  const list = Array.isArray(patch) ? patch : [patch]
  return list.map((entry) => resolve(packageDir, entry))
}

/** The client entry file a package exports as `./client`, resolved on disk. */
export function clientEntry(manifest, packageDir) {
  const client = dshBlock(manifest)?.client
  if (client === undefined) return undefined
  if (client.platform !== undefined && client.platform !== 'web') return undefined
  const exported = manifest?.exports?.['./client']
  const relative =
    typeof exported === 'string'
      ? exported
      : exported?.default ?? exported?.import ?? './client.js'
  return resolve(packageDir, relative)
}

/** Every `insert:` row id in one patch file, read without a YAML parser. */
export function insertRowIds(patchFile) {
  const text = readFileSync(patchFile, 'utf8')
  const ids = []
  const lines = text.split(/\r?\n/)
  let inInsert = false
  let insertIndent = 0
  for (const line of lines) {
    const stripped = line.replace(/#.*$/, '')
    if (!stripped.trim()) continue
    const indent = stripped.length - stripped.trimStart().length
    if (!inInsert) {
      if (/^\s*-\s*insert:\s*$/.test(stripped)) {
        inInsert = true
        insertIndent = indent
      }
      continue
    }
    if (indent <= insertIndent) {
      inInsert = false
      continue
    }
    const match = /^\s*-\s*id:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(stripped)
    if (match) ids.push(match[1])
  }
  return ids
}

/** `--flag value` / `--flag=value` / boolean flags, without a CLI framework. */
export function parseArgs(argv, spec, usage) {
  const values = {}
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${(usage ?? `usage: node <script> [options]  (options: ${Object.keys(spec).join(', ')})`).trimEnd()}\n`)
      process.exit(0)
    }
    if (!argument.startsWith('--')) {
      positionals.push(argument)
      continue
    }
    const [rawName, inline] = argument.slice(2).split('=')
    const name = rawName.trim()
    const type = spec[name]
    if (type === undefined) die(`unknown option --${name}`)
    if (type === 'boolean') {
      values[name] = inline === undefined ? true : inline !== 'false'
      continue
    }
    const value = inline ?? argv[index + 1]
    if (value === undefined) die(`option --${name} needs a value`)
    if (inline === undefined) index += 1
    values[name] = value
  }
  return { values, positionals }
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/** `ok` / `FAIL` lines shared by status and smoke output. */
export function line(ok, label, detail = '') {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`)
}

/** Sorted directory listing, used for reporting node_modules drift. */
export function listDir(directory) {
  return existsSync(directory) ? readdirSync(directory).sort() : []
}

/** Move a file out of the way, keeping the original name for restore. */
export function moveAside(file) {
  if (!existsSync(file)) return undefined
  const target = `${file}.off-${timestamp()}`
  renameSync(file, target)
  return target
}

/** Bytes on disk, or 0. */
export function sizeOf(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** Overwrite one file with another, byte for byte. */
export function restoreFile(backupFile, targetFile) {
  copyFileSync(backupFile, targetFile)
}

export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/**
 * Every node process whose command line mentions `needle`, via one CIM query.
 * Read-only; returns [] when the query cannot run.
 * @param {string} [needle]
 * @returns {Promise<Array<{pid: number, commandLine: string, startedAt?: string}>>}
 */
export async function listNodeProcesses(needle) {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    'Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress'
  const result = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeoutMs: 30_000,
  })
  if (result.code !== 0 || !result.stdout.trim()) return []
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows
    .map((row) => ({
      pid: row.ProcessId,
      commandLine: String(row.CommandLine ?? ''),
      // CIM dates look like /Date(1698765432000)/ — show it only when parseable.
      startedAt: typeof row.CreationDate === 'string' ? row.CreationDate : undefined,
    }))
    .filter((row) => row.commandLine.length > 0)
    .filter((row) => (needle === undefined ? true : row.commandLine.includes(needle)))
}

/** Is anything listening on a TCP port? Read-only, no admin rights needed. */
export async function portInUse(port) {
  const result = await run(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Measure-Object).Count`],
    { timeoutMs: 20_000 },
  )
  return result.code === 0 && Number(result.stdout.trim()) > 0
}

export { existsSync, join, resolve, mkdirSync, copyFileSync }
