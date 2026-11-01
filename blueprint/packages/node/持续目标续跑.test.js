/**
 * 续跑交给 dsh 的 Goal（选 13、19、20）：真实 dsh loop ＋ 官方 Goal（dsh-goal、dsh-goal-round-driver、dsh-tool-goal），只有模型是假的。
 * 节点开工时建 Goal；Goal 自己开的每一轮第一步先过选择机（思考开头的 pre-step）；next 只记交接，下一轮由 Goal 开；
 * finish 把 Goal 标完成；等孩子、等回条时 Goal 被业务等待挡着，不抢跑，别的事照样叫醒；出错先重试一次、再错和轮数用完都按出事了报。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session } from '@deepseek-ai/dsh-session'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import GoalService from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import * as ToolGoal from '@deepseek-ai/dsh-tool-goal'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { 一段 } from '../prompt/src/index.js'
// 每进一个环节，插页末尾接一句「这一段结束前先告诉用户……」（10-27，选 48；回话不接）。
const 环节收尾 = `\n\n${一段('重置/环节收尾')}`
import { 落新名册, 改名册, 加行, 记会话, 读名册, 行Of, 写工作文档, 新工作文档, 读纸条, 改纸条, 新纸条, 模型表路径, 节点类型, 读节点文档 } from '../roster/src/index.js'
import { 已发布成果 } from '../roster/src/信息依赖.js'
import { 装用户分身 } from './src/用户分身.js'
import { 交接来路 } from './src/交给新总分身.js'
import { 装工具 } from './src/工具.js'
import { 装纸条, 传纸条, 回条, 报出事 } from './src/纸条.js'
import { 装纸条等待 } from './src/纸条等待.js'
import { 装条件等待, 复查项目等待 } from './src/条件等待.js'
import { 装节点文档 } from './src/节点文档.js'
import { 装思考开头, 思考开头来路 } from './src/思考开头.js'
import { 装通用工具 } from './src/通用工具.js'
import { 装持续工作, 当前持续目标, Goal轮数上限 } from './src/持续工作.js'
import { 装收尾续工 } from './src/index.js'
import { 叫醒 } from './src/会话.js'
import { 用户停下的, 叫醒来路 } from './src/规则.js'
import { 准备节点Git空间 } from './src/节点Git空间.js'
import { 等这一批交回, 装策略 } from './src/策略.js'
import { 查卡住, 记动静 } from './src/卡住提醒.js'
import { 写问答 } from '../roster/src/问答.js'
import { 写solo } from './src/人工审核.js'

const 文字 = messages => messages.flatMap(m => (m.content || []).filter(b => b.type === 'text').map(b => b.text)).join('\n')
const 工具调用 = (id, name, args) => ({ type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) })
const 插页们 = messages => messages.filter(m => m.source?.kind === `plugin:${思考开头来路}`).map(m => 文字([m]))
const 是Goal轮 = m => m.source?.kind === 'goal' && m.source.round > 0
/** 这次请求比上一次多出来的消息（请求带着整段历史，上一轮的插页也在里面）。 */
const 新增 = (request, 上一次) => { const 旧 = new Set((上一次?.messages || []).map(m => m.id)); return request.messages.filter(m => !旧.has(m.id)) }

/**
 * 假模型：选择机的调用（来源 plugin:blueprint-selector）单独记、只回阶段名；节点的调用按会话排的步骤答。
 * 步骤可以带 `when(request)`（对不上就按普通收尾答、留给后面的请求）、`before(request)`、`calls`（工具调用）、`error`（这一轮出错）。
 */
class 续跑模型 extends LlmAdapter {
  constructor() { super(); this.requests = []; this.selections = []; this.answers = []; this.steps = new Map(); this.choosers = new Map() }
  async resolveModel(provider, model) { return { provider, id: model, name: model, contextWindow: 1000000 } }
  async *stream(request) {
    if (request.messages.some(m => m.source?.kind === 'plugin:blueprint-selector')) {
      this.selections.push({ sessionId: request.sessionId, text: 文字(request.messages) })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      // 按节点给的选法（选择机的请求不带会话号，认对话里最先出现的那一句职责原文）优先；没有就按排好的回答，再没有就 execute。
      const 文 = 文字(request.messages)
      const 谁 = [...this.choosers.keys()].map(称呼 => [文.indexOf(称呼), 称呼]).filter(([i]) => i >= 0).sort((a, b) => a[0] - b[0])[0]?.[1]
      const 选 = 谁 && this.choosers.get(谁)(文)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 选 || (this.answers.length ? this.answers.shift() : 'execute') } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.requests.push(request)
    const queue = this.steps.get(request.sessionId) || []
    const step = queue[0] && (!queue[0].when || queue[0].when(request)) ? queue.shift() : undefined
    await step?.before?.(request)
    if (step?.error) throw new Error(step.error)
    const blocks = step?.calls || [{ type: 'text', text: step?.text || '假模型本轮结束。' }]
    for (const [index, block] of blocks.entries()) {
      yield { type: 'block-start', index, blockType: block.type }
      yield { type: 'block-end', index, block }
    }
    yield { type: 'finish', reason: { kind: step?.calls ? 'tool-calls' : 'stop' } }
  }
}

/**
 * 一个项目：0 号（helm）和 `孩子们` 里列的孩子（run），各有真实会话、工作文档和 Git 空间；模型表指向假模型，选择机和节点同用一张。
 * 这里不开工，用例自己用 `叫醒(…开工)` 开工（和真正的开节点走同一个入口）。
 */
async function 搭续跑(t, { 孩子们 = [] } = {}) {
  const 根 = await realpath(await mkdtemp(join(tmpdir(), 'Blueprint 持续目标续跑-')))
  const ctx = new Context(), model = new 续跑模型(), failures = []
  t.after(async () => {
    await 复查项目等待(ctx, 根)
    await ctx.fiber.dispose()
    // 轮尾的异步记账（选择机记录、名册）可能还在写：删目录遇到「非空」就稍等重试。
    await rm(根, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry, TypertRegistry]) await ctx.plugin(plugin)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(GoalService)
  await ctx.plugin(GoalRoundDriver)
  await ctx.plugin(ToolGoal)
  await ctx.plugin(LocalFileSystem, { cwd: 根 })
  ctx.llm.registerAdapter(['goal-continue-fixture'], model)
  ctx.provide('blueprintToolCatalog', { list: agent => ctx.tools.schemas(agent) })
  装工具(ctx); 装纸条(ctx); 装节点文档(ctx); 装思考开头(ctx); 装通用工具(ctx)
  装纸条等待(ctx); 装条件等待(ctx); 装持续工作(ctx); 装收尾续工(ctx)
  ctx.on('agent/error', ({ error }) => { failures.push(error) })
  await 落新名册(根, '续跑核对', '做一个能玩的小房间')
  await writeFile(模型表路径(根), JSON.stringify({ provider: 'goal-continue-fixture', model: 'fixture' }))
  await 改名册(根, async m => {
    for (const name of 孩子们) m = 加行(m, '0', { name, task: `${name}的活`, goal: `${name}的成果` }).名册
    for (const row of m.rows) await 写工作文档(根, row, 新工作文档(row, row.task, { responsibility: `${row.name}负责${row.task}。` }))
    return m
  })
  const agents = new Map()
  for (const row of (await 读名册(根)).rows) {
    await 准备节点Git空间(根, row, await 读名册(根), { 新建项目: row.id === '0' })
    const { agent } = await ctx.agents.create({ sessionId: `goal-continue-${row.id.replace(/\./g, '-')}-${Math.random().toString(36).slice(2, 8)}`,
      agentOptions: { provider: 'goal-continue-fixture', model: 'fixture' }, meta: { cwd: 根 } })
    agents.set(row.id, agent)
    await 改名册(根, m => 记会话(m, row.id, agent.session.id))
  }
  const 请求们 = id => model.requests.filter(r => r.sessionId === agents.get(id).session.id)
  const 选择们 = id => model.selections.filter(s => s.sessionId === undefined || s.sessionId === agents.get(id).session.id)
  return { 根, ctx, model, agents, failures, 请求们, 选择们, 步骤: (id, ...steps) => model.steps.set(agents.get(id).session.id, steps) }
}

/** 轮询到条件成立且所有会话停稳；超时如实报出请求数和 Goal 状态。 */
async function 等到(f, 条件, timeoutMs = 5000) {
  const 截止 = Date.now() + timeoutMs
  while (true) {
    if (await 条件() && [...f.agents.values()].every(a => a.status === 'idle')) break
    if (Date.now() > 截止) {
      const goals = [...f.agents.entries()].map(([id, a]) => `${id}:${当前持续目标(f.ctx, a)?.phase ?? '无'}/${当前持续目标(f.ctx, a)?.blockedReason?.code ?? ''}`).join(' ')
      throw new Error(`等待超时：节点请求 ${f.model.requests.length}，选择 ${f.model.selections.length}，Goal ${goals}，失败 ${f.failures.map(e => e.message).join('；')}`)
    }
    await new Promise(r => setTimeout(r, 10))
  }
  for (const agent of f.agents.values()) await agent.whenIdle()
}
/** 不该发生的事：停稳后再等一小段，确认没有再动。 */
const 静一会 = async (f, ms = 150) => { await new Promise(r => setTimeout(r, ms)); for (const a of f.agents.values()) await a.whenIdle() }
const 选择器 = async (f, id = '0') => 行Of(await 读名册(f.根), id).selector || {}

// 选 19、20：开工时建 Goal；next 只记交接、结束这一轮；节点闲下来 Goal 开下一轮，第一步先过选择机，这次＝「上一个阶段结束了。交接：…」；
// finish 就是 Goal 完成，之后不再开轮。
// 选 19：等孩子时挡住 Goal。10-19 那把「有孩子没交回就挡」的锁一直暂停着；10-24 用户定「挡吧还是」，改由 divide 派出后
// 替上级登记一条通用的等待（策略.js 的 等这一批交回）。下面几条用例的母节点不真的调 divide，在它那一轮里调同一个函数，就是派出后的样子。
const 派出了 = f => () => 等这一批交回(f.ctx, f.根, '0', f.agents.get('0'))

test('开工后建 Goal；next 只记交接，Goal 自开的下一轮带交接过选择机；finish 后 Goal 完成、不再开轮', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t), agent = f.agents.get('0')
  f.model.answers.push('orient', 'execute')
  f.步骤('0',
    { calls: [工具调用('结束-orient', 'next', { handoff: 'orient 想清楚了：先做一个能走动的房间。' })] },
    { when: request => request.messages.some(是Goal轮), calls: [工具调用('交回', 'finish', { result: 'achieved', handoff: '房间能走动了，入口在作品/。', checked: '自己验过：在台上跑了一遍' })] },
  )
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  const goal = 当前持续目标(f.ctx, agent)
  assert.ok(goal, '开工叫醒之后就有 Goal')
  assert.equal(goal.objective, '续跑核对：做一个能玩的小房间', 'Goal 的目标是名字与请求一句话')
  assert.equal(goal.maxGoalRounds, Goal轮数上限)
  await 等到(f, () => 当前持续目标(f.ctx, agent)?.phase === 'complete')
  await 静一会(f)
  const [开工轮, Goal一轮, ...多的] = f.请求们('0')
  assert.equal(多的.length, 0, `finish 之后不再开轮：${多的.map(r => 文字(r.messages).slice(-80)).join(' ｜ ')}`)
  // 开工那一轮：叫醒话原样进，第一步末尾两条插页（开头在前、阶段页在后，同 1）；Goal 还没开轮。
  assert.ok(!开工轮.messages.some(是Goal轮), 'Goal 没有抢在开工话前面开一轮')
  assert.equal(开工轮.messages.filter(m => 文字([m]) === 一段('重置/叫醒/开工')).length, 1)
  const [开工开头, 开工插页, ...开工多的] = 插页们(开工轮.messages)
  assert.equal(开工多的.length, 0, '一轮只插一次')
  assert.match(开工开头, /续跑核对负责做一个能玩的小房间。/, '开头带职责原文')
  assert.equal(开工插页, `【环节：orient】\n\n${一段('重置/阶段/helm/orient')}${环节收尾}`, '阶段页单独一条在最后')
  // next 只记交接：不留接着转，也不靠机器另送叫醒话。
  assert.ok(!f.请求们('0').some(r => r.messages.some(m => m.source?.summary === 'blueprint-continue')), '有 Goal 时不送接着转')
  // Goal 自开的那一轮：选择机看到节点对话里已有的全部，上一个阶段和交接写在问题那一段。
  assert.ok(新增(Goal一轮, 开工轮).some(是Goal轮))
  const [第一次, 第二次, ...选多了] = f.选择们('0')
  assert.equal(选多了.length, 0, '两轮各过一次选择机')
  assert.ok(第一次.text.includes(一段('重置/叫醒/开工')))
  assert.ok(第一次.text.includes(开工开头), '开工那次选择机也看到开头')
  assert.ok(第二次.text.includes('上一个环节：orient；交接：orient 想清楚了：先做一个能走动的房间。'))
  assert.ok(第二次.text.includes(开工插页), '选择机看到节点对话里已有的阶段页：和节点同一份 context（同 1）')
  const [Goal插页, ...Goal多的] = 插页们(新增(Goal一轮, 开工轮))
  assert.equal(Goal多的.length, 0)
  assert.ok(Goal插页.startsWith(`【环节：execute】\n\n${一段('重置/阶段/helm/execute')}`))
  // 交回：名册记完成，Goal 标完成。
  const row = 行Of(await 读名册(f.根), '0')
  assert.equal(row.status, '完成')
  assert.equal(row.selector.last, 'execute'); assert.equal(row.selector.handoff, undefined); assert.equal(row.selector.continue, undefined)
  assert.equal(当前持续目标(f.ctx, agent).phase, 'complete')
  assert.equal(当前持续目标(f.ctx, agent).roundsStarted, 1)
  assert.deepEqual(f.failures, [])
})

