// 固定官方 Goal/driver，只有模型是离线脚本；验证 Blueprint 接缝，不重测原生全部内部实现。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { 当前持续目标, 装持续工作, 复查持续工作, 操作持续目标, 等待阶段转换, 停用持续工作 } from '../../blueprint/packages/node/src/持续工作.js'
import { 递自动输入, 叫醒 } from '../../blueprint/packages/node/src/会话.js'
import { 装纸条等待 } from '../../blueprint/packages/node/src/纸条等待.js'
import { 装会话事实 } from '../../blueprint/packages/node/src/会话事实.js'
import { 落新名册, 改名册, 记会话, 读名册, 行Of, 写工作文档, 新工作文档, 改纸条, 新纸条, 加行 } from '../../blueprint/packages/roster/src/index.js'
import { 装思考开头, 思考开头来路 } from '../../blueprint/packages/node/src/思考开头.js'
import { 重建原文 } from '../../blueprint/packages/node/src/上下文重建.js'
import { 一段, 只回一段字 } from '../../blueprint/packages/prompt/src/index.js'
import { fixtureProjectRoot as 项目路径 } from './project-fixture-root.mjs'
import { 持续目标操作, 停用会话持续目标 } from '../../blueprint/packages/studio/src/持续目标.js'

const require = createRequire(new URL('../package.json', import.meta.url))
const names = ['cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent',
  'dsh-agent-loop', 'dsh-typert-registry', 'dsh-goal', 'dsh-goal-round-driver', 'dsh-tool-goal']
