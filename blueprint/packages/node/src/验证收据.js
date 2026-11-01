import { constants as fsConstants } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { open, lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { 存证据 } from './资料.js'
import { 文件许可 } from './项目隔离.js'
import { 证据夹名 } from '../../roster/src/index.js'
import { 说明书, 只回一段字 } from '../../prompt/src/index.js'

const RECEIPT_TYPE = 'blueprint.verification-receipt'
const LOG_TYPE = 'blueprint.verification-log'
const VERSION = 1
const STATES = new Set(['launching', 'pending', 'completed', 'failed', 'unknown'])
const TERMINAL = new Set(['completed', 'failed', 'killed'])
const OWNER_ERROR = 'verification receipt can only be collected by its original agent'
const contextState = new WeakMap()
const receiptKey = (root, path) => `${root}\0${path}`
const digest = value => createHash('sha256').update(value).digest('hex')
const shortDigest = value => digest(value).slice(0, 24)
const json = value => JSON.stringify(value)
const projectScope = root => ({ 根: root, 技能: root })

class UnsafeInput extends Error {}

const runtimeRequire = createRequire(new URL('../../../../app/package.json', import.meta.url))
function runtimeVersion(name) {
  try { return runtimeRequire(`${name}/package.json`).version } catch { return null }
}

const bashToolVersion = runtimeVersion('@deepseek-ai/dsh-tool-bash')
const bashExecutorVersion = runtimeVersion('@deepseek-ai/dsh-bash-local')

function rootOf(exec) {
  const session = exec?.agent?.session
  if (typeof session?.header?.cwd !== 'string' || typeof session.id !== 'string' || !session.id) throw new Error('verification requires a project session')
  return session
}

function observationsOf(value) {
  if (value === undefined) value = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('environmentObservations must be a string record')
  const extra = {}
  for (const [name, observation] of Object.entries(value)) {
    if (!name || typeof observation !== 'string') throw new Error('environmentObservations must map names to strings')
    if (['node', 'platform', 'arch', 'bashToolVersion', 'bashExecutorVersion'].includes(name)) throw new Error(`environment observation name is reserved: ${name}`)
    extra[name] = observation
  }
  return {
    values: { node: process.version, platform: process.platform, arch: process.arch,
      bashToolVersion: bashToolVersion ?? 'unavailable', bashExecutorVersion: bashExecutorVersion ?? 'unavailable', ...extra },
    complete: bashToolVersion !== null && bashExecutorVersion !== null,
  }
}

function fingerprintObservations(observations) {
  const names = Object.keys(observations.values).sort()
  return { names, hashes: Object.fromEntries(names.map(name => [name, digest(observations.values[name])])), complete: observations.complete }
}

function validatedEnvironment(value) {
  if (!value || !Array.isArray(value.names) || !value.hashes || typeof value.hashes !== 'object' || typeof value.complete !== 'boolean') return false
  const names = [...value.names]
  return names.every(name => typeof name === 'string' && name.length > 0)
    && new Set(names).size === names.length && names.sort().join('\0') === value.names.join('\0')
    && Object.keys(value.hashes).sort().join('\0') === value.names.join('\0')
    && Object.values(value.hashes).every(hash => /^[0-9a-f]{64}$/.test(hash))
}

function environmentMatch(before, current) {
  if (!validatedEnvironment(before)) return 'unknown'
  if (!current.complete || !before.complete) return 'unknown'
  if (before.names.join('\0') !== current.names.join('\0')) return 'unknown'
  return before.names.every(name => before.hashes[name] === current.hashes[name]) ? 'matched' : 'stale'
}

function assertNoGitPath(root, path) {
  const rel = relative(root, path)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('PROJECT_ISOLATION: verification path leaves the project root')
  if (rel.split(sep).includes('.git')) throw new UnsafeInput('.git paths cannot be verification inputs')
  return rel || '.'
}

async function noSymlinkPath(root, path, { missing = false } = {}) {
  const rel = assertNoGitPath(root, path)
  let current = root
  for (const part of rel === '.' ? [] : rel.split(sep)) {
    current = join(current, part)
    let info
    try { info = await lstat(current) }
    catch (error) { if (missing && error.code === 'ENOENT') return current; throw error }
    if (info.isSymbolicLink()) throw new UnsafeInput(`symbolic links cannot be verification inputs: ${relative(root, current)}`)
  }
  return path
}

function normalizePath(root, value, scope) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('inputs must contain non-empty paths')
  const absolute = resolve(root, value)
  const permitted = 文件许可(scope, absolute, false, root)
  const rel = assertNoGitPath(root, absolute)
  if (rel.split(sep)[0] === 证据夹名) throw new UnsafeInput('machine verification evidence cannot be an input')
  if (permitted !== absolute) throw new UnsafeInput(`symbolic links cannot be verification inputs: ${value}`)
  return { declared: value, relative: relative(root, absolute) || '.' }
}

