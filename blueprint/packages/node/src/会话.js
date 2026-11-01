/**
 * 会话：node 碰 dsh 会话的全部地方 —— 开一个节点、叫醒一个节点。
 *
 * 机器让一个节点开始一轮，只有一个动作：**叫醒**（往它的会话里递一句话，说清为什么叫它）。
 * 出生也是叫醒：`开节点()` 建会话、把会话号记进名册，然后叫醒它；
 * 它醒来第一步，`context` 把它的节点前缀摆在最前面。
 */

import { 有待回答 } from '../../roster/src/问答.js'
import { 关掉留下的进程 } from './留下的进程.js'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { 一段 } from '../../prompt/src/index.js'
import { 项目根, 改名册, 读名册, 记会话, 行Of, 我是谁, 在等谁, 读模型表, 后代们, 上级链, 派出者Of,
  读纸条, 重开, 是spark } from '../../roster/src/index.js'
import { 等前置, 等开工孩子, 交齐汇总, 汇总里的新孩子 } from '../../roster/src/组织.js'
import { 补齐组织文档, 补齐组织收据, 叫回run } from './组织设计.js'
import { 叫醒来路, 重建叫醒, 用户续工来路, 用户停下的 } from './规则.js'
import { 关闭节点终端 } from './终端.js'
import { 离开工具执行 } from './项目隔离.js'
import { 送未送纸条, 原生输入已收, 在等回条 } from './纸条.js'
import { 等待允许输入 } from './纸条等待.js'
import { 准备节点Git空间, 节点工作目录, 接着做前并入话 } from './节点Git空间.js'
import { 在等条件, 运行卡点, 复查项目等待 } from './条件等待.js'
import { 记节点起点 } from './节点起点.js'
import { 节点会话事实 } from './会话事实.js'
import { 当前持续目标, 复查持续工作, 停用持续工作, 开持续目标, 目标在转 } from './持续工作.js'
import { 项目停着 } from './项目停下.js'
import { 是外部run, 开工外部run, 关掉的改回 } from './外部run.js'
import { 刚收尾 } from './收尾.js'

/** 项目的模型表归 roster（所有节点读同一份）；这儿转手出去。 */
export { 读模型表 }

/** 节点的组装名：座位卡那一格的名字（`.dsh/.agent-presets/blueprint/`）。所有节点照它装。 */
export const 组装名 = 'blueprint'
export const 节点醒来事件 = 'blueprint/node-awake'

/**
 * 输入投递前按目标 agent 的原生 scope 递交；忙着的节点由后端留到下一轮处理。
 * `重建`：一圈边界的叫醒（成果报告、孩子交齐、请求被改写）才按节点文档重建 context；
 * 纸条、回条、求助、开工、用户说话与 Start All 恢复都接着原来的 context。
 */
export async function 节点醒来(ctx, 根, id, agent, { 重建 = false } = {}) {
  await agentEvents(ctx, agent).serial(节点醒来事件, { 根, id: String(id), 重建 })
}

/**
 * 节点的当前目录放进它自己的产物空间（0 号是 作品/，其余是 作品空间/<编号>）：相对路径、命令、终端都从这里起。
 * 有台的块（十步重置 10-24）放进台目录：它的空间里只检出了台（节点Git空间.js 的 节点工作目录）。
 * 会话头的 cwd 仍是项目根，那是项目身份。没有原生目录服务的宿主（离线核对）不设。
 * `只从项目根迁`：恢复旧会话时只搬还停在项目根的；换过目录的（新节点出生就在空间里，或模型自己 cd 过）不动。
 */
export async function 进入产物空间(目录服务, agent, 根, id, { 只从项目根迁 = false, bench = '' } = {}) {
  if (typeof 目录服务?.set !== 'function') return
  if (只从项目根迁 && 目录服务.get(agent.session) !== agent.session.header.cwd) return
  await 目录服务.set(agent, join(根, 节点工作目录({ id: String(id), bench })))
}

/** dsh 的会话总管（建会话、给会话递话都走它）。 */
function 总管Of(ctx) {
  const c = ctx.get('sessionController') || (ctx.root && ctx.root.get && ctx.root.get('sessionController'))
  if (!c) throw new Error('这个部署没有 sessionController —— 开不了节点')
  return c
}