// 选 41：10-16-6 的 10.2 在 Goal 轮里先 update_goal 标完成，dsh 回「别再调工具」，它就没 finish，任务表一直是「在做」。
for (const [经由, 包一层] of [['直接调', false], ['经 call_tool 调', true]]) {
  test(`Goal 轮里${经由} update_goal 标完成被拦下：Goal 不完成、不收尾；接着 finish 正常交回`, { timeout: 20000 }, async t => {
    const f = await 搭续跑(t), agent = f.agents.get('0')
    f.model.answers.push('orient', 'execute')
    f.步骤('0',
      { calls: [工具调用('结束-orient', 'next', { handoff: 'orient 想清楚了：先做一个能走动的房间。' })] },
      { when: request => request.messages.some(是Goal轮), before() {
        const goal = 当前持续目标(f.ctx, agent), args = { goal_id: goal.id, revision: goal.revision, action: 'complete' }
        this.calls = [包一层 ? 工具调用('标完成', 'call_tool', { name: 'update_goal', arguments: args }) : 工具调用('标完成', 'update_goal', args)]
      } },
      { calls: [工具调用('交回', 'finish', { result: 'achieved', handoff: '房间能走动了，入口在作品/。', checked: '自己验过：在台上跑了一遍' })] },
    )
    assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
    await 等到(f, async () => 行Of(await 读名册(f.根), '0').status === '完成')
    await 静一会(f)
    const 交回那步 = f.请求们('0').at(-1)
    assert.ok(交回那步.messages.some(m => m.role === 'tool' && 文字([m]).includes(一段('重置/工具/update_goal完成'))), '拒绝那句回给了模型')
    assert.ok(!f.请求们('0').some(r => 文字(r.messages).includes('<goal_complete>')), 'dsh 的收尾话没出现')
    assert.equal(当前持续目标(f.ctx, agent).phase, 'complete', 'Goal 由 finish 标完成')
    assert.deepEqual(f.failures, [])
  })
}

// execute 用 next 交成果报告的那一轮停下：Goal 不能抢先开下一轮。挡 Goal 放在 next 里做——轮尾回调正在追加 turn/end，
// 这时再写 goal/change，dsh 会报「append 不能重入」，挡不住，阶段报告的叫醒也跟着丢了（10-14 冒烟发现）。
test('execute 用 next 交成果报告：Goal 先被挡住，下一轮是阶段报告的叫醒，不是 Goal 自开的一轮', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t), agent = f.agents.get('0')
  f.model.answers.push('execute', 'complete')
  f.步骤('0',
    { calls: [工具调用('报告', 'next', { handoff: '结果：房间能走动。\n证据入口：作品/。\n和预测不一样的地方：没有。' })] },
    { when: request => 文字(request.messages).includes(一段('重置/叫醒/阶段报告')), calls: [工具调用('交回', 'finish', { result: 'achieved', handoff: '房间能走动了。', checked: '自己验过：在台上跑了一遍' })] },
  )
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  await 等到(f, () => 当前持续目标(f.ctx, agent)?.phase === 'complete')
  await 静一会(f)
  assert.deepEqual(f.failures, [])
  const [, 第二次, ...选多了] = f.选择们('0')
  assert.equal(选多了.length, 0, '开工一次、阶段报告一次')
  assert.ok(第二次.text.includes(一段('重置/叫醒/阶段报告')), '报告之后选择机看到阶段报告的叫醒')
  assert.ok(!f.请求们('0').some(r => r.messages.some(是Goal轮)), 'Goal 没有抢在阶段报告前面开一轮')
  assert.equal(当前持续目标(f.ctx, agent).roundsStarted, 0)
})

// 选 14：一个阶段中途到的事（这里是用户的话）马上进同一轮的下一步，不插页、不调选择机；
// 它已在节点对话里，下一次选择机（Goal 开的下一轮）看的就是那一份，直接看得到（同 1）。真实 loop 里同一轮各步的 turn 相同。
test('真实 loop：一轮只在第一步过一次选择机；中途的用户话原样进下一步，Goal 下一轮的选择机从对话里看到它', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t), agent = f.agents.get('0')
  // 第一个阶段选 orient：它的 next 只记交接；execute 的 next 是成果报告，会走重建叫醒（选 25）。
  f.model.answers.push('orient', 'execute')
  const 补话 = createUserMessage({ content: [{ type: 'text', text: '用户补一句：门要能打开。' }], source: { kind: 'user' } })
  f.步骤('0',
    // 开工那一轮第一步：模型在想的时候用户说了一句；这一步读一下节点文档，工具结果回来以后进第二步。
    { before: () => agent.steer(补话), calls: [工具调用('读文档', 'node_doc', {})] },
    { when: request => 文字(request.messages).includes('用户补一句：门要能打开。'), calls: [工具调用('结束-orient', 'next', { handoff: '房间搭好了，门还没做。' })] },
    { when: request => request.messages.some(是Goal轮), calls: [工具调用('交回', 'finish', { result: 'achieved', handoff: '房间和门都做好了。', checked: '自己验过：在台上跑了一遍' })] },
  )
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  await 等到(f, () => 当前持续目标(f.ctx, agent)?.phase === 'complete')
  const [第一步, 第二步, Goal一轮, ...多的] = f.请求们('0')
  assert.equal(多的.length, 0)
  const 第二步新增 = 新增(第二步, 第一步)
  assert.ok(第二步新增.some(m => m.id === 补话.id), '用户的话当场进了同一轮的下一步')
  assert.deepEqual(插页们(第二步新增), [], '中途不插页')
  assert.equal(插页们(第一步.messages).length, 2, '开头一条、阶段页一条')
  const [开工选, Goal选, ...选多了] = f.选择们('0')
  assert.equal(选多了.length, 0, '中途不调选择机')
  assert.doesNotMatch(开工选.text, /门要能打开/)
  // Goal 开的下一轮：中途的话已在对话里，上一个阶段和交接在问题那一段。
  assert.ok(Goal选.text.includes('用户补一句：门要能打开。'), '选择机从对话里看到中途的话')
  assert.ok(Goal选.text.includes('上一个环节：orient；交接：房间搭好了，门还没做。'), Goal选.text.slice(-300))
  assert.equal(插页们(新增(Goal一轮, 第二步)).length, 1, 'Goal 自开的一轮只插阶段页')
  assert.equal((await 选择器(f)).pending, undefined, '不另记中途')
  assert.deepEqual(f.failures, [])
})

