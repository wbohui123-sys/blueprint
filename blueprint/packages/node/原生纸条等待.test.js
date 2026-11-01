import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import GoalService from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { 只回一段字, 一段 } from '../prompt/src/index.js'
import { 项目路径 } from '../prompt/src/路径.js'
import {
  落新名册, 改名册, 加团队, 记会话, 读名册, 行Of, 写工作文档, 新工作文档, 读节点文档, 读纸条, 结束节点,
} from '../roster/src/index.js'
import { 装纸条, 传纸条, 回条, 送未送纸条 } from './src/纸条.js'
import { 装纸条等待, 停下等回条, 在等回条 } from './src/纸条等待.js'
import { 装通用工具 } from './src/通用工具.js'
import { 装条件等待, 发布成果, 登记等待, 复查项目等待, 运行卡点 } from './src/条件等待.js'
import { 装收尾续工 } from './src/index.js'
import { 装节点文档 } from './src/节点文档.js'
import { 装工具 } from './src/工具.js'
import { 装项目隔离 } from './src/项目隔离.js'
import { 离线已定稿行 } from './测试会话.js'
import { 检查行动预测 } from './src/预测.js'
import { 工具结果Of } from '../context/src/消息协议.js'
import { 递自动输入, 停止后台 } from './src/会话.js'
import { 装持续工作, 开持续目标, 当前持续目标 } from './src/持续工作.js'
import { 写问答 } from '../roster/src/问答.js'

const 输入 = (text, source = { kind: 'user' }) => createUserMessage({ content: [{ type: 'text', text }], source })
const 文字 = messages => messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
const 工具调用 = (id, name, args) => ({ id: ToolCallId(id), name, arguments: JSON.stringify(args), type: 'tool-call' })