/**
 * 开一个节点：建会话（cwd ＝ 项目文件夹，照组装名装）→ 会话号记进名册 → 叫醒。
 *
 * - **派出者派的**（`spawn`）：`agents.create`，dsh 血统上挂在派出者底下（`parentSession`），
 *   工具照派出者身上那一套接过来（`composeFrom`）。界面那棵树就是顺这层血统长的。
 * - **没有派出者**（0：建项目）：`sessionController.create`，照组装名装。
 * 不走 dsh 的 subagent：开出来的是独立会话，界面上能直接跟它说话；run 也一样。
 *
 * @param {object|null} 派出者 派它的那个活 agent；0 没有
 * @returns {Promise<string>} 会话号
 */
const 开节点中 = new Map()

export async function 开节点(ctx, 根, id, 派出者 = null, options = {}) {
  const key = `${根}#${id}`
  if (开节点中.has(key)) return 开节点中.get(key)
  const 任务 = (async () => {
    const 名册 = await 读名册(根), 行 = 行Of(名册, id)
    if (行.status === '去掉') return 行.session || null
    // 交给 Codex／Claude Code 的 run 自己当这个节点，没有 DeepSeek 会话；它由 外部run.js 开工（叶 6）。
    if (是外部run(行)) return null
    // spark 只陪用户聊、不动成品：不开 Git 空间，当前目录留在项目根（十 56）。
    if (!是spark(行)) await 准备节点Git空间(根, 行, 名册, { 新建项目: options.新建项目 === true })
    if (行.session) {
      if (options.纸条 !== false) await 送未送纸条(ctx, 根, id)
      return 行.session
    }
    // 开节点常在派出者的 spawn／finish 里发生：新节点的循环不带那次工具执行的边界。
    const parent = 派出者Of(id, 名册)
    const sourceSession = parent === null ? null : 行Of(名册, parent).session
    if (!派出者 && sourceSession) 派出者 = ctx.root.agents.get(sourceSession) || await 捞回来(ctx, 根, sourceSession)
    const inherited = { ...options, ...(Object.hasOwn(options, 'parentSession') ? {} : { parentSession: parent === null ? null : 行Of(名册, parent).session }) }
    return 离开工具执行(() => 新开节点(ctx, 根, id, 派出者, inherited))
  })()
  开节点中.set(key, 任务)
  try { return await 任务 } finally { 开节点中.delete(key) }
}

async function 新开节点(ctx, 根, id, 派出者 = null, options = {}) {
  await 记节点起点(根, id)
  const 新行 = 行Of(await 读名册(根), id), 会话 = `session-${randomUUID()}`, bench = 新行.bench || '', spark = 是spark(新行)
  if (派出者) {
    const 模型 = await 读模型表(根)
    const parentSession = Object.hasOwn(options, 'parentSession') ? options.parentSession : 派出者.session.id
    await ctx.root.agents.create({
      sessionId: 会话,
      meta: { cwd: 根, agentPreset: 组装名, ...(parentSession == null ? {} : { parentSession: String(parentSession) }) },
      agentOptions: 模型 ? { provider: 模型.provider, model: 模型.model } : {},
      /* 目录照抄 dsh 子 agent 出生的做法（先设目录）；照抄 dsh 的 applyChildComposition：不 composeFrom，新会话的工具表是空的。 */
      setup: async (子ctx, 子) => {
        if (!spark) await 进入产物空间(子ctx.get('workingDirectory'), 子, 根, id, { bench })
        子ctx.get('agentPresets')?.composeFrom(子ctx, 派出者.ctx)
      },
    })
  } else {
    await 总管Of(ctx).create({ sessionId: 会话, cwd: 根, agentPreset: 组装名 })
  }
  await 改名册(根, (m) => 记会话(m, id, 会话))
  // 会话总管建会话没有 setup 口：记进名册后再设目录。设不上不拦开工：先留在项目根，下次冷恢复时再迁。
  if (!派出者 && !spark) {
    const agent = ctx.root.agents.get(会话)
    try { if (agent) await 进入产物空间(ctx.get('workingDirectory'), agent, 根, id, { bench }) }
    catch (error) { console.log(`Blueprint node: ⚠️ ${id} 的当前目录没有设进产物空间，先留在项目根 —— ${error.message || error}`) }
  }
  // 创建会话期间分支可能已被去掉；刚注册的会话也必须停止。
  if (行Of(await 读名册(根), id).status === '去掉') {
    const agent = ctx.root.agents.get(会话)
    agent?.cancel({ kind: 'parent' })
    await agent?.whenIdle()
    return 会话
  }
  if (options.叫醒 !== false) await 叫醒(ctx, 根, id, 一段('重置/叫醒/开工'))
  else if (options.纸条 !== false) await 送未送纸条(ctx, 根, id)
  return 会话
}