// 选 19：派出去的孩子没交齐，Goal 不替它开下一轮（被 blueprint-wait 挡着，不耗轮数）；孩子交齐的汇总叫醒它时，
// 汇总并进 Goal 恢复后的那一轮，选择机以汇总为这次的事。
test('等孩子时 Goal 不抢跑、不耗轮数；孩子交齐后 Goal 恢复，汇总并进 Goal 那一轮过选择机', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t, { 孩子们: ['画面'] }), agent = f.agents.get('0'), child = f.agents.get('1')
  f.model.answers.push('execute', 'complete')
  f.步骤('0',
    { before: 派出了(f), text: '派出去了，等画面交回。' },
    { when: request => request.messages.some(是Goal轮), calls: [工具调用('交回', 'finish', { result: 'achieved', handoff: '画面已并进来。', checked: '自己验过：在台上跑了一遍' })] },
  )
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  await 等到(f, () => 当前持续目标(f.ctx, agent)?.phase === 'blocked')
  await 静一会(f)
  assert.equal(f.请求们('0').length, 1, '开工那一轮之后 Goal 没开新的一轮')
  const 挡着 = 当前持续目标(f.ctx, agent)
  assert.equal(挡着.blockedReason.code, 'blueprint-wait')
  assert.match(挡着.blockedReason.message, /等这一批派出的块交回/)
  assert.equal(挡着.roundsStarted, 0, '被业务等待挡着不耗轮数')
  assert.equal(f.选择们('0').length, 1)
  // 孩子交回：汇总叫醒母节点，Goal 恢复，下一轮带着汇总。
  const 交回 = await f.ctx.tools.execute({ name: 'finish', arguments: { result: 'achieved', handoff: '画面三张，放在作品/画面/。', checked: '自己验过：在台上跑了一遍' },
    agent: child, callId: ToolCallId('孩子交回'), signal: new AbortController().signal })
  assert.equal(交回.isError, false, JSON.stringify(交回))
  await 等到(f, () => 当前持续目标(f.ctx, agent)?.phase === 'complete')
  const [开工轮, 恢复轮, ...多的] = f.请求们('0')
  assert.equal(多的.length, 0)
  const 恢复新增 = 新增(恢复轮, 开工轮)
  assert.ok(恢复新增.some(是Goal轮), '汇总并进 Goal 恢复后的那一轮，没有另开一轮')
  const 汇总们 = 恢复新增.filter(m => m.source?.kind === 'plugin:blueprint-node' && 文字([m]).includes('画面三张'))
  assert.equal(汇总们.length, 1, '汇总只进模型一次')
  assert.equal(插页们(恢复新增).length, 2, '有新事：开头一条、阶段页一条')
  const [, 恢复选, ...选多了] = f.选择们('0')
  assert.equal(选多了.length, 0)
  assert.ok(恢复选.text.includes('画面三张，放在作品/画面/'), '选择机看到汇总')
  assert.ok(恢复选.text.includes('上一个环节：execute'))
  assert.equal(当前持续目标(f.ctx, agent).roundsStarted, 1)
  assert.deepEqual(f.failures, [])
})

// 选 18：Goal 被等回条挡着（blueprint-wait）时，新纸条照样叫醒节点处理这件事，Goal 继续挡着；
// 对应回条到了，Goal 恢复，回条并进 Goal 那一轮。每份输入只进模型一次，每轮只过一次选择机。
test('Goal 被等回条挡着时新纸条照样叫醒节点、Goal 不恢复；回条到了 Goal 才接着转，回条并进那一轮', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t, { 孩子们: ['美术', '关卡'] }), agent = f.agents.get('0')
  // 两个孩子都交回过了（不挡母节点）；0 早先向 1 发过一张求助还没回。
  await 改名册(f.根, m => ({ ...m, rows: m.rows.map(r => r.id === '0' ? r : { ...r, status: '完成' }) }))
  await 改纸条(f.根, 纸条 => 新纸条(纸条, { from: '0', to: '1', kind: 'ask', text: '画风定像素还是手绘？' }).纸条)
  f.model.answers.push('plan', 'reply', 'execute')
  f.步骤('0',
    { text: '先等美术回画风。' },
    { when: request => 文字(request.messages).includes('用户想加一个夜晚关卡。'), text: '记下了夜晚关卡，画风还在等。' },
    { when: request => request.messages.some(是Goal轮), calls: [工具调用('交回', 'finish', { result: 'achieved', handoff: '按像素风做完了。', checked: '自己验过：在台上跑了一遍' })] },
  )
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  await 等到(f, () => 当前持续目标(f.ctx, agent)?.phase === 'blocked')
  await 静一会(f)
  assert.equal(f.请求们('0').length, 1)
  assert.equal(当前持续目标(f.ctx, agent).blockedReason.code, 'blueprint-wait')
  assert.match(当前持续目标(f.ctx, agent).blockedReason.message, /N1 的回条/)
  // 关卡发来一封传达：照样叫醒它，Goal 继续挡着。
  await 传纸条(f.ctx, f.根, '2', '0', '用户想加一个夜晚关卡。', { kind: 'tell' })
  await 等到(f, () => f.请求们('0').length === 2)
  await 静一会(f)
  assert.equal(f.请求们('0').length, 2, '传达叫醒了一轮，没有接着空转')
  assert.equal(当前持续目标(f.ctx, agent).phase, 'blocked', '回条没到，Goal 不恢复')
  assert.equal(当前持续目标(f.ctx, agent).roundsStarted, 0)
  const [开工轮, 传达轮] = f.请求们('0')
  const 传达新增 = 新增(传达轮, 开工轮)
  assert.ok(!传达新增.some(是Goal轮), '传达那一轮不是 Goal 开的')
  assert.equal(插页们(传达新增).length, 2, '开头一条、阶段页一条')
  assert.ok(f.选择们('0')[1].text.includes('用户想加一个夜晚关卡。'))
  // 美术回了 N1：Goal 恢复，回条并进它开的那一轮。
  await 回条(f.ctx, f.根, '1', 'N1', '像素风，16 色。')
  await 等到(f, () => 当前持续目标(f.ctx, agent)?.phase === 'complete')
  const [, , 回条轮, ...多的] = f.请求们('0')
  assert.equal(多的.length, 0)
  const 回条新增 = 新增(回条轮, 传达轮)
  assert.ok(回条新增.some(是Goal轮), '回条并进 Goal 恢复后的那一轮')
  assert.equal(回条新增.filter(m => 文字([m]).includes('像素风，16 色。') && m.source?.kind === 'plugin:blueprint-node').length, 1)
  assert.equal(插页们(回条新增).length, 2, '开头一条、阶段页一条')
  const 选 = f.选择们('0')
  assert.equal(选.length, 3, '三轮各过一次选择机')
  assert.ok(选[2].text.includes('像素风，16 色。'))
  // 每份输入只进模型一次（按「新增」数，历史里重复出现的不算再进一次）。
  const 进过 = 文 => f.请求们('0').reduce((n, r, i) => n + 新增(r, f.请求们('0')[i - 1]).filter(m => m.source?.kind === 'plugin:blueprint-node' && 文字([m]).includes(文)).length, 0)
  assert.equal(进过('用户想加一个夜晚关卡。'), 1)
  assert.equal(进过('像素风，16 色。'), 1)
  assert.deepEqual(f.failures, [])
})

// 10-22：原来节点登记等待后正常收了这一轮，自动续跑又开一个空轮再被挡掉（Mac mini 118 轮里 17 个）；现在开始等的那一刻就挂起。
test('开始等的那一刻就挂起自动续跑：不出空轮；等的到了照常恢复接着做', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t, { 孩子们: ['美术'] }), agent = f.agents.get('0'), child = f.agents.get('1')
  f.model.answers.push('plan', 'execute')
  f.步骤('0',
    { calls: [工具调用('等美术', 'wait', { reason: '等美术交回画风', conditions: [{ type: 'node', node: '1' }] })] },
    { when: request => 文字(request.messages).includes('画风定了像素'), calls: [工具调用('交回', 'finish', { result: 'achieved', handoff: '按像素风做完了。', checked: '自己验过：在台上跑了一遍' })] })
  const 收尾 = () => agent.session.ownEvents().filter(e => e.type === 'turn/end').map(e => e.data.reason.kind)
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  await 等到(f, () => 当前持续目标(f.ctx, agent)?.phase === 'blocked')
  await 静一会(f)
  assert.deepEqual(收尾(), ['completed'], '登记等待的那一轮正常结束，没有再开一个空轮被挡掉')
  assert.equal(当前持续目标(f.ctx, agent).blockedReason.code, 'blueprint-wait')
  const 交 = await f.ctx.tools.execute({ name: 'finish', arguments: { result: 'achieved', handoff: '画风定了像素。', checked: '自己验过：在台上跑了一遍' },
    agent: child, callId: ToolCallId('美术交回'), signal: new AbortController().signal })
  assert.equal(交.isError, false, JSON.stringify(交))
  await 等到(f, async () => 行Of(await 读名册(f.根), '0').status === '完成')
  assert.ok(!收尾().includes('blocked'), JSON.stringify(收尾()))
  assert.deepEqual(f.failures, [])
})

// 10-24 用户「挡吧还是」：上级用 divide 派出了块，系统替它登记「等这一批派出的块交回」（通用的 children 等待），登记那一刻挂起 Goal。
// 孩子在做的时候它不空转；用户对它说话照样醒（2.26），这一轮完了照旧挂着；孩子交齐，交齐汇总只叫醒它一次，这条等待在同一次写名册里撤掉。
test('派出后上级挂起：孩子做的时候不空转；用户说话照样叫醒、答完照旧挂着；交齐由交齐汇总叫醒一次、等待一并撤掉', { timeout: 30000 }, async t => {
  const f = await 搭续跑(t), agent = f.agents.get('0')
  // 0 号是 helm：一个阶段派一块总 dock（第三版 10-24）；dock 派 run 也走同一个 等这一批交回。
  装策略(f.ctx)
  await 写solo(f.根, true)
  // 派出去的总 dock 会话号事先不知道：它的步骤在第一次请求时排上；放行之前它一直在做。
  const 原有 = new Set([...f.agents.values()].map(a => a.session.id)), 取 = f.model.steps.get.bind(f.model.steps)
  let 放行; const 放行了 = new Promise(resolve => { 放行 = resolve })
  f.model.steps.get = id => {
    if (!f.model.steps.has(id) && !原有.has(id)) f.model.steps.set(id, [{ before: () => 放行了,
      calls: [工具调用('孩子交回', 'finish', { result: 'achieved', handoff: '画面三张，放在台的 交付/。', checked: '自己验过：在台上跑了一遍' })] }])
    return 取(id)
  }
  const 有 = 话 => request => 文字(request.messages).includes(话)
  const 选法 = 规矩 => 文 => 规矩.map(([话, stage]) => [文.lastIndexOf(话), stage]).filter(([i]) => i >= 0).sort((a, b) => b[0] - a[0])[0]?.[1]
  f.model.choosers.set((r => `${r.name}负责${r.task}`)(行Of(await 读名册(f.根), '0')),
    选法([['开工。', 'plan'], ['顺便把标题也定一下', 'execute'], ['本次分工的直接子节点都交回了', 'complete']]))
  f.步骤('0',
    { calls: [工具调用('派出', 'divide', { whole: '测试里我要做的', blocks: [{ key: '画面', name: '画面', role: 'dock', situation: '小房间还没有画面',
      what: '三张画面', link: '为整件事服务', level: 'polished' }] })] },
    { when: 有('顺便把标题也定一下'), text: '标题定了：夜行。' },
    { when: 有('本次分工的直接子节点都交回了'), calls: [工具调用('总交回', 'finish', { result: 'achieved', handoff: '画面接上了，交给用户看。', checked: '自己验过：在台上跑了一遍' })] })
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  // 孩子在做（放行前一直跑着，它不在 f.agents 里）：等到 只等母节点停稳。
  await 等到(f, async () => !!行Of(await 读名册(f.根), '0').wait && 当前持续目标(f.ctx, agent)?.phase === 'blocked' && (await 读名册(f.根)).rows.length === 2)
  await 静一会(f, 300)
  let m = await 读名册(f.根)
  assert.equal(m.rows.length, 2, '派出了一块')
  assert.deepEqual([行Of(m, '0').wait.reason, 行Of(m, '0').wait.conditions], ['等这一批派出的块交回', [{ type: 'children', nodes: ['1'] }]])
  assert.equal(当前持续目标(f.ctx, agent).blockedReason?.code, 'blueprint-wait', '登记那一刻挂起 Goal')
  assert.equal(f.请求们('0').length, 1, '孩子在做的时候不空转')
  const 收尾 = () => agent.session.ownEvents().filter(e => e.type === 'turn/end').map(e => e.data.reason.kind)
  assert.deepEqual(收尾(), ['completed'], '派出那一轮正常结束，没有被挡掉的空轮')
  // 用户说话：照样醒、过选择机、做这一轮；完了照旧挂着。
  agent.steer(createUserMessage({ content: [{ type: 'text', text: '顺便把标题也定一下。' }], source: { kind: 'user' } }))
  await 等到(f, () => f.请求们('0').length === 2)
  await 静一会(f, 300)
  assert.equal(f.请求们('0').length, 2, '用户的话叫醒它一次，答完不接着转')
  assert.ok(!!行Of(await 读名册(f.根), '0').wait, '等待还在')
  assert.equal(当前持续目标(f.ctx, agent).blockedReason?.code, 'blueprint-wait')
  // 孩子交回：交齐汇总叫醒一次，等待一并撤掉。
  放行()
  await 等到(f, async () => 行Of(await 读名册(f.根), '0').status === '完成', 20000)
  await 静一会(f)
  m = await 读名册(f.根)
  assert.equal(行Of(m, '1').status, '完成')
  const 汇总轮 = f.请求们('0').filter((r, i) => 文字(新增(r, f.请求们('0')[i - 1])).includes('本次分工的直接子节点都交回了'))
  assert.equal(汇总轮.length, 1, '交齐汇总只叫醒一次')
  assert.ok(文字(汇总轮[0].messages).includes('画面三张，放在台的 交付/。'))
  assert.ok(!文字(f.请求们('0').flatMap(r => r.messages)).includes('等待条件已有结果'), '等待在交回时撤掉，不另叫醒一次')
  assert.ok(!收尾().includes('blocked'), JSON.stringify(收尾()))
  assert.equal(当前持续目标(f.ctx, agent).phase, 'complete')
  assert.deepEqual(f.failures, [])
})