const sdk = Object.fromEntries(await Promise.all(names.map(async name => [name, await import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href)])))
const wait = async predicate => {
  const end = Date.now() + 5000
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail('Goal 接缝未在预期时间内收束')
}
const ref = goal => ({ id: goal.id, revision: goal.revision })
async function fixture(t) {
  const root = await mkdtemp(join(项目路径, '原生持续目标核对-')), ctx = new sdk.cordis.Context(), requests = []
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-typert-registry']) await ctx.plugin(sdk[name].default)
  await ctx.plugin(sdk['dsh-agent-loop'].default, { agents: [] })
  await ctx.plugin(sdk['dsh-goal'].default)
  await ctx.plugin(sdk['dsh-goal-round-driver'])
  await ctx.plugin(sdk['dsh-tool-goal'])
  let response
  class Offline extends sdk['dsh-llm'].LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      if (options.messages.some(message => message.source?.kind === 'plugin:blueprint-selector')) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'execute' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      requests.push(options)
      const blocks = response && await response(options)
      if (blocks) {
        for (const [index, block] of blocks.entries()) {
          yield { type: 'block-start', index, blockType: block.type }
          yield { type: 'block-end', index, block }
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '离线目标核对' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['goal-fixture'], new Offline())
  const handle = await ctx.agents.create({ sessionId: sdk['dsh-session'].SessionId('native-goal-' + root.split('/').at(-1)), meta: { cwd: root }, agentOptions: { provider: 'goal-fixture', model: 'offline' } })
  const agent = handle.agent
  await 落新名册(root, '持续目标核对', '完成核对')
  await 改名册(root, m => 记会话(m, '0', String(agent.id)))
  装会话事实(ctx); 装纸条等待(ctx); 装持续工作(ctx)
  return { ctx, agent, handle, root, requests, respond: fn => { response = fn }, operation: args => 操作持续目标(ctx, agent, args) }
}

// 新业务输入带完整情境，Goal 自行续轮只插阶段页；用户对既有节点说话只接回话页。
test('新业务输入接职责原文，Goal 续轮不重复上下文；中途输入和技能结果原样保留，清除后只回话', async t => {
  const f = await fixture(t), gate = Promise.withResolvers()
  t.after(() => gate.resolve())
  const row = 行Of(await 读名册(f.root), '0'), responsibility = '职责原文：核对 {{字面标记}} 与文件入口。'
  await 写工作文档(f.root, row, 新工作文档(row, '完成核对', { responsibility }))
  await 改名册(f.root, m => {
    const { 名册: next } = 加行(m, '0', { kind: 'worker', name: '来信源' })
    return { ...next, rows: next.rows.map(row => row.id === '1' ? { ...row, status: '完成' } : row) }
  })
  await 改纸条(f.root, notes => 新纸条(notes, { from: '1', to: '0', text: '待处理来信的 {{字面原文}}' }))
  装思考开头(f.ctx)
  f.ctx.tools.register({ name: 'skill', description: '离线技能页', parameters: { type: 'object', properties: { name: { type: 'string' } } },
    output: 只回一段字, execute: async () => {
      await 写工作文档(f.root, row, 新工作文档(row, '完成核对', { responsibility: '最新职责：保留 {{新的字面标记}}。' }))
      return { 文: '技能页原文' }
    } })
  f.respond(async () => {
    if (f.requests.length !== 1) return
    await gate.promise
    return [{ type: 'tool-call', id: sdk['dsh-llm'].ToolCallId('goal-opening-skill'), name: 'skill', arguments: JSON.stringify({ name: 'orient' }) }]
  })
  f.agent.inject(sdk['dsh-llm'].createUserMessage({ source: { kind: 'plugin:blueprint-node' }, content: [{ type: 'text', text: '开始核对职责和来信' }] }))
  await f.operation({ action: 'create', objective: '核对 Goal 情境', maxGoalRounds: 2 })
  await wait(() => f.requests.length === 1)
  // Goal 第一轮正在跑：叫醒话原样排进 inbox，不在投递时插页。
  await 叫醒(f.ctx, f.root, '0', '本次变化的业务原文', { inputId: 'goal-context-business-input' })
  const pending = f.agent.inbox.nextStep.find(message => message.id === 'goal-context-business-input')
  assert.deepEqual(pending.content, [{ type: 'text', text: '本次变化的业务原文' }])
  const fixed = 一段('重置/开头', { 职责: '', 等你的: '', 你等的: '' }).split('\n\n').slice(1, -1).join('\n\n')
  const rebuilt = (await 重建原文(f.ctx, f.agent)).map(block => block.text || '').join('\n')
  assert.ok(rebuilt.includes(fixed), '文档重建照常带开头（不再由系统提示接管）')
  gate.resolve()
  await wait(() => f.agent.status === 'idle' && 当前持续目标(f.ctx, f.agent).blockedReason?.code === 'round-limit')
  assert.equal(f.requests.length, 3, 'Goal 第一轮两步（技能结果之后一步）＋第二轮一步')
  assert.equal(当前持续目标(f.ctx, f.agent).roundsStarted, 2)
  const openings = request => request.messages.filter(message => message.source?.kind === `plugin:${思考开头来路}`)
  const added = (request, previous) => { const seen = new Set(previous.messages.map(m => m.id)); return request.messages.filter(m => !seen.has(m.id)) }
  for (const request of f.requests) assert.ok(!request.messages.some(message => message.role === 'system'
    && message.content.some(block => block.text?.includes(fixed))), '系统提示里不再有持续工作判断')
  // 第一轮第一步：Goal 那一轮的提示后面接一份开头，职责与来信原文里的花括号原样保留。
  const fullOpenings = request => openings(request).filter(message => message.content.some(block => block.text?.includes(fixed)))
  const [first] = fullOpenings(f.requests[0])
  assert.ok(first, 'Goal 第一轮第一步接开头')
  assert.match(JSON.stringify(first), /职责原文：核对 \{\{字面标记\}\}/)
  assert.match(JSON.stringify(first), /待处理来信的 \{\{字面原文\}\}/)
  assert.ok(f.requests[0].messages.some(message => message.source?.kind === 'goal' && message.source.round === 1))
  // 第一轮第二步：中途到的叫醒话（和叫醒时顺带送的那张来信）原样进来，不再插第二份开头；它们记进中途，给下一次选择机。
  const middle = added(f.requests[1], f.requests[0])
  assert.equal(middle.filter(message => JSON.stringify(message.content).includes('本次变化的业务原文')).length, 1)
  assert.equal(middle.filter(message => JSON.stringify(message.content).includes('待处理来信的 {{字面原文}}')).length, 1)
  assert.deepEqual(openings({ messages: middle }), [])
  // 第二轮没有新输入：仅阶段页，不重复职责、纸条、组织情境。
  const second = added(f.requests[2], f.requests[1])
  assert.ok(second.some(message => message.source?.kind === 'goal' && message.source.round === 2))
  assert.equal(openings({ messages: second }).length, 1, '续轮仅插阶段页')
  assert.deepEqual(fullOpenings({ messages: second }), [])
  assert.equal(fullOpenings(f.requests[2]).length, 1, '历史里的完整情境仍可复用')
  assert.ok(!JSON.stringify(second).includes('最新职责：保留'), '未发生新业务输入时不重复刷新职责')
  assert.equal((await 读名册(f.root)).rows[0].selector?.pending, undefined, '中途记下的事在第二轮过选择机时清掉')
  const skill = f.agent.session.ownEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'goal-opening-skill')
  assert.deepEqual(skill.data.message.content, [{ type: 'text', text: '技能页原文' }])
  // 清除 Goal 后用户再说话：只接回话页；不替用户重建 Goal，答完就停。
  await f.operation({ action: 'clear', ref: ref(当前持续目标(f.ctx, f.agent)) })
  assert.equal(当前持续目标(f.ctx, f.agent), undefined)
  const 清除前请求 = f.requests.length
  f.agent.followup(sdk['dsh-llm'].createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '清除目标后的用户输入' }] }))
  await wait(() => f.requests.length > 清除前请求 && f.agent.status === 'idle')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(f.requests.length, 清除前请求 + 1, '没有重建 Goal，答完不再开轮')
  const afterClear = added(f.requests.at(-1), f.requests.at(-2))
  assert.ok(afterClear.some(message => JSON.stringify(message.content).includes('清除目标后的用户输入')))
  assert.equal(openings({ messages: afterClear }).length, 1)
  assert.match(openings({ messages: afterClear })[0].content[0].text, /【环节：reply】/)
  assert.deepEqual(fullOpenings({ messages: afterClear }), [])
  assert.equal(当前持续目标(f.ctx, f.agent), undefined, '用户清除过的 Goal 不重建')
})

