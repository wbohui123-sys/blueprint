import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute, relative } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import LlmRuntime, { LlmAdapter, createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalFS from '@deepseek-ai/dsh-fs-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import * as ToolFS from '@deepseek-ai/dsh-tool-fs'
import * as ToolWorkingDirectory from '@deepseek-ai/dsh-tool-working-directory'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { 抓网页, 存证据, 选片段, 装资料, 回收已读结果 } from './src/资料.js'
import { 工具结果Of } from '../context/src/消息协议.js'
import { 装项目隔离 } from './src/项目隔离.js'
import { 项目路径 } from '../prompt/src/路径.js'

const sessionAt = root => Session.create('research-test', undefined, { version: SESSION_FORMAT_VERSION, id: 'research-test', createdAt: 0, isSeeded: false, cwd: root })
const mockWeb = content => ({ web: { fetch: async () => ({ url: 'https://example.org/manual', statusCode: 200, body: { kind: 'text', content }, truncated: false }) } })

test('长网页完整落盘，返回尾部关键词片段；缺少命中与抓取截断明确提示', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blueprint-source-'))
  const session = sessionAt(root)
  const content = 'unrelated line\n'.repeat(10000) + 'needle verified evidence\nlast line'
  try {
    const r = await 抓网页(mockWeb(content), { url: 'https://example.org/manual', query: 'needle' }, { agent: { session }, signal: new AbortController().signal })
    assert.ok(r.文.length < 7500)
    assert.match(r.文, /needle verified evidence/)
    assert.equal(r.文.match(/原文文件：([^\n]+)/)[1], join(root, r.archive.path))
    assert.equal(isAbsolute(r.archive.path), false, '存储字段继续是项目相对路径')
    const saved = await readFile(join(root, r.archive.path), 'utf8')
    assert.ok(saved.includes(content), '50k 以后的正文必须仍在本地')
    assert.equal(选片段(content, 'absent').matched, 0)
    const ctx = mockWeb('partial')
    const original = ctx.web.fetch
    ctx.web.fetch = async () => ({ ...await original(), truncated: true })
    assert.match((await 抓网页(ctx, { url: 'https://example.org/manual' }, { agent: { session } })).文, /不能当作完整网页/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('真实工具注册与执行：结构化返回也只含片段和文件地址', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blueprint-fetch-'))
  const host = new Context()
  const prompt = await host.plugin(SystemPrompt)
  const tools = await host.plugin(ToolRuntime)
  装资料({ tools: host.tools, web: mockWeb('test evidence\n'.repeat(10000)).web, on() {} })
  try {
    const r = await host.tools.execute({ callId: 'fetch-one', name: 'web_fetch', arguments: { url: 'https://example.org/manual' }, signal: new AbortController().signal, agent: { ctx: host, session: sessionAt(root) } })
    assert.equal(r.isError, false, JSON.stringify(r))
    assert.ok(JSON.stringify(r.value).length < 8000)
    assert.ok(r.meta.blueprintArchive.path)
  } finally { await tools.dispose(); await prompt.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('原生 cd 后网页正文、HTML 和回收入口均可直接重读；复用项目相对归档并保留原生历史身份', { timeout: 10000 }, async t => {
  const root = await realpath(await mkdtemp(join(项目路径, '资料原文目录入口核对-')))
  const first = join(root, '取材目录'), second = join(root, '继续工作目录')
  await mkdir(first); await mkdir(second)
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry, LocalFS, Subprocess, WorkingDirectory, TokenMeter]) await ctx.plugin(plugin)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ToolFS); await ctx.plugin(ToolWorkingDirectory)
  装项目隔离(ctx)
  const html = '<html><body>\n' + '<p>资料关键词与事实。</p>\n'.repeat(4000) + '</body></html>'
  ctx.provide('web', { fetch: async () => ({ url: 'https://example.org/manual', statusCode: 200,
    body: { kind: 'html', content: html }, truncated: false }) })
  装资料(ctx)
  const requests = []
  class ArchiveModel extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      requests.push(options)
      if (requests.length === 1 || requests.length === 5) {
        const regular = requests.length === 5
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(regular ? 'archive-read-native' : 'archive-fetch-native'),
          name: regular ? 'read' : 'web_fetch', arguments: JSON.stringify(regular ? { file_path: '普通工具读取.txt' } : { url: 'https://example.org/manual' }) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '已消费网页原文片段。' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['archive-fixture'], new ArchiveModel())
  const { agent } = await ctx.agents.create({ sessionId: 'archive-directory-native', meta: { cwd: root },
    agentOptions: { provider: 'archive-fixture', model: 'archive-fixture' } })
  let sequence = 0
  const invoke = async (name, args, caller = agent) => {
    const result = await ctx.tools.execute({ name, arguments: args, callId: ToolCallId(`archive-direct-${++sequence}`),
      agent: caller, signal: new AbortController().signal })
    assert.equal(result.isError, false, JSON.stringify(result))
    return result
  }
  const textOf = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const run = async (text, caller = agent) => { caller.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })); await caller.whenIdle() }
  await invoke('working_directory', { cd: first })
  await run('取回网页资料')
  assert.equal(requests.length, 2)
  const original = agent.session.ownEvents().find(event => event.type === 'tool/result')
  const history = structuredClone(original)
  const archive = original.data.meta.blueprintArchive
  assert.equal(isAbsolute(archive.path), false)
  const originalText = textOf(original.data.message)
  const bodyPath = originalText.match(/原文文件：([^\n]+)/)[1]
  const htmlPath = originalText.match(/原始 HTML：([^\n]+)/)[1]
  assert.equal(bodyPath, join(root, archive.path))
  assert.equal(isAbsolute(htmlPath), true)
  assert.equal(await readFile(htmlPath, 'utf8'), html)
  await invoke('working_directory', { cd: second })
  for (const path of [bodyPath, htmlPath]) assert.match(textOf(await invoke('read', { file_path: path, limit: 12 })), /资料关键词与事实/)
  await run('继续处理已读资料')
  assert.equal(requests.length, 3)
  assert.equal(await 回收已读结果(ctx, agent.session), 1, '归档路径检查显式触发普通工具回收')
  const replacement = agent.session.ownEvents().findLast(event => event.type === 'tool/result')
  assert.ok(replacement.seq > original.seq)
  const reclaimed = replacement.data.message
  assert.match(textOf(reclaimed), /^已读长工具结果已回收/)
  assert.equal(textOf(reclaimed).match(/原文文件：([^\n]+)/)[1], bodyPath)
  assert.match(textOf(await invoke('read', { file_path: bodyPath, limit: 12 })), /资料关键词与事实/)
  assert.deepEqual(replacement.data.meta.blueprintArchive, archive, '已有归档 metadata 继续复用项目相对路径')
  assert.equal(reclaimed.role, 'tool'); assert.equal(reclaimed.id, original.data.message.id)
  assert.equal(reclaimed.toolCallId, original.data.message.toolCallId)
  assert.equal(reclaimed.isError, original.data.message.isError)
  assert.deepEqual(reclaimed.source, original.data.message.source)
  assert.deepEqual(agent.session.eventAt(original.seq), history, '原生历史事实未因入口绝对化改写')
  assert.equal((await readdir(join(root, archive.path, '..'))).filter(name => name.endsWith('.txt')).length, 2, '只有正文与原始 HTML，不为旧归档再存一份')
  const index = await readFile(join(root, '.blueprint-evidence/网页目录.md'), 'utf8')
  assert.equal(index.split('\n').filter(line => line.startsWith('- ')).length, 1)
  assert.ok(index.includes(`\`${archive.path}\``))
  assert.ok(!index.includes(root), '机器目录仍保存项目相对入口')
  assert.equal(ctx.workingDirectory.get(agent.session), second)
  const legacyText = textOf(reclaimed).replace(bodyPath, archive.path)
  const legacy = agent.session.append('tool/result', { ...replacement.data,
    message: { ...reclaimed, content: [{ type: 'text', text: legacyText }] } }, {
    surfaceOp: { op: 'replace', startSeq: replacement.seq, endSeq: replacement.seq }, sourceEventSeqs: [replacement.seq],
  })
  const legacySnapshot = structuredClone(legacy)
  const pruneCount = agent.session.ownEvents().filter(event => event.type === 'compaction/prune').length
  await invoke('working_directory', { cd: first })
  await run('首次升级后继续读取旧归档')
  assert.equal(requests.length, 4)
  const upgraded = requests.at(-1).messages.find(message => message.role === 'tool' && message.toolCallId === reclaimed.toolCallId)
  assert.equal(textOf(upgraded), textOf(reclaimed), '只把已知相对入口还原为原项目绝对入口，其余文字原样保留')
  assert.match(textOf(await invoke('read', { file_path: textOf(upgraded).match(/原文文件：([^\n]+)/)[1], limit: 12 })), /资料关键词与事实/)
  assert.deepEqual(agent.session.eventAt(legacy.seq), legacySnapshot, '旧提示的历史原件仍可读')
  assert.equal(upgraded.id, reclaimed.id); assert.equal(upgraded.toolCallId, reclaimed.toolCallId)
  assert.equal(agent.session.ownEvents().filter(event => event.type === 'compaction/prune').length, pruneCount, '旧入口更新不再 prune 或归档')
  const seq = agent.session.seq
  assert.equal(await 回收已读结果(ctx, agent.session), 0)
  assert.equal(agent.session.seq, seq, '第二次不重复 replacement')
  const current = agent.session.ownEvents().findLast(event => event.type === 'tool/result')
  assert.throws(() => agent.session.append('tool/result', { ...current.data,
    meta: { ...current.data.meta, extraArchiveFact: true } }, {
    surfaceOp: { op: 'replace', startSeq: current.seq, endSeq: current.seq }, sourceEventSeqs: [current.seq],
  }), /surface replacement may change only content/, '不能为了补归档 metadata 绕过原生 surface 契约')
  assert.equal(agent.session.seq, seq)
  assert.equal((await readdir(join(root, archive.path, '..'))).filter(name => name.endsWith('.txt')).length, 2)
  for (const [text, meta] of [[legacyText, undefined], [legacyText.replace(`原文文件：${archive.path}`, '原文入口：未知文本格式'), replacement.data.meta]]) {
    const untouched = Session.create(`archive-unknown-${meta ? 'text' : 'meta'}`, undefined,
      { ...agent.session.header, id: `archive-unknown-${meta ? 'text' : 'meta'}` })
    const callId = ToolCallId('unknown-archive')
    const assistant = (step, content) => untouched.append('assistant/message', { turn: 1, step, stream: [], message: createMessage({
      role: 'assistant', content, source: { kind: 'model', provider: 'archive-fixture', model: 'archive-fixture' },
    }) }, { surfaceOp: 'append' })
    untouched.append('turn/start', { turn: 1 }); untouched.append('step/start', { turn: 1, step: 1 })
    assistant(1, [{ type: 'tool-call', id: callId, name: 'web_fetch', arguments: '{}' }])
    untouched.append('tool/call', { turn: 1, step: 1, callId, name: 'web_fetch', arguments: '{}' })
    untouched.append('tool/result', { turn: 1, step: 1, ...(meta === undefined ? {} : { meta }),
      message: createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text }] }) }, { surfaceOp: 'append' })
    untouched.append('step/end', { turn: 1, step: 1 }); untouched.append('step/start', { turn: 1, step: 2 })
    assistant(2, [{ type: 'text', text: '已读旧结果。' }])
    const before = untouched.seq
    assert.equal(await 回收已读结果(ctx, untouched), 0)
    assert.equal(untouched.seq, before, '无归档事实或未知提示格式时不猜入口、不替换')
  }
  const replay = Session.create(agent.session.id, agent.session.snapshotEvents(), agent.session.header)
  assert.deepEqual(replay.deriveMessages(), agent.session.deriveMessages())
  await writeFile(join(first, '普通工具读取.txt'), '普通工具原文证据\n'.repeat(1000))
  const { agent: regular } = await ctx.agents.create({ sessionId: 'archive-directory-ordinary', meta: { cwd: root },
    agentOptions: { provider: 'archive-fixture', model: 'archive-fixture' } })
  await invoke('working_directory', { cd: first }, regular)
  await run('通过原生 read 读取普通工具原文', regular)
  assert.equal(requests.length, 6)
  const fullRead = regular.session.ownEvents().find(event => event.type === 'tool/result')
  const fullReadSnapshot = structuredClone(fullRead)
  await run('开始消费后的普通结果回收', regular)
  assert.equal(requests.length, 7)
  assert.equal(await 回收已读结果(ctx, regular.session), 1, '普通工具归档路径检查显式触发回收')
  const readReclaimed = regular.session.ownEvents().findLast(event => event.type === 'tool/result')
  const absoluteText = textOf(readReclaimed.data.message), readPath = absoluteText.match(/原文文件：([^\n]+)/)[1]
  assert.equal(readReclaimed.data.meta?.blueprintArchive, undefined, '普通原生工具 metadata 无 archive 字段且不可补写')
  const oldRead = regular.session.append('tool/result', { ...readReclaimed.data,
    message: { ...readReclaimed.data.message, content: [{ type: 'text', text: absoluteText.replace(readPath, relative(root, readPath)) }] } }, {
    surfaceOp: { op: 'replace', startSeq: readReclaimed.seq, endSeq: readReclaimed.seq }, sourceEventSeqs: [readReclaimed.seq],
  })
  const ordinaryPrunes = regular.session.ownEvents().filter(event => event.type === 'compaction/prune').length
  await invoke('working_directory', { cd: second }, regular)
  await run('首次升级后在另一目录读取普通旧回收', regular)
  assert.equal(requests.length, 8)
  const upgradedRead = requests.at(-1).messages.find(message => message.role === 'tool' && message.toolCallId === 'archive-read-native')
  assert.equal(textOf(upgradedRead), absoluteText)
  assert.match(textOf(await invoke('read', { file_path: textOf(upgradedRead).match(/原文文件：([^\n]+)/)[1], limit: 12 }, regular)), /普通工具原文证据/)
  assert.deepEqual(regular.session.eventAt(fullRead.seq), fullReadSnapshot)
  assert.equal(upgradedRead.id, oldRead.data.message.id)
  assert.equal(regular.session.ownEvents().filter(event => event.type === 'compaction/prune').length, ordinaryPrunes)
  const ordinarySeq = regular.session.seq
  assert.equal(await 回收已读结果(ctx, regular.session), 0)
  assert.equal(regular.session.seq, ordinarySeq)
})