/** 整支先建会话，正式前置满足的节点启动；children 不经过统筹确认门。 */
/** 用户动作：用户按了继续或全部启动；等用户处理的外部 run 只在这时再试。 */
export async function 开团队(ctx, 根, id, 派出者, { 用户续工 = false, 仅新建 = false, 用户动作 = false } = {}) {
  await 补齐组织文档(ctx, 根)
  const m = await 读名册(根)
  const ids = [String(id), ...后代们(m, id)].filter(n => 行Of(m, n).status === '开工')
    .sort((a, b) => 上级链(a, m).length - 上级链(b, m).length)
  // 用户在「Agent 选择」页关掉了的那家：还没开工、被打断、等用户的块改回 DeepSeek 做，下面照 DeepSeek 的 run 建会话、叫醒。
  await 关掉的改回(根, ids)
  const 新开的 = new Set()
  for (const n of ids) {
    const 册 = await 读名册(根), r = 行Of(册, n)
    if (是外部run(r)) continue
    if (r.session) {
      if (!仅新建) await 开节点(ctx, 根, n, 派出者, { 叫醒: false, 纸条: false })
      continue
    }
    const parent = 派出者Of(n, 册)
    const sourceSession = parent === null ? null : 行Of(册, parent).session
    const source = sourceSession ? ctx.root.agents.get(sourceSession) || await 捞回来(ctx, 根, sourceSession) : 派出者
    await 开节点(ctx, 根, n, source || 派出者, { 叫醒: false, 纸条: false, parentSession: parent === null ? null : 行Of(册, parent).session })
    新开的.add(n)
  }
  for (const n of ids) {
    const 册 = await 读名册(根), r = 行Of(册, n)
    // 外部 run：新开、改写的开工；被打断的接着做；等用户的只在用户动作时再试。启动不上不拦别的节点。
    if (是外部run(r)) { await 开工外部run(ctx, 根, n, { 用户动作 }).catch(error => console.log(`Blueprint node: 外部 run ${n} 没启动 —— ${error.message || error}`)); continue }
    if (r.kickoff) { await 启动待发(ctx, 根, n); continue }
    if (等前置(册, n).length) continue
    const agent = ctx.root.agents.get(r.session)
    const facts = agent && 节点会话事实(ctx, agent.session)
    const 未开始 = agent && !agent.session.deriveMessages().length && !(facts
      ? facts.lastEndedTurn !== null : agent.session.ownEvents().some(e => e.type === 'turn/end'))
    if ((用户续工 && n === String(id)) || (!新开的.has(n) && !未开始 && 在等谁(册, n).length)) continue
    if (新开的.has(n) || (!仅新建 && 未开始)) await 叫醒(ctx, 根, n, 一段('重置/叫醒/开工'), { 等子节点: !新开的.has(n) && !未开始 })
  }
  await 补齐组织收据(根)
}

const 启动中 = new Map()
export function 启动待发(ctx, root, id) {
  const key = `${root}#${id}`, prior = 启动中.get(key) || Promise.resolve()
  const task = prior.catch(() => {}).then(async () => {
    const m = await 读名册(root), r = 行Of(m, id)
    if (是外部run(r)) return 开工外部run(ctx, root, id)
    if (!r.kickoff || r.kickoff.delivered || r.status !== '开工' || 等前置(m, id).length || 等开工孩子(m, id).length) return false
    // 接着用一个节点（同一阶段里交回过的子 dock 接着改，请求被改写，十 42）：先把派它的节点此刻的分支并进它的空间，并了什么、撞了什么接在叫醒后面（轮 3）；
    // 台换了的，稀疏规则在 准备节点Git空间 里换好，工作目录跟着搬进新台。
    if (r.kickoff.kind === 'rewrite') await 换进台(ctx, root, r)
    // 叫回的 run（十 60）不按文档重建：它记得的东西就是叫回它的理由；这次的请求接在对话末尾。
    const 叫回 = 叫回run(r)
    const 话 = r.kickoff.kind === 'rewrite' ? [叫回 ? 一段('叫醒/叫回', { 请求: r.kickoff.request || '（见节点文档记录段的最后一节）' }) : 一段('叫醒/改写'),
      await 接着做前并入话(root, m, id)].filter(Boolean).join('\n\n')
      : 一段('重置/叫醒/开工')
    const delivered = await 叫醒(ctx, root, id, 话, { 重建: r.kickoff.kind === 'rewrite' && !叫回, inputId: r.kickoff.id, 重开续跑: true })
    if (delivered) await 改名册(root, latest => ({ ...latest, rows: latest.rows.map(row => row.id === String(id) && row.kickoff?.id === r.kickoff.id
      ? { ...row, kickoff: { ...row.kickoff, delivered: true },
        ...(r.start === 'children_done' && row.aggregate && row.aggregate.id === r.aggregate?.id
          ? { aggregate: { ...row.aggregate, delivered: true } } : {}) } : row) }))
    return delivered
  })
  启动中.set(key, task)
  return task.finally(() => { if (启动中.get(key) === task) 启动中.delete(key) })
}