async function validateWorkdir(root, value) {
  const absolute = resolve(root, value ?? '.')
  const permitted = 文件许可(projectScope(root), absolute, false, root)
  assertNoGitPath(root, absolute)
  await noSymlinkPath(root, absolute)
  const info = await lstat(absolute)
  if (!info.isDirectory()) throw new Error('workdir must be a project directory')
  return permitted
}

async function hashFile(path, expectedInfo) {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0))
  try {
    const actual = await handle.stat()
    if (!actual.isFile() || actual.size !== expectedInfo.size || (actual.mode & 0o111) !== (expectedInfo.mode & 0o111)
      || (actual.dev !== expectedInfo.dev) || (actual.ino !== expectedInfo.ino)) throw new UnsafeInput('input changed while hashing')
    const content = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) content.update(chunk)
    return content.digest('hex')
  } finally { await handle.close() }
}

async function snapshotOne(root, input, scope) {
  const normalized = normalizePath(root, input, scope)
  const absolute = join(root, normalized.relative)
  await noSymlinkPath(root, absolute)
  const entries = []
  async function walk(path, local) {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new UnsafeInput(`symbolic links cannot be verification inputs: ${relative(root, path)}`)
    if (info.isDirectory()) {
      entries.push({ local, path, type: 'directory', mode: info.mode & 0o111, size: null, info })
      const children = await readdir(path, { withFileTypes: true })
      children.sort((a, b) => a.name.localeCompare(b.name, 'en'))
      for (const child of children) {
        // Machine receipts change as this check runs; they are evidence, not project inputs.
        if (child.name === '.git' || (path === root && child.name === 证据夹名)) continue
        await walk(join(path, child.name), local === '.' ? child.name : `${local}/${child.name}`)
      }
      return
    }
    if (!info.isFile()) throw new UnsafeInput(`verification input is not a regular file or directory: ${relative(root, path)}`)
    entries.push({ local, path, type: 'file', mode: info.mode & 0o111, size: info.size, info })
  }
  await walk(absolute, '.')
  const hash = createHash('sha256')
  for (const entry of entries) {
    const fileHash = entry.type === 'file' ? await hashFile(entry.path, entry.info) : null
    hash.update(json([entry.local, entry.type, entry.mode, entry.size, fileHash]) + '\n')
  }
  return { declared: normalized.declared, path: normalized.relative, sha256: hash.digest('hex') }
}

async function snapshot(root, manifest) {
  const scope = projectScope(root)
  const items = []
  for (const input of manifest) items.push(await snapshotOne(root, input, scope))
  const value = items.map(({ declared, path, sha256 }) => [declared, path, sha256])
  return { items, sha256: digest(json(value)) }
}

async function manifestBefore(root, inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.some(path => typeof path !== 'string' || path.length === 0)) {
    throw new Error('inputs must be a non-empty list of project paths')
  }
  if (new Set(inputs).size !== inputs.length) throw new Error('inputs must not contain duplicate paths')
  const items = []
  for (const path of inputs) items.push(normalizePath(root, path, projectScope(root)))
  const manifest = items.map(item => item.declared)
  return { manifest, fingerprint: await snapshot(root, manifest) }
}

function receiptSource(kind) { return { kind: `verification-${kind}` } }