test('官方 Goal 自动轮次、原生上限和按需工具，自动输入不另开一轮', async t => {
  const f = await fixture(t)
  const goal = await f.operation({ action: 'create', objective: '完成离线核对', maxGoalRounds: 2 })
  递自动输入(f.ctx, f.agent, sdk['dsh-llm'].createUserMessage({ source: { kind: 'plugin:blueprint-node' }, content: [{ type: 'text', text: '阶段依据已经到达' }] }))
  await wait(() => 当前持续目标(f.ctx, f.agent).phase === 'blocked')
  const ended = 当前持续目标(f.ctx, f.agent)
  assert.equal(ended.blockedReason.code, 'round-limit'); assert.equal(ended.roundsStarted, 2)
  assert.equal(f.requests.length, 2)
  assert.ok(f.requests.some(request => JSON.stringify(request.messages).includes('阶段依据已经到达')))
  assert.ok(['get_goal', 'create_goal', 'update_goal'].every(name => f.ctx.tools.schemas(f.agent).some(row => row.name === name)))
  assert.ok(f.agent.session.ownEvents().some(event => event.type === 'goal/change'))
  assert.equal(goal.id, ended.id)
})

test('阶段转换占住原生驱动，释放后只由 Goal 继续', async t => {
  const f = await fixture(t)
  f.ctx.goals.create(f.agent, { objective: '阶段核对', maxGoalRounds: 1 })
  const release = 等待阶段转换(f.ctx, f.agent)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.requests.length, 0)
  assert.equal(当前持续目标(f.ctx, f.agent).blockedReason.code, 'blueprint-wait')
  递自动输入(f.ctx, f.agent, sdk['dsh-llm'].createUserMessage({ source: { kind: 'plugin:blueprint-node' }, content: [{ type: 'text', text: '已经重建的差异判断原文' }] }))
  await release()
  await wait(() => f.requests.length >= 1 && f.agent.status === 'idle')
  // 叫醒自己先开一轮，Goal 等它开了轮才放开，之后才接着转；不再由 Goal 那一轮把叫醒捎进去（9a2ed78）。
  assert.match(JSON.stringify(f.requests[0].messages), /已经重建的差异判断原文/)
  assert.ok(!f.requests[0].messages.some(m => m.source?.kind === 'goal'), '叫醒那一轮不是 Goal 开的')
})