/** 接着用前：空间照这次的台检出（换了台的换稀疏规则），工作目录搬进台。设不上不拦开工，记一行日志。 */
async function 换进台(ctx, root, r) {
  if (!r.session || !r.bench) return
  try {
    await 准备节点Git空间(root, r, await 读名册(root))
    const agent = ctx.root.agents.get(r.session) || await 捞回来(ctx, root, r.session)
    await 进入产物空间(ctx.get('workingDirectory'), agent, root, r.id, { bench: r.bench })
  } catch (error) { console.log(`Blueprint node: ⚠️ ${r.id} 接着用时没换进台 ${r.bench} —— ${error.message || error}`) }
}

/** 每项正式交回独立释放后置；最后一项交回再投递母节点的汇总。可重试。 */
export async function 推进组织(ctx, root, creator, { scope, 用户动作 = false } = {}) {
  await 补齐组织文档(ctx, root)
  const m = await 读名册(root)
  const roots = scope ? [行Of(m, scope)] : m.rows.filter(r => r.parent === null)
  for (const r of roots) await 开团队(ctx, root, r.id, creator, { 用户续工: true, 仅新建: true, 用户动作 })
  const members = scope ? new Set([String(scope), ...后代们(m, scope)]) : null
  for (const r of (await 读名册(root)).rows) {
    if (members && !members.has(r.id)) continue
    if (r.status !== '开工' || !r.aggregate || r.aggregate.delivered) continue
    await 补送节点汇总(ctx, root, r.id)
  }
}

/** 正常收尾只补送已登记的交齐事实，不因节点尚未交回而制造新一轮。 */
export function 补送节点汇总(ctx, root, id) {
  const key = `${root}#aggregate#${id}`, pending = 启动中.get(key)
  if (pending) return pending
  const task = Promise.resolve().then(async () => {
    const latest = await 读名册(root), row = 行Of(latest, id)
    if (row.status !== '开工' || !row.aggregate || row.aggregate.delivered || 在等谁(latest, id).length || 等前置(latest, id).length) return
    if (row.start === 'children_done' && row.kickoff && !row.kickoff.delivered) { await 启动待发(ctx, root, id); return }
    // 这一圈新交回的给全文，前面已经送到过的各留一行（10-22）；送到了就把这次给了全文的孩子记上。
    const 汇总 = 交齐汇总(latest, id, root), 新的 = new Set(汇总里的新孩子(latest, id))
    if (await 叫醒(ctx, root, id, 一段('叫醒/交差', { 汇总 }), { 等子节点: true, 纸条: false, 重建: true, inputId: row.aggregate.id, 重开续跑: true })) {
      await 改名册(root, current => ({ ...current, rows: current.rows.map(n => n.id === String(id) && n.aggregate?.id === row.aggregate.id
        ? { ...n, aggregate: { ...n.aggregate, delivered: true } } : 新的.has(n.id) ? { ...n, reportedIn: row.aggregate.id } : n) }))
      // 孩子没交回期间压着没送的传达，跟这次叫醒一起送到（选 37）。
      await 送未送纸条(ctx, root, id)
    }
  }).finally(() => { if (启动中.get(key) === task) 启动中.delete(key) })
  启动中.set(key, task)
  return task
}

/** 上一轮被切断：进程退出时这一轮还开着，dsh 载入时补记 `interrupted`。它当时在干活，不是自己停下来等。 */
function 上一轮被切断(session) {
  const last = session.ownEvents().findLast(e => e.type === 'turn/start' || e.type === 'turn/end')
  return last?.type === 'turn/end' && last.data?.reason?.kind === 'interrupted'
}