for (const toolName of ['bash', 'call_tool']) test(`真实会话回收 ${toolName}：先读一次、保留错误与思考、历史可重放`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'blueprint-reclaim-'))
  const session = sessionAt(root), ctx = new Context()
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  const assistant = (step, content) => session.append('assistant/message', { turn: 1, step, stream: [], message: createMessage({ role: 'assistant', content, source: { kind: 'model', provider: 'test', model: 'test' } }) }, { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const args = toolName === 'call_tool' ? JSON.stringify({ name: 'bash', arguments: {} }) : '{}'
  assistant(1, [{ type: 'tool-call', id: 'lookup', name: toolName, arguments: args }])
  session.append('tool/call', { turn: 1, step: 1, callId: 'lookup', name: toolName, arguments: args })
  const full = 'diagnostic evidence\n'.repeat(3000)
  const original = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'lookup', content: [{ type: 'text', text: full }], isError: true }) }, { surfaceOp: 'append' })
  try {
    assert.equal(await 回收已读结果(ctx, session), 0)
    session.append('step/end', { turn: 1, step: 1 })
    session.append('step/start', { turn: 1, step: 2 })
    const thought = assistant(2, [{ type: 'reasoning', text: 'reasoning remains untouched' }, { type: 'text', text: 'Evidence recorded.' }])
    assert.equal(await 回收已读结果(ctx, session), 1)
    const replacement = session.snapshotEvents().at(-1)
    assert.equal(工具结果Of(replacement).isError, true)
    assert.equal(工具结果Of(replacement).toolCallId, 'lookup')
    assert.equal(工具结果Of(session.eventAt(original.seq)).content[0].text, full)
    const path = 工具结果Of(replacement).content[0].text.match(/原文文件：([^\n]+)/)[1]
    assert.equal(isAbsolute(path), true, '回收入口不随 Session 当前目录变化')
    assert.equal(await readFile(path, 'utf8'), full)
    assert.equal(工具结果Of(replacement).role, original.data.message.role)
    assert.equal(工具结果Of(replacement).id, original.data.message.id)
    assert.deepEqual(工具结果Of(replacement).source, original.data.message.source)
    assert.ok(session.surface.nodes.includes(thought.seq))
    const replay = Session.create(session.id, session.snapshotEvents(), session.header)
    assert.deepEqual(replay.deriveMessages(), session.deriveMessages())
    assert.equal(await 回收已读结果(ctx, replay), 0)
    const relativePath = relative(root, path)
    const oldText = 工具结果Of(replacement).content[0].text.replace(path, relativePath)
    const legacy = session.append('tool/result', { ...replacement.data,
      message: { ...replacement.data.message, content: [{ type: 'text', text: oldText }] } }, {
      surfaceOp: { op: 'replace', startSeq: replacement.seq, endSeq: replacement.seq }, sourceEventSeqs: [replacement.seq],
    })
    const pruneCount = session.ownEvents().filter(event => event.type === 'compaction/prune').length
    assert.equal(legacy.data.meta, undefined, '旧普通工具回收未存 archive metadata')
    assert.equal(await 回收已读结果(ctx, session), 1, '首次升级立即核实本会话固定格式入口')
    const upgraded = session.ownEvents().at(-1)
    assert.equal(工具结果Of(upgraded).content[0].text, 工具结果Of(replacement).content[0].text)
    assert.equal(工具结果Of(upgraded).id, original.data.message.id)
    assert.equal(工具结果Of(upgraded).toolCallId, 'lookup')
    assert.equal(工具结果Of(upgraded).isError, true)
    assert.equal(工具结果Of(session.eventAt(legacy.seq)).content[0].text, oldText)
    assert.equal(session.ownEvents().filter(event => event.type === 'compaction/prune').length, pruneCount)
    const fixedSeq = session.seq
    assert.equal(await 回收已读结果(ctx, session), 0)
    assert.equal(session.seq, fixedSeq)
    let active = upgraded
    const foreign = await 存证据({ id: 'foreign-archive', header: { cwd: root } }, full)
    for (const unknown of [oldText.replace(`${full.length} 字符`, `${full.length + 1} 字符`), oldText.replace(relativePath, foreign.path)]) {
      active = session.append('tool/result', { ...active.data,
        message: { ...active.data.message, content: [{ type: 'text', text: unknown }] } }, {
        surfaceOp: { op: 'replace', startSeq: active.seq, endSeq: active.seq }, sourceEventSeqs: [active.seq],
      })
      const before = session.seq
      assert.equal(await 回收已读结果(ctx, session), 0)
      assert.equal(session.seq, before, '长度不实或别的会话目录不能被当作当前归档入口')
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

/** 往会话里一步步追加模型调用和工具结果；文字Of 取某个结果眼前（surface 上）的文字。 */
function 记步骤(session, requestHeader) {
  let step = 0
  const 一步 = calls => {
    step++
    session.append('step/start', { turn: 1, step })
    if (step === 1 && requestHeader) session.append('request/header', { header: requestHeader, reason: 'initial' })
    session.append('assistant/message', { turn: 1, step, stream: [], message: createMessage({ role: 'assistant',
      content: calls.length ? calls.map(([id, name, args]) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) }))
        : [{ type: 'text', text: '看过了。' }], source: { kind: 'model', provider: 'test', model: 'test' } }) }, { surfaceOp: 'append' })
    const results = {}
    for (const [id, name, args, text] of calls) {
      session.append('tool/call', { turn: 1, step, callId: id, name, arguments: JSON.stringify(args) })
      results[id] = session.append('tool/result', { turn: 1, step, message: createToolResultMessage({ callId: id,
        content: [{ type: 'text', text: text ?? '已完成' }], isError: false }) }, { surfaceOp: 'append' })
    }
    session.append('step/end', { turn: 1, step })
    return results
  }
  const 文字Of = event => 工具结果Of(session.eventAt(session.surface.nodes.find(seq => 工具结果Of(session.eventAt(seq))?.toolCallId === event.data.message.toolCallId))).content[0].text
  session.append('turn/start', { turn: 1 })
  return { 一步, 文字Of }
}