// 十步重置（10-24）；第三版：helm 和总 dock 之间用和 dock、run 之间同一套——派出，总 dock 做完 finish 交回，孩子交齐由交齐汇总叫醒上级。
// 真循环里走一轮：总 dock 做完交回；交齐汇总只叫醒 helm 一次，它进 complete 对照用户意图、交回。不登记等待、不发布轮报告，没有被挡掉的空轮。
test('helm 和总 dock 同一套父子循环：总 dock 做完就交回，交齐汇总叫醒 helm 一次，差异判断后交回；全程没有被挡掉的空轮', { timeout: 30000 }, async t => {
  const f = await 搭续跑(t, { 孩子们: ['主线'] })
  // 这里没走 divide：角色、p 编号和派出时记的第 1 轮直接写上（divide 自己的核对在 策略.test.js）。
  await 改名册(f.根, m => ({ ...m, rows: m.rows.map(r => r.id === '1' ? { ...r, role: 'dock', p: 'p1', rounds: [{ round: 1, via: 'start', stage: 1, at: '2026-10-24T00:00:00.000Z' }] } : r) }))
  const 有 = 话 => request => 文字(request.messages).includes(话)
  f.model.choosers.set('主线负责主线的活', () => 'complete')
  f.model.choosers.set((r => `${r.name}负责${r.task}`)(行Of(await 读名册(f.根), '0')), () => 'complete')
  f.步骤('1', { calls: [工具调用('交回1', 'finish', { result: 'achieved', handoff: '1 号这一阶段做好了，入口在 作品/。', checked: '自己验过：在台上跑了一遍' })] })
  f.步骤('0',
    { when: 有('本次分工的直接子节点都交回了'), calls: [工具调用('总交回', 'finish', { result: 'achieved', handoff: '交给用户试玩。', checked: '自己验过：在台上跑了一遍', status: '总图景' })] })
  assert.equal(await 叫醒(f.ctx, f.根, '1', 一段('重置/叫醒/开工')), true)
  await 等到(f, async () => 行Of(await 读名册(f.根), '0').status === '完成', 20000)
  await 静一会(f)
  const 收尾 = id => f.agents.get(id).session.ownEvents().filter(e => e.type === 'turn/end').map(e => e.data.reason.kind)
  for (const id of ['0', '1']) assert.ok(!收尾(id).includes('blocked'), `${id} 号：${JSON.stringify(收尾(id))}`)
  const m = await 读名册(f.根)
  assert.equal(行Of(m, '1').status, '完成')
  assert.equal(行Of(m, '1').publications, undefined, '总 dock 不发布轮报告')
  assert.equal(行Of(m, '1').wait, undefined, '总 dock 不登记等待')
  assert.equal(行Of(m, '1').rounds[0].handback.handoff, '1 号这一阶段做好了，入口在 作品/。', '交回的结论存进这一轮那一条')
  assert.equal(f.请求们('0').filter(r => 文字(新增(r, f.请求们('0')[f.请求们('0').indexOf(r) - 1])).includes('本次分工的直接子节点都交回了')).length, 1, '总 dock 交回只叫醒 helm 一次')
  const helm看到 = f.请求们('0').map(r => 文字(r.messages)).find(t => t.includes('本次分工的直接子节点都交回了')) || ''
  assert.ok(helm看到.includes('1 号这一阶段做好了'), '交齐汇总里有总 dock 的交回')
  assert.ok(f.选择们('1').some(s => s.text.includes('orient、plan、execute、integrate、complete、reply')), '总 dock 走 dock 的菜单')
  assert.ok(f.选择们('0').some(s => s.text.includes('orient、plan、execute、complete、reply')), 'helm 的菜单没有 integrate')
  for (const id of ['0', '1']) assert.equal(当前持续目标(f.ctx, f.agents.get(id)).phase, 'complete')
  assert.deepEqual(f.failures, [])
})

// 选 13：出错断掉的一轮，机器先原样叫醒一次（出错重试）；重试的那一轮自己又出错，就算出事了：
// 给母节点一封传达（出事了），再告诉在等它回求助的节点（对方出事了）。同一件事只报一次。
test('出错一次叫醒重试；再错报出事：母节点和等它回求助的节点各收到一封传达，只报一次', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t, { 孩子们: ['美术', '关卡'] })
  await 派出了(f)()
  // 关卡（2）在美术（1）重试的时候发来一张求助、在等它回。这里只写进纸条账、不投递：
  f.步骤('1', { error: '上游 502：第一次' }, {
    before: () => 改纸条(f.根, 纸条 => 新纸条(纸条, { from: '2', to: '1', kind: 'ask', text: '画风定了吗？' }).纸条),
    error: '上游 502：第二次' })
  assert.equal(await 叫醒(f.ctx, f.根, '1', 一段('重置/叫醒/开工')), true)
  await 等到(f, async () => !!(await 选择器(f, '1')).incident && (await 读纸条(f.根)).filter(n => n.kind === 'tell').length === 2
    && f.请求们('0').length >= 1 && f.请求们('2').length >= 1)
  await 静一会(f)
  const [开工轮, 重试轮, ...多的] = f.请求们('1')
  assert.equal(多的.length, 0, '只重试一次')
  const 重试话 = 新增(重试轮, 开工轮).filter(m => m.source?.kind === 'plugin:blueprint-node')
  assert.equal(重试话.length, 1)
  assert.match(文字(重试话), /^上一步出错断了：[\s\S]*上游 502：第一次[\s\S]*接着做。$/)
  const s = await 选择器(f, '1')
  assert.match(s.errorRetry, /^blueprint-error:/, '记着重试那一下的输入号')
  assert.match(s.incident.reason, /^重试以后还是出错：[\s\S]*上游 502：第二次/)
  const 传达们 = (await 读纸条(f.根)).filter(n => n.kind === 'tell')
  assert.deepEqual(传达们.map(n => [n.from, n.to]), [['1', '0'], ['1', '2']])
  assert.match(传达们[0].text, /^1 · run · 美术 停下了，没能接着做：重试以后还是出错：/)
  assert.equal(传达们[1].text, 一段('重置/叫醒/对方出事了', { 节点: '1 · run · 美术', 编号: 'N1' }))
  // 两封传达都送到了：母节点和等回信的节点各醒一次读到。
  assert.match(文字(f.请求们('0')[0].messages), /美术 停下了，没能接着做/)
  assert.match(文字(f.请求们('2')[0].messages), /你的求助 N1 暂时没人回/)
  // 同一件事再报一次（例如事件重复到达、Goal 又报阻塞）：名册上已记着出事了，不再写传达。
  assert.equal(await 报出事(f.ctx, f.根, '1', '又一次'), false)
  assert.equal((await 读纸条(f.根)).filter(n => n.kind === 'tell').length, 2)
  // 出事以后不再自动叫醒它：Goal 被出错停用，不另开轮。
  assert.equal(f.请求们('1').length, 2)
  assert.notEqual(当前持续目标(f.ctx, f.agents.get('1')).activation, 'armed')
})

// 选 19：Goal 轮数用完，dsh 记成阻塞（round-limit），按出事了处理，给母节点一封传达。
// 开持续目标建的 Goal 上限是 500 轮；这里开工那一轮里把上限改成 1，免得假模型空转 500 轮。
test('Goal 轮数用完记成 round-limit：报出事，给母节点一封传达，只报一次', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t, { 孩子们: ['美术'] }), 美术 = f.agents.get('1')
  await 派出了(f)()
  f.步骤('1', { before: () => {
    const goal = f.ctx.goals.get(美术)
    f.ctx.goals.edit(美术, { id: goal.id, revision: goal.revision }, { maxGoalRounds: 1 })
  }, text: '开工这一轮先看看。' }, { text: 'Goal 第一轮：还没做完。' })
  assert.equal(await 叫醒(f.ctx, f.根, '1', 一段('重置/叫醒/开工')), true)
  await 等到(f, async () => 当前持续目标(f.ctx, 美术)?.blockedReason?.code === 'round-limit' && (await 读纸条(f.根)).length === 1 && f.请求们('0').length >= 1)
  await 静一会(f)
  assert.equal(f.请求们('1').length, 2, '开工一轮＋Goal 一轮')
  assert.equal(当前持续目标(f.ctx, 美术).roundsStarted, 1)
  const s = await 选择器(f, '1')
  assert.match(s.incident.reason, /转了 1 轮还没交回，Goal 轮数用完/)
  const [传达, ...多的] = await 读纸条(f.根)
  assert.equal(多的.length, 0, '只报一次')
  assert.deepEqual([传达.from, 传达.to, 传达.kind], ['1', '0', 'tell'])
  assert.equal(传达.text, 一段('重置/叫醒/出事了', { 节点: '1 · run · 美术', 原因: s.incident.reason }))
  assert.match(文字(f.请求们('0')[0].messages), /美术 停下了，没能接着做：转了 1 轮还没交回/)
  assert.deepEqual(f.failures, [])
})

