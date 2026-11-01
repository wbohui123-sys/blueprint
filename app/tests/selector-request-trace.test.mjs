import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { 落新名册, 排队, 写工作文档, 新工作文档, 模型表路径 } from '../../blueprint/packages/roster/src/index.js'
import { 选择记录路径, 选阶段 } from '../../blueprint/packages/node/src/选择机.js'

const user = text => ({ role: 'user', content: [{ type: 'text', text }] })

async function fixture(t, answers = ['plan']) {
  const root = await mkdtemp(join(tmpdir(), 'blueprint-selector-trace-project-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const roster = await 落新名册(root, 'trace replay', 'verify selector request trace')
  const row = roster.rows[0]
  await 排队(root, () => 写工作文档(root, row, 新工作文档(row, 'verify selector request trace')))
  const config = { provider: 'fixture', model: 'trace-model', reasoningEffort: 'high' }
  await writeFile(模型表路径(root), JSON.stringify(config))
  const expected = {
    provider: 'fixture', model: 'trace-model', reasoningEffort: 'high',
    config: { provider: 'fixture', model: 'trace-model', effort: 'high' },
    system: 'trace system prompt',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'system' }] },
      { role: 'assistant', thinking: { signature: 'thinking-state' }, replayState: { cursor: 7 }, content: [] },
      user('task prompt'),
    ],
    tools: [{ name: 'next', parameters: { type: 'object' } }],
    toolHistory: { tools: [{ name: 'next' }], updates: [] },
    sessionId: 'trace-session', maxTokens: 4096,
  }
  const session = {
    id: expected.sessionId,
    requestHeader: () => ({ config, tools: expected.tools }),
    deriveMessages: () => expected.messages,
    toolHistory: () => expected.toolHistory,
  }
  const calls = [], remaining = [...answers]
  const llm = {
    resolveCallConfig: async options => options,
    async *stream(options) {
      calls.push(options)
      const answer = remaining.shift()
      if (answer === undefined) throw new Error('unexpected extra model call')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return { root, row, expected, session, calls, llm }
}

async function readLog(root) {
  return (await readFile(选择记录路径(root), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
}

test('选择机把不含 AbortSignal 的原生请求完整落盘后才分发', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'blueprint-selector-trace-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const dir = join(parent, 'trace')
  const previous = process.env.BLUEPRINT_SELECTOR_TRACE_DIR
  t.after(() => previous === undefined ? delete process.env.BLUEPRINT_SELECTOR_TRACE_DIR : process.env.BLUEPRINT_SELECTOR_TRACE_DIR = previous)
  process.env.BLUEPRINT_SELECTOR_TRACE_DIR = dir
  const { root, row, session, calls, llm } = await fixture(t)
  const signal = new AbortController().signal
  llm.stream = async function* (options) {
    calls.push(options)
    const files = await readdir(dir)
    assert.equal(files.length, 1, 'trace must exist before model dispatch')
    const saved = JSON.parse(await readFile(join(dir, files[0]), 'utf8'))
    assert.equal(saved.requestId, files[0].replace(/\.json$/, ''))
    assert.equal(saved.version, 1)
    assert.match(saved.sha256, /^[a-f0-9]{64}$/)
    assert.equal(saved.sha256, createHash('sha256').update(JSON.stringify(saved.options)).digest('hex'))
    const serializable = structuredClone(options)
    delete serializable.signal
    assert.deepEqual(saved.options, serializable)
    assert.equal(saved.options.signal, undefined)
    assert.ok(saved.options.messages.some(message => message.thinking?.signature === 'thinking-state'))
    assert.ok(saved.options.messages.some(message => message.replayState?.cursor === 7))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'plan' }
    yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  assert.equal(await 选阶段({ llm }, root, row, { session, signal, 这一步: [user('task prompt')] }), 'plan')
  assert.ok(calls[0].signal instanceof AbortSignal)
  const [log] = await readLog(root)
  assert.equal(log.requests.length, 1)
  assert.equal(log.requests[0].attempt, 1)
  assert.equal(log.requests[0].usageIndex, 0)
  assert.equal(log.requests[0].requestId, (await readdir(dir))[0].replace(/\.json$/, ''))
  assert.equal((await stat(join(dir, (await readdir(dir))[0]))).mode & 0o777, 0o600)
  assert.equal((await stat(dir)).mode & 0o777, 0o700)
})

test('重问时分别记录两份请求并按 attempt 与 usage 顺序关联', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'blueprint-selector-trace-retry-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const previous = process.env.BLUEPRINT_SELECTOR_TRACE_DIR
  t.after(() => previous === undefined ? delete process.env.BLUEPRINT_SELECTOR_TRACE_DIR : process.env.BLUEPRINT_SELECTOR_TRACE_DIR = previous)
  process.env.BLUEPRINT_SELECTOR_TRACE_DIR = dir
  const { root, row, session, calls, llm } = await fixture(t, ['not a stage', 'plan'])
  assert.equal(await 选阶段({ llm }, root, row, { session }), 'plan')
  assert.equal(calls.length, 2)
  const [log] = await readLog(root)
  assert.deepEqual(log.requests.map(({ attempt, usageIndex }) => [attempt, usageIndex]), [[1, 0], [2, 1]])
  assert.equal(new Set(log.requests.map(request => request.requestId)).size, 2)
  const files = (await readdir(dir)).sort()
  assert.equal(files.length, 2)
  const snapshots = await Promise.all(files.map(async file => JSON.parse(await readFile(join(dir, file), 'utf8')).options))
  for (const snapshot of snapshots) assert.deepEqual(snapshot, Object.fromEntries(Object.entries(calls[0]).filter(([key]) => key !== 'signal')))
})

test('未配置 trace 目录时不保存完整请求', async t => {
  const previous = process.env.BLUEPRINT_SELECTOR_TRACE_DIR
  t.after(() => previous === undefined ? delete process.env.BLUEPRINT_SELECTOR_TRACE_DIR : process.env.BLUEPRINT_SELECTOR_TRACE_DIR = previous)
  delete process.env.BLUEPRINT_SELECTOR_TRACE_DIR
  const { root, row, session, calls, llm } = await fixture(t)
  assert.equal(await 选阶段({ llm }, root, row, { session }), 'plan')
  assert.equal(calls.length, 1)
  const [log] = await readLog(root)
  assert.equal(log.requests.length, 1)
  assert.equal(log.requests[0].enabled, false)
  assert.equal(log.requests[0].file, undefined)
})

test('trace 写入失败会进入选择记录，但不会拦住模型调用', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'blueprint-selector-trace-failure-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const notDirectory = join(parent, 'file')
  await writeFile(notDirectory, 'occupied')
  const previous = process.env.BLUEPRINT_SELECTOR_TRACE_DIR
  t.after(() => previous === undefined ? delete process.env.BLUEPRINT_SELECTOR_TRACE_DIR : process.env.BLUEPRINT_SELECTOR_TRACE_DIR = previous)
  process.env.BLUEPRINT_SELECTOR_TRACE_DIR = notDirectory
  const { root, row, session, calls, llm } = await fixture(t)
  assert.equal(await 选阶段({ llm }, root, row, { session }), 'plan')
  assert.equal(calls.length, 1)
  const [log] = await readLog(root)
  assert.equal(log.requests.length, 1)
  assert.match(log.requests[0].traceError, /EEXIST|ENOTDIR/)
  assert.equal(log.requests[0].version, 1)
  assert.match(log.requests[0].sha256, /^[a-f0-9]{64}$/)
  assert.equal(log.stage, 'plan')
})