test('业务等待不消费模型轮次，不误记 prompt-rejected；条件解除精确恢复', async t => {
  const f = await fixture(t)
  await 改名册(f.root, m => ({ ...m, rows: m.rows.map(row => row.id === '0' ? { ...row, wait: { id: 'goal-wait', reason: '等待用户说明', mode: 'all', conditions: [{ type: 'input' }], inputIds: [], resolved: false } } : row) }))
  await f.operation({ action: 'create', objective: '收到依据后继续', maxGoalRounds: 1 })
  await wait(() => 当前持续目标(f.ctx, f.agent).phase === 'blocked')
  assert.equal(当前持续目标(f.ctx, f.agent).blockedReason.code, 'blueprint-wait')
  assert.equal(f.requests.length, 0)
  assert.equal(当前持续目标(f.ctx, f.agent).roundsStarted, 0)
  await 改名册(f.root, m => ({ ...m, rows: m.rows.map(({ wait, ...row }) => row) }))
  递自动输入(f.ctx, f.agent, sdk['dsh-llm'].createUserMessage({ source: { kind: 'plugin:blueprint-node' }, content: [{ type: 'text', text: '等待解除的原文' }] }))
  await wait(() => f.requests.length === 1 && f.agent.status === 'idle')
  assert.match(JSON.stringify(f.requests[0].messages), /等待解除的原文/)
})

test('延迟目标变更只复查等待，解除原文投递前不抢先恢复', async t => {
  const f = await fixture(t)
  await 改名册(f.root, m => ({ ...m, rows: m.rows.map(row => ({ ...row,
    wait: { id: 'late-event-wait', reason: '等待原文', mode: 'all', conditions: [{ type: 'input' }], inputIds: [], resolved: false } })) }))
  await f.operation({ action: 'create', objective: '原文到达后继续', maxGoalRounds: 1 })
  await 改名册(f.root, m => ({ ...m, rows: m.rows.map(({ wait, ...row }) => row) }))
  f.ctx.emit('goal/changed', { agent: f.agent, change: { operation: 'create' } })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.requests.length, 0)
  assert.equal(当前持续目标(f.ctx, f.agent).blockedReason.code, 'blueprint-wait')
  递自动输入(f.ctx, f.agent, sdk['dsh-llm'].createUserMessage({ source: { kind: 'plugin:blueprint-node' }, content: [{ type: 'text', text: '延迟事件之后的解除原文' }] }))
  await wait(() => f.requests.length === 1 && f.agent.status === 'idle')
  assert.match(JSON.stringify(f.requests[0].messages), /延迟事件之后的解除原文/)
})

