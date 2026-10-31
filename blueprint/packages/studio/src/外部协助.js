import { isAbsolute } from 'node:path'
import { 会话观察 } from './实时输出.js'
import { 工具结果失败 } from '../../context/src/消息协议.js'
import { 项目操作会话 } from './项目操作.js'

export const 外部运行状态 = new Set(['running', 'stopping', 'settling'])
const textOf = content => (content || []).filter(block => block?.type === 'text').map(block => block.text).join('\n')
const receiptOf = event => event.type === 'tool/result' && !工具结果失败(event)
  ? event.data?.meta?.blueprintExternal : null
const recorded = value => value && typeof value.id === 'string' && value.id
  && typeof value.provider === 'string' && value.provider && typeof value.cwd === 'string' && isAbsolute(value.cwd)
const settled = message => message?.source?.kind === 'subagent-settled'
  && typeof message.source.senderSessionId === 'string'

// catalog 决定直父归属；meta 是启动目录/提供方，Inbox 和已消费消息是原生报告。
// 不从工具名称、英文通知或没有本地 Session 推断提供方与成功/失败。
export function 外部协助投影(catalog, events, inbox, live, parentSessionId, inheritedEventCount = 0) {
  const own = events.filter(event => event.seq >= inheritedEventCount)
  const receipts = new Map(), reports = new Map(), accepted = new Map()
  for (const event of own) {
    const receipt = receiptOf(event)
    if (recorded(receipt)) receipts.set(receipt.id, receipt)
    if (event.type === 'agent/inbox/spliced') {
      for (const message of event.data?.inserted || []) if (settled(message)) accepted.set(message.id, event.seq)
    }
    if (event.type === 'user/message' && settled(event.data)) {
      const message = event.data
      reports.set(message.source.senderSessionId, { summary: message.source.summary || '',
        text: textOf(message.content), seq: event.seq, messageId: message.id, pending: false })
    }
  }
  for (const message of [...(inbox?.['next-turn'] || []), ...(inbox?.['next-step'] || [])]) {
    if (!settled(message) || reports.get(message.source.senderSessionId)?.messageId === message.id) continue
    reports.set(message.source.senderSessionId, { summary: message.source.summary || '',
      text: textOf(message.content), seq: accepted.get(message.id), messageId: message.id, pending: true })
  }
  const active = new Map((live || []).filter(row => row.parentSessionId === parentSessionId
    && 外部运行状态.has(row.status)).map(row => [row.id, row]))
  return catalog.filter(row => row.mode === 'external').map(row => {
    const execution = active.get(row.id), receipt = receipts.get(row.id), report = reports.get(row.id)
    const identity = recorded(execution) ? execution : receipt
    return { id: row.id, parentSessionId, label: row.label || row.id, createdAt: row.createdAt,
      ...(identity ? { provider: identity.provider, cwd: identity.cwd } : {}),
      status: execution?.status || (report ? 'reported' : 'unknown'),
      canStop: !!execution,
      ...(report ? { report } : {}) }
  })
}

export function 原生外部运行(ctx, parentSessionId) {
  const subagents = ctx.get('subagents')
  // dsh 0.2.1-rc.5 没有 listExternalActivations：没有外部任务时按空处理，别让整块面板炸掉。
  if (typeof subagents?.listExternalActivations !== 'function') return []
  return subagents.listExternalActivations(parentSessionId)
}

// 与普通会话名单取同一项目成员；先读原生 live 对象，只核对活任务直父目录。
// 无活任务不准备整个项目的冷账本，也不把 external 伪装成 Session。
export async function 项目外部目录(ctx, members, projectSessionId, signal) {
  const subagents = ctx.get('subagents')
  if (!subagents?.listChildren) return []
  const parents = new Set(members.map(parent => String(parent.sessionId)))
  const live = 原生外部运行(ctx).filter(row => parents.has(String(row.parentSessionId)))
  const catalogs = new Map(await Promise.all([...new Set(live.map(row => row.parentSessionId))]
    .map(async parent => [parent, await subagents.listChildren(parent, signal)])))
  return live.filter(row => catalogs.get(row.parentSessionId).some(child => child.mode === 'external' && child.id === row.id))
    .map(row => ({ id: row.id, parentSessionId: row.parentSessionId, projectSessionId: String(projectSessionId), status: row.status }))
}

export async function 读取外部协助(ctx, parentSessionId, { signal, live } = {}) {
  const subagents = ctx.get('subagents')
  if (!subagents?.listChildren) throw new Error('原生子任务目录不可用')
  const catalog = await subagents.listChildren(parentSessionId, signal)
  if (!catalog.some(row => row.mode === 'external')) return { rows: [] }
  let missing
  if (!live) {
    try { live = 原生外部运行(ctx, parentSessionId) }
    catch (error) { live = []; missing = error.message }
  }
  const rows = await 会话观察(ctx.get('sessionQuery'), parentSessionId, source => {
    const inbox = source.projections?.values?.inbox
    if (!inbox) throw new Error('原生 Inbox 投影不可用')
    return 外部协助投影(catalog, source.events, inbox, live, parentSessionId, source.inheritedEventCount)
  }, { signal, projectionMode: 'all' })
  return { rows, ...(missing ? { missing } : {}) }
}

export async function 停止外部协助(ctx, items, payload) {
  const { projectSessionId, parentSessionId, childSessionId } = payload
  const members = 项目操作会话(items, projectSessionId)
  if (!parentSessionId || !members.some(row => String(row.sessionId) === String(parentSessionId))) {
    throw new Error('外部任务的父会话不属于当前项目，未执行操作')
  }
  const subagents = ctx.get('subagents')
  if (!childSessionId || !subagents?.listChildren || !subagents?.interrupt) throw new Error('外部任务停止入口不可用')
  const catalog = await subagents.listChildren(String(parentSessionId))
  if (!catalog.some(row => row.mode === 'external' && String(row.id) === String(childSessionId))) {
    throw new Error('该父会话未登记这个外部任务，未执行操作')
  }
  subagents.interrupt(String(childSessionId), { kind: 'user', parentSessionId: String(parentSessionId) })
  return { accepted: true }
}