/**
 * Start All 和单个节点的启动钮只恢复可运行的责任。
 * 孩子没交齐不挡（10-19 用户：「交完之后强行 block 的锁」先失效，同 持续工作.js）；
 * 上一轮被切断的，等回条也不挡——它当时正在做自己的活（10-20 用户：5、6 号被重启切断后点启动没反应）。
 */
export async function 准备节点续工(ctx, 根, id) {
  id = String(id)
  await 补齐组织文档(ctx, 根)
  if (行Of(await 读名册(根), id).status === '去掉') return { waitingForChildren: [], completed: true, removed: true }
  await 开节点(ctx, 根, id, null, { 叫醒: false, 纸条: false })
  const agent = ctx.root.agents.get(行Of(await 读名册(根), id).session)
    || await 捞回来(ctx, 根, 行Of(await 读名册(根), id).session)
  await 推进组织(ctx, 根, agent, { scope: id, 用户动作: true })
  const 切断 = 上一轮被切断(agent.session)
  const 挡着 = (m, 纸条) => !!(等前置(m, id).length || 在等条件(m, id, agent.session, ctx).length
    || (!切断 && 在等回条(纸条, id, m, agent.session, ctx).length))
  let m = await 读名册(根)
  const 仍在等待 = 挡着(m, await 读纸条(根))
  if (行Of(m, id).status !== '完成' && 仍在等待 && (节点会话事实(ctx, agent.session)?.userStopped ?? 用户停下的(agent.session.ownEvents()))) {
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 一段('叫醒/等待') }],
      source: { kind: `plugin:${用户续工来路}` } }), { surfaceOp: 'append' })
    m = await 读名册(根)
  }
  await 送未送纸条(ctx, 根, id, { 恢复: true })
  // 复查管的是全项目：别的节点出事不能让这个节点续不了工（10-15-1 Start All 四个全没递进去）。
  await 复查项目等待(ctx, 根).catch(error =>
    console.log(`Blueprint node: Start All 前的项目复查失败，照常恢复 ${id} —— ${error.message || error}`))
  m = await 读名册(根)
  const 纸条 = await 读纸条(根)
  const ready = { id, session: agent.session.id, waitingForChildren: 在等谁(m, id), waitingForPrerequisites: 等前置(m, id),
    waitingForNotes: 在等回条(纸条, id, m, agent.session, ctx).map(n => n.id), waitingForConditions: 在等条件(m, id, agent.session, ctx), completed: 行Of(m, id).status === '完成',
    interrupted: 切断 }
  ready.resumable = !ready.completed && !挡着(m, 纸条)
  if (ready.resumable && !有待回答(根, agent.session.id)) await 节点醒来(ctx, 根, id, agent)
  return ready
}

/**
 * 冷了的节点捞回来（进程重起过、或者 dsh 把闲着的放掉了）。
 *
 * ⚠️ **走 `mount()`，不走 `recompose()`**：捞回来的个个都跑过，`recompose` 只对还没产出过内容的会话合法。
 * 界面上对一个冷节点说话之前，也用它先捞回来（studio）。
 *
 * 同一个会话只捞一次：dsh 恢复先拿会话写锁，同一进程里并发恢复同一个会话，后来的那次被拒
 * （already owned by an active write handle）。重启后复查等待、Start All、界面发话可能同时捞同一个节点：
 * 已经活着的直接用，正在捞的等那一次捞完。
 */
const 捞回中 = new WeakMap()

export function 捞回来(ctx, 根, 会话) {
  const 活着 = ctx.root.agents.get(会话)
  if (活着) return Promise.resolve(活着)
  let 进行中 = 捞回中.get(ctx.root)
  if (!进行中) { 进行中 = new Map(); 捞回中.set(ctx.root, 进行中) }
  if (进行中.has(会话)) return 进行中.get(会话)
  const task = 恢复会话(ctx, 根, 会话).finally(() => 进行中.delete(会话))
  进行中.set(会话, task)
  return task
}