// 暂停的 Goal 不算「在转」：机器输入走普通叫醒（会话没有被用户按停就照样跑这一轮），但不恢复 Goal、不开 Goal 轮。
// 用户按停（取消本轮）挡住机器输入见后面「用户停止挡住…」。
// 进程里没人持有的 blueprint-wait 复查时认领（重启后接着转，见「冷恢复认领…」），只认领，不靠这次复查放开。
test('人工暂停、旧 revision 不被自动输入恢复；暂停时机器输入按普通叫醒只跑这一轮；没人持有的业务等待复查只认领不放开', async t => {
  const f = await fixture(t)
  const initial = f.ctx.goals.create(f.agent, { objective: '暂停核对', maxGoalRounds: 1 })
  const paused = f.ctx.goals.pause(f.agent, ref(initial))
  递自动输入(f.ctx, f.agent, sdk['dsh-llm'].createUserMessage({ source: { kind: 'plugin:blueprint-node' }, content: [{ type: 'text', text: '晚到通知' }] }))
  await assert.rejects(f.operation({ action: 'resume', ref: ref(initial) }))
  await wait(() => f.requests.length === 1 && f.agent.status === 'idle')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.requests.length, 1, '普通叫醒只跑这一轮')
  assert.match(JSON.stringify(f.requests[0].messages), /晚到通知/)
  assert.ok(!f.requests[0].messages.some(message => message.source?.kind === 'goal' && message.source.round > 0), '不是 Goal 开的轮')
  assert.equal(当前持续目标(f.ctx, f.agent).phase, 'paused'); assert.equal(当前持续目标(f.ctx, f.agent).roundsStarted, 0)
  f.ctx.goals.resume(f.agent, ref(paused))
  const external = f.ctx.goals.block(f.agent, ref(当前持续目标(f.ctx, f.agent)), { code: 'blueprint-wait', message: '原进程留下的等待' })
  await 复查持续工作(f.ctx, f.agent)
  assert.equal(当前持续目标(f.ctx, f.agent).revision, external.revision)
  assert.equal(f.requests.length, 1)
})

test('正式责任收束停用 Goal，不伪造目标完成；显式人工恢复沿原生 CAS', async t => {
  const f = await fixture(t)
  const created = f.ctx.goals.create(f.agent, { objective: '收束核对', maxGoalRounds: 1 })
  停用持续工作(f.ctx, [f.agent])
  assert.equal(当前持续目标(f.ctx, f.agent).phase, 'active')
  assert.equal(当前持续目标(f.ctx, f.agent).activation, 'disarmed')
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(f.requests.length, 0)
  await f.operation({ action: 'resume', ref: ref(created) })
  await wait(() => f.requests.length === 1 && f.agent.status === 'idle')
})

test('Studio 在 native lookup 前拒绝跨项目和辅助会话，合法查询沿原生目标', async t => {
  const f = await fixture(t), lookups = []
  const api = { get: name => name === 'sessionController' ? { list: async () => ({ items: [
    { sessionId: String(f.agent.id), cwd: f.root }, { sessionId: 'other', cwd: '/other-project' },
    { sessionId: 'helper', parentSessionId: String(f.agent.id), origin: 'subagent' },
  ] }) } : name === 'typert' ? { lookups: new Map([['agent', { resolve: async id => { lookups.push(id); return f.agent } }]]) } : f.ctx.get(name), root: f.ctx, sessions: f.ctx.sessions }
  const signal = new AbortController().signal, payload = { projectSessionId: String(f.agent.id), sessionId: 'other', action: 'get' }
  await assert.rejects(持续目标操作(api, payload, signal), { code: 'project/scope-invalid' })
  await assert.rejects(持续目标操作(api, { ...payload, sessionId: 'helper' }, signal), /正式节点/)
  assert.deepEqual(lookups, [])
  assert.equal(await 持续目标操作(api, { ...payload, sessionId: String(f.agent.id) }, signal), null)
  assert.equal(f.requests.length, 0)
})