// 选 13：出错一次，机器原样叫醒重试；重试那一轮正常转完，出错计数清掉，不算出事。
test('出错一次叫醒重试，重试那一轮正常转完：出错计数清掉、不报出事', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t), agent = f.agents.get('0')
  f.步骤('0', { error: '上游 502：只这一次' }, { calls: [工具调用('重试后交回', 'finish', { result: 'achieved', handoff: '房间搭好了。', checked: '自己验过：在台上跑了一遍' })] })
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  await 等到(f, async () => 行Of(await 读名册(f.根), '0').status === '完成' && !(await 选择器(f)).errors)
  const [开工轮, 重试轮, ...多的] = f.请求们('0')
  assert.equal(多的.length, 0)
  assert.match(文字(新增(重试轮, 开工轮)), /上一步出错断了：[\s\S]*上游 502：只这一次/)
  const s = await 选择器(f)
  assert.equal(s.errors, undefined, '正常转完一轮，出错计数清掉'); assert.equal(s.incident, undefined)
  assert.equal((await 读纸条(f.根)).filter(n => n.kind === 'tell').length, 0, '没有出事的传达')
  assert.equal(当前持续目标(f.ctx, agent).phase, 'complete')
})

// 选 31：工具参数修补修不好时，重试的话说清坏在哪个工具、哪个文件、附近原文；附近原文里的分号不拆开。
test('工具参数坏了：重试的话逐个列出坏调用的工具、文件和出错处附近', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t)
  const 错误 = ['DeepSeek Messages stream: tool input is invalid JSON:',
    'call_tool→write; file /p/门.mjs; Expected \',\' or \'}\' after property value in JSON at position 60 (line 1 column 61); near: …const a = 1; 他说"开门"…',
    'call_tool→next; Expected \',\' or \'}\' after property value in JSON at position 30 (line 1 column 31); near: …手感目标是"宽容、顺滑"…'].join('\n')
  f.步骤('0', { error: 错误 }, { calls: [工具调用('重试后交回', 'finish', { result: 'achieved', handoff: '门做好了。', checked: '自己验过：在台上跑了一遍' })] })
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  await 等到(f, async () => 行Of(await 读名册(f.根), '0').status === '完成')
  const [开工轮, 重试轮] = f.请求们('0')
  const 重试话 = 新增(重试轮, 开工轮).filter(m => m.source?.kind === 'plugin:blueprint-node')
  assert.equal(文字(重试话), 一段('重置/叫醒/工具参数坏了', { 坏处: [
    '- call_tool→write（/p/门.mjs），出错处附近：…const a = 1; 他说"开门"…',
    '- call_tool→next，出错处附近：…手感目标是"宽容、顺滑"…'].join('\n') }))
})

// 选 17、27：求助到的那一步是新事，开头里列着它；Goal 还在转时停下不另发提醒，Goal 自开的下一轮只插阶段页。
test('求助到的那一步开头里列着它；Goal 在转时停下不另发提醒，下一轮只插阶段页，回了以后照常交回', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t, { 孩子们: ['美术'] }), agent = f.agents.get('0')
  await 改名册(f.根, m => ({ ...m, rows: m.rows.map(r => r.id === '1' ? { ...r, status: '完成' } : r) }))
  await 改纸条(f.根, 纸条 => 新纸条(纸条, { from: '1', to: '0', kind: 'ask', text: '要几张草图？' }).纸条)
  f.步骤('0', { text: '先把房间搭起来。' },
    { when: request => request.messages.some(是Goal轮), calls: [工具调用('回美术', 'note', { reply: 'N1', text: '三张。' }), 工具调用('交回', 'finish', { result: 'achieved', handoff: '房间搭好了。', checked: '自己验过：在台上跑了一遍' })] })
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  await 等到(f, () => 当前持续目标(f.ctx, agent)?.phase === 'complete')
  const 消息们 = agent.session.ownEvents().filter(e => e.type === 'user/message').map(e => e.data)
  assert.ok(!消息们.some(m => String(m.source?.summary || '').startsWith('blueprint-owed:')), 'Goal 在转时不发欠求助提醒')
  // 开工时纸条先送成一轮，开工话在同一轮的下一步进来（中途，不插页）；之后才是 Goal 开的一轮。
  const 请求们 = f.请求们('0'), i = 请求们.findIndex((r, n) => n > 0 && 新增(r, 请求们[n - 1]).some(是Goal轮))
  assert.ok(i > 0, 'Goal 开了下一轮')
  assert.match(插页们(请求们[0].messages).join('\n'), /- N1 · 1：要几张草图？/, '求助到的那一步，开头里列着要回的求助')
  const [Goal插页, ...插多了] = 插页们(新增(请求们[i], 请求们[i - 1]))
  assert.equal(插多了.length, 0)
  assert.equal(Goal插页, `【环节：execute】${环节收尾}`, 'Goal 自开的一轮只插阶段页（选 27）')
  assert.equal((await 读纸条(f.根)).find(n => n.id === 'N1').status, 'answered')
})

// 选 13：出错重试是「先原样叫醒一次」，重试那一轮正常转完就回到常规：next 之后 Goal 照样开下一轮。
// 出错时 dsh 的 Goal 驱动器把续行停用（agent/error → disarm）；机器重试那一下把它重新接上，next 之后 Goal 照样开下一轮。
test('出错一次、重试那一轮正常转完：next 之后 Goal 照样开下一轮', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t), agent = f.agents.get('0')
  f.model.answers.push('orient', 'orient')
  f.步骤('0', { error: '上游 502：只这一次' },
    { calls: [工具调用('重试后结束阶段', 'next', { handoff: '重试成功，房间搭好了。' })] },
    { when: request => request.messages.some(是Goal轮), calls: [工具调用('交回', 'finish', { result: 'achieved', handoff: '做完了。', checked: '自己验过：在台上跑了一遍' })] })
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  await 等到(f, () => 当前持续目标(f.ctx, agent)?.phase === 'complete', 3000)
  assert.equal(f.请求们('0').length, 3, '开工（出错）、重试、Goal 一轮')
  assert.equal(行Of(await 读名册(f.根), '0').status, '完成')
})

// 重试那一轮正好在 execute 里交了成果报告：先送重建叫醒，再把 Goal 接回去；Goal 不抢在前面开一轮。
test('出错重试的那一轮交成果报告：重建叫醒先到，Goal 接回去以后才开轮', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t), agent = f.agents.get('0')
  f.model.answers.push('execute', 'execute', 'complete')
  f.步骤('0', { error: '上游 502：只这一次' },
    { calls: [工具调用('重试后报告', 'next', { handoff: '结果：房间能走动。' })] },
    { when: request => 文字(request.messages).includes(一段('重置/叫醒/阶段报告')), calls: [工具调用('交回', 'finish', { result: 'achieved', handoff: '做完了。', checked: '自己验过：在台上跑了一遍' })] })
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  await 等到(f, () => 当前持续目标(f.ctx, agent)?.phase === 'complete', 8000)
  const 请求们 = f.请求们('0')
  assert.equal(请求们.length, 3, '开工（出错）、重试、阶段报告的重建叫醒')
  const 重建那轮 = 新增(请求们[2], 请求们[1])
  assert.ok(重建那轮.some(m => 文字([m]) === 一段('重置/叫醒/阶段报告')), '阶段报告的重建叫醒没丢')
  assert.ok(!请求们.slice(0, 2).some(r => r.messages.some(是Goal轮)), 'Goal 没有在重建叫醒之前单独开一轮')
  assert.ok(f.选择们('0')[2].text.includes(一段('重置/叫醒/阶段报告')), '选择机看到阶段报告的叫醒')
  assert.equal(行Of(await 读名册(f.根), '0').status, '完成')
})

// 选 46：节点在等孩子（Goal 被挡着），用户问一句进展：不过选择机，不插开头和组织情境，只接回话页，用户的话离它最近；
// 答完不开 Goal 轮、Goal 照样挡着。
test('等孩子时用户问一句：不过选择机、不插开头，只接回话页；答完 Goal 照样挡着、不开轮', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t, { 孩子们: ['画面'] }), agent = f.agents.get('0')
  f.model.answers.push('execute')
  f.步骤('0', { before: 派出了(f), text: '派出去了，等画面交回。' }, { text: '画面还在做，交回后我再整合。' })
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  await 等到(f, () => 当前持续目标(f.ctx, agent)?.phase === 'blocked')
  const goalId = 当前持续目标(f.ctx, agent).id
  agent.steer(createUserMessage({ content: [{ type: 'text', text: '现在进展怎么样？' }], source: { kind: 'user' } }))
  await 等到(f, () => f.请求们('0').length === 2)
  await 静一会(f)
  const [开工轮, 问答轮, ...多的] = f.请求们('0')
  assert.equal(多的.length, 0, '回话之后不开轮')
  assert.deepEqual(插页们(新增(问答轮, 开工轮)), [`【环节：reply】\n\n${一段('重置/阶段/reply')}`], '只接回话页，不带开头和组织情境')
  assert.equal(文字([问答轮.messages.at(-2)]), '现在进展怎么样？', '用户的话紧挨着回话页')
  assert.equal(f.选择们('0').length, 1, '用户的话不过选择机')
  assert.equal(当前持续目标(f.ctx, agent).id, goalId, '不另建 Goal')
  assert.equal(当前持续目标(f.ctx, agent).blockedReason?.code, 'blueprint-wait')
  assert.equal(当前持续目标(f.ctx, agent).roundsStarted, 0)
  assert.equal((await 选择器(f)).last, 'reply')
})

// 用户按停：正在跑的 Goal 轮当场停下，dsh 把 Goal 暂停；之后到的纸条记在纸条账上、不叫醒它，Goal 也不续。
// 用户再说话只跑这一轮。（排着的纸条随用户输入送到、整项目停和恢复，是选 22 那一段的事，这里不测。）
// 选 22：项目里任何一个节点被用户按停，整个项目停下，谁也叫不醒，纸条照收；
// 用户在项目里任何一个节点输入任何东西，整个项目继续：Goal 恢复，排着的纸条送到。
/** 只等条件，不要求别的节点停稳（被停的那个之外，别的节点还在跑）。 */
async function 直到(条件, timeoutMs = 5000) {
  const 截止 = Date.now() + timeoutMs
  while (!(await 条件())) {
    if (Date.now() > 截止) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, 10))
  }
}

