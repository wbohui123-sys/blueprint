/** 等待以项目纸条为准；已领取的输入放回原生 inbox，不另存运行状态。 */
import { 项目根, 读名册, 我是谁, 读纸条, 行Of } from '../../roster/src/index.js'
import { 纸条已收 } from './纸条.js'
import { 运行卡点 } from './条件等待.js'
import { 等前置, 等开工孩子 } from '../../roster/src/组织.js'
import { 消息来自 } from '../../context/src/消息协议.js'
import { 装会话事实, 节点会话事实 } from './会话事实.js'
import { 当前持续目标, 复查持续工作 } from './持续工作.js'
import { 剥外壳 } from './通用工具.js'

/** 仅供旧日志读取；新等待只使用项目事实和原生轮尾。 */
export const 纸条等待事件 = 'blueprint/waiting-for-notes'
export const 条件等待事件 = 'blueprint/waiting-for-conditions'

/** 已写回的纸条也要等对应回复进入本会话账本；落盘的 answer 不能代替收到。 */
export function 在等回条(纸条, id, 名册, session, ctx) {
  return 纸条.filter(n => {
    if (n.kind === 'reply' || n.from !== String(id)) return false
    if (n.status === 'open') return true
    if (n.status === 'auto_answered') return !纸条已收(session, `blueprint-note:${n.id}:auto`, ctx)
    if (n.status !== 'answered') return false
    const reply = 纸条.find(r => r.kind === 'reply' && r.reply_to === n.id)
    return !reply || !纸条已收(session, `blueprint-note:${reply.id}:reply`, ctx)
  })
}

async function 等待中的纸条(ctx, session) {
  if (!session || session.header?.origin === 'subagent') return []
  let 根
  try { 根 = 项目根(ctx, session.id) } catch { return [] }
  const 名册 = await 读名册(根), 我 = 名册 && 我是谁(名册, session.id)
  return 我 ? 在等回条(await 读纸条(根), 我, 名册, session, ctx) : []
}

/** 当次拒绝的收尾协调；恢复仍只看项目等待和原生输入收据。 */
async function 等待收尾(ctx, agent, turn, signal) {
  await agent.whenIdle()
  const 仍是本轮 = () => {
    if (signal?.aborted || ctx.root.agents.get(agent.session.id) !== agent || agent.status !== 'idle') return false
    try { ctx.fiber?.assertActive(); agent.ctx?.fiber?.assertActive() } catch { return false }
    const boundary = ctx.sessionProjections?.stateOf(agent.session, 'turnBoundary')
    if (boundary && (boundary.lastTurn !== turn || boundary.openTurnStartSeq !== null)) return false
    const facts = 节点会话事实(ctx, agent.session)
    if (facts) return !facts.userStopped && facts.turn === null && facts.lastEndedTurn === turn
    // 未装原生投影的旧宿主仍只读原日志。
    const ended = agent.session.ownEvents().findLast(event => event.type === 'turn/end')
    return ended?.data?.turn === turn && ended.data.reason?.kind === 'blocked'
  }
  if (!仍是本轮()) return
  // Goal 已完成、节点还开着工的当没有 Goal：还该做就补启。
  const goal = 当前持续目标(ctx, agent)
  if (goal && goal.phase !== 'complete') {
    await 复查持续工作(ctx, agent, { 恢复: agent.inbox.nextStep.some(m => 消息来自(m, 'plugin:blueprint-node')) })
    return
  }
  if ((await 等待中的纸条(ctx, agent.session)).length || (await 运行卡点(ctx, agent.session)).length || !仍是本轮()) return
  // 只补启结果／叫醒输入；无关输入留在原生 inbox，不能代替等待结果。
  const message = agent.inbox.nextStep.findLast(m => 消息来自(m, 'plugin:blueprint-node'))
  if (!message) return
  agent.inbox.remove(message.id)
  agent.steer(message)
  await ctx.sessions.flush(agent.session)
}

/** 接管旧运行中的等待，不写用户手动停止标记；回条仍可自动恢复。 */
export async function 停下等回条(ctx, sessionId) {
  const agent = ctx.root.agents.get(String(sessionId))
  const 等待 = agent ? await 等待中的纸条(ctx, agent.session) : []
  if (!等待.length) return { stopped: false, waitingForNotes: [] }
  agent.cancel({ kind: 'hook', reason: 'blueprint-note-wait' }, { keepInbox: true })
  await agent.whenIdle()
  await ctx.sessions.flush(agent.session)
  return { stopped: true, waitingForNotes: 等待.map(n => n.id) }
}

/**
 * 这一批里刚发了求助的节点：同一批后面的工具不再执行（它说了要停下）；下一步开始前清掉。
 * 原生 concludeTurn 不取消同一响应里后续的工具，这里在它们真正执行前拦住。
 */