async function saveReceipt(session, record, kind) {
  const source = receiptSource(kind)
  const body = { type: RECEIPT_TYPE, version: VERSION, ...record, archiveSource: source }
  const text = json(body) + '\n'
  return { ...await 存证据(session, text, source), record: body }
}

async function saveLog(session, record, chunks, complete, redactValues) {
  const source = receiptSource('log')
  const sanitized = redact(chunks, redactValues)
  const body = { type: LOG_TYPE, version: VERSION, projectRoot: record.projectRoot, jobId: record.job.id,
    archiveSource: source, complete, chunks: sanitized }
  const text = json(body) + '\n'
  return { ...await 存证据(session, text, source), complete }
}

function redact(value, secrets) {
  if (typeof value === 'string') {
    let output = value
    for (const secret of secrets) if (secret) output = output.replaceAll(secret, '[REDACTED]')
    return output
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]))
  return value
}

function validArchivePath(value) {
  const prefix = `${证据夹名}/`
  if (typeof value !== 'string' || isAbsolute(value) || !value.startsWith(prefix)) throw new Error('invalid verification receipt path')
  const parts = value.split('/')
  if (parts.length !== 3 || parts[0] !== 证据夹名 || !/^[0-9a-f]{24}$/.test(parts[1]) || !/^[0-9a-f]{24}[.]txt$/.test(parts[2])) {
    throw new Error('invalid verification receipt path')
  }
  return value
}

async function readArchive(root, value, expectedKind) {
  const rel = validArchivePath(value)
  const path = resolve(root, rel)
  const permitted = 文件许可(projectScope(root), path, false, root)
  if (permitted !== path) throw new Error('verification archive path resolves through a symlink')
  await noSymlinkPath(root, path)
  const text = await readFile(path, 'utf8')
  let record
  try { record = JSON.parse(text) } catch { throw new Error('verification archive is malformed') }
  if (!record || (expectedKind && record.archiveSource?.kind !== expectedKind)
    || shortDigest(json(record.archiveSource) + '\n' + text) !== path.slice(path.lastIndexOf('/') + 1, -4)) {
    throw new Error('verification archive failed its content-address check')
  }
  return { path: rel, text, record }
}

function validateReceiptShape(record, root) {
  if (record.type !== RECEIPT_TYPE || record.version !== VERSION || record.projectRoot !== root || !STATES.has(record.state)
    || typeof record.owner !== 'string' || !record.owner || typeof record.command !== 'string' || !record.command
    || typeof record.cwd !== 'string' || !Array.isArray(record.manifest) || record.manifest.length === 0
    || record.manifest.some(path => typeof path !== 'string' || path.length === 0) || record.acceptanceComplete !== false
    || !record.environment || !validatedEnvironment(record.environment) || !record.fingerprintBefore?.sha256) {
    throw new Error('verification receipt schema or project root is invalid')
  }
  for (const input of record.manifest) assertNoGitPath(root, resolve(root, input))
  if (Object.hasOwn(record, 'reusable')) throw new Error('verification receipts do not contain reusable decisions')
  return record
}

async function loadReceipt(exec, value) {
  const session = rootOf(exec), root = await realpath(session.header.cwd)
  const saved = await readArchive(root, value, undefined)
  const allowed = new Set(['verification-request', 'verification-pending', 'verification-final', 'verification-failed', 'verification-unknown'])
  if (!allowed.has(saved.record.archiveSource?.kind)) throw new Error('verification receipt kind is invalid')
  validateReceiptShape(saved.record, root)
  return { session, root, ...saved, record: saved.record }
}

function jobService(ctx) {
  return ctx.get?.('jobs') ?? ctx.jobs
}

function ownerId(exec) { return rootOf(exec).id }

function result(action, receipt, record, extra = {}) {
  return { 文: json({ action, receipt, state: record.state, nativeReportedSuccess: record.nativeReportedSuccess === true,
    acceptanceComplete: false, ...(record.reason ? { reason: record.reason } : {}), ...(record.inputsStable !== undefined ? { inputsStable: record.inputsStable } : {}), ...extra }) }
}