// 选 46：对停着的节点说话先回话；它在回话里用 next 交接，才只继续它这一个，排着的纸条送到。
test('用户按停一个节点：只停这一个，别的节点照跑；纸条照收不叫醒它；对它说话、它用 next 交接才继续它，排着的纸条送到', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t, { 孩子们: ['关卡'] }), helm = f.agents.get('0'), 孩子 = f.agents.get('1')
  const 挂着 = request => new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }))
  // 两个节点的开工那一轮都挂着（helm 有孩子没交齐，Goal 本来就被挡着，不会自己开轮）。
  const helm开工了 = Promise.withResolvers(), 孩子开工了 = Promise.withResolvers()
  f.步骤('0', { before: r => { helm开工了.resolve(); return 挂着(r) } },
    { when: r => 文字(r.messages).includes('接着做吧。'), calls: [工具调用('接着', 'next', { handoff: '用户让我接着做。' })] },
    { text: '好，接着做。' })
  f.步骤('1', { before: r => { 孩子开工了.resolve(); return 挂着(r) } })
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  assert.equal(await 叫醒(f.ctx, f.根, '1', 一段('重置/叫醒/开工')), true)
  await Promise.all([helm开工了.promise, 孩子开工了.promise])

  helm.cancel({ kind: 'user' })
  await helm.whenIdle()
  await 直到(() => 当前持续目标(f.ctx, helm)?.phase !== 'active' || 当前持续目标(f.ctx, helm)?.activation !== 'armed')
  await new Promise(r => setTimeout(r, 100))
  assert.notEqual(孩子.status, 'idle', '别的节点照跑')
  assert.equal(当前持续目标(f.ctx, 孩子)?.phase, 'active', '别的节点的 Goal 不受影响')
  assert.equal(existsSync(join(f.根, '系统文档', '停下.json')), false, '不再记整个项目停着')
  const helm停时 = f.请求们('0').length
  // 用求助：传达在 helm 闲着、孩子没交回时本来就压着不送（选 37），和按停无关。
  await 传纸条(f.ctx, f.根, '1', '0', '用户想加一个夜晚关卡。', { kind: 'ask' })
  assert.equal(await 叫醒(f.ctx, f.根, '0', '机器想叫醒它'), false, '停着时机器叫醒不发')
  await new Promise(r => setTimeout(r, 200))
  assert.equal(f.请求们('0').length, helm停时, '停着时纸条不叫醒')
  assert.ok((await 读纸条(f.根)).some(n => n.to === '0' && n.text === '用户想加一个夜晚关卡。'), '纸条记在账上')

  // 孩子也按停：下面核对继续 helm 不会把它一起叫起来。
  孩子.cancel({ kind: 'user' })
  await 孩子.whenIdle()
  const 孩子停时 = f.请求们('1').length
  helm.steer(createUserMessage({ content: [{ type: 'text', text: '接着做吧。' }], source: { kind: 'user' } }))
  // 继续以后 Goal 一直自己转（假模型每轮都只说一句），看到纸条送到就先把它暂停，再等停稳。
  await 直到(() => f.请求们('0').some(r => 文字(r.messages).includes('用户想加一个夜晚关卡。'))
    && f.请求们('0').some(r => 文字(r.messages).includes('接着做吧。')), 10000)
  const helm目标 = 当前持续目标(f.ctx, helm)
  assert.ok(helm目标.phase !== 'paused', '它的 Goal 恢复了')
  if (helm目标.phase === 'active') f.ctx.get('goals').pause(helm, { id: helm目标.id, revision: helm目标.revision })
  await helm.whenIdle()
  const 送到 = f.请求们('0').find(r => 文字(r.messages).includes('用户想加一个夜晚关卡。'))
  assert.equal(文字(送到.messages).split('用户想加一个夜晚关卡。').length - 1, 1, '排着的纸条送到一次')
  await 静一会(f)
  assert.equal(f.请求们('1').length, 孩子停时, '继续 helm 不叫醒被停的孩子')
  assert.equal(await 叫醒(f.ctx, f.根, '1', '机器想叫醒它'), false, '孩子仍停着')
})

// 选 46：对停着的节点说话，直接回话，答完照样停着；接连问两句，两次都答完就停、Goal 不替它接着转。
// 说继续，它在回话里用 next 交接：这一轮当场过选择机接着做，停稳后 Goal 恢复、接着转到交回。
test('对停着的节点说话：直接回话、答完照样停着；它用 next 交接才继续，Goal 接着转', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t), agent = f.agents.get('0')
  const 开工了 = Promise.withResolvers()
  f.model.answers.push('execute', 'execute')
  f.步骤('0',
    { before: r => { 开工了.resolve(); return new Promise((_, reject) => r.signal.addEventListener('abort', () => reject(r.signal.reason), { once: true })) } },
    { when: r => 文字(r.messages).includes('现在做到哪了？'), text: '墙搭好了，门还没做。' },
    { when: r => 文字(r.messages).includes('为什么先做墙？'), text: '先做墙是为了让房间能走动、能碰撞。' },
    { when: r => 文字(r.messages).includes('继续吧。'), calls: [工具调用('接着', 'next', { handoff: '用户让我接着做。' })] },
    { text: '好，接着做。' },
    { when: r => r.messages.some(是Goal轮), calls: [工具调用('交回', 'finish', { result: 'achieved', handoff: '房间做好了。', checked: '自己验过：在台上跑了一遍' })] },
  )
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  await 开工了.promise
  agent.cancel({ kind: 'user' })
  await agent.whenIdle()
  for (const [问, 第几次] of [['现在做到哪了？', 2], ['为什么先做墙？', 3]]) {
    agent.steer(createUserMessage({ content: [{ type: 'text', text: 问 }], source: { kind: 'user' } }))
    await 等到(f, () => f.请求们('0').length === 第几次)
    await 静一会(f, 300)
    assert.equal(f.请求们('0').length, 第几次, `「${问}」答完不接着转`)
    assert.equal((await 选择器(f)).last, 'reply')
    assert.equal(用户停下的(agent.session.ownEvents()), true, '答完照样停着')
    assert.equal(await 叫醒(f.ctx, f.根, '0', '机器想叫醒它'), false, '停着时机器叫醒不发')
  }
  assert.equal(f.选择们('0').length, 1, '用户的话不过选择机')
  assert.ok(!f.请求们('0').some(r => r.messages.some(是Goal轮)), 'Goal 没有替它开一轮')
  agent.steer(createUserMessage({ content: [{ type: 'text', text: '继续吧。' }], source: { kind: 'user' } }))
  await 等到(f, () => 当前持续目标(f.ctx, agent)?.phase === 'complete')
  assert.equal(f.选择们('0')[1]?.text.includes('上一个环节：reply；交接：用户让我接着做。'), true, 'next 以后这一轮当场过选择机')
  assert.ok(f.请求们('0').some(r => r.messages.some(是Goal轮)), '用 next 交接以后 Goal 接着转')
  assert.equal(行Of(await 读名册(f.根), '0').status, '完成')
  assert.deepEqual(f.failures, [])
})

// 10-19 幸存者游戏 10-19-3 的 helm：回话那一轮刚答完，3 号的传达塞进同一轮下一步，它批完接着干。
// 选 46：回话那一轮里到的纸条只记账、不塞进来；回完不改状态，接着等，孩子交回照常叫醒它，纸条随交齐一起送到（选 37）。
// 10-25 玄道 10-25 的总 dock：在等孩子时用户交代「这一轮整合完就停」，原来要么选成干活当场开工，要么选成回话停死、孩子交回也叫不醒。
test('等孩子时用户问一句：回话那一轮里到的纸条不塞进来；回完接着等，孩子交回照常叫醒，纸条和交回一起送到', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t, { 孩子们: ['声音'] }), agent = f.agents.get('0'), child = f.agents.get('1')
  f.model.answers.push('execute', 'complete')
  f.步骤('0', { before: 派出了(f), text: '派出去了，等声音交回。' },
    { when: r => 文字(r.messages).includes('现在进展怎么样？'),
      before: () => 传纸条(f.ctx, f.根, '1', '0', '声音开工口径：要加一个跳尸落地事件。', { kind: 'tell' }), text: '声音还在做。' },
    { when: r => 文字(r.messages).includes('音效三十个'),
      calls: [工具调用('交回', 'finish', { result: 'achieved', handoff: '声音并进来了。', checked: '自己验过：在台上跑了一遍' })] })
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  await 等到(f, () => 当前持续目标(f.ctx, agent)?.phase === 'blocked')
  agent.steer(createUserMessage({ content: [{ type: 'text', text: '现在进展怎么样？' }], source: { kind: 'user' } }))
  await 等到(f, () => f.请求们('0').length === 2)
  await 静一会(f, 300)
  assert.equal(f.请求们('0').length, 2, '纸条没有把回话那一轮接下去')
  assert.ok(!文字(f.请求们('0')[1].messages).includes('跳尸落地'))
  assert.ok((await 读纸条(f.根)).some(n => n.to === '0' && n.text.includes('跳尸落地')), '纸条记在账上')
  assert.equal(用户停下的(agent.session.ownEvents()), false, '回完不算停着')
  assert.equal(当前持续目标(f.ctx, agent)?.blockedReason?.code, 'blueprint-wait', '回完接着等')
  const 交回 = await f.ctx.tools.execute({ name: 'finish', arguments: { result: 'achieved', handoff: '音效三十个，放在 audio/。', checked: '自己验过：在台上跑了一遍' },
    agent: child, callId: ToolCallId('孩子交回'), signal: new AbortController().signal })
  assert.equal(交回.isError, false, JSON.stringify(交回))
  await 等到(f, async () => 行Of(await 读名册(f.根), '0').status === '完成', 10000)
  const 后来 = 文字(f.请求们('0').slice(2).flatMap(r => r.messages))
  assert.ok(后来.includes('音效三十个'), '孩子交回照常叫醒它')
  assert.ok(后来.includes('跳尸落地'), '纸条随交齐一起送到')
  assert.deepEqual(f.failures, [])
})

/**
 * 交回了的 helm 开新总分身走「新建任务线」那条路（要求账新 3）：给假宿主一个会话总管、装上首句话接缝；
 * 新会话的步骤预先排好（它的会话号事先不知道）。开出来以后记进 f.agents，等到() 也等它停稳。
 */
function 接上新分身(f, ...steps) {
  f.ctx.provide('sessionController', { create: ({ sessionId, cwd }) => f.ctx.agents.create({ sessionId,
    agentOptions: { provider: 'goal-continue-fixture', model: 'fixture' }, meta: { cwd } }) })
  装用户分身(f.ctx)
  const 原 = f.model.steps.get.bind(f.model.steps), 原有 = new Set([...f.agents.values()].map(a => a.session.id))
  f.model.steps.get = id => {
    if (!f.model.steps.has(id) && !原有.has(id)) f.model.steps.set(id, [...steps])
    return 原(id)
  }
  return async id => {
    const row = (await 读名册(f.根)).rows.find(r => r.id === id), agent = row?.session && f.ctx.agents.get(row.session)
    if (agent) f.agents.set(id, agent)
    return agent
  }
}
const 是交接记号 = m => m.source?.kind === `plugin:${交接来路}`