async function 恢复会话(ctx, 根, 会话) {
  const 名册 = await 读名册(根), id = 我是谁(名册, 会话)
  if (id === null) throw new Error('恢复会话不在项目名册里')
  // 冷恢复也可能发生在开节点的纸条补送中，直接核验，不能反等开节点自己的去重 promise。
  await 准备节点Git空间(根, 行Of(名册, id), 名册)
  const 模型 = await 读模型表(根)
  const handle = await ctx.root.agents.resume({
    resumeSessionId: 会话,
    agentOptions: 模型 ? { provider: 模型.provider, model: 模型.model } : {},
    // 目录记在会话账本里，冷恢复原样带回；还停在项目根的旧节点趁这次搬进自己的产物空间。
    setup: async (子ctx, 子) => {
      await 子ctx.get('agentPresets')?.mount(子ctx, 组装名)
      await 进入产物空间(子ctx.get('workingDirectory'), 子, 根, id, { 只从项目根迁: true, bench: 行Of(名册, id).bench || '' })
    },
  })
  return handle.agent
}

/**
 * 叫醒一个节点：往它的会话里递一句 `话`（为什么叫它）。
 * 在跑的收到它，下一步接着走；停着的收到它，开一轮新的；冷了的先捞回来。
 *
 * 不叫的两种：已经交差的；最近一轮被用户手动停下的（那是人要看一眼的时候）。
 * 上级改写意图时，名册先把它改回「开工」，再叫。
 *
 * @returns {Promise<boolean>} 叫了没有
 */
const 叫醒中 = new WeakMap(), 已固化输入 = new WeakMap()

export function 叫醒(ctx, 根, id, 话, options = {}) {
  // 叫醒常在别的节点的工具执行里发生（交差、改写）：被叫醒的那一轮不带那次工具执行的边界。
  if (!options.inputId) return 离开工具执行(() => 叫醒节点(ctx, 根, id, 话, options))
  let pending = 叫醒中.get(ctx.root)
  if (!pending) { pending = new Map(); 叫醒中.set(ctx.root, pending) }
  const key = `${根}#${id}#${options.inputId}`
  if (pending.has(key)) return pending.get(key)
  const task = Promise.resolve().then(() => 离开工具执行(() => 叫醒节点(ctx, 根, id, 话, options)))
    .finally(() => pending.delete(key))
  pending.set(key, task)
  return task
}

/** 内存只记已成功 flush 的输入；冷恢复或失败重试仍核对原生收据并固化。 */
async function 固化叫醒输入(ctx, session, inputId) {
  let confirmed = 已固化输入.get(session)
  if (!confirmed) { confirmed = new Set(); 已固化输入.set(session, confirmed) }
  if (confirmed.has(inputId)) return
  await ctx.sessions.flush(session)
  if (!原生输入已收(session, message => message?.id === inputId, ctx)) throw new Error(`叫醒输入未进入目标会话账本：${inputId}`)
  confirmed.add(inputId)
}

async function 叫醒节点(ctx, 根, id, 话, { 等子节点 = false, 孩子没回不叫 = false, 纸条 = true, 重建 = false, inputId, waitId, 重开续跑 = !!waitId } = {}) {
  const m = await 读名册(根)
  if (!m) return false
  const r = 行Of(m, id)
  if (!r.session) return false
  const 不可叫 = () => (等子节点 && 在等谁(m, id).length) || 等前置(m, id).length || 等开工孩子(m, id).length || r.status !== '开工' || 有待回答(根, r.session)
  if (!inputId && 不可叫()) return false
  const agent = ctx.root.agents.get(r.session) || await 捞回来(ctx, 根, r.session)
  const 已收 = () => 原生输入已收(agent.session, message => message?.id === inputId, ctx)
  if (inputId && 已收()) {
    // 上次投递后刷盘失败，先固化已收到的输入，不重复叫醒后端或 steer。
    await 固化叫醒输入(ctx, agent.session, inputId)
    return true
  }
  if (inputId) 已固化输入.get(agent.session)?.delete(inputId)
  if (不可叫()) return false
  // 成果发布这类通知：派出去的还没全交回、它又闲着，就先不叫醒；全部交回后名册一变就会再送（选 37）。
  if (孩子没回不叫 && agent.status === 'idle' && 在等谁(m, id).length) return false
  // 用户按停了这个项目：谁也叫不醒，等用户输入任何东西再继续（选 22）。
  if (项目停着(根)) return false
  if (节点会话事实(ctx, agent.session)?.userStopped ?? 用户停下的(agent.session.ownEvents())) return false
  if (纸条) await 送未送纸条(ctx, 根, id)
  if ((await 运行卡点(ctx, agent.session, { waitId })).length) return false
  await 节点醒来(ctx, 根, id, agent, { 重建 })
  // 叫醒话原样送；它开的那一轮第一步再过选择机（思考开头的 pre-step）。
  const input = String(话)
  if (r.initialState && r.initialState.input === undefined) await 记节点起点(根, id, input)
  // 推迟了（它这一步刚收尾）：停稳后才进账本。带编号的这次先不算叫到、不当场核收据，下次照编号认，不会再递一遍；不带编号的照旧算叫了。
  const 推迟 = 递叫醒(agent, input, { ctx, 重建, inputId })
  if (inputId && 推迟) return false
  if (inputId) {
    await 固化叫醒输入(ctx, agent.session, inputId)
  }
  // 第一次叫醒（开工、启动待发）时建 Goal：先递话让它这一轮跑起来，再建，免得 Goal 抢在开工话前面开空的一轮。
  // Goal 完成了、节点又开着工的（交回后被接着用、等的到了、交齐、叫起来看卡住）由这些叫醒带 重开续跑 重建；纸条、通知、阶段报告不开。
  const 名册 = await 读名册(根)
  开持续目标(ctx, agent, 行Of(名册, id), { 重开续跑 })
  return true
}