export const 刚发求助 = new WeakSet()
/**
 * 放进来的那一轮：等回条时来了新事（选 18），或者用户说话（选 23：所有节点都可以对话，等着条件也一样）。
 * 这一轮后面的步骤和工具也放行，它可能要先查再回；登记着的等待不动，这一轮完了照旧等。
 * 记下放行时登记着的是哪个等待：这一轮里新登记的等待（同一批里先 wait 再调别的）照样挡。
 */
const 放行的轮 = new WeakMap()
async function 等待号(ctx, session) {
  let 根
  try { 根 = 项目根(ctx, session.id) } catch { return null }
  const 名册 = await 读名册(根), 我 = 名册 && 我是谁(名册, session.id)
  return (我 && 行Of(名册, 我).wait?.id) || null
}
async function 放行中(ctx, agent, turn) {
  const 放行 = agent && 放行的轮.get(agent)
  return !!放行 && turn !== undefined && 放行.turn === turn && 放行.等待 === await 等待号(ctx, agent.session)
}
/** 卡着的只是登记的等待：正式前置没满足、开工前等下层的，还没开工，用户说话也照旧等到能开工。 */
async function 只卡在等待(ctx, session) {
  let 根
  try { 根 = 项目根(ctx, session.id) } catch { return false }
  const 名册 = await 读名册(根), 我 = 名册 && 我是谁(名册, session.id)
  return !!我 && 行Of(名册, 我).status === '开工' && !等前置(名册, 我).length && !等开工孩子(名册, 我).length
}
/** 用户自己说的话（不含 Goal 面板的恢复、机器的叫醒）。 */
const 用户说话 = messages => (messages || []).some(m => (m.role === undefined || m.role === 'user') && ['user', 'api'].includes(m.source?.kind))
const 是纸条调用 = exec => exec.name === 'note' || (exec.name === 'call_tool' && 剥外壳(exec.arguments)?.name === 'note')

/** 这一步带来了新事：纸条、回条、叫醒话、用户的话（Goal 自己开的那一轮不算）。 */
const 有新事 = messages => (messages || []).some(m => !(m.source?.kind === 'goal' && m.source.round > 0))
/** 条件等待时获准投递的纸条：求助、出事通知或上级传达；回条不冒充条件结果。 */
const 来了纸条 = messages => (messages || []).some(m => /^blueprint-note:.+:note$/.test(m.source?.summary || ''))

/** 补启和 pre-step 共用：新事可处理一轮，登记的等待不解除，正式开工限制不绕过。 */
export async function 等待允许输入(ctx, session, messages, 条件) {
  条件 ??= await 运行卡点(ctx, session)
  return ((用户说话(messages) || 来了纸条(messages)) && await 只卡在等待(ctx, session))
    || (!条件.length && 有新事(messages))
}

export function 装纸条等待(ctx) {
  装会话事实(ctx)
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
    if (agent) 刚发求助.delete(agent)
    const 等待 = await 等待中的纸条(ctx, agent?.session)
    const 条件 = await 运行卡点(ctx, agent?.session)
    if (!等待.length && !条件.length) return next()
    if (await 放行中(ctx, agent, turn)) return next()
    // 等回条时处理新事；条件等待时处理用户输入和获准投递的纸条，原等待保持不变。
    if (await 等待允许输入(ctx, agent.session, messages, 条件)) {
      放行的轮.set(agent, { turn, 等待: await 等待号(ctx, agent.session) })
      return next()
    }
    await 复查持续工作(ctx, agent)
    for (const message of messages || []) if (!(message.source?.kind === 'goal' && message.source.round > 0)) agent.inject(message)
    await ctx.sessions.flush(agent.session)
    // 原生 steer 在 reject 尚未退出时不会再开驱动；不 await，避免等自己的步骤停稳。
    void 等待收尾(ctx, agent, turn, signal)
      .catch(error => console.log(`Blueprint node: 等待回条恢复失败 —— ${error.message || error}`))
    return { kind: 'reject' }
  }, { prepend: true })

  // 原生 concludeTurn 不取消同一响应中后续工具；在它们真正执行前守住：同一批里刚发的求助、条件等待。
  // 之后醒来（新纸条、用户说话）不拦工具：它要用 note 回别人，卡住的那件活由 prompt 管（选 18）。
  ctx.on('tools/execute', async (exec, next) => {
    const 求助 = exec.agent && 刚发求助.has(exec.agent) && !是纸条调用(exec)
    const 条件 = 求助 ? [] : await 运行卡点(ctx, exec.agent?.session)
    if (!求助 && !条件.length) return next()
    if (!求助 && exec.agent && await 放行中(ctx, exec.agent, 节点会话事实(ctx, exec.agent.session)?.turn)) return next()
    const 等待 = 求助 ? await 等待中的纸条(ctx, exec.agent?.session) : []
    const 文 = `等待 ${[...等待.map(n => `${n.id} 的回条`), ...条件].join('、')}；本次工具未执行。`
    return { isError: true, error: { code: 求助 ? 'WAITING_FOR_REPLY' : 'WAITING_FOR_CONDITION', message: 文 }, content: [{ type: 'text', text: 文 }] }
  }, { prepend: true })
}