const 请求头 = model => ({ config: { provider: 'fixture', model } })

function 自动回收夹具(contextWindows = new Map(), options) {
  const meterContext = new Context()
  new SessionProjectionRegistry(meterContext)
  const meter = new TokenMeter(meterContext)
  const resolved = []
  const llm = { async resolveModelInfo(provider, model) {
    resolved.push({ provider, model })
    const contextWindow = contextWindows.get(model)
    return { provider, id: model, name: model, ...(contextWindow === undefined ? {} : { context: { contextWindow } }) }
  } }
  let preStep
  const ctx = {
    tools: { register() {} },
    get: name => name === 'tokenMeter' ? meter : undefined,
    llm,
    on(event, listener) { if (event === 'agent/pre-step') preStep = listener },
  }
  装资料(ctx, options)
  return {
    ctx, meter, resolved,
    enter: session => preStep({ agent: { session }, messages: [], turn: 1, step: session.seq,
      signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] })),
  }
}

test('自动回收在低压力或模型容量未知时保留前缀，并在低压力下修复安全的旧入口', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blueprint-auto-reclaim-low-'))
  const windows = new Map(), fixture = 自动回收夹具(windows)
  const full = 'low pressure evidence\n'.repeat(300)
  try {
    const low = sessionAt(root), { 一步, 文字Of } = 记步骤(low, 请求头('low'))
    const original = 一步([['low-read', 'read', {}, full]])
    一步([])
    const before = structuredClone(low.deriveMessages()), beforeSeq = low.seq
    windows.set('low', Math.ceil(fixture.meter.measure(low, low.requestHeader()).totalTokens * 2))
    await fixture.enter(low)
    assert.equal(low.seq, beforeSeq)
    assert.deepEqual(low.deriveMessages(), before, '低压力请求保留原生消息前缀')
    assert.equal(文字Of(original['low-read']), full)
    assert.equal(low.ownEvents().filter(event => event.type === 'compaction/prune').length, 0)
    assert.deepEqual(fixture.resolved.at(-1), { provider: 'fixture', model: 'low' }, '用持久 request/header 解析准确路由')

    const unknown = sessionAt(root), unknownSteps = 记步骤(unknown, 请求头('unknown'))
    const unknownResult = unknownSteps.一步([['unknown-read', 'read', {}, full]])
    unknownSteps.一步([])
    const unknownBefore = structuredClone(unknown.deriveMessages()), unknownSeq = unknown.seq
    await fixture.enter(unknown)
    assert.equal(unknown.seq, unknownSeq)
    assert.deepEqual(unknown.deriveMessages(), unknownBefore)
    assert.equal(unknownSteps.文字Of(unknownResult['unknown-read']), full)
    assert.equal(unknown.ownEvents().filter(event => event.type === 'compaction/prune').length, 0)
    assert.deepEqual(fixture.resolved.at(-1), { provider: 'fixture', model: 'unknown' })

    assert.equal(await 回收已读结果(fixture.ctx, low), 1, '显式调用仍强制回收')
    const reclaimed = low.ownEvents().findLast(event => event.type === 'tool/result')
    const reclaimedText = 工具结果Of(reclaimed).content[0].text
    const absolutePath = reclaimedText.match(/原文文件：([^\n]+)/)[1]
    const legacyText = reclaimedText.replace(absolutePath, relative(root, absolutePath))
    const legacy = low.append('tool/result', { ...reclaimed.data,
      message: { ...reclaimed.data.message, content: [{ type: 'text', text: legacyText }] } }, {
      surfaceOp: { op: 'replace', startSeq: reclaimed.seq, endSeq: reclaimed.seq }, sourceEventSeqs: [reclaimed.seq],
    })
    const pruneCount = low.ownEvents().filter(event => event.type === 'compaction/prune').length
    await fixture.enter(low)
    const upgraded = low.ownEvents().findLast(event => event.type === 'tool/result')
    assert.ok(upgraded.seq > legacy.seq)
    assert.ok(工具结果Of(upgraded).content[0].text.includes(`原文文件：${absolutePath}`))
    assert.equal(low.ownEvents().filter(event => event.type === 'compaction/prune').length, pruneCount, '旧入口修复不 prune')
    const repairedSeq = low.seq
    await fixture.enter(low)
    assert.equal(low.seq, repairedSeq, '已修复入口不重复改写')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('高压力时批量回收，压力未回落到迟滞水位前不逐步改写', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blueprint-auto-reclaim-high-'))
  const windows = new Map(), fixture = 自动回收夹具(windows)
  const full = name => `${name}\n` + 'evidence line for archival\n'.repeat(220)
  try {
    const held = sessionAt(root), heldSteps = 记步骤(held, 请求头('held'))
    held.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'irreducible context '.repeat(8000) }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const heldResults = heldSteps.一步([['held-a', 'read', {}, full('held a')], ['held-b', 'read', {}, full('held b')]])
    heldSteps.一步([])
    const pressure = fixture.meter.measure(held, held.requestHeader()).totalTokens
    windows.set('held', Math.ceil(pressure / 0.8))
    await fixture.enter(held)
    assert.equal(held.ownEvents().filter(event => event.type === 'compaction/prune').length, 2, '同一次高压进入批量回收两条结果')
    assert.match(heldSteps.文字Of(heldResults['held-a']), /^已读长工具结果已回收/)
    assert.match(heldSteps.文字Of(heldResults['held-b']), /^已读长工具结果已回收/)
    const afterBatch = fixture.meter.measure(held, held.requestHeader()).totalTokens
    assert.ok(afterBatch > windows.get('held') * 0.65, '上下文仍高于迟滞重启水位')
    const heldNext = heldSteps.一步([['held-next', 'read', {}, full('held next')]])
    heldSteps.一步([])
    assert.ok(fixture.meter.measure(held, held.requestHeader()).totalTokens > windows.get('held') * 0.75)
    const heldSeq = held.seq
    await fixture.enter(held)
    assert.equal(held.seq, heldSeq, '压力持续高于触发线时等待迟滞，避免逐步改写')
    assert.equal(held.ownEvents().filter(event => event.type === 'compaction/prune').length, 2)
    assert.equal(heldSteps.文字Of(heldNext['held-next']), full('held next'))
    assert.deepEqual(fixture.resolved.at(-1), { provider: 'fixture', model: 'held' })

    const rearm = sessionAt(root), rearmSteps = 记步骤(rearm, 请求头('rearm'))
    const first = rearmSteps.一步([['rearm-first', 'read', {}, full('rearm first')]])
    rearmSteps.一步([])
    const firstPressure = fixture.meter.measure(rearm, rearm.requestHeader()).totalTokens
    windows.set('rearm', Math.ceil(firstPressure / 0.8))
    await fixture.enter(rearm)
    assert.equal(rearm.ownEvents().filter(event => event.type === 'compaction/prune').length, 1)
    assert.ok(fixture.meter.measure(rearm, rearm.requestHeader()).totalTokens <= windows.get('rearm') * 0.65, '回落到迟滞水位后可以重新武装')
    const second = rearmSteps.一步([['rearm-second', 'read', {}, full('rearm second')]])
    rearmSteps.一步([])
    assert.ok(fixture.meter.measure(rearm, rearm.requestHeader()).totalTokens > windows.get('rearm') * 0.75)
    await fixture.enter(rearm)
    assert.equal(rearm.ownEvents().filter(event => event.type === 'compaction/prune').length, 2)
    assert.match(rearmSteps.文字Of(first['rearm-first']), /^已读长工具结果已回收/)
    assert.match(rearmSteps.文字Of(second['rearm-second']), /^已读长工具结果已回收/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('装资料校验压力与迟滞比例', () => {
  const ctx = { tools: { register() {} }, on() {} }
  for (const options of [{ 压力比例: 0 }, { 压力比例: 1 }, { 压力比例: Number.NaN }, { 迟滞比例: 0 }, { 迟滞比例: 0.8 }]) {
    assert.throws(() => 装资料(ctx, options), RangeError)
  }
})

test('本会话改过的文件、回收过又来读的那几行，read 原文留着不回收；往后翻的照常回收，留下的之后也不回收', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blueprint-reclaim-editing-'))
  const session = sessionAt(root), ctx = new Context()
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  const 正在改 = join(root, '层.js'), 新写 = join(root, '新.js'), 只看 = join(root, '参考.js')
  const full = name => `// ${name}\n` + 'const layer = 1\n'.repeat(400)
  const { 一步, 文字Of } = 记步骤(session)
  try {
    // 先读两个文件；下一步经 call_tool 改了其中一个，另写一个新文件。
    const 读 = 一步([['read-edit', 'read', { file_path: 正在改 }, full('层')], ['read-ref', 'read', { file_path: 只看 }, full('参考')]])
    一步([['edit-1', 'call_tool', { name: 'edit', arguments: { file_path: 正在改, old_string: 'const layer = 1', new_string: 'const layer = 2' } }],
      ['write-1', 'write', { file_path: 新写, content: 'x' }]])
    assert.equal(await 回收已读结果(ctx, session), 1, '只回收没改过的参考文件')
    assert.equal(文字Of(读['read-edit']), full('层'))
    assert.match(文字Of(读['read-ref']), /^已读长工具结果已回收/)
    // 相对路径按会话目录解析；读写过的新文件同样留下。参考文件被收走的那几行又来读，整段或其中一段都留下；
    // 往后翻到没读过的行（不写 limit 的 read 读到第 2000 行）照常回收。
    const 再读 = 一步([['read-rel', 'read', { file_path: '层.js', offset: 1, limit: 200 }, full('层·相对')],
      ['read-new', 'read', { file_path: 新写 }, full('新')], ['read-ref-2', 'read', { file_path: 只看 }, full('参考·再读')],
      ['read-ref-part', 'read', { file_path: 只看, offset: 200, limit: 200 }, full('参考·其中一段')],
      ['read-ref-next', 'read', { file_path: 只看, offset: 2001, limit: 200 }, full('参考·往后翻')]])
    一步([])
    assert.equal(await 回收已读结果(ctx, session), 1)
    assert.equal(文字Of(再读['read-rel']), full('层·相对'))
    assert.equal(文字Of(再读['read-new']), full('新'))
    assert.equal(文字Of(再读['read-ref-2']), full('参考·再读'))
    assert.equal(文字Of(再读['read-ref-part']), full('参考·其中一段'))
    assert.match(文字Of(再读['read-ref-next']), /^已读长工具结果已回收/)
    // 显式写 offset 1、不写 limit 和什么都不写是同一段。
    const 第三次 = 一步([['read-ref-3', 'read', { file_path: 只看, offset: 1 }, full('参考·第三次')]])
    一步([])
    assert.equal(await 回收已读结果(ctx, session), 0)
    assert.equal(文字Of(第三次['read-ref-3']), full('参考·第三次'))
    // 留下的结果之后多跑几次也不回收，不会在深处换内容打断缓存。
    一步([])
    const before = session.seq
    assert.equal(await 回收已读结果(ctx, session), 0)
    assert.equal(session.seq, before)
    const replay = Session.create(session.id, session.snapshotEvents(), session.header)
    assert.deepEqual(replay.deriveMessages(), session.deriveMessages())
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('bash 里单纯读文件的 cat、sed -n、head 和 read 一样算：回收过又来读的、改过的留下；混了运行程序、盯日志末尾、解不开路径的照常回收', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blueprint-reclaim-bash-'))
  const session = sessionAt(root), ctx = new Context()
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  const 引擎 = join(root, '管线', '引擎.py'), 出图 = join(root, '管线', '出图.py')
  const full = name => `# ${name}\n` + 'def 方块(): pass\n'.repeat(400)
  const { 一步, 文字Of } = 记步骤(session)
  try {
    // 玄道 10-25：read 整份引擎被收走，模型改用 sed 一段段再读。
    const 首读 = 一步([['read-engine', 'read', { file_path: 引擎 }, full('引擎')],
      ['write-out', 'write', { file_path: 出图, content: 'x' }]])
    一步([])
    assert.equal(await 回收已读结果(ctx, session), 1)
    assert.match(文字Of(首读['read-engine']), /^已读长工具结果已回收/)
    const 再读 = 一步([
      ['sed-cd', 'bash', { command: "cd 管线 && sed -n '139,300p' 引擎.py", description: '读' }, full('引擎·sed')],
      ['cat-quoted', 'bash', { command: 'cat "管线/引擎.py" 2>/dev/null' }, full('引擎·cat')],
      ['head-workdir', 'bash', { command: 'head -n 50 引擎.py', workdir: '管线' }, full('引擎·head')],
      ['echo-sep', 'bash', { command: "sed -n '1,10p' 管线/引擎.py && echo ---- && sed -n '20,30p' 管线/引擎.py" }, full('引擎·两段')],
      ['cat-edited', 'bash', { command: `cat ${出图}` }, full('出图')],
      ['piped-head', 'bash', { command: 'wc -l 管线/引擎.py; cat 管线/引擎.py | head -n 80' }, full('引擎·前 80 行')],
      ['loop', 'bash', { command: 'cd 管线; for f in 引擎.py 色板.css; do echo "## $f"; cat "$f"; done' }, full('引擎·循环')],
      ['mixed', 'bash', { command: "sed -n '1,50p' 管线/引擎.py; python3 管线/引擎.py" }, full('引擎·混了运行')],
      ['piped-run', 'bash', { command: 'cat 管线/引擎.py | python3 -' }, full('引擎·管道给程序')],
      ['tail-log', 'bash', { command: 'tail -n 50 管线/引擎.py' }, full('引擎·末尾')],
      ['var-path', 'bash', { command: 'cat "$TMPDIR/引擎.py"' }, full('临时副本')],
      ['other-file', 'bash', { command: 'cat 管线/像素化.py' }, full('像素化')]])
    一步([])
    assert.equal(await 回收已读结果(ctx, session), 5)
    for (const [id, name] of [['sed-cd', '引擎·sed'], ['cat-quoted', '引擎·cat'], ['head-workdir', '引擎·head'], ['echo-sep', '引擎·两段'],
      ['cat-edited', '出图'], ['piped-head', '引擎·前 80 行'], ['loop', '引擎·循环']]) {
      assert.equal(文字Of(再读[id]), full(name), id)
    }
    for (const id of ['mixed', 'piped-run', 'tail-log', 'var-path', 'other-file']) assert.match(文字Of(再读[id]), /^已读长工具结果已回收/, id)
    // bash 收走的范围反过来也算：read 和经 call_tool 的 bash 再读像素化.py 都留下。
    const 第三次 = 一步([['read-pixel', 'read', { file_path: '管线/像素化.py', offset: 10, limit: 20 }, full('像素化·read')],
      ['call-sed', 'call_tool', { name: 'bash', arguments: { command: "sed -n '5,9p' 管线/像素化.py" } }, full('像素化·call_tool')]])
    一步([])
    assert.equal(await 回收已读结果(ctx, session), 0)
    assert.equal(文字Of(第三次['read-pixel']), full('像素化·read'))
    assert.equal(文字Of(第三次['call-sed']), full('像素化·call_tool'))
    const replay = Session.create(session.id, session.snapshotEvents(), session.header)
    assert.deepEqual(replay.deriveMessages(), session.deriveMessages())
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('归档路径不能借软链接写到其他项目', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blueprint-source-symlink-'))
  const other = await mkdtemp(join(tmpdir(), 'blueprint-other-'))
  try {
    await symlink(other, join(root, '.blueprint-evidence'))
    await assert.rejects(存证据(sessionAt(root), 'private evidence'), /PROJECT_ISOLATION/)
  } finally { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }) }
})

test('网页目录只为新正文追加；重复抓取与 raw-html 不追加，并发会话不丢行', async t => {
  const root = await mkdtemp(join(tmpdir(), 'blueprint-网页目录核对-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const session = sessionAt(root), source = { url: 'https://example.org/manual', truncated: true }
  const saved = await 存证据(session, '网页正文', source)
  await 存证据(session, '网页正文', source)
  await 存证据(session, '<html>原始网页</html>', { ...source, format: 'raw-html' })
  const index = join(root, '.blueprint-evidence/网页目录.md')
  let text = await readFile(index, 'utf8')
  assert.equal(text.split('\n').filter(line => line.startsWith('- ')).length, 1)
  assert.match(text, /^# 网页目录（机器追加，只读）\n/)
  assert.ok(text.includes(`https://example.org/manual → \`${saved.path}\`（4 字，已截断）`))
  const urls = Array.from({ length: 24 }, (_, i) => `https://example.org/source-${i}`)
  await Promise.all(urls.map((url, i) => 存证据({ id: `网页会话-${i}`, header: { cwd: root } }, '并发取得正文', { url })))
  text = await readFile(index, 'utf8')
  assert.equal(text.split('\n').filter(line => line.startsWith('- ')).length, 25)
  for (const url of urls) assert.ok(text.includes(`${url} → `))
  assert.equal(text.split('# 网页目录').length - 1, 1)
})

test('两个会话同时创建网页目录时，标题与正文行完整保留', async t => {
  const root = await mkdtemp(join(tmpdir(), 'blueprint-网页目录并发创建-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await Promise.all(['甲', '乙'].map(id => 存证据({ id, header: { cwd: root } }, `网页正文${id}`, { url: `https://example.org/${id}` })))
  const text = await readFile(join(root, '.blueprint-evidence/网页目录.md'), 'utf8')
  assert.match(text, /^# 网页目录（机器追加，只读）\n- /)
  assert.equal(text.trim().split('\n').length, 3)
})