/**
 * 将调用方已核验的叫醒请求构造成原生输入；忙时的补启在停稳后再核验。
 * 要重建的叫醒带上标记：它若在忙时到达、留到新一轮，新一轮第一步照样先重建。
 */
export function 递叫醒(agent, 话, { ctx, 重建 = false, inputId } = {}) {
  const message = createUserMessage({
    content: [{ type: 'text', text: String(话) }],
    source: { kind: `plugin:${叫醒来路}`, ...(重建 ? { summary: 重建叫醒 } : {}) },
  })
  // createUserMessage 总是生成新 id；已有投递身份使用原生 freezeMessage 保留。
  const input = inputId ? freezeMessage({ ...message, id: inputId }) : message
  if (ctx) return 递自动输入(ctx, agent, input)
  agent.steer(input)
  return false
}

/**
 * 自动结果忙时只进入原生 Inbox；停稳读到取消原因后，才决定是否补启。
 * 这一步刚用收尾工具结束了这一轮（收尾.js）：等这一轮停稳再照常投递，不插进这一轮的下一步。
 * 返回 true 表示推迟了：这时账本里还没有它，调用方别当场核收据（10-23 恶魔之魂 10-23-2：4 号给刚收尾的 2 号传纸条，
 * 当场核不到就报「纸条未进入目标会话账本」，4 号以为没发出去，换着写法连发了五次）。停稳后它会到；没到的，下次补送照账本重送。
 */
export function 递自动输入(ctx, agent, message) {
  if (!刚收尾(agent)) { 照常递(ctx, agent, message); return false }
  void agent.whenIdle().then(() => 照常递(ctx, agent, message))
    .catch(error => console.log(`Blueprint node: 收尾后补投自动输入失败 —— ${error.message || error}`))
  return true
}

function 照常递(ctx, agent, message) {
  let 根 = null
  try { 根 = 项目根(ctx, agent.session.id) } catch { /* 不在项目里的会话 */ }
  const stopped = () => 项目停着(根) || (节点会话事实(ctx, agent.session)?.userStopped ?? 用户停下的(agent.session.ownEvents()))
  if (agent.inject && 目标在转(当前持续目标(ctx, agent)) && !stopped()) {
    // Goal 在转：输入并进它的下一轮（pre-step 把它和 Goal 那一轮合成一份）。被业务等待挡着就先复查能不能放开；
    // 还挡着（等回条、等孩子）也照样叫醒它处理这件事（选 18），Goal 等卡点清了再接着转。
    agent.inject(message)
    void (async () => {
      await 复查持续工作(ctx, agent, { 恢复: true })
      const 现在 = 当前持续目标(ctx, agent)
      if (现在?.phase === 'active' && 现在.activation === 'armed') return
      await 停稳后补启(ctx, agent, message, stopped)
    })().catch(error => console.log(`Blueprint node: 持续目标输入复查失败 —— ${error.message || error}`))
    return
  }
  if (!agent.inject || (agent.status === 'idle' && !stopped())) return agent.steer(message)
  agent.inject(message)
  void 停稳后补启(ctx, agent, message, stopped).catch(error => console.log(`Blueprint node: 自动输入停稳后补启失败 —— ${error.message || error}`))
}