function unknownRecord(record, reason) {
  return { ...record, state: 'unknown', nativeReportedSuccess: false, reason, acceptanceComplete: false }
}


function actions(ctx, exec) {
  if (!contextState.has(ctx)) contextState.set(ctx, { latest: new Map(), observationValues: new Map(), activeBegins: new Map() })
  const { latest, observationValues, activeBegins } = contextState.get(ctx)
  const releaseBegin = record => {
    if (activeBegins.get(record.verificationKey)?.jobId === record.job?.id) activeBegins.delete(record.verificationKey)
  }
  const linkedLatest = (root, path) => latest.get(receiptKey(root, path)) || path
  const setLatest = (root, from, to) => latest.set(receiptKey(root, from), to)
  const session = rootOf(exec)
  const owner = ownerId(exec)

  async function begin(command, workdir, inputs, environmentObservations = {}) {
    if (typeof command !== 'string' || !command.trim()) throw new Error('command must be a non-empty string')
    const root = await realpath(session.header.cwd)
    const directory = ctx.get?.('workingDirectory')
    const current = directory?.ensure ? await directory.ensure(exec.agent, exec.signal) : root
    const cwd = await validateWorkdir(root, resolve(current, workdir ?? '.'))
    const { manifest, fingerprint } = await manifestBefore(root, inputs)
    const rawObservations = observationsOf(environmentObservations)
    const environment = fingerprintObservations(rawObservations)
    const verificationKey = digest(json([root, owner, command, cwd, fingerprint.sha256, environment]))
    const previous = activeBegins.get(verificationKey)
    if (previous) {
      const saved = await loadReceipt(exec, previous.path)
      return result('begin', saved.path, saved.record, { jobId: saved.record.job.id,
        wait: { type: 'job', id: saved.record.job.id }, scope: 'declared-inputs-only' })
    }
    const base = { projectRoot: root, owner, command, cwd, manifest, fingerprintBefore: fingerprint, environment, verificationKey,
      state: 'launching', nativeReportedSuccess: false, acceptanceComplete: false }
    await saveReceipt(session, base, 'request')
    let execution
    try {
      execution = await ctx.tools.execute({ name: 'bash', arguments: { command, description: 'Run declared project verification command', workdir: cwd, run_in_background: true },
        callId: `${String(exec.callId || 'verification')}:bash`, rootCallId: exec.rootCallId, parent: exec.token,
        agent: exec.agent, signal: exec.signal })
    } catch {
      const unknown = await saveReceipt(session, unknownRecord(base, 'native-execution-outcome-unavailable'), 'unknown')
      return result('begin', unknown.path, unknown.record)
    }
    for (const message of execution?.additionalContexts || []) exec.deferContext(message)
    const value = execution?.value
    if (execution?.isError || value?.kind !== 'background' || typeof value.jobId !== 'string' || !value.jobId || typeof value.cwd !== 'string') {
      const reason = execution?.isError ? `native-bash-tool-error:${execution.error?.info?.code || execution.error?.code || 'unspecified'}` : value?.kind !== 'background'
        ? 'native-bash-did-not-return-background' : typeof value?.jobId !== 'string' || !value.jobId
          ? 'native-job-id-unavailable' : 'native-cwd-unavailable'
      const unknown = await saveReceipt(session, unknownRecord(base, reason), 'unknown')
      return result('begin', unknown.path, unknown.record)
    }
    let actualCwd, job
    try {
      actualCwd = await validateWorkdir(root, value.cwd)
      job = jobService(ctx)?.get(value.jobId, owner)
    } catch {}
    if (!job || job.id !== value.jobId || job.kind !== 'bash' || job.owner !== owner || job.startedAt === undefined || actualCwd !== cwd) {
      const unknown = await saveReceipt(session, { ...unknownRecord(base, 'native-job-record-unavailable'), job: { id: value.jobId } }, 'unknown')
      return result('begin', unknown.path, unknown.record)
    }
    const record = { ...base, cwd: actualCwd, state: 'pending', job: { id: value.jobId, owner, startedAt: job.startedAt, kind: job.kind },
      nativeReportedSuccess: false }
    const saved = await saveReceipt(session, record, 'pending')
    activeBegins.set(verificationKey, { path: saved.path, jobId: value.jobId })
    observationValues.set(receiptKey(root, saved.path), Object.values(rawObservations.values))
    return result('begin', saved.path, saved.record, { jobId: value.jobId, wait: { type: 'job', id: value.jobId }, scope: 'declared-inputs-only' })
  }

  async function collect(receipt) {
    const initial = await loadReceipt(exec, receipt)
    const resolved = linkedLatest(initial.root, initial.path)
    const loaded = resolved === initial.path ? initial : await loadReceipt(exec, resolved)
    const record = loaded.record
    if (record.owner !== owner) throw new Error(OWNER_ERROR)
    if (record.state === 'completed' || record.state === 'failed' || record.state === 'unknown') {
      releaseBegin(record)
      return result('collect', loaded.path, record, {
        ...(record.job?.id ? { jobId: record.job.id } : {}),
        ...(record.output ? { outputComplete: record.output.complete } : {}),
        ...(record.inputsStable !== undefined ? { inputsStable: record.inputsStable } : {}),
      })
    }
    if (!record.job?.id) {
      const unknown = await saveReceipt(session, unknownRecord(record, 'job-id-unavailable'), 'unknown')
      setLatest(loaded.root, loaded.path, unknown.path)
      releaseBegin(record)
      return result('collect', unknown.path, unknown.record)
    }
    let job
    try { job = jobService(ctx)?.get(record.job.id, owner) } catch {}
    if (!job || job.id !== record.job.id || job.owner !== owner || job.kind !== 'bash' || record.job.kind !== 'bash' || job.startedAt !== record.job.startedAt) {
      const unknown = await saveReceipt(session, unknownRecord(record, 'job-unavailable-or-identity-changed'), 'unknown')
      setLatest(loaded.root, loaded.path, unknown.path)
      releaseBegin(record)
      observationValues.delete(receiptKey(loaded.root, loaded.path))
      return result('collect', unknown.path, unknown.record, { jobId: record.job.id })
    }
    if (job.status === 'running' || job.status === 'stopping') return result('collect', loaded.path, record, {
      jobId: record.job.id, wait: { type: 'job', id: record.job.id }, scope: 'declared-inputs-only',
    })
    if (!TERMINAL.has(job.status)) {
      const unknown = await saveReceipt(session, unknownRecord(record, 'job-state-unavailable'), 'unknown')
      setLatest(loaded.root, loaded.path, unknown.path)
      releaseBegin(record)
      return result('collect', unknown.path, unknown.record, { jobId: record.job.id })
    }
    const success = job.status === 'completed' && job.detail === 'exit code: 0'
    let logArchive, outputComplete = false
    try {
      const read = jobService(ctx)?.readAt(record.job.id, 0, owner)
      if (read && Array.isArray(read.chunks) && typeof read.lossy === 'boolean') {
        const secrets = observationValues.get(receiptKey(loaded.root, loaded.path)) || []
        logArchive = await saveLog(session, record, read.chunks, read.lossy === false, secrets)
        outputComplete = logArchive.complete
      }
    } catch {}
    let after
    try { after = await snapshot(loaded.root, record.manifest) } catch {}
    const inputsStable = !!after && after.sha256 === record.fingerprintBefore.sha256
    const state = success ? 'completed' : 'failed'
    const finalRecord = { ...record, state, nativeReportedSuccess: success, finishedAt: job.finishedAt ?? null,
      job: { ...record.job, status: job.status, detail: typeof job.detail === 'string' ? job.detail : null },
      fingerprintAfter: after || null, inputsStable, output: logArchive ? { path: logArchive.path, complete: outputComplete } : { complete: false },
      acceptanceComplete: false }
    const final = await saveReceipt(session, finalRecord, 'final')
    releaseBegin(record)
    setLatest(loaded.root, loaded.path, final.path)
    setLatest(loaded.root, initial.path, final.path)
    observationValues.delete(receiptKey(loaded.root, loaded.path))
    return result('collect', final.path, final.record, { jobId: record.job.id, outputComplete, inputsStable })
  }

  async function compare(receipt, command, environmentObservations = {}) {
    const initial = await loadReceipt(exec, receipt)
    const current = linkedLatest(initial.root, initial.path)
    const loaded = current === initial.path ? initial : await loadReceipt(exec, current)
    const record = loaded.record
    if (record.owner !== owner && record.state !== 'completed') throw new Error('only completed verification receipts may be compared by another agent')
    const base = { state: record.state, match: 'unknown', scope: 'declared-inputs-only', acceptanceComplete: false,
      cwd: record.cwd, inputs: record.fingerprintBefore.items?.map(item => item.path), inputFingerprint: record.fingerprintBefore.sha256,
      nativeReportedSuccess: record.nativeReportedSuccess === true, ...(record.inputsStable !== undefined ? { inputsStable: record.inputsStable } : {}) }
    if (record.state === 'pending') {
      let job
      try { job = jobService(ctx)?.get(record.job?.id, record.job?.owner) } catch {}
      if (!job) return { 文: json({ ...base, state: 'unknown', reason: 'job-unavailable' }) }
      if (job.status === 'running' || job.status === 'stopping') return { 文: json({ ...base, wait: { type: 'job', id: record.job.id } }) }
      return { 文: json({ ...base, wait: { type: 'job', id: record.job.id }, reason: 'collect-settled-job-first' }) }
    }
    if (record.state === 'launching' || record.state === 'unknown') return { 文: json({ ...base, state: 'unknown' }) }
    const inputSnapshot = await snapshot(loaded.root, record.manifest).catch(() => null)
    if (!inputSnapshot) return { 文: json({ ...base, match: 'stale', reason: 'declared-input-changed-or-unavailable' }) }
    if (command !== record.command || inputSnapshot.sha256 !== record.fingerprintBefore.sha256 || record.inputsStable !== true) {
      return { 文: json({ ...base, match: 'stale', reason: command !== record.command ? 'command-changed' : 'declared-inputs-changed' }) }
    }
    const env = environmentMatch(record.environment, fingerprintObservations(observationsOf(environmentObservations)))
    if (env !== 'matched') return { 文: json({ ...base, match: env, reason: env === 'stale' ? 'environment-observation-changed' : 'environment-observation-incomplete' }) }
    if (!record.output?.complete || typeof record.output.path !== 'string') return { 文: json({ ...base, match: 'unknown', reason: 'output-incomplete' }) }
    try {
      const log = await readArchive(loaded.root, record.output.path, 'verification-log')
      if (log.record.type !== LOG_TYPE || log.record.version !== VERSION || log.record.projectRoot !== loaded.root
        || log.record.jobId !== record.job?.id || log.record.complete !== true || !Array.isArray(log.record.chunks)) throw new Error('invalid verification log')
    } catch { return { 文: json({ ...base, match: 'unknown', reason: 'output-archive-unavailable-or-corrupt' }) } }
    if (record.state !== 'completed' || record.nativeReportedSuccess !== true) return { 文: json({ ...base, match: 'unknown', reason: 'native-command-not-successful' }) }
    return { 文: json({ ...base, match: 'matched' }) }
  }

  return { begin, collect, compare }
}

export function 装验证收据(ctx) {
  ctx.tools.register({
    name: 'verification',
    description: 说明书('verification'),
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['begin', 'collect', 'compare'] },
      command: { type: 'string' }, workdir: { type: 'string' },
      inputs: { type: 'array', items: { type: 'string' } },
      environmentObservations: { type: 'object', additionalProperties: { type: 'string' } },
      receipt: { type: 'string' },
    } },
    output: 只回一段字,
    isConcurrencySafe: args => args.action === 'compare',
    async execute(args, exec) {
      const api = actions(ctx, exec)
      if (args.action === 'begin') return api.begin(args.command, args.workdir, args.inputs, args.environmentObservations)
      if (args.action === 'collect') return api.collect(args.receipt)
      if (args.action === 'compare') return api.compare(args.receipt, args.command, args.environmentObservations)
      throw new Error('verification action must be begin, collect, or compare')
    },
  })
}
