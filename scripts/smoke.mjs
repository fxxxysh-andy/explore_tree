#!/usr/bin/env node
/**
 * End-to-end smoke check for a bundle package inside a dsh profile.
 *
 * Two modes:
 *   --boot                 launch `dsh web` on a spare port, capture the launch
 *                          token from stdout, verify, then kill the server.
 *   --base --token         attach to a server that is already running.
 *
 * Verified facts this encodes (measured on dsh 0.2.1-rc.5):
 *   - `dsh <profile>` boots the profile; there is no `dsh <profile> web` form.
 *   - the launch URL prints `dsh web: http://127.0.0.1:<port>/?token=<token>`.
 *   - `GET /?token=…` answers 303 + `set-cookie: dsh-auth-…`; `GET /` without
 *     the cookie answers 401.
 *   - client bundles are served combo-style only: `plugins/??<pkg>/client.js&rev=<rev>`.
 *   - the boot graph is inlined into the index HTML as `globalThis["__DSH_BOOT__"]`.
 *   - `/plugins/events` is the SSE graph stream.
 *   - routes registered by a plugin are NOT behind the browser auth check.
 *
 * Usage:
 *   node scripts/smoke.mjs --profile explore-scratch --boot --path /explore-fixture/ping
 *   node scripts/smoke.mjs --profile web --base http://127.0.0.1:3080 --path /explore-tree/ping
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  REPO_ROOT,
  bundlePatchFiles,
  clientEntry,
  insertRowIds,
  die,
  line,
  parseArgs,
  portInUse,
  printJson,
  profileDir,
  readJson,
  resolveDsh,
  sleep,
} from './lib.mjs'

const SPEC = {
  profile: 'string',
  name: 'string',
  package: 'string',
  id: 'string',
  port: 'string',
  boot: 'boolean',
  base: 'string',
  token: 'string',
  path: 'string',
  keep: 'boolean',
  json: 'boolean',
  timeout: 'string',
}
const USAGE = "usage: node scripts/smoke.mjs --profile <name> --boot [--port <n>] [--path </route>] [--keep] [--json]\n       node scripts/smoke.mjs --profile <name> --base <url> [--token <token>] [--path </route>] [--json]\n--boot launches dsh web on a spare port (--port 0 = OS picks), checks stderr/handshake/graph/bundle/route, then kills it.\n--base attaches to a server that is already running."

const { values: options } = parseArgs(process.argv.slice(2), SPEC, USAGE)
const profile = options.profile
if (!profile) die('missing --profile <name>')
if (!options.boot && !options.base) die('pass --boot (launch a server) or --base <url> (attach to a running one)')
if (options.boot && options.base) die('--boot and --base are mutually exclusive')

const json = options.json === true
const report = { profile, mode: options.boot ? 'boot' : 'attach', checks: [], facts: {} }
const checks = report.checks
const timeoutMs = Number(options.timeout ?? 90_000)

function check(ok, label, detail = '') {
  checks.push({ ok, label, detail })
  if (!json) line(ok, label, detail)
}

function fail(message) {
  if (json) printJson({ ...report, ok: false, error: message })
  die(message)
}

// ── resolve the package under test ───────────────────────────────────────────
let name = options.name
const packageDir = options.package ? options.package : REPO_ROOT
if (name === undefined) {
  const manifestFile = join(packageDir, 'package.json')
  if (!existsSync(manifestFile)) die('missing --name <package-name>')
  name = readJson(manifestFile).name
}
report.facts.name = name
const manifest = readJson(join(packageDir, 'package.json'))

// A client entry is keyed by package name, but the Loader row id from the patch
// is also worth accepting (and --id covers anything else).
const aliasIds = new Set([name])
for (const file of bundlePatchFiles(manifest, packageDir)) for (const id of insertRowIds(file)) aliasIds.add(id)
if (options.id) aliasIds.add(options.id)

const matchesOwn = (entry) => aliasIds.has(entry.id)

// The default probe route: honour an explicit --path, else a manifest hint,
// else skip the route probe (a bundle without a host route is still valid).
const probePath = options.path ?? manifest.dsh?.exploreTree?.smokePath ?? undefined

let child
let base = options.base
let token = options.token

if (options.boot) {
  const port = Number(options.port ?? 3099)
  // --port 0 lets the OS pick a free port; the printed URL carries the real one.
  if (port !== 0 && (await portInUse(port))) fail(`port ${port} is already in use; pass --port <free port> (never reuse the user's ${3080}, and never kill what is listening)`)
  const { node, bin } = resolveDsh()
  const args = [bin, '--profile', profile, '--no-open', '--port', String(port)]
  report.commands = [`"${node}" "${bin}" --profile ${profile} --no-open --port ${port}`]
  child = spawn(node, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const exited = new Promise((resolvePromise) => child.on('exit', (code, signal) => resolvePromise({ code, signal })))

  const started = Date.now()
  let launch
  while (Date.now() - started < timeoutMs) {
    launch = /dsh web: (\S+)/.exec(stdout)?.[1]
    if (launch !== undefined) break
    if (child.exitCode !== null) break
    await sleep(250)
  }
  report.facts.stdout = stdout.trim()
  report.facts.stderr = stderr.trim()
  report.facts.pid = child.pid
  if (launch === undefined) {
    const exit = child.exitCode === null ? null : await exited
    killServer(child)
    if (json) printJson({ ...report, ok: false })
    process.stderr.write(`--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`)
    fail(
      exit?.code === null
        ? `server did not print a launch URL within ${timeoutMs} ms`
        : `server exited with code ${exit?.code} before readiness (boot error — see the output above)`,
    )
  }
  check(true, 'boot', `ready in ${Date.now() - started} ms — ${launch.replace(/token=[^&]+/, 'token=…')}`)
  if (stderr.trim().length > 0) {
    // Warnings are acceptable (a failed host entry is a warning, not fatal);
    // print them but keep the exit code honest via the boot-graph check below.
    check(true, 'stderr', `${stderr.trim().split(/\r?\n/).length} line(s) of warnings on stderr`)
    report.facts.stderrLines = stderr.trim().split(/\r?\n/)
  } else check(true, 'stderr', 'clean')

  const url = new URL(launch)
  base = url.origin
  token = url.searchParams.get('token') ?? undefined
}

report.facts.base = base

// ── auth handshake ───────────────────────────────────────────────────────────
let cookie
if (token !== undefined) {
  const handshake = await http(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const setCookie = handshake.headers.get('set-cookie')
  if (handshake.status !== 303 || setCookie === null) {
    check(false, 'auth handshake', `GET /?token=… -> ${handshake.status}, set-cookie: ${setCookie === null ? 'absent' : 'present'}`)
    await shutdown(1)
  } else {
    cookie = setCookie.split(';')[0]
    check(true, 'auth handshake', `303 + ${cookie.replace(/=[^=]+$/, '=…')}`)
  }
} else {
  check(true, 'auth handshake', 'no token supplied: index checks are skipped; the graph, bundle and route checks below need no cookie')
}

async function authHeaders(extra = {}) {
  return cookie === undefined ? extra : { ...extra, cookie }
}

// ── unauthenticated behaviour ────────────────────────────────────────────────
const anonymousIndex = await http(`${base}/`, { redirect: 'manual' })
if (cookie === undefined) {
  if (anonymousIndex.status === 200) check(true, 'anonymous index', '200 (auth disabled or already trusted)')
  else check(true, 'anonymous index', `${anonymousIndex.status} (auth on; no token to authenticate with)`)
} else if (anonymousIndex.status === 401) {
  check(true, 'anonymous index', `401 — body: ${(await anonymousIndex.text()).trim().slice(0, 80)}`)
} else {
  check(false, 'anonymous index', `expected 401 without a cookie, got ${anonymousIndex.status}`)
}

// ── boot graph: /plugins/events works WITHOUT the browser cookie ─────────────
// (verified against the live GUI: GET /plugins/events -> 200 text/event-stream,
// first graph event contains every client entry with its bundle url + rev)
const sse = await readSseGraph(`${base}/plugins/events`, cookie === undefined ? {} : await authHeaders(), 8_000)
let graph = sse?.graph
if (graph === undefined) {
  check(false, '/plugins/events', sse?.status ? `${sse.status}, no graph event in 8 s` : 'no response')
} else {
  report.facts.rev = graph.rev
  report.facts.release = graph.release
  const entries = collectEntries(graph)
  report.facts.entryCount = entries.length
  const present = entries.some((entry) => matchesOwn(entry))
  check(
    present,
    '/plugins/events',
    `${entries.length} entries, rev=${graph.rev}${present ? `, contains ${name}` : ` — ${name} is absent (client half will not load)`}`,
  )
}

// ── authenticated index (only when a launch token was supplied) ──────────────
if (cookie !== undefined) {
  const indexResponse = await http(`${base}/`, { headers: await authHeaders() })
  const html = await indexResponse.text()
  if (indexResponse.status !== 200) check(false, 'authenticated index', `expected 200, got ${indexResponse.status}`)
  else {
    const inlined = parseBootGraph(html)
    check(
      inlined !== undefined,
      'authenticated index',
      `${indexResponse.status}, ${html.length} B${inlined === undefined ? ' (no __DSH_BOOT__ marker)' : `, boot graph rev=${inlined.rev}`}`,
    )
    if (graph === undefined && inlined !== undefined) graph = inlined
  }
}

// ── client bundle ────────────────────────────────────────────────────────────
if (graph !== undefined) {
  const entries = collectEntries(graph)
  const own = entries.find((entry) => matchesOwn(entry))
  if (own !== undefined) {
    const bundleResponse = await http(new URL(own.url, `${base}/`).href, { headers: cookie === undefined ? {} : await authHeaders() })
    const body = await bundleResponse.text()
    const type = bundleResponse.headers.get('content-type') ?? ''
    if (bundleResponse.status === 200 && body.length > 0 && /javascript/.test(type)) {
      check(true, 'client bundle', `${own.url} -> 200 ${type}, ${body.length} B`)
    } else check(false, 'client bundle', `${own.url} -> ${bundleResponse.status} ${type}, ${body.length} B`)
    report.facts.bundle = { url: own.url, rev: own.rev, status: bundleResponse.status, bytes: body.length }
  }
}

// ── plugin HTTP route: deliberately WITHOUT the cookie — plugin routes are not
// behind the browser auth check, so this proves the host half is running ─────
if (probePath === undefined) {
  check(true, 'route probe', 'skipped (pass --path /your/route)')
} else {
  const route = await http(`${base}${probePath}`, { headers: {} })
  const body = (await route.text()).trim()
  check(route.status >= 200 && route.status < 300, 'route probe', `${probePath} -> ${route.status} ${route.headers.get('content-type') ?? ''} ${body.slice(0, 160)}`)
  report.facts.route = { status: route.status, body: body.slice(0, 400), authenticated: false }
}

await shutdown(checks.every((entry) => entry.ok) ? 0 : 1)

// ── helpers ──────────────────────────────────────────────────────────────────
function collectEntries(graph) {
  // `entries` mirrors every batch, so merge by id instead of concatenating.
  const byId = new Map()
  for (const entry of graph.entries ?? []) if (entry && typeof entry === 'object') byId.set(entry.id, entry)
  for (const batch of graph.batches ?? []) {
    for (const entry of batch.entries ?? []) if (entry && typeof entry === 'object') byId.set(entry.id, entry)
  }
  return [...byId.values()]
}

function parseBootGraph(html) {
  const marker = 'globalThis["__DSH_BOOT__"]'
  const start = html.indexOf(marker)
  if (start < 0) return undefined
  const braceStart = html.indexOf('{', start + marker.length)
  if (braceStart < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = braceStart; index < html.length; index += 1) {
    const character = html[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(braceStart, index + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

async function http(url, init = {}) {
  try {
    return await fetch(url, { redirect: 'manual', ...init })
  } catch (error) {
    if (json) printJson({ ...report, ok: false })
    die(`request failed: ${url} — ${String(error)}`)
  }
}

async function readSseGraph(url, headers, timeout) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, { headers: { ...headers, accept: 'text/event-stream' }, signal: controller.signal })
    if (response.status !== 200) return { status: response.status }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const match = /^data: (.*)$/m.exec(buffer)
      if (match) {
        try {
          const parsed = JSON.parse(match[1])
          if (parsed.type === 'graph') {
            await reader.cancel().catch(() => {})
            return { status: 200, graph: parsed.graph }
          }
        } catch {
          /* a partial event; keep reading */
        }
      }
    }
    await reader.cancel().catch(() => {})
    return { status: 200, graph: undefined }
  } catch {
    return { status: 0 }
  } finally {
    clearTimeout(timer)
  }
}