/** 只提供固定输出，所有调度、工具执行和 inbox 都由真实 dsh runtime 完成。 */
class 等待核对模型 extends LlmAdapter {
  constructor() { super(); this.requests = []; this.coordinator = null; this.steps = []; this.stepsBySession = new Map() }
  async resolveModel(provider, model) { return { provider, id: model, name: model, contextWindow: 1000000 } }
  async *stream(request) {
    this.requests.push(request)
    const queue = this.stepsBySession.get(request.sessionId) || (request.sessionId === this.coordinator ? this.steps : [])
    // 带 when 的步骤只在请求内容对上时才用；对不上按普通收尾答、留给后面的请求，核对不依赖中间多一步还是少一步。
    const step = queue?.[0] && (!queue[0].when || queue[0].when(request)) ? queue.shift() : undefined
    await step?.before?.(request)
    if (step?.calls) {
      for (const [index, block] of step.calls.entries()) {
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'block-end', index, block }
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: step?.text || '固定模型本轮结束。' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function 搭原生等待(t, { jobs = false, goals = false, autoResume = false, predictionGuard = false, scopedWait = false } = {}) {
  const 根 = await mkdtemp(join(predictionGuard ? 项目路径 : tmpdir(), 'Blueprint 原生纸条等待回归-'))
  const ctx = new Context()
  t.after(async () => {
    await 复查项目等待(ctx, 根)
    await ctx.fiber.dispose()
    await 复查项目等待(ctx, 根)
    await rm(根, { recursive: true, force: true })
  })
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) await ctx.plugin(plugin)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (goals) { await ctx.plugin(GoalService); await ctx.plugin(GoalRoundDriver) }
  if (jobs) { await ctx.plugin(JobsLocal); await ctx.plugin(ToolJobs) }
  if (autoResume) { await ctx.plugin(LocalFileSystem, { cwd: 根 }); 装节点文档(ctx); 装工具(ctx); 装收尾续工(ctx) }
  if (predictionGuard) await ctx.plugin(Subprocess)
  const model = new 等待核对模型()
  ctx.llm.registerAdapter(['native-note-wait-fixture'], model)
  ctx.provide('blueprintToolCatalog', { list: agent => ctx.tools.schemas(agent) })
  let waitOwner = null
  if (!scopedWait) 装纸条等待(ctx)
  装纸条(ctx); 装通用工具(ctx); 装条件等待(ctx)
  if (goals) 装持续工作(ctx)
  if (predictionGuard) 装项目隔离(ctx, { 检查预测: 检查行动预测 })
  await 落新名册(根, '原生纸条等待回归', '取得其他节点的实际证据后再继续。')
  await 改名册(根, async 名册 => {
    for (const name of ['事实核验', '效果核验', '独立协调']) {
      名册 = 加团队(名册, '0', { name, task: name, goal: '交回实际证据', intent: `取得${name}的实际证据。` }).名册
    }
    for (const row of 名册.rows) await 写工作文档(根, row, 新工作文档(row, row.id === '0' ? '取得实际证据后再继续。' : row.name))
    return 名册
  })
  const agents = new Map()
  for (const [id, name] of [['0', 'coordinator'], ['1', 'fact-checker'], ['2', 'effect-checker'], ['3', 'independent-coordinator']]) {
    const { agent } = await ctx.agents.create({ sessionId: `native-note-wait-${name}`,
      agentOptions: { provider: 'native-note-wait-fixture', model: 'fixture' }, meta: { cwd: 根 } })
    agents.set(id, agent)
    await 改名册(根, 名册 => 记会话(名册, id, agent.session.id))
  }
  const agent = agents.get('0')
  if (scopedWait) waitOwner = await agent.ctx.plugin(function waitingScope(childCtx) { 装纸条等待(childCtx) })
  model.coordinator = agent.session.id
  const failures = []
  ctx.on('agent/error', ({ error }) => { failures.push(error) })
  const rootRequests = () => model.requests.filter(request => request.sessionId === agent.session.id)
  const settle = async () => { for (const current of agents.values()) await current.whenIdle() }
  return { 根, ctx, agent, agents, model, rootRequests, settle, failures, waitOwner }
}

/** turn/end 的宿主恢复在原生 whenIdle 之外；等最终状态，避免只测驱动器刚停下的瞬间。 */
async function 等到续工结束(f, expectedRequests, timeoutMs = 1000) {
  await new Promise((resolve, reject) => {
    const disposers = []
    const finish = error => {
      clearTimeout(timer)
      for (const dispose of disposers) dispose()
      if (error) reject(error)
      else resolve()
    }
    const check = () => {
      if (f.failures.length) return finish(f.failures[0])
      if (f.rootRequests().length >= expectedRequests && f.agent.status === 'idle') finish()
    }
    const timer = setTimeout(() => finish(new Error(`等待原生续工超时：模型请求 ${f.rootRequests().length}，状态 ${f.agent.status}，pending ${f.agent.inbox.nextStep.length}`)), timeoutMs)
    disposers.push(f.ctx.on('agent/status', ({ agent }) => { if (agent === f.agent) check() }))
    disposers.push(f.ctx.on('agent/error', check))
    check()
  })
  await f.settle()
}

/** 轮询到条件成立且所有节点停稳；超时如实报出模型请求数，不留悬着的 promise。 */
async function 等到(f, 条件, timeoutMs = 3000) {
  const 截止 = Date.now() + timeoutMs
  while (true) {
    if (f.failures.length) throw f.failures[0]
    if (await 条件() && [...f.agents.values()].every(agent => agent.status === 'idle')) break
    if (Date.now() > 截止) throw new Error(`等待超时：模型请求 ${f.model.requests.length}，0 号状态 ${f.agent.status}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await f.settle()
}
const 排空 = (f, ...agents) => () => f.model.steps.length === 0 && agents.every(agent => !f.model.stepsBySession.get(agent.session.id)?.length)
const 出现次数 = (text, part) => text.split(part).length - 1
/** Goal 自己开的一轮（goal-round-driver 用 followup 排进来的那种）：它不算新事，等回条时照旧被拒（选 18）。 */
const Goal轮 = (round = 1) => createUserMessage({ content: [{ type: 'text', text: `<goal_round>\n继续持续目标。Round: ${round}\n</goal_round>` }],
  source: { kind: 'goal', goalId: 'goal-native-note-wait', revision: 1, round } })
const 在等的 = async f => 在等回条(await 读纸条(f.根), '0', await 读名册(f.根), f.agent.session, f.ctx).map(n => n.id)

// 选 18：互相求助不算死锁。等回条时新求助照样叫醒收信人，它可以先回；自己卡住的那件活，等对应回条到了再接着做。
test('两个真实节点互相求助：反向求助照样落盘，等回条的一方醒来先回，对应回条到了才接着原来的活', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t, { autoResume: true, predictionGuard: true }), child = f.agents.get('1')
  await 改名册(f.根, async m => ({ ...m, rows: await Promise.all(m.rows.map(async row => 离线已定稿行(row, await 读节点文档(f.根, row)))) }))
  const childRequests = () => f.model.requests.filter(r => r.sessionId === child.session.id)
  const 原请求回条 = '已取得核验录像，尚缺你的独立判断；原核验结论未达标。'
  f.model.steps.push(
    { calls: [工具调用('明确核验调查', 'call_tool', { name: 'node_doc', arguments: { inquiry: {
      purpose: '取得录像的实际核验结论', expectation: '取得已有录像及具体缺口，供独立判断' } } })] },
    { calls: [工具调用('索取实际证据', 'call_tool', { name: 'note', arguments: { to: '1', text: '请交回核验录像与实际结论。' } })] },
    { when: request => 文字(request.messages).includes('请先独立判断录像。'), before: async request => {
      assert.match(文字(request.messages), /求助 N2，来自 [^\n]*（要回）：请先独立判断录像。/)
      assert.ok(!文字(request.messages).includes(原请求回条), '先被反向求助叫醒，原请求的回条还没到')
      assert.equal((await 读纸条(f.根)).find(n => n.id === 'N1').status, 'open')
    }, calls: [工具调用('先回反向求助', 'call_tool', { name: 'note', arguments: { reply: 'N2', text: '独立判断：机制可识别，首次按键理由仍缺视觉依据。' } })] },
    { when: request => 文字(request.messages).includes(原请求回条), text: '收到原请求的回条，接着核验后续。' },
  )
  f.model.stepsBySession.set(child.session.id, [
    { before: request => assert.match(文字(request.messages), /求助 N1，来自 [^\n]*（要回）：请交回核验录像与实际结论。/),
      calls: [工具调用('明确录像调查', 'call_tool', { name: 'node_doc', arguments: { inquiry: {
        purpose: '整理已有录像与所缺判断', expectation: '明确录像结论及需要根节点独立判断的缺口' } } })] },
    { calls: [工具调用('反向求助', 'call_tool', { name: 'note', arguments: { to: '0', text: '请先独立判断录像。' } })] },
    { when: request => 文字(request.messages).includes('独立判断：机制可识别'),
      calls: [工具调用('归还原请求', 'call_tool', { name: 'note', arguments: { reply: 'N1', text: 原请求回条 } })] },
    { text: '回了原请求，从核验继续处理具体缺口。' },
  ])
  f.agent.steer(输入('索取本次核验录像与实际结论。'))
  await 等到(f, 排空(f, child), 5000)
  const papers = await 读纸条(f.根)
  assert.deepEqual(papers.map(n => [n.id, n.kind, n.status, n.reply_to]), [
    ['N1', 'ask', 'answered', undefined], ['N2', 'ask', 'answered', undefined], ['N3', 'reply', 'answered', 'N2'], ['N4', 'reply', 'answered', 'N1'],
  ])
  assert.deepEqual(f.failures, [])
  const 子结果 = child.session.ownEvents().filter(event => event.type === 'tool/result').map(工具结果Of)
  assert.ok(子结果.every(result => !result.isError), '反向求助没有被等待环拒绝，子节点的工具都正常执行')
  // 原来的活只在对应回条到了之后接着做：带着原请求回条的模型请求恰好一次，而且是 0 号最后一次。
  const 原活续上 = f.rootRequests().filter(r => 文字(r.messages).includes(原请求回条))
  assert.equal(原活续上.length, 1)
  assert.equal(原活续上[0], f.rootRequests().at(-1))
  assert.equal(出现次数(文字(原活续上[0].messages), 原请求回条), 1, '回条只进模型一次')
  // 子节点发反向求助时自己还欠着 N1：它在等回条，不被欠求助提醒；请求次数看回条来得快慢，这里不卡死。
  assert.ok(childRequests().length >= 4)
  for (const agent of [f.agent, child]) {
    assert.equal(agent.status, 'idle'); assert.deepEqual(agent.inbox.nextStep, [])
  }
  const count = f.model.requests.length
  await 复查项目等待(f.ctx, f.根); await f.settle()
  assert.equal(f.model.requests.length, count, '无变化复查不会再次调用模型')
})

test('真实 loop 普通工具执行后正常收尾，不因未交回而再调用模型', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t, { autoResume: true })
  f.ctx.tools.register({ name: '取得一项事实', description: '离线读取已存在的事实',
    parameters: { type: 'object', properties: {} }, output: 只回一段字,
    execute: () => ({ 文: '这一项事实已经取得' }),
  })
  f.model.steps.push({ calls: [工具调用('取得现有事实', '取得一项事实', {})] }, { text: '本轮正常收尾。' })
  f.agent.steer(输入('读取这一项事实。'))
  await f.settle()
  await new Promise(resolve => setTimeout(resolve, 50))
  await f.settle()
  assert.equal(f.rootRequests().length, 2, '取得事实和本轮收尾之后，没有自动开启另一轮')
  assert.deepEqual(f.failures, [])
})

test('execute 用 next 交阶段报告后只续工做差异判断，普通判断收尾不再自唤醒', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t, { autoResume: true })
  await 改名册(f.根, m => ({ ...m, rows: m.rows.map(r => r.id === '0' ? { ...r, selector: { last: 'execute' } } : r) }))
  f.model.steps.push({ calls: [工具调用('写实际阶段报告', 'next', { handoff: '已有光照与构图证据；角色时机曲线仍缺可靠测量。' })] },
    { calls: [工具调用('记录具体缺口', 'node_doc', { append_record: '后续围绕角色时机曲线缺口判断。' })] },
    { text: '这一圈差异判断结束。' })
  f.agent.steer(输入('记录这一圈已取得的结果，接着做差异判断。'))
  await 等到续工结束(f, 3)
  await new Promise(resolve => setTimeout(resolve, 50))
  await f.settle()
  assert.equal(f.rootRequests().length, 3)
  const facts = 文字(f.rootRequests()[1].messages)
  assert.ok(JSON.stringify(f.rootRequests()[1].messages).includes('已有光照与构图证据'))
  assert.ok(facts.includes(一段('重置/叫醒/阶段报告')))
  const inputs = f.agent.session.ownEvents().filter(e => e.type === 'user/message' && e.data.id.startsWith('blueprint-stage-report:'))
  assert.equal(inputs.length, 1)
  assert.deepEqual(f.failures, [])
})

// 选 18：同一批里刚发了求助，后面的工具不执行；之后有新事（已排队的来信、外部输入）照样叫醒，它可以先处理；
// 对应回条到了才接着原来的活，被略过的工具不补执行，每份输入只进模型一次。
test('真实 loop 中求助停下后，同批后续工具不执行；已排队来信和外部输入照样叫醒，回条到了再接着原来的活', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t), 修改记录 = [], noteResults = []
  f.ctx.tools.register({ name: 'after_note_change', description: '核对等待后的修改是否执行',
    parameters: { type: 'object', additionalProperties: false, properties: {} }, output: 只回一段字,
    execute: () => { 修改记录.push('未经回条就修改'); return { 文: '已经修改' } },
  })
  f.ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.name === 'note') noteResults.push(result)
    return next()
  })
  const 排队来信 = 输入('等待前已排队的无关来信，求助发出后照样要处理。', { kind: 'plugin:native-note-wait-fixture' })
  const 外部来信 = 输入('未回期间的新外部输入，照样叫醒它。')
  const 回条文 = '实际证据：事实核验入口已经跑通。'
  f.model.steps.push({
    before: () => f.agent.inject(排队来信),
    calls: [
      工具调用('request-fact-evidence', 'call_tool', { name: 'note', arguments: { to: '1', text: '请交回事实核验的实际证据。' } }),
      工具调用('nested-change-after-note', 'call_tool', { name: 'after_note_change', arguments: {} }),
      工具调用('direct-change-after-note', 'after_note_change', {}),
    ],
  }, { when: request => 文字(request.messages).includes(排队来信.content[0].text), text: '先看了排队来信，事实证据还没回。' },
  { when: request => 文字(request.messages).includes(外部来信.content[0].text), text: '外部输入已读，自己的活等事实证据。' },
  { when: request => 文字(request.messages).includes(回条文), text: '收到事实核验的实际证据，继续本节点判断。' })
  f.agent.steer(输入('向事实核验节点索取实际证据。'))
  await f.settle()
  assert.deepEqual(f.failures, [])
  assert.equal(f.rootRequests().length, 2, 'note 之后已排队的来信在同一轮下一步照样进模型')
  assert.equal(f.agent.session.ownEvents().some(event => event.type.includes('waiting-for-')), false, '等待不再写扩展运行事件')
  assert.equal(f.agent.session.ownEvents().filter(event => event.type === 'turn/start').length, 1)
  assert.equal(f.agent.session.ownEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
  assert.deepEqual(修改记录, [], '原生调度器同批计划的后续工具没有执行')
  assert.equal(noteResults.length, 1)
  assert.equal(noteResults[0].concludesTurn, true, '真实 note 结果带 concludeTurn，且经 call_tool 传回')
  const 已存纸条 = (await 读纸条(f.根)).find(note => note.from === '0' && note.to === '1')
  assert.deepEqual([已存纸条.kind, 已存纸条.status], ['ask', 'open'])
  assert.deepEqual(await 在等的(f), [已存纸条.id], '处理别的来信不等于回条到了')
  assert.equal(出现次数(文字(f.rootRequests()[1].messages), 排队来信.content[0].text), 1)
  assert.deepEqual(f.agent.inbox.nextStep, [])
  const results = f.agent.session.ownEvents().filter(event => event.type === 'tool/result')
  assert.equal(results.length, 3, '每个已计划调用都有合法结果，回放不缺 call/result 配对')
  assert.notEqual(工具结果Of(results[0]).isError, true, '发出的纸条正常保存')
  for (const event of results.slice(1)) {
    assert.equal(工具结果Of(event).isError, true, '略过的工具如实标为未执行')
    assert.ok(工具结果Of(event).content.some(block => block.type === 'text' && block.text.includes(`等待 ${已存纸条.id} 的回条；本次工具未执行`)))
  }

  f.agent.steer(外部来信)
  await f.settle()
  assert.equal(f.rootRequests().length, 3, '外部 steer 照样叫醒等回条的节点')
  assert.deepEqual(await 在等的(f), [已存纸条.id])

  await 回条(f.ctx, f.根, '1', 已存纸条.id, 回条文)
  await 等到(f, 排空(f))
  assert.equal(f.rootRequests().length, 4, '对应回条到达后接着一次模型请求')
  const 接续文字 = 文字(f.rootRequests().at(-1).messages)
  for (const text of [排队来信.content[0].text, 外部来信.content[0].text, 回条文]) {
    assert.equal(出现次数(接续文字, text), 1, `${text} 只进入模型一次`)
  }
  assert.deepEqual(await 在等的(f), [])
  assert.deepEqual(f.agent.inbox.nextStep, [])
  assert.deepEqual(修改记录, [], '回条不会补执行等待前已经被略过的工具批次')
})

// 选 16：传达不用回、发信人不停下；同一批后面的工具照常执行，本轮接着走。
test('真实 loop 中传达不停下：同批后续工具照常执行、本轮接着走；收信人收到不用回，发信人不在等', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t), child = f.agents.get('1'), 修改记录 = []
  f.ctx.tools.register({ name: 'after_tell_change', description: '核对传达之后的修改是否执行',
    parameters: { type: 'object', additionalProperties: false, properties: {} }, output: 只回一段字,
    execute: () => { 修改记录.push('传达后照常执行'); return { 文: '已经修改' } },
  })
  f.model.steps.push({ calls: [
    工具调用('tell-direction', 'call_tool', { name: 'note', arguments: { to: '1', kind: 'tell', text: '用户改了方向：先做竖版。' } }),
    工具调用('change-after-tell', 'after_tell_change', {}),
  ] }, { text: '传达已送出，接着做本节点的活。' })
  f.model.stepsBySession.set(child.session.id, [{
    before: request => assert.match(文字(request.messages), /传达 N1，来自 [^\n]*（不用回）：用户改了方向：先做竖版。/),
    text: '知道方向变了，不用回。' }])
  f.agent.steer(输入('通知事实核验节点方向变了。'))
  await 等到(f, 排空(f, child))
  assert.deepEqual(修改记录, ['传达后照常执行'])
  assert.equal(f.rootRequests().length, 2, '传达之后本轮接着调用模型')
  assert.equal(f.agent.session.ownEvents().filter(event => event.type === 'turn/start').length, 1, '传达不结束本轮')
  assert.deepEqual((await 读纸条(f.根)).map(n => [n.id, n.kind, n.status]), [['N1', 'tell', 'told']])
  assert.deepEqual(await 在等的(f), [])
  assert.equal(f.model.requests.filter(r => r.sessionId === child.session.id).length, 1)
  assert.deepEqual(f.failures, [])
})

// 选 18：醒来时工具不拦。只拦同一批里刚发求助之后的工具和条件等待；卡住的那件活由 prompt 管。
test('等回条时被新纸条叫醒，醒来的那一步工具照常执行；对应回条到了才接着原来的活', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t), 修改记录 = []
  f.ctx.tools.register({ name: 'record_side_note', description: '醒来后先处理别人的事',
    parameters: { type: 'object', additionalProperties: false, properties: {} }, output: 只回一段字,
    execute: () => { 修改记录.push('醒来后执行'); return { 文: '已记下口径' } },
  })
  const 请求 = await 传纸条(f.ctx, f.根, '0', '1', '等事实证据。')
  await f.settle()
  f.model.steps.push(
    { when: request => 文字(request.messages).includes('请顺手记一笔取证口径。'), calls: [工具调用('醒来先处理', 'record_side_note', {})] },
    { when: request => 文字(request.messages).includes('事实证据交回。'), text: '收到对应回条，接着原来的活。' })
  // 3 也是 0 派出去的、还在做：它的传达压到全部交回再送（选 37），用求助叫醒（选 18）。
  await 传纸条(f.ctx, f.根, '3', '0', '请顺手记一笔取证口径。')
  await 等到(f, () => 修改记录.length === 1)
  assert.deepEqual(修改记录, ['醒来后执行'], '醒来时工具不拦')
  const 结果 = f.agent.session.ownEvents().filter(event => event.type === 'tool/result').map(工具结果Of)
  assert.equal(结果.at(-1).isError, false)
  assert.deepEqual(await 在等的(f), [请求.id], '处理别的事不等于回条到了')
  await 回条(f.ctx, f.根, '1', 请求.id, '事实证据交回。')
  await 等到(f, 排空(f))
  assert.equal(出现次数(文字(f.rootRequests().at(-1).messages), '事实证据交回。'), 1)
  assert.deepEqual(修改记录, ['醒来后执行'])
  assert.deepEqual(await 在等的(f), [])
  assert.deepEqual(f.failures, [])
})

test('真实 loop 有多张未回求助时，外部输入、别的来信、先到的回条都照样叫醒；最后一张回条到了才不再等', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t)
  const 事实请求 = await 传纸条(f.ctx, f.根, '0', '1', '请交回事实核验结果。')
  const 效果请求 = await 传纸条(f.ctx, f.根, '0', '2', '请交回效果核验结果。')
  await f.settle()
  assert.equal(f.rootRequests().length, 0, '发出求助本身不叫醒发信人')
  const 外部输入 = 输入('等待中的外部输入照样交给模型。')
  f.agent.steer(外部输入)
  await f.settle()
  assert.equal(f.rootRequests().length, 1, '外部输入照样叫醒')
  assert.deepEqual(await 在等的(f), [事实请求.id, 效果请求.id])
  const 无关来信 = await 传纸条(f.ctx, f.根, '3', '0', '另有一份求助，要你回。')
  await f.settle()
  assert.equal(f.rootRequests().length, 2, '收到别的求助照样叫醒，它可以先回')
  assert.deepEqual(await 在等的(f), [事实请求.id, 效果请求.id], '别的纸条不代替所等结果')

  await 回条(f.ctx, f.根, '1', 事实请求.id, '事实核验已跑通。')
  await f.settle()
  assert.equal(f.rootRequests().length, 3, '先到的回条当场送到')
  assert.deepEqual(await 在等的(f), [效果请求.id], '只收到部分回条仍在等另一张')
  const 部分回复 = await 读纸条(f.根)
  assert.equal(部分回复.find(note => note.id === 事实请求.id).answer, '事实核验已跑通。')

  await 回条(f.ctx, f.根, '2', 效果请求.id, '效果核验已跑通。')
  await f.settle()
  assert.deepEqual(f.failures, [])
  assert.equal(f.rootRequests().length, 4)
  assert.deepEqual(await 在等的(f), [])
  const 接续文字 = 文字(f.rootRequests().at(-1).messages)
  // 别人的求助原文还会列在每次开头的「要你回的」里，所以按投递那一句数。
  for (const text of [外部输入.content[0].text, `求助 ${无关来信.id}，来自`, '事实核验已跑通。', '效果核验已跑通。']) {
    assert.equal(出现次数(接续文字, text), 1, `${text} 只进入模型一次`)
  }
  const 纸条 = await 读纸条(f.根)
  assert.ok(纸条.filter(note => note.from === '0').every(note => note.status === 'answered'))
  assert.equal(纸条.find(note => note.id === 无关来信.id).status, 'open', '别人的求助没有被等待门禁回答或作废，仍要它回')
  assert.deepEqual(f.agent.inbox.nextStep, [])
  const 行 = 行Of(await 读名册(f.根), '0')
  assert.equal(行.status, '开工', '等待与恢复没有误交回节点责任')
})

test('回条已写项目纸条但尚未进入目标会话时仍算在等；外部 steer 照样叫醒，回条随后只进模型一次', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t)
  const 请求 = await 传纸条(f.ctx, f.根, '0', '1', '取得实际证据后才继续。')
  await f.settle()
  const 投递开始 = Promise.withResolvers(), 放行投递 = Promise.withResolvers(), 醒来要重建 = []
  f.ctx.on('blueprint/node-awake', async ({ id, 重建 }) => {
    if (id !== '0') return
    醒来要重建.push(重建)
    投递开始.resolve()
    await 放行投递.promise
  })
  t.after(() => 放行投递.resolve())
  const 回复中 = 回条(f.ctx, f.根, '1', 请求.id, '已经取得实际证据。')
  await 投递开始.promise
  assert.equal((await 读纸条(f.根)).find(note => note.id === 请求.id).status, 'answered')
  assert.deepEqual(await 在等的(f), [请求.id], 'answer 已落盘仍不等于目标收到回条')
  const 提前来信 = 输入('回条投递间隙的新输入，照样先读。')
  f.agent.steer(提前来信)
  await f.agent.whenIdle()
  assert.equal(f.rootRequests().length, 1, '外部 steer 照样叫醒等回条的节点')
  assert.ok(文字(f.rootRequests()[0].messages).includes(提前来信.content[0].text))
  assert.ok(!文字(f.rootRequests()[0].messages).includes('已经取得实际证据。'), '回条还没进会话')

  放行投递.resolve()
  await 回复中
  await f.settle()
  assert.deepEqual(f.failures, [])
  assert.equal(f.rootRequests().length, 2)
  const 接续文字 = 文字(f.rootRequests()[1].messages)
  assert.equal(出现次数(接续文字, 提前来信.content[0].text), 1)
  assert.equal(出现次数(接续文字, '已经取得实际证据。'), 1)
  assert.deepEqual(await 在等的(f), [])
  assert.deepEqual(f.agent.inbox.nextStep, [])
  assert.deepEqual(醒来要重建, [false], '回条叫醒不重建 context')
})

// 下面四个核对等回条的拒绝收尾。选 18 之后，带新事的一步放行，拒绝只剩没有新输入的一步，
// 这里用 Goal 自己开的一轮触发（goal-round-driver 的 followup），时序窗口与原来相同。
test('Goal 自开一轮在等回条时被拒；最后回条在拒绝的 flush 间隙送达，真实 loop 不得带着回条睡死', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t)
  const 请求 = await 传纸条(f.ctx, f.根, '0', '1', '等事实核验的实际回条再继续。')
  await f.settle()
  const 等待刷盘 = Promise.withResolvers(), 放行刷盘 = Promise.withResolvers()
  const 原刷盘 = f.ctx.sessions.flush.bind(f.ctx.sessions)
  let 已卡住 = false
  f.ctx.sessions.flush = async session => {
    if (session === f.agent.session && !已卡住) {
      已卡住 = true
      等待刷盘.resolve()
      await 放行刷盘.promise
    }
    return 原刷盘(session)
  }
  t.after(() => 放行刷盘.resolve())
  const goal轮 = Goal轮()
  f.agent.followup(goal轮)
  await 等待刷盘.promise
  assert.equal(f.agent.status, 'running')
  assert.equal(f.rootRequests().length, 0)

  await 回条(f.ctx, f.根, '1', 请求.id, '最后回条恰好在等待刷盘中送达。')
  assert.ok(文字(f.agent.inbox.nextStep).includes('最后回条恰好在等待刷盘中送达。'), '回条确实已送进仍在 running 的原生 inbox')
  放行刷盘.resolve()
  await 等到续工结束(f, 1)
  assert.deepEqual(f.failures, [])
  assert.equal(f.rootRequests().length, 1, '拒绝等待步骤前收到最后回条，应继续取得模型判断，不能以 idle 留下无人处理的回条')
  const 接续文字 = 文字(f.rootRequests()[0].messages)
  assert.equal(出现次数(接续文字, '最后回条恰好在等待刷盘中送达。'), 1)
  assert.ok(!接续文字.includes(goal轮.content[0].text), '被拒的 Goal 轮不退回 inbox，由 Goal 自己再排')
  assert.deepEqual(f.agent.inbox.nextStep, [])
})

test('Goal 自开一轮被拒的收尾期间用户按停，已到回条保留但不被临时补启自动续跑', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t)
  const 请求 = await 传纸条(f.ctx, f.根, '0', '1', '等人工判断前所需的实际回条。')
  await f.settle()
  const 刷盘开始 = Promise.withResolvers(), 放行刷盘 = Promise.withResolvers()
  const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
  let intercepted = false
  f.ctx.sessions.flush = async session => {
    if (session === f.agent.session && !intercepted) {
      intercepted = true; 刷盘开始.resolve(); await 放行刷盘.promise
    }
    return flush(session)
  }
  t.after(() => 放行刷盘.resolve())
  f.agent.followup(Goal轮())
  await 刷盘开始.promise
  await 回条(f.ctx, f.根, '1', 请求.id, '已到达但用户要求先停看的回条。')
  f.agent.cancel({ kind: 'user' }, { keepInbox: true })
  放行刷盘.resolve()
  await f.settle()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.rootRequests().length, 0)
  assert.deepEqual(f.agent.session.ownEvents().findLast(event => event.type === 'turn/end').data.reason,
    { kind: 'aborted', reason: { kind: 'user' } })
  assert.ok(文字(f.agent.inbox.nextStep).includes('已到达但用户要求先停看的回条'))
  assert.deepEqual(f.failures, [])
})

test('等待插件 scope 释放后，Goal 轮被拒的收尾不再补启仍存 inbox 的结果', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t, { scopedWait: true })
  const 请求 = await 传纸条(f.ctx, f.根, '0', '1', '所需回条会在等待插件卸载期间到达。')
  await f.settle()
  const 刷盘开始 = Promise.withResolvers(), 放行刷盘 = Promise.withResolvers()
  const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
  let intercepted = false
  f.ctx.sessions.flush = async session => {
    if (session === f.agent.session && !intercepted) {
      intercepted = true; 刷盘开始.resolve(); await 放行刷盘.promise
    }
    return flush(session)
  }
  t.after(() => 放行刷盘.resolve())
  f.agent.followup(Goal轮())
  await 刷盘开始.promise
  await 回条(f.waitOwner.ctx, f.根, '1', 请求.id, 'scope 释放前已耐久送达的实际结果。')
  await f.waitOwner.dispose()
  放行刷盘.resolve()
  await f.settle()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.rootRequests().length, 0)
  assert.ok(文字(f.agent.inbox.nextStep).includes('scope 释放前已耐久送达的实际结果'))
  assert.equal(f.agent.session.ownEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'blocked')
  assert.deepEqual(f.failures, [])
})

test('另一轮已取得驱动后，旧的 Goal 轮拒绝收尾不能补启另一门禁拒绝留下的结果', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t)
  const 请求 = await 传纸条(f.ctx, f.根, '0', '1', '取得这份回条后再由另一个门禁决定执行。')
  await f.settle()
  const 收尾挂起 = Promise.withResolvers(), 放行收尾 = Promise.withResolvers()
  const whenIdle = f.agent.whenIdle.bind(f.agent)
  let held = true
  f.agent.whenIdle = async () => { await whenIdle(); if (held) { 收尾挂起.resolve(); await 放行收尾.promise } }
  t.after(() => 放行收尾.resolve())
  f.ctx.on('agent/pre-step', async ({ agent, messages, turn }, next) => {
    if (agent !== f.agent || turn < 2) return next()
    for (const message of messages) agent.inject(message)
    return { kind: 'reject' }
  })
  f.agent.followup(Goal轮())
  await 收尾挂起.promise
  await 回条(f.ctx, f.根, '1', 请求.id, '另一轮门禁尚未放行的实际结果。')
  await whenIdle()
  assert.equal(f.agent.session.ownEvents().findLast(event => event.type === 'turn/end').data.turn, 2)
  held = false; 放行收尾.resolve()
  await f.settle()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.rootRequests().length, 0)
  assert.equal(f.agent.session.ownEvents().filter(event => event.type === 'turn/start').length, 2)
  assert.ok(文字(f.agent.inbox.nextStep).includes('另一轮门禁尚未放行的实际结果'))
  assert.deepEqual(f.failures, [])
})

// 选 17：一轮正常结束时还欠着求助，机器叫醒它去回；每张求助只提醒一次，之后靠开头列着，由它自己判断。
test('真实 loop 欠求助提醒：一直不回也只提醒一次；不惊动母节点', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t, { autoResume: true }), owed = f.agents.get('1')
  const owedRequests = () => f.model.requests.filter(r => r.sessionId === owed.session.id)
  const 求助 = await 传纸条(f.ctx, f.根, '2', '1', '请给我判断。')
  await 等到(f, async () => owedRequests().length >= 2, 5000)
  await new Promise(resolve => setTimeout(resolve, 150)); await f.settle()
  assert.deepEqual(f.failures, [])
  assert.equal(owedRequests().length, 2, '收到求助一次，停下时提醒一次，之后不再催')
  assert.match(文字(owedRequests()[1].messages), new RegExp(`- ${求助.id} · [^\\n]*：请给我判断。`))
  assert.deepEqual(行Of(await 读名册(f.根), '1').selector.reminded, [求助.id])
  assert.equal((await 读纸条(f.根)).some(n => n.kind === 'tell'), false, '不给母节点发传达')
  assert.equal(f.rootRequests().length, 0)
  assert.equal((await 读纸条(f.根)).find(n => n.id === 求助.id).status, 'open', '提醒不替它回')
})

// 为了回求助先反问别人、停下等回条：照样提醒一次（规矩只有一条，它自己判断），不会每停一次就催。
test('为回求助先反问、停下等回条：只被提醒一次，不空转、不惊动母节点', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t, { autoResume: true }), asker = f.agents.get('1'), helper = f.agents.get('3')
  // 帮手迟迟不回：它的模型挂着，直到核对取完数再放行（也随取消退出），不留悬着的 promise。
  const 放行 = Promise.withResolvers()
  f.model.stepsBySession.set(asker.session.id, [{ calls: [工具调用('反问口径', 'note', { to: '3', text: '要答 2 的求助，我先得知道口径。' })] }])
  f.model.stepsBySession.set(helper.session.id, [{ before: request => Promise.race([放行.promise,
    new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))]), text: '口径还在整理。' }])
  await 传纸条(f.ctx, f.根, '2', '1', '请给我判断。')
  await new Promise(resolve => setTimeout(resolve, 400))
  const 请求数 = f.model.requests.filter(r => r.sessionId === asker.session.id).length
  const 有传达 = (await 读纸条(f.根)).some(n => n.kind === 'tell')
  放行.resolve()
  await f.settle()
  assert.equal(请求数, 2, '反问之后停下被提醒一次，之后不再催')
  assert.equal(有传达, false, '不惊动母节点')
})

// 选 17 要求的「送到、叫醒它去回」：交回了、还欠着求助的节点，运行卡点放它跑这一轮去回。
test('给已交回的节点发求助：真实 loop 里它要能醒来回条，发信人收到回条再接着做', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t, { autoResume: true }), done = f.agents.get('1')
  await 改名册(f.根, m => 结束节点(m, '1', { result: 'achieved', handoff: '结果在 结果.md。' }).名册)
  const 回条文 = '结果在 结果.md，口径见第二节。'
  // 交回了的节点只要能回这一条；回完之后它还跑不跑，由修法决定，这里不要求。
  f.model.stepsBySession.set(done.session.id, [{ calls: [工具调用('回交回后的求助', 'note', { reply: 'N1', text: 回条文 })] }])
  f.model.steps.push({ calls: [工具调用('问已交回的节点', 'note', { to: '1', text: '你的结果在哪？' })] },
    { when: request => 文字(request.messages).includes(回条文), text: '收到回条，接着做。' })
  f.agent.steer(输入('问一下已交回节点的结果。'))
  await 等到(f, 排空(f, done), 1500)
  assert.equal((await 读纸条(f.根)).find(n => n.id === 'N1').status, 'answered')
  assert.ok(f.model.requests.some(r => r.sessionId === done.session.id), '交回了的节点被求助叫醒后调用了模型')
  assert.equal(出现次数(文字(f.rootRequests().at(-1).messages), 回条文), 1, '发信人收到回条后接着做')
})

// 等回条时因新事放进来的那一轮，后面的步骤也放行，它可以先查再回。
test('等回条时被新求助叫醒、要先查再回：醒来后的第二步不该当成没有新输入被拒', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t), 查过 = []
  f.ctx.tools.register({ name: 'look_up_basis', description: '先查一下再回',
    parameters: { type: 'object', additionalProperties: false, properties: {} }, output: 只回一段字,
    execute: () => { 查过.push('查了'); return { 文: '口径在 口径.md' } },
  })
  const 自己的 = await 传纸条(f.ctx, f.根, '0', '1', '等你的证据。')
  await f.settle()
  f.model.steps.push(
    { when: request => 文字(request.messages).includes('请给我取证口径。'), calls: [工具调用('先查', 'look_up_basis', {})] },
    { calls: [工具调用('再回', 'note', { reply: 'N2', text: '查到了：口径在 口径.md。' })] },
    { text: '回完了，自己的活等回条。' })
  await 传纸条(f.ctx, f.根, '3', '0', '请给我取证口径。')
  await 等到(f, async () => (await 读纸条(f.根)).find(n => n.id === 'N2')?.status === 'answered', 1500)
  assert.deepEqual(查过, ['查了'])
  assert.equal((await 读纸条(f.根)).find(n => n.id === 自己的.id).status, 'open', '自己的求助仍在等')
})

test('接管真正运行中的原生 LLM 时以 hook 停下、保留 inbox，收到回条后自动恢复', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t), 模型开始 = Promise.withResolvers()
  f.model.steps.push({
    before: request => {
      模型开始.resolve()
      return new Promise((resolve, reject) => {
        const abort = () => reject(new Error('固定模型响应 hook 取消'))
        if (request.signal.aborted) abort()
        else request.signal.addEventListener('abort', abort, { once: true })
      })
    },
  }, { text: '接管前已经排队的输入和对应回条已收到，继续判断。' })
  f.agent.steer(输入('旧运行已经开始，本次由宿主接管等待。'))
  await 模型开始.promise
  const 排队输入 = 输入('取消当前生成时仍须保留的原生 inbox 输入。')
  f.agent.inject(排队输入)
  const 请求 = await 传纸条(f.ctx, f.根, '0', '1', '当前运行实际还在等这份证据。')
  await f.agents.get('1').whenIdle()
  assert.equal(f.agent.status, 'running')
  const 停下结果 = await 停下等回条(f.ctx, f.agent.session.id)
  assert.deepEqual(停下结果, { stopped: true, waitingForNotes: [请求.id] })
  assert.equal(f.agent.status, 'idle')
  assert.equal(f.rootRequests().length, 1, '取消后没有继续调用模型')
  assert.deepEqual(f.agent.inbox.nextStep.map(message => message.id), [排队输入.id], 'keepInbox 保存已经排队的输入')
  const 结束 = f.agent.session.ownEvents().findLast(event => event.type === 'turn/end')
  assert.equal(结束.data.reason.kind, 'aborted')
  assert.equal(结束.data.reason.reason.kind, 'hook', '接管等待没有写成用户手动停下')
  assert.deepEqual(f.failures, [])

  await 回条(f.ctx, f.根, '1', 请求.id, '接管等待所需的实际证据已交回。')
  await 等到续工结束(f, 2)
  assert.equal(f.rootRequests().length, 2, 'hook 取消不阻止对应回条自动叫醒')
  const 接续文字 = 文字(f.rootRequests()[1].messages)
  for (const text of [排队输入.content[0].text, '接管等待所需的实际证据已交回。']) {
    assert.ok(接续文字.includes(text), text)
    assert.equal(接续文字.split(text).length - 1, 1, '接管后保留的输入与回条只进入模型一次')
  }
  assert.deepEqual(f.agent.inbox.nextStep, [])
  assert.deepEqual(f.failures, [])
})

test('hook 取消尚未退出时最后回条送达，真实 loop 退出后自动继续且输入各保留一次', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t)
  const 模型开始 = Promise.withResolvers(), 取消已到 = Promise.withResolvers(), 允许退出 = Promise.withResolvers()
  t.after(() => 允许退出.resolve())
  f.model.steps.push({
    before: async request => {
      模型开始.resolve()
      await new Promise(resolve => {
        if (request.signal.aborted) resolve()
        else request.signal.addEventListener('abort', resolve, { once: true })
      })
      取消已到.resolve()
      await 允许退出.promise
      throw new Error('固定模型收到 hook 取消后延迟退出')
    },
  }, { text: '取消收尾期间收到的回条已经到齐，继续本节点判断。' })
  f.agent.steer(输入('旧原生模型正在运行，取消收尾期间也须保留回条。'))
  await 模型开始.promise
  const 原排队输入 = 输入('hook 取消收尾前已经排队的原始输入。')
  f.agent.inject(原排队输入)
  const 请求 = await 传纸条(f.ctx, f.根, '0', '1', '旧运行还在等最后这份结果。')
  await f.agents.get('1').whenIdle()
  const 停止中 = 停下等回条(f.ctx, f.agent.session.id)
  await 取消已到.promise
  assert.equal(f.agent.status, 'running', '固定模型刻意保留取消后的 unwind 窗口')
  assert.equal(f.rootRequests().length, 1)
  await 回条(f.ctx, f.根, '1', 请求.id, '最后回条在 hook 取消收尾期间到达。')
  assert.ok(文字([...f.agent.inbox.nextStep, ...f.agent.inbox.nextTurn]).includes('最后回条在 hook 取消收尾期间到达。'))
  assert.equal(f.rootRequests().length, 1, '旧模型退出前没有并行开启下一次请求')

  允许退出.resolve()
  assert.equal((await 停止中).stopped, true)
  await 等到续工结束(f, 2)
  assert.deepEqual(f.failures, [])
  assert.equal(f.rootRequests().length, 2, '最后回条在取消收尾期间到达，退出后自动再开一次模型请求')
  const 接续文字 = 文字(f.rootRequests()[1].messages)
  for (const text of [原排队输入.content[0].text, '最后回条在 hook 取消收尾期间到达。']) {
    assert.ok(接续文字.includes(text), text)
    assert.equal(接续文字.split(text).length - 1, 1, '原排队输入和回条在恢复请求中各出现一次')
  }
  assert.deepEqual(f.agent.inbox.nextStep, [])
  assert.deepEqual(f.agent.inbox.nextTurn, [])
})

for (const [name, cause, resume, question] of [
  ['用户先按停', { kind: 'user' }, false],
  ['hook 接管等待', { kind: 'hook', reason: 'blueprint-note-wait' }, true],
  ['hook 后待人工回答', { kind: 'hook', reason: 'blueprint-note-wait' }, false, true],
]) test(`真实自动投递在${name}尚未退出时收回条，停稳后按原生取消原因与项目门禁判断是否继续`, { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t)
  const 模型开始 = Promise.withResolvers(), 取消已到 = Promise.withResolvers(), 允许退出 = Promise.withResolvers()
  t.after(() => 允许退出.resolve())
  f.model.steps.push({ before: async request => {
    模型开始.resolve()
    await new Promise(resolve => {
      if (request.signal.aborted) resolve()
      else request.signal.addEventListener('abort', resolve, { once: true })
    })
    取消已到.resolve(); await 允许退出.promise
    throw new Error('固定模型保持真实取消收尾窗口')
  } }, { text: '从已到达的回条继续判断。' })
  f.agent.steer(输入('正在处理的本节点任务。'))
  await 模型开始.promise
  f.agent.cancel(cause, { keepInbox: true })
  await 取消已到.promise
  assert.equal(f.agent.status, 'running')
  assert.equal(f.agent.session.ownEvents().some(event => event.type === 'turn/end'), false, '取消意图尚未写成轮尾')
  const 回条 = 输入(`在${name}取消收尾中到达的实际回条。`, { kind: 'plugin:blueprint-node', summary: `blueprint-note:${name}:reply` })
  递自动输入(f.ctx, f.agent, 回条)
  await f.ctx.sessions.flush(f.agent.session)
  if (question) 写问答(f.根, { frame: { session: f.agent.session.id, rpcId: 'late-pending-question',
    questions: [{ id: 'continue-choice', question: '请判断该如何继续。', options: [{ label: '先审阅现有结果' }] }] } })
  assert.equal(f.rootRequests().length, 1, '旧模型尚未退出时没有开启新请求')
  assert.deepEqual(f.agent.inbox.nextStep.map(message => message.id), [回条.id])
  assert.deepEqual(f.agent.inbox.nextTurn, [], '自动结果没有在取消期间锁存下一轮醒来请求')
  允许退出.resolve()
  if (resume) {
    await f.agent.whenIdle()
    assert.doesNotThrow(() => { f.ctx.fiber.assertActive(); f.agent.ctx.fiber.assertActive() })
    assert.deepEqual(await 运行卡点(f.ctx, f.agent.session), [])
    await 等到续工结束(f, 2)
  }
  else { await f.settle(); await new Promise(resolve => setTimeout(resolve, 30)) }
  assert.equal(f.rootRequests().length, resume ? 2 : 1)
  const ended = f.agent.session.ownEvents().filter(event => event.type === 'turn/end')
  assert.deepEqual(ended[0].data.reason, { kind: 'aborted', reason: cause })
  if (resume) {
    assert.equal(f.rootRequests()[1].messages.filter(message => message.id === 回条.id).length, 1)
    assert.deepEqual(f.agent.inbox.nextStep, [])
    await 复查项目等待(f.ctx, f.根); await f.settle()
    assert.equal(f.rootRequests().length, 2, '重复复查不再次补启已经消费的回条')
  } else {
    assert.deepEqual(f.agent.inbox.nextStep.map(message => message.id), [回条.id], '禁止自动续跑时仍保留实际回条')
  }
  assert.deepEqual(f.failures, [])
})

test('真实自动投递在正常忙碌时同批进入下一步，每份结果只消费一次且不另开一轮', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t), 模型开始 = Promise.withResolvers(), 允许结束 = Promise.withResolvers()
  t.after(() => 允许结束.resolve())
  f.model.steps.push({ before: async () => { 模型开始.resolve(); await 允许结束.promise }, text: '第一步正常结束。' },
    { text: '读取同批到达的两份实际结果。' })
  f.agent.steer(输入('正在正常处理的原始任务。'))
  await 模型开始.promise
  const replies = ['事实证据', '效果证据'].map(name => 输入(`${name}在忙碌期间交回。`, { kind: 'plugin:blueprint-node' }))
  for (const message of replies) 递自动输入(f.ctx, f.agent, message)
  await f.ctx.sessions.flush(f.agent.session)
  assert.equal(f.rootRequests().length, 1)
  assert.deepEqual(f.agent.inbox.nextStep.map(message => message.id), replies.map(message => message.id))
  允许结束.resolve()
  await 等到续工结束(f, 2)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.rootRequests().length, 2, '两份自动结果共享下一步，没有重复补启')
  for (const result of replies) assert.equal(f.rootRequests()[1].messages.filter(message => message.id === result.id).length, 1)
  assert.equal(f.agent.session.ownEvents().filter(event => event.type === 'turn/start').length, 1)
  assert.deepEqual(f.agent.inbox.nextStep, [])
  assert.deepEqual(f.failures, [])
})

test('真实 loop 中 wait 停住同批工具与无关输入，指定成果发布后才继续，保持原工作 context', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t), changes = []
  f.ctx.tools.register({ name: 'change_after_wait', description: '核对等待之后的修改',
    parameters: { type: 'object', additionalProperties: false, properties: {} }, output: 只回一段字,
    execute: () => { changes.push('不应发生'); return { 文: '修改已执行' } },
  })
  const queued = 输入('等待前排队的普通通知。', { kind: 'plugin:fixture' })
  f.model.steps.push({ before: () => f.agent.inject(queued), calls: [
    工具调用('wait-evidence', 'call_tool', { name: 'wait', arguments: { phase: '核验', reason: '核验缺实际对标证据', conditions: [{ type: 'result', node: '1', key: '对标证据' }] } }),
    工具调用('change-after-wait', 'change_after_wait', {}),
  ] }, { text: '已有证据，从核验继续。' })
  f.agent.steer(输入('正在核验这一圈的实际结果，等待所需证据。'))
  await f.settle()
  assert.equal(f.rootRequests().length, 1)
  assert.deepEqual(changes, [])
  // 用户说话等着条件也照样放进来（选 23，10-22），这里用别的输入核对它代替不了所需成果。
  f.agent.steer(输入('无关通知也不能代替所需成果。', { kind: 'plugin:fixture' }))
  await f.agent.whenIdle()
  assert.equal(f.rootRequests().length, 1)
  await 发布成果(f.ctx, f.根, '1', { key: '另一项结果', summary: '非所需成果' })
  assert.equal(f.rootRequests().length, 1)
  await 发布成果(f.ctx, f.根, '1', { key: '对标证据', summary: '已跑过的对标证据' })
  await 等到续工结束(f, 2)
  assert.equal(f.rootRequests().length, 2)
  assert.deepEqual(changes, [])
  const resumed = 文字(f.rootRequests()[1].messages)
  for (const text of ['正在核验这一圈的实际结果', '等待前排队的普通通知', '无关通知', '已跑过的对标证据', '从等待前的工作继续判断']) assert.ok(resumed.includes(text), text)
  await 复查项目等待(f.ctx, f.根)
  await f.settle()
  assert.equal(f.rootRequests().length, 2, '重复事件不重复调用模型')
  assert.deepEqual(f.failures, [])
})

test('真实 loop 的正式前置不被普通纸条和外部 steer 绕过', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t), dependent = f.agents.get('1')
  const requests = () => f.model.requests.filter(r => r.sessionId === dependent.session.id)
  // 用合法的平级前置；根等自己孩子会让孩子继承等待自身，原夹具实际是死锁。
  await 改名册(f.根, m => ({ ...m, rows: m.rows.map(r => r.id === '1' ? { ...r, after: ['2'] } : r) }))
  await 传纸条(f.ctx, f.根, '3', '1', '这张普通纸条不能提前启动依赖者。')
  dependent.steer(输入('正式前置未满足时的外部输入。'))
  await f.settle()
  assert.equal(requests().length, 0)
  assert.equal(dependent.status, 'idle')
  await 改名册(f.根, m => 结束节点(m, '2', { result: 'achieved', handoff: '正式前置的实际结果' }).名册)
  await 送未送纸条(f.ctx, f.根, '1')
  await f.settle()
  assert.equal(requests().length, 1)
  assert.ok(文字(requests()[0].messages).includes('正式前置未满足时的外部输入'))
  assert.deepEqual(f.failures, [])
})

test('真实 loop 的交齐启动挡住外部输入，部分交回不放行，全部交回后保留原输入继续', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t)
  await 改名册(f.根, m => ({ ...m, rows: m.rows.map(r => r.id === '0'
    ? { ...r, start: 'children_done', kickoff: { id: '交齐启动原生核对', delivered: false } } : r) }))
  f.agent.steer(输入('下层交齐之前保留的用户说明。'))
  await f.settle()
  assert.equal(f.rootRequests().length, 0)
  for (const id of ['1', '2']) await 改名册(f.根, m => 结束节点(m, id, { result: 'achieved', handoff: `${id} 的正式结果` }).名册)
  f.agent.steer(输入('部分交回仍不能启动。'))
  await f.settle()
  assert.equal(f.rootRequests().length, 0)
  await 改名册(f.根, m => 结束节点(m, '3', { result: 'unmet', handoff: '最后一项未达成，交回实际缺口' }).名册)
  f.agent.steer(输入('下层已交齐，现在承接实际结果。'))
  await f.settle()
  assert.equal(f.rootRequests().length, 1)
  assert.ok(文字(f.rootRequests()[0].messages).includes('下层交齐之前保留的用户说明'))
  assert.deepEqual(f.failures, [])
})

test('条件结果在 reject 尚未退出时到达，原生 idle 后不丢失唤醒', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t)
  await 登记等待(f.ctx, f.根, '0', { phase: '取材评估', reason: '等材料', conditions: [{ type: 'result', node: '1', key: '实际材料' }] }, f.agent)
  let sent = false
  f.ctx.on('agent/pre-step', async (_payload, next) => {
    const result = await next()
    if (result?.kind === 'reject' && !sent) {
      sent = true
      await 发布成果(f.ctx, f.根, '1', { key: '实际材料', summary: '拒绝收尾期间取得的材料' })
    }
    return result
  }, { prepend: true })
  f.agent.steer(输入('等待材料期间先收到的消息。', { kind: 'plugin:fixture' }))
  await 等到续工结束(f, 1)
  assert.equal(f.rootRequests().length, 1)
  assert.ok(文字(f.rootRequests()[0].messages).includes('拒绝收尾期间取得的材料'))
  assert.deepEqual(f.failures, [])
})

test('真实原生作业终态事件解除多作业等待；第一个通知和无关消息不能提前调用模型', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t, { jobs: true }), outcomes = [Promise.withResolvers(), Promise.withResolvers()]
  const owner = f.ctx.jobs.events ? f.agent.session.id : f.agent
  const ids = outcomes.map((outcome, index) => f.ctx.jobs.start({ kind: 'bash', owner, label: `证据作业 ${index + 1}`,
    run: () => ({ cancel: () => outcome.resolve({ status: 'killed' }), done: outcome.promise }),
  }))
  f.model.steps.push({ calls: [工具调用('wait-native-jobs', 'wait', { phase: '执行', reason: '等两个证据作业结束', conditions: ids.map(id => ({ type: 'job', id })) })] }, { text: '两个作业都已结束，判断各自实际结果。' })
  f.agent.steer(输入('执行中等原生作业。'))
  await f.settle()
  assert.equal(f.rootRequests().length, 1)
  outcomes[0].resolve({ status: 'completed', output: '第一份证据' })
  await f.ctx.jobs.wait(ids[0], 1000, owner)
  await 复查项目等待(f.ctx, f.根)
  await f.settle()
  assert.equal(f.rootRequests().length, 1)
  outcomes[1].resolve({ status: 'failed', detail: '实测失败', output: '失败证据' })
  await 等到续工结束(f, 2)
  assert.equal(f.rootRequests().length, 2)
  assert.ok(文字(f.rootRequests()[1].messages).includes('实测失败'))
  assert.deepEqual(f.failures, [])
})

test('真实原生登记册：交回时停得到节点自己的后台作业', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t, { jobs: true }), outcome = Promise.withResolvers()
  const id = f.ctx.jobs.start({ kind: 'bash', owner: f.agent.session.id, label: '节点自己的后台命令',
    run: () => ({ cancel: () => outcome.resolve({ status: 'killed' }), done: outcome.promise }),
  })
  await 停止后台(f.ctx, [f.agent])
  assert.equal(f.ctx.jobs.get(id, f.agent.session.id).status, 'killed')
})

test('真实 loop 等下一条用户输入，旧消息与插件通知不释放，用户输入后续工一次', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t)
  f.model.steps.push({ calls: [工具调用('wait-user-choice', 'wait', { phase: '粗略估计', reason: '等用户方向判断', conditions: [{ type: 'input' }] })] }, { text: '按用户新方向继续。' })
  f.agent.steer(输入('已经收到的原始意图。'))
  await f.settle()
  assert.equal(f.rootRequests().length, 1)
  f.agent.steer(输入('插件通知不能当作用户判断。', { kind: 'plugin', plugin: 'fixture' }))
  await f.agent.whenIdle()
  assert.equal(f.rootRequests().length, 1)
  f.agent.steer(输入('用户现在给出的新方向。'))
  await 等到续工结束(f, 2)
  assert.equal(f.rootRequests().length, 2)
  assert.ok(文字(f.rootRequests()[1].messages).includes('用户现在给出的新方向'))
  assert.deepEqual(f.failures, [])
})

/** 真实 wait 工具挂起 Goal，保留 input 等待；后续由原生 inbox 和调度处理纸条。 */
async function 搭Goal输入等待(t, id = '1') {
  const f = await 搭原生等待(t, { goals: true }), agent = f.agents.get(id)
  const steps = [{ calls: [工具调用('wait-input', 'wait', { reason: '等用户提供执行条件', conditions: [{ type: 'input' }] })] }]
  f.model.stepsBySession.set(agent.session.id, steps)
  const row = 行Of(await 读名册(f.根), id)
  agent.steer(输入('先核对执行条件，缺少时登记等待。'))
  开持续目标(f.ctx, agent, row)
  await 等到(f, () => 当前持续目标(f.ctx, agent)?.phase === 'blocked')
  const requests = () => f.model.requests.filter(r => r.sessionId === agent.session.id)
  assert.equal(requests().length, 1)
  assert.equal(当前持续目标(f.ctx, agent).blockedReason.code, 'blueprint-wait')
  const wait = 行Of(await 读名册(f.根), id).wait
  assert.deepEqual(wait.conditions, [{ type: 'input' }])
  return { ...f, target: agent, steps, requests, wait }
}

for (const kind of ['tell', 'ask']) test(`Goal 等 input 时上级 ${kind} 唤醒一轮，原等待不解除，重复投递不重复处理`, { timeout: 15000 }, async t => {
  const f = await 搭Goal输入等待(t), agent = f.target, text = `上级 ${kind}：执行条件有了新的信息。`
  f.steps.push({ text: '已处理上级的新信息，原条件仍待确认。' })
  const note = await 传纸条(f.ctx, f.根, '0', '1', text, { kind })
  await 等到(f, () => f.requests().length === 2)
  assert.ok(文字(f.requests()[1].messages).includes(text), '新纸条实际到达模型')
  const received = agent.session.ownEvents().filter(e => e.type === 'user/message' && e.data.source?.summary === `blueprint-note:${note.id}:note`)
  assert.equal(received.length, 1)
  assert.equal(agent.inbox.nextStep.some(m => m.id === received[0].data.id), false)
  assert.deepEqual(行Of(await 读名册(f.根), '1').wait, f.wait, '处理新事不冒充等待条件已满足')
  assert.equal(当前持续目标(f.ctx, agent).phase, 'blocked', '不恢复 Goal 自动续跑')
  await 送未送纸条(f.ctx, f.根, '1'); await 复查项目等待(f.ctx, f.根)
  await new Promise(resolve => setTimeout(resolve, 50)); await f.settle()
  assert.equal(f.requests().length, 2)
  assert.deepEqual(f.failures, [])
})

for (const barrier of ['正式前置', '开工前等下层', '节点已去掉', '无关通知', '回条']) {
  test(`Goal 等 input 的补启与 pre-step 都保留${barrier}限制`, { timeout: 15000 }, async t => {
    const id = barrier === '开工前等下层' ? '0' : '1'
    const f = await 搭Goal输入等待(t, id), agent = f.target
    if (['正式前置', '开工前等下层', '节点已去掉'].includes(barrier)) {
      await 改名册(f.根, m => ({ ...m, rows: m.rows.map(r => r.id !== id ? r : {
        ...r, ...(barrier === '正式前置' ? { after: ['2'] }
          : barrier === '开工前等下层' ? { start: 'children_done', kickoff: { id: '等待孩子后开工', delivered: false } }
            : { status: '去掉' }),
      }) }))
    }
    const source = barrier === '无关通知' ? { kind: 'plugin:fixture' }
      : { kind: 'plugin:blueprint-node', summary: `blueprint-note:gate:${barrier === '回条' ? 'reply' : 'note'}` }
    const queued = 输入(`${barrier}尚未解除时到达的自动输入。`, source)
    const before = agent.session.ownEvents().filter(e => e.type === 'turn/start').length
    // 直接走自动输入入口，确保核对的是补启门禁，而非纸条投递层提前过滤。
    递自动输入(f.ctx, agent, queued)
    await new Promise(resolve => setTimeout(resolve, 100)); await f.settle()
    assert.equal(agent.session.ownEvents().filter(e => e.type === 'turn/start').length, before, '补启不能抢开一轮')
    assert.ok(agent.inbox.nextStep.some(m => m.id === queued.id), '未获准的输入保留在 inbox')
    const direct = 输入(`${barrier}尚未解除时直接叫醒。`, source)
    agent.steer(direct)
    await agent.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 50)); await f.settle()
    assert.equal(f.requests().length, 1, 'pre-step 也不允许进入模型')
    for (const input of [queued, direct]) assert.ok(agent.inbox.nextStep.some(m => m.id === input.id))
    assert.deepEqual(f.failures, [])
  })
}

test('Goal 等 input 处理纸条期间用户按停，排队纸条不补启，后续上级消息也不唤醒', { timeout: 15000 }, async t => {
  const f = await 搭Goal输入等待(t), agent = f.target
  const started = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  f.steps.push({ before: async request => {
    started.resolve(); await release.promise; request.signal.throwIfAborted()
  }, text: '处理这一条新消息。' })
  await 传纸条(f.ctx, f.根, '0', '1', '请核对新信息。', { kind: 'tell' })
  await started.promise
  const queued = 输入('用户按停前已经排队的新纸条。', { kind: 'plugin:blueprint-node', summary: 'blueprint-note:queued:note' })
  递自动输入(f.ctx, agent, queued)
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  release.resolve()
  await f.settle()
  await new Promise(resolve => setTimeout(resolve, 100)); await f.settle()
  assert.equal(f.requests().length, 2, '停稳后的补启不能越过用户停止')
  assert.ok(agent.inbox.nextStep.some(m => m.id === queued.id))
  const end = agent.session.ownEvents().findLast(e => e.type === 'turn/end')
  assert.deepEqual(end.data.reason, { kind: 'aborted', reason: { kind: 'user' } })
  const later = await 传纸条(f.ctx, f.根, '0', '1', '停下后又来的上级消息。', { kind: 'tell' })
  await new Promise(resolve => setTimeout(resolve, 50)); await f.settle()
  assert.equal(f.requests().length, 2)
  assert.ok((await 读纸条(f.根)).some(n => n.id === later.id), '停止期间纸条仍保存在项目队列')
  assert.deepEqual(f.failures, [])
})

test('收尾工具结束这一轮的同一刻到了纸条：这一轮照样结束，纸条停稳后进下一轮（10-23 幸存者 4 号）', { timeout: 15000 }, async t => {
  const f = await 搭原生等待(t)
  const { 收尾 } = await import('./src/收尾.js')
  const 纸条 = 输入('传达：同一刻到的一张纸条。', { kind: 'plugin:blueprint-node' })
  f.ctx.tools.register({ name: 'conclude_stage', description: '交这一段，结束这一轮',
    parameters: { type: 'object', additionalProperties: false, properties: {} }, output: 只回一段字,
    execute: (args, exec) => { 收尾(exec); 递自动输入(f.ctx, f.agent, 纸条); return { 文: '这个阶段结束了。' } },
  })
  f.model.steps.push({ calls: [工具调用('conclude-stage', 'conclude_stage', {})] }, { text: '新一轮看到纸条。' })
  f.agent.steer(输入('交这一段。'))
  await 等到续工结束(f, 2)
  const 轮们 = f.agent.session.ownEvents().filter(event => event.type === 'turn/start')
  assert.equal(轮们.length, 2, '收尾那一轮结束了，纸条另开一轮')
  assert.equal(f.rootRequests()[0].messages.some(message => message.id === 纸条.id), false)
  assert.equal(f.rootRequests()[1].messages.filter(message => message.id === 纸条.id).length, 1)
  const 第一轮尾 = f.agent.session.ownEvents().find(event => event.type === 'turn/end')
  assert.ok(第一轮尾.seq < 轮们[1].seq)
  assert.deepEqual(f.agent.inbox.nextStep, [])
  assert.deepEqual(f.failures, [])
})