/** 忙时进了原生 Inbox 的自动输入：停稳以后核验，还该做就补启一轮。 */
async function 停稳后补启(ctx, agent, message, stopped) {
  await agent.whenIdle()
  const active = () => {
    try { ctx.fiber?.assertActive(); agent.ctx?.fiber?.assertActive() } catch { return false }
    return ctx.root.agents.get(agent.session.id) === agent && agent.status === 'idle' && !stopped()
  }
  if (!active() || !await 等待允许输入(ctx, agent.session, [message])) return
  let root
  try { root = 项目根(ctx, agent.session.id) } catch { return }
  const roster = await 读名册(root), id = roster && 我是谁(roster, agent.session.id)
  if (!id || !active() || 有待回答(root, agent.session.id)) return
  const pending = agent.inbox.nextStep.find(input => input.id === message.id)
  if (!pending) return
  agent.inbox.remove(pending.id)
  agent.steer(pending)
  await ctx.sessions.flush(agent.session)
}

/**
 * 交回了的节点又被叫去干活（选择机选的不是回话）：它重新开工，交回结论清掉，干完再交回（用户 10-14）。
 * 母节点已经收过的交齐汇总一并清掉，它再交回时母节点会重新收到。
 */
export async function 重新开工(根, id) {
  await 改名册(根, m => {
    const r = 行Of(m, id)
    if (r.status !== '完成') return m
    const 爹 = 派出者Of(id, m), 新 = 重开(m, id)
    return { ...新, rows: 新.rows.map(row => 爹 !== null && row.id === 爹 && row.aggregate?.delivered
      ? Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'aggregate')) : row) }
  })
}

/** 本轮尚在工作的节点及其辅助会话；归属沿原生血统查找，不再投影调用计数。 */
export function 相关会话(ctx, m, id, { 全部 = false, 节点们 } = {}) {
  const descendants = new Set(节点们 || 后代们(m, id))
  const nodes = new Set(m.rows.filter(r => (r.id === id || descendants.has(r.id)) && (全部 || r.id === id || r.status === '开工')).map(r => r.session))
  const 全节点 = new Set(m.rows.map(r => r.session))
  const registry = ctx.root.agents
  return [...registry.list()].filter(agent => {
    let session = agent.session
    const seen = new Set()
    while (session && !seen.has(session.id)) {
      if (全节点.has(session.id)) return nodes.has(session.id)
      seen.add(session.id)
      const parent = session.header.parentSession
      session = registry.get(parent)?.session || ctx.sessions.get(parent)
    }
    return false
  })
}

export async function 停止后台(ctx, agents) {
  // 命令里 `&` 放出去的服务、浏览器不在任务表上，跟后台任务一起关（10-26）。
  关掉留下的进程(agents.map(agent => agent.session.id))
  const jobs = ctx.get?.('jobs') || ctx.jobs
  if (!jobs) return
  // 原生登记册拿会话号认主人；传 agent 本身只看得见无主的，交回时本轮后台一件都停不到。
  const pending = agents.flatMap(agent => { const owner = agent.session.id
    return jobs.list(owner).filter(j => j.owner === owner && ['running', 'stopping'].includes(j.status)).map(job => ({ owner, job })) })
  for (const { owner, job } of pending) jobs.kill(job.id, owner, '节点主动交回，结束它的后台任务并保留现状')
  const settled = await Promise.all(pending.map(({ owner, job }) => jobs.wait(job.id, 10000, owner)))
  if (settled.some(j => ['running', 'stopping'].includes(j.status))) throw new Error('交回前后台任务尚未停止，保留工作状态，这次先不交回')
}

/** 等旧分支与辅助执行真正停止，再交回或开始下一轮；已完成节点的用户对话不取消。 */
export async function 收束分支(ctx, 根, id, agent) {
  const m = await 读名册(根)
  const all = 相关会话(ctx, m, id)
  停用持续工作(ctx, all)
  await 停止后台(ctx, all)
  const completed = new Set(m.rows.filter(r => r.status === '完成').map(r => r.session))
  const live = all.filter(a => a.session.id !== agent.session.id && !completed.has(a.session.id))
  for (const child of live) child.cancel({ kind: 'parent' })
  await Promise.all(live.map(child => child.whenIdle()))
  await 关闭节点终端(ctx, all.filter(a => a === agent || !completed.has(a.session.id)))
  await ctx.get('blueprintExecutionFeatures')?.releaseResources(all.filter(a => a === agent || !completed.has(a.session.id)))
}