async function shutdown(code) {
  killServer(child)
  if (json) {
    report.ok = code === 0
    printJson(report)
  } else {
    const failed = checks.filter((entry) => !entry.ok)
    process.stdout.write(`\nsmoke: ${code === 0 ? 'PASS' : 'FAIL'} — ${checks.length - failed.length}/${checks.length} checks${report.facts.pid ? ` (server pid ${report.facts.pid} killed)` : ''}\n`)
    for (const entry of failed) process.stdout.write(`  failed: ${entry.label} — ${entry.detail}\n`)
  }
  process.exit(code)
}

function killServer(handle) {
  if (handle === undefined || handle === null || options.keep) return
  if (handle.exitCode !== null) return
  try {
    handle.kill()
  } catch {
    /* already gone */
  }
  // Windows: a detached node server survives SIGTERM in some cases; the
  // process tree is force-killed only for the pid this script started.
  setTimeout(() => {
    if (handle.exitCode === null) {
      try {
        spawn('taskkill', ['/PID', String(handle.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } catch {
        /* ignore */
      }
    }
  }, 2_000).unref()
}

// An interrupted run must not leave the server behind.
process.on('SIGINT', () => {
  killServer(child)
  process.exit(130)
})
process.on('SIGTERM', () => {
  killServer(child)
  process.exit(143)
})