// 用户 10-14：「所有节点都可以对话」。交回只是告一段落。选 46：问一句直接回话，仍是交回；
// 让它干活，它在回话里用 next 交接，原地重新开工（十 54：一个座位始终一个 helm），这一轮当场过选择机接着做。
test('对交回了的 helm 说话：问一句直接回话、仍是交回；让它干活，它用 next 交接就原地重新开工，不开新的 helm（十 54）', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t), agent = f.agents.get('0')
  f.步骤('0', { calls: [工具调用('先交回', 'finish', { result: 'achieved', handoff: '小房间搭好了。', checked: '自己验过：在台上跑了一遍' })] },
    { when: r => 文字(r.messages).includes('为什么用暖色？'), text: '因为你说想要温馨的感觉。' },
    { when: r => 文字(r.messages).includes('再加一扇窗。'), calls: [工具调用('要加窗', 'next', { handoff: '用户要加窗，是新的活。' })] },
    { calls: [工具调用('再交回', 'finish', { result: 'achieved', handoff: '加了一扇窗。', checked: '自己验过：在台上跑了一遍' })] })
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  await 等到(f, async () => 行Of(await 读名册(f.根), '0').status === '完成' && 当前持续目标(f.ctx, agent)?.phase === 'complete')
  const 第一个目标 = 当前持续目标(f.ctx, agent).id

  agent.steer(createUserMessage({ content: [{ type: 'text', text: '为什么用暖色？' }], source: { kind: 'user' } }))
  await 等到(f, () => f.请求们('0').some(r => 文字(r.messages).includes('为什么用暖色？')))
  await 静一会(f)
  const 问的那轮 = f.请求们('0').at(-1)
  assert.match(插页们(问的那轮.messages).at(-1), /^【环节：reply】/, '交回了的节点也直接回话')
  assert.ok(!f.选择们('0').some(s => s.text.includes('为什么用暖色？')), '用户的话不过选择机')
  assert.equal(行Of(await 读名册(f.根), '0').status, '完成', '只是问一句，仍是交回')
  assert.equal(当前持续目标(f.ctx, agent).id, 第一个目标, '没有新建 Goal')

  f.model.answers.push('execute')
  agent.steer(createUserMessage({ content: [{ type: 'text', text: '再加一扇窗。' }], source: { kind: 'user' } }))
  await 等到(f, async () => 行Of(await 读名册(f.根), '0').handoff === '加了一扇窗。')
  const m = await 读名册(f.根)
  assert.equal(m.rows.length, 1, '一个座位始终一个 helm，不开新的')
  assert.equal(行Of(m, '0').status, '完成', '原地干完又交回')
  assert.ok(agent.session.deriveMessages().some(x => x.source?.kind === 'user' && 文字([x]) === '再加一扇窗。'), '这句话进的就是原来的对话')
  assert.ok(!agent.session.deriveMessages().some(是交接记号))
  assert.deepEqual(f.failures, [])
})

// 十 54、选 46：回话时它自己发现要做事、用 next 交接的，原地重新开工；这一轮不收，当场过选择机，接着做到交回。
test('交回了的 helm 在回话里用 next 交接：原地重新开工，这一轮当场过选择机接着做，不开新的 helm', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t), agent = f.agents.get('0')
  f.步骤('0', { calls: [工具调用('先交回', 'finish', { result: 'achieved', handoff: '小房间搭好了。', checked: '自己验过：在台上跑了一遍' })] },
    { when: r => 文字(r.messages).includes('顺手把灯也换了吧。'), calls: [工具调用('接着做', 'next', { handoff: '用户要换灯，是新的活。' })] },
    { calls: [工具调用('换完交回', 'finish', { result: 'achieved', handoff: '灯换好了。', checked: '自己验过：在台上跑了一遍' })] })
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  await 等到(f, async () => 行Of(await 读名册(f.根), '0').status === '完成')

  f.model.answers.push('execute')
  const 交回前 = f.请求们('0').length
  agent.steer(createUserMessage({ content: [{ type: 'text', text: '顺手把灯也换了吧。' }], source: { kind: 'user' } }))
  await 等到(f, async () => 行Of(await 读名册(f.根), '0').handoff === '灯换好了。')
  const [回话那步, 接着那步, ...多的] = f.请求们('0').slice(交回前)
  assert.equal(多的.length, 0, '同一轮里做完')
  assert.match(插页们(回话那步.messages).at(-1), /^【环节：reply】/)
  assert.match(插页们(新增(接着那步, 回话那步)).at(-1), /^【环节：execute】/, 'next 以后当场接上选出的那一页')
  assert.ok(f.选择们('0').at(-1).text.includes('上一个环节：reply；交接：用户要换灯，是新的活。'))
  const m = await 读名册(f.根)
  assert.equal(m.rows.length, 1, '不开新的 helm')
  assert.equal(行Of(m, '0').status, '完成', '原地干完又交回')
  assert.ok(!agent.session.deriveMessages().some(是交接记号))
  assert.deepEqual(f.failures, [])
})

// 选 23 对 print 照旧：交回了的 print 被叫去做事，原地重新开工、新建 Goal，干完再交回，不开新分身。
test('对交回了的 print 说要做事：照旧原地重新开工，不开新分身', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t, { 孩子们: ['门'] }), child = f.agents.get('1')
  接上新分身(f)
  // 孩子交回叫醒 0 号时它直接交回，免得 Goal 接着转。
  f.步骤('0', { calls: [工具调用('零交回', 'finish', { result: 'achieved', handoff: '门在作品里。', checked: '自己验过：在台上跑了一遍' })] })
  f.步骤('1', { when: r => 文字(r.messages).includes('再刷一遍漆。'), calls: [工具调用('刷完交回', 'finish', { result: 'achieved', handoff: '刷好了。', checked: '自己验过：在台上跑了一遍' })] })
  const 交回 = await f.ctx.tools.execute({ name: 'finish', arguments: { result: 'achieved', handoff: '门装好了。', checked: '自己验过：在台上跑了一遍' },
    agent: child, callId: ToolCallId('门交回'), signal: new AbortController().signal })
  assert.equal(交回.isError, false, JSON.stringify(交回))
  await 等到(f, async () => 行Of(await 读名册(f.根), '0').status === '完成')

  f.model.answers.push('execute')
  child.steer(createUserMessage({ content: [{ type: 'text', text: '再刷一遍漆。' }], source: { kind: 'user' } }))
  await 等到(f, async () => 行Of(await 读名册(f.根), '1').handoff === '刷好了。')
  assert.equal((await 读名册(f.根)).rows.length, 2, '没有开新分身')
  assert.equal(行Of(await 读名册(f.根), '1').status, '完成', '原地干完又交回')
  assert.ok(!child.session.deriveMessages().some(是交接记号))
  assert.deepEqual(f.failures, [])
})

// 用户 10-14：目标面板的「暂停」等同按停，「恢复」等同继续。
test('目标面板的暂停就是按停这个节点，恢复就是继续它', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t), agent = f.agents.get('0')
  const 开工了 = Promise.withResolvers()
  f.步骤('0', { before: r => { 开工了.resolve(); return new Promise((_, reject) => r.signal.addEventListener('abort', () => reject(r.signal.reason), { once: true })) } },
    { when: r => r.messages.some(是Goal轮), calls: [工具调用('恢复后交回', 'finish', { result: 'achieved', handoff: '恢复后做完了。', checked: '自己验过：在台上跑了一遍' })] })
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  await 开工了.promise
  const goals = f.ctx.get('goals'), 目标 = 当前持续目标(f.ctx, agent)
  goals.pause(agent, { id: 目标.id, revision: 目标.revision })
  await 等到(f, () => agent.status === 'idle' && 当前持续目标(f.ctx, agent)?.phase === 'paused')
  assert.equal(await 叫醒(f.ctx, f.根, '0', '机器想叫醒它'), false, '暂停以后谁也叫不醒')
  const 暂停的 = 当前持续目标(f.ctx, agent)
  goals.resume(agent, { id: 暂停的.id, revision: 暂停的.revision })
  await 等到(f, async () => 行Of(await 读名册(f.根), '0').status === '完成')
  assert.equal(当前持续目标(f.ctx, agent).phase, 'complete')
  assert.deepEqual(f.failures, [])
})

// 10-22 用户：helm 这件工作还没完成，整个项目 5 分钟没有节点在跑（后台程序不算），自动给 helm 发一段话叫它起来看看。
// 登记着等待条件的节点什么都动不了，所以先撤下 helm 的等待再走平常的叫醒，叫醒话里写清原来等什么；它看完自己再登记。
// 同一段卡住只叫一次，别的节点动过才算新的一段。
test('卡住提醒：helm 等的孩子一直没动，5 分钟后撤下它的等待叫它起来看；同一段只叫一次，孩子动过再卡才再叫', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t, { 孩子们: ['美术'] }), helm = f.agents.get('0'), 孩子 = f.agents.get('1')
  const 再等 = id => ({ when: r => 文字(r.messages).includes('没有节点在跑'), calls: [工具调用(id, 'wait', { reason: '等美术交回画风', conditions: [{ type: 'node', node: '1' }] })] })
  f.model.answers.push('plan')
  f.步骤('0', { calls: [工具调用('等美术', 'wait', { reason: '等美术交回画风', conditions: [{ type: 'node', node: '1' }] })] }, 再等('再等一'), 再等('再等二'))
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  await 等到(f, () => 当前持续目标(f.ctx, helm)?.phase === 'blocked')
  await 静一会(f)
  const 停时 = Date.now(), 叫醒话们 = () => f.请求们('0').filter(r => 文字(r.messages).includes('没有节点在跑'))
  assert.deepEqual(await 查卡住(f.ctx, f.根, 停时 + 4 * 60_000), [], '不到 5 分钟不叫')
  assert.deepEqual(await 查卡住(f.ctx, f.根, 停时 + 6 * 60_000), ['0'])
  await 等到(f, async () => 叫醒话们().length === 1 && !!行Of(await 读名册(f.根), '0').wait)
  await 静一会(f)
  const 文 = 文字(叫醒话们()[0].messages)
  assert.ok(文.includes(一段('重置/叫醒/没人在跑', { 分钟: 6 })), '叫醒话原样送到，带着几分钟')
  assert.ok(文.includes(一段('重置/叫醒/没人在跑撤等待', { 原因: '等美术交回画风', 条件: JSON.stringify([{ type: 'node', node: '1' }]) })), '写清原来在等什么')
  assert.equal(行Of(await 读名册(f.根), '0').wait.reason, '等美术交回画风', '看完自己又登记了等待')
  assert.equal(当前持续目标(f.ctx, helm)?.blockedReason?.code, 'blueprint-wait')
  assert.deepEqual(await 查卡住(f.ctx, f.根, Date.now() + 20 * 60_000), [], '同一段卡住只叫一次')
  记动静(f.ctx, 孩子.session.id)
  assert.deepEqual(await 查卡住(f.ctx, f.根, Date.now() + 6 * 60_000), ['0'], '孩子动过以后又卡住，再叫')
  await 等到(f, async () => 叫醒话们().length === 2 && !!行Of(await 读名册(f.根), '0').wait)
  assert.deepEqual(f.failures, [])
})