test('模型流失败时也保留该次请求的 trace 引用', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'blueprint-selector-trace-stream-error-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const previous = process.env.BLUEPRINT_SELECTOR_TRACE_DIR
  t.after(() => previous === undefined ? delete process.env.BLUEPRINT_SELECTOR_TRACE_DIR : process.env.BLUEPRINT_SELECTOR_TRACE_DIR = previous)
  process.env.BLUEPRINT_SELECTOR_TRACE_DIR = dir
  const { root, row, session, calls, llm } = await fixture(t)
  llm.stream = async function* (options) { calls.push(options); throw new Error('transport failed') }
  assert.equal(await 选阶段({ llm }, root, row, { session }), null)
  assert.equal(calls.length, 1)
  const [log] = await readLog(root)
  assert.equal(log.requests.length, 1)
  assert.equal(log.requests[0].attempt, 1)
  assert.equal(log.requests[0].usageIndex, null)
  assert.ok(log.requests[0].requestId)
  assert.match(log.error, /transport failed/)
  assert.equal((await readdir(dir)).length, 1)
})

test('既有非私有 trace 目录保持原权限并报告写入失败，模型调用继续', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'blueprint-selector-trace-shared-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const dir = join(parent, 'shared')
  await mkdir(dir)
  await chmod(dir, 0o755)
  const previous = process.env.BLUEPRINT_SELECTOR_TRACE_DIR
  t.after(() => previous === undefined ? delete process.env.BLUEPRINT_SELECTOR_TRACE_DIR : process.env.BLUEPRINT_SELECTOR_TRACE_DIR = previous)
  process.env.BLUEPRINT_SELECTOR_TRACE_DIR = dir
  const { root, row, session, calls, llm } = await fixture(t)
  assert.equal(await 选阶段({ llm }, root, row, { session }), 'plan')
  assert.equal(calls.length, 1)
  assert.equal((await stat(dir)).mode & 0o777, 0o755)
  const [log] = await readLog(root)
  assert.match(log.requests[0].traceError, /owned private directory/)
})

test('拒绝符号链接 trace 目录并继续模型调用', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'blueprint-selector-trace-symlink-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const target = join(parent, 'target'), link = join(parent, 'link')
  await mkdir(target, { mode: 0o700 })
  await symlink(target, link)
  const previous = process.env.BLUEPRINT_SELECTOR_TRACE_DIR
  t.after(() => previous === undefined ? delete process.env.BLUEPRINT_SELECTOR_TRACE_DIR : process.env.BLUEPRINT_SELECTOR_TRACE_DIR = previous)
  process.env.BLUEPRINT_SELECTOR_TRACE_DIR = link
  const { root, row, session, calls, llm } = await fixture(t)
  assert.equal(await 选阶段({ llm }, root, row, { session }), 'plan')
  assert.equal(calls.length, 1)
  assert.equal((await readdir(target)).length, 0)
  const [log] = await readLog(root)
  assert.match(log.requests[0].traceError, /owned private directory/)
})