test('用户停止挡住未领取的 Goal 与忙时通知；明确恢复后才消费原文', async t => {
  const f = await fixture(t), gate = Promise.withResolvers()
  f.respond(async () => { if (f.requests.length === 1) await gate.promise })
  const created = await f.operation({ action: 'create', objective: '停止恢复核对', maxGoalRounds: 2 })
  await wait(() => f.requests.length === 1)
  停用会话持续目标(f.ctx, f.agent.id)
  f.agent.cancel({ kind: 'user' })
  递自动输入(f.ctx, f.agent, sdk['dsh-llm'].createUserMessage({ source: { kind: 'plugin:blueprint-node' }, content: [{ type: 'text', text: '停止期间收到的依据' }] }))
  gate.resolve()
  await f.agent.whenIdle()
  await 复查持续工作(f.ctx, f.agent)
  assert.equal(f.requests.length, 1)
  assert.equal(当前持续目标(f.ctx, f.agent).activation, 'disarmed')
  await f.operation({ action: 'resume', ref: ref(created) })
  await wait(() => f.requests.length === 2 && f.agent.status === 'idle')
  assert.match(JSON.stringify(f.requests[1].messages), /停止期间收到的依据/)
  assert.equal(当前持续目标(f.ctx, f.agent).blockedReason.code, 'round-limit')
})

test('冷恢复保留目标与原生 Inbox，旧进程的业务恢复权不继承', async t => {
  const f = await fixture(t)
  const created = f.ctx.goals.create(f.agent, { objective: '冷恢复核对', maxGoalRounds: 1 })
  停用持续工作(f.ctx, [f.agent])
  递自动输入(f.ctx, f.agent, sdk['dsh-llm'].createUserMessage({ source: { kind: 'plugin:blueprint-node' }, content: [{ type: 'text', text: '冷恢复前待处理依据' }] }))
  const seed = f.agent.session.ownEvents(), id = f.agent.id
  await f.handle.dispose()
  const replacement = (await f.ctx.agents.create({ sessionId: id, seed, meta: { cwd: f.root }, agentOptions: { provider: 'goal-fixture', model: 'offline' } })).agent
  await 复查持续工作(f.ctx, replacement)
  assert.equal(f.requests.length, 0)
  assert.equal(当前持续目标(f.ctx, replacement).activation, 'disarmed')
  assert.equal(replacement.inbox.nextStep.length, 1)
  await 操作持续目标(f.ctx, replacement, { action: 'resume', ref: ref(created) })
  await wait(() => f.requests.length === 1 && replacement.status === 'idle')
  assert.match(JSON.stringify(f.requests[0].messages), /冷恢复前待处理依据/)
})

// 10-15-1 的 2 号：被业务等待挡着时 dsh 重启，等的孩子交齐后只按普通叫醒跑了一轮，next 之后再没人开轮。
// blueprint-wait 只由 Blueprint 写下，新进程复查时认领：卡点没清照样挡着，清了以后叫醒放开 Goal、并进它那一轮。
test('冷恢复认领 blueprint-wait：卡点没清照样挡着，清了叫醒放开 Goal、并进 Goal 那一轮', async t => {
  const f = await fixture(t)
  await 改名册(f.root, m => ({ ...m, rows: m.rows.map(row => row.id === '0' ? { ...row, wait: { id: 'cold-wait', reason: '等待孩子交回', mode: 'all', conditions: [{ type: 'input' }], inputIds: [], resolved: false } } : row) }))
  await f.operation({ action: 'create', objective: '重启后接着转', maxGoalRounds: 2 })
  await wait(() => 当前持续目标(f.ctx, f.agent).phase === 'blocked')
  const blocked = 当前持续目标(f.ctx, f.agent)
  assert.equal(blocked.blockedReason.code, 'blueprint-wait')
  const seed = f.agent.session.ownEvents(), id = f.agent.id
  await f.handle.dispose()
  const replacement = (await f.ctx.agents.create({ sessionId: id, seed, meta: { cwd: f.root }, agentOptions: { provider: 'goal-fixture', model: 'offline' } })).agent
  await 复查持续工作(f.ctx, replacement, { 恢复: true })
  assert.equal(当前持续目标(f.ctx, replacement).revision, blocked.revision, '卡点还在：认领了也照样挡着')
  assert.equal(f.requests.length, 0)
  await 改名册(f.root, m => ({ ...m, rows: m.rows.map(({ wait, ...row }) => row) }))
  递自动输入(f.ctx, replacement, sdk['dsh-llm'].createUserMessage({ source: { kind: 'plugin:blueprint-node' }, content: [{ type: 'text', text: '孩子都交回了' }] }))
  await wait(() => 当前持续目标(f.ctx, replacement).blockedReason?.code === 'round-limit' && replacement.status === 'idle')
  assert.equal(当前持续目标(f.ctx, replacement).roundsStarted, 2, 'Goal 放开后自己接着开轮')
  assert.match(JSON.stringify(f.requests[0].messages), /孩子都交回了/)
  assert.ok(f.requests[0].messages.some(message => message.source?.kind === 'goal' && message.source.round > 0), '叫醒并进 Goal 那一轮，不是普通补启')
})