test('卡住提醒不叫的：本服务开着以后没动过的项目、在等用户回话的、挂着提问的、外部 run 等用户处理的、helm 交回了的', { timeout: 20000 }, async t => {
  // 10-23 用户：等人回话就该一直停着等，不算卡住。
  const f = await 搭续跑(t, { 孩子们: ['美术'] }), helm = f.agents.get('0')
  assert.deepEqual(await 查卡住(f.ctx, f.根, Date.now() + 60 * 60_000), [], '没动过的项目不看')
  f.model.answers.push('plan')
  f.步骤('0', { calls: [工具调用('问用户', 'wait', { reason: '等用户定画风', conditions: [{ type: 'input' }] })] },
    { when: r => 文字(r.messages).includes('没有节点在跑'), calls: [工具调用('再等美术', 'wait', { reason: '等美术交回画风', conditions: [{ type: 'node', node: '1' }] })] })
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  await 等到(f, () => 当前持续目标(f.ctx, helm)?.phase === 'blocked')
  await 静一会(f)
  const 过六分钟 = () => 查卡住(f.ctx, f.根, Date.now() + 6 * 60_000)
  assert.deepEqual(await 过六分钟(), [], '在等用户回话')
  await 改名册(f.根, m => ({ ...m, rows: m.rows.map(r => r.id === '0' ? { ...r, wait: { ...r.wait, conditions: [{ type: 'node', node: '1' }] } } : r) }))
  写问答(f.根, { frame: { session: f.agents.get('1').session.id, rpcId: '问画风' } })
  assert.deepEqual(await 过六分钟(), [], '这件工作里有人挂着提问')
  写问答(f.根, { frame: { session: f.agents.get('1').session.id, rpcId: '问画风' } }, true)
  const 原来 = 行Of(await 读名册(f.根), '1')
  for (const [说明, 改] of [
    ['外部 run 停着等用户处理（登录、额度、换模型）', r => ({ ...r, external: { attempt: 1, state: 'blocked' } })],
    ['外部 run 被用户按停', r => ({ ...r, external: { attempt: 1, state: 'running', userStopped: true } })],
  ]) {
    await 改名册(f.根, m => ({ ...m, rows: m.rows.map(r => r.id === '1' ? 改(原来) : r) }))
    assert.deepEqual(await 过六分钟(), [], 说明)
  }
  await 改名册(f.根, m => ({ ...m, rows: m.rows.map(r => r.id === '1' ? 原来 : r) }))
  assert.equal(f.请求们('0').filter(r => 文字(r.messages).includes('没有节点在跑')).length, 0)
  assert.deepEqual(await 过六分钟(), ['0'], '都不在等用户了，才叫')
  await 等到(f, async () => f.请求们('0').some(r => 文字(r.messages).includes('没有节点在跑')) && !!行Of(await 读名册(f.根), '0').wait)
  await 静一会(f)
  await 改名册(f.根, m => ({ ...m, rows: m.rows.map(r => ({ ...r, status: '完成' })) }))
  assert.deepEqual(await 查卡住(f.ctx, f.根, Date.now() + 60 * 60_000), [], '交回了')
})

// 10-22 用户：任务交回时给用户的是说明＋相关文件。finish 的 files 先核对都在，写错的退回、这次不交回。
test('finish 带相关文件：写了不存在的路径退回、不交回；路径都在才交回', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t, { 孩子们: ['美术'] }), 孩子 = f.agents.get('1')
  await writeFile(join(f.根, '画风说明.md'), '# 像素风')
  const 交 = files => f.ctx.tools.execute({ name: 'finish', arguments: { result: 'achieved', handoff: '画风定了像素。', checked: '自己验过：在台上跑了一遍', files },
    agent: 孩子, callId: ToolCallId(`交-${files.length}-${Math.random()}`), signal: new AbortController().signal })
  const 错 = await 交(['画风说明.md', '没有这个.png'])
  assert.equal(错.isError, true)
  assert.match(文字([{ content: 错.content }]), /files 里的 没有这个\.png/)
  assert.equal(行Of(await 读名册(f.根), '1').status, '开工', '写错了不交回')
  const 对 = await 交(['画风说明.md'])
  assert.equal(对.isError, false, JSON.stringify(对))
  assert.equal(行Of(await 读名册(f.根), '1').status, '完成')
})

// 10-22 用户：「现在改完之后，我和节点对话也会被锁住了」——座位轮里座位每一步都登记着等待，等着条件时整步退回，连用户的话也退回。
// 选 23：所有节点都可以对话。用户说话照样醒、过选择机，这一轮的工具也放行；登记着的等待不动，答完照旧等。
const 用户说 = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const 结果们 = (agent, id) => agent.session.ownEvents().filter(e => e.type === 'tool/result' && e.data?.message?.toolCallId === id)
  .map(e => 文字([e.data.message]))
test('等着条件时用户说话：照样醒、直接回话，这一轮的工具照常执行；等待不动，答完照旧等着', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t, { 孩子们: ['美术'] }), helm = f.agents.get('0')
  f.model.answers.push('plan', 'execute')
  f.步骤('0', { calls: [工具调用('等美术', 'wait', { reason: '等美术交回画风', conditions: [{ type: 'node', node: '1' }] })] },
    { when: r => 文字(r.messages).includes('画风到底定了没有？'), calls: [工具调用('看文档', 'node_doc', {})] },
    { text: '还在等美术交回画风。' })
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  await 等到(f, () => 当前持续目标(f.ctx, helm)?.phase === 'blocked')
  await 静一会(f)
  helm.steer(用户说('画风到底定了没有？'))
  await 等到(f, () => f.请求们('0').some(r => 文字(r.messages).includes('还在等美术交回画风。')) || 结果们(helm, '看文档').length > 0)
  await 静一会(f)
  assert.ok(!f.选择们('0').some(s => s.text.includes('画风到底定了没有？')), '用户的话不过选择机（选 46）')
  assert.ok(f.请求们('0').some(r => 插页们(r.messages).at(-1)?.startsWith('【环节：reply】')), '接的是回话页')
  const [回] = 结果们(helm, '看文档')
  assert.ok(回 && !回.includes('WAITING_FOR_CONDITION') && !回.includes('本次工具未执行'), `这一轮的工具照常执行：${回}`)
  assert.equal(行Of(await 读名册(f.根), '0').wait?.reason, '等美术交回画风', '等待不动')
  assert.equal(当前持续目标(f.ctx, helm)?.blockedReason?.code, 'blueprint-wait', '答完照旧等着')
  assert.deepEqual(f.failures, [])
})

test('用户说话放进来的那一轮里新登记了等待：同一批后面的工具照样挡', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t, { 孩子们: ['美术'] }), helm = f.agents.get('0')
  f.model.answers.push('plan', 'execute')
  f.步骤('0', { calls: [工具调用('等美术', 'wait', { reason: '等美术交回画风', conditions: [{ type: 'node', node: '1' }] })] },
    { when: r => 文字(r.messages).includes('改成等用户吧。'), calls: [
      工具调用('改等', 'wait', { reason: '等用户定画风', conditions: [{ type: 'input' }] }), 工具调用('又看文档', 'node_doc', {})] })
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  await 等到(f, () => 当前持续目标(f.ctx, helm)?.phase === 'blocked')
  await 静一会(f)
  helm.steer(用户说('改成等用户吧。'))
  await 等到(f, () => 结果们(helm, '又看文档').length > 0)
  await 静一会(f)
  assert.match(结果们(helm, '又看文档')[0], /本次工具未执行/)
  assert.equal(行Of(await 读名册(f.根), '0').wait?.reason, '等用户定画风')
})

// 选 46：回完不改状态。等着条件时用户问一句，答完照旧等着；等的到了照常叫醒它（选 39 那时停死、要用户再说一句）。
test('等着条件时用户问一句：直接回话；答完接着等，等的到了照常叫醒它', { timeout: 20000 }, async t => {
  const f = await 搭续跑(t, { 孩子们: ['美术'] }), helm = f.agents.get('0'), 孩子 = f.agents.get('1')
  f.model.answers.push('plan', 'execute')
  f.步骤('0', { calls: [工具调用('等美术', 'wait', { reason: '等美术交回画风', conditions: [{ type: 'node', node: '1' }] })] },
    { when: r => 文字(r.messages).includes('现在在等谁？'), text: '在等美术交回画风。' },
    { when: r => 文字(r.messages).includes('画风定了像素。'), text: '画风到了，接着做。' })
  assert.equal(await 叫醒(f.ctx, f.根, '0', 一段('重置/叫醒/开工')), true)
  await 等到(f, () => 当前持续目标(f.ctx, helm)?.phase === 'blocked')
  await 静一会(f)
  helm.steer(用户说('现在在等谁？'))
  await 等到(f, () => f.请求们('0').some(r => 文字(r.messages).includes('现在在等谁？')))
  await 静一会(f)
  assert.equal(helm.session.ownEvents().findLast(e => e.type === 'turn/end')?.data.reason.kind, 'completed', '答完正常收尾，没有被挡')
  assert.equal(用户停下的(helm.session.ownEvents()), false, '答完不算停着')
  assert.equal(当前持续目标(f.ctx, helm)?.blockedReason?.code, 'blueprint-wait', '答完接着等')
  const 交 = await f.ctx.tools.execute({ name: 'finish', arguments: { result: 'achieved', handoff: '画风定了像素。', checked: '自己验过：在台上跑了一遍' },
    agent: 孩子, callId: ToolCallId('美术交回-回话后'), signal: new AbortController().signal })
  assert.equal(交.isError, false, JSON.stringify(交))
  // 等的到了它接着转（Goal 放开以后假模型每轮只说一句），看到叫醒就先暂停 Goal，再等停稳。
  await 直到(() => f.请求们('0').some(r => 文字(r.messages).includes('画风定了像素。')), 10000)
  const 目标 = 当前持续目标(f.ctx, helm)
  if (目标?.phase === 'active') f.ctx.get('goals').pause(helm, { id: 目标.id, revision: 目标.revision })
  await helm.whenIdle()
  assert.deepEqual(f.failures, [])
})