test('查看冷目标只读官方 projection，不恢复 Agent；取消仍释放 observation', async t => {
  const f = await fixture(t), ac = new AbortController()
  let released = 0
  const projection = { goal: { id: 'cold-goal', revision: 3, objective: '冷目标', phase: 'paused', maxGoalRounds: 4 }, roundsStarted: 2, createdAt: 10, updatedAt: 20 }
  const api = { root: { get: () => ({ get: () => undefined }) }, get: name => ({
    sessionController: { list: async () => ({ items: [{ sessionId: f.agent.id, cwd: f.root }] }) }, goals: f.ctx.goals,
    typert: { lookups: new Map([['agent', { resolve() { assert.fail('查看不能恢复 Agent') } }]]) },
    sessionQuery: { observeSession: async () => ({ projections: { values: { goal: projection } }, [Symbol.dispose]() { released++ } }) },
  })[name] }
  const payload = { projectSessionId: f.agent.id, sessionId: f.agent.id, action: 'get' }
  assert.deepEqual(await 持续目标操作(api, payload, ac.signal), { ...projection.goal, roundsStarted: 2, createdAt: 10, updatedAt: 20, activation: 'disarmed' })
  const get = api.get
  api.get = name => name === 'sessionQuery' ? { observeSession: async () => { ac.abort(); return { [Symbol.dispose]() { released++ } } } } : get(name)
  await assert.rejects(持续目标操作(api, payload, ac.signal), { name: 'AbortError' })
  assert.equal(released, 2); assert.equal(f.requests.length, 0)
})

test('正式节点拒绝 update_goal complete，要求 finish 正式交回且不伪造完成', async t => {
  const f = await fixture(t)
  f.respond(() => {
    if (f.requests.length !== 1) return
    const goal = 当前持续目标(f.ctx, f.agent)
    return [{ type: 'tool-call', id: sdk['dsh-llm'].ToolCallId('complete-native-goal'), name: 'update_goal',
      arguments: JSON.stringify({ goal_id: goal.id, revision: goal.revision, action: 'complete' }) }]
  })
  await f.operation({ action: 'create', objective: '自主收尾核对', maxGoalRounds: 2 })
  await wait(() => 当前持续目标(f.ctx, f.agent).blockedReason?.code === 'round-limit' && f.agent.status === 'idle')
  assert.equal(当前持续目标(f.ctx, f.agent).roundsStarted, 2)
  assert.equal(f.requests.length, 3, '拒绝完成后仍可继续执行，直到原生轮数上限')
  const result = f.agent.session.ownEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'complete-native-goal')
  assert.equal(result.data.message.isError, true)
  assert.match(JSON.stringify(result.data.message), /finish/)
  assert.ok(!JSON.stringify(f.requests).includes('goal_complete'))
  const roster = await (await import('../../blueprint/packages/roster/src/index.js')).读名册(f.root)
  assert.equal(roster.rows[0].status, '开工', 'Goal complete 不能伪造正式交回')
})
