/** 每轮第一步过选择机并插页：思考开头（职责与求助）、组织情境、项目经验、节点总表在前，选出的阶段页在最后；同源读取节点文档和纸条原文。
 *  用户亲口说的话不过选择机，只接回话页（选 46）。 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { 消息来自 } from '../../context/src/消息协议.js'
import { 一段, run开工页 } from '../../prompt/src/index.js'
import { 项目根, 读名册, 改名册, 我是谁, 行Of, 读节点文档, 读纸条, 没回纸条, 给读者的任务表, 节点总表路径, 节点类型, 新阶段待开 } from '../../roster/src/index.js'
import { 组织情境 } from '../../roster/src/组织.js'
import { 开持续目标, 停用持续工作 } from './持续工作.js'
import { 阶段页 } from './选择机.js'
import { 先想这一步 } from './预测.js'
import { 重新开工 } from './会话.js'
import { 是重建叫醒, 回话停下, 用户回话, 用户停下的 } from './规则.js'
import { 节点会话事实 } from './会话事实.js'
import { 项目经验段 } from './交回记忆.js'
import { 是用户的话 } from './交给新总分身.js'
import { 需要项目短名 } from './项目名称.js'

export const 思考开头来路 = 'blueprint-thinking-opening'
const 输入来路 = ['plugin:blueprint-node', 'plugin:blueprint-rebuild']

async function 未回纸条(根, id) {
  const m = await 读名册(根)
  const { incoming, outgoing } = 没回纸条(await 读纸条(根), id)
  const 列出 = (条们, 对方) => 条们.length
    ? '\n' + 条们.map(条 => `- ${条.id} · ${条[对方]}：${条.text}`).join('\n') : '没有'
  return {
    等你的: 列出(incoming, 'from'),
    你等的: 列出(outgoing, 'to'),
  }
}

/**
 * 别人并进来、和它碰过同一批文件的通知：带上一次就清掉。
 * 清通知不等它写完：开头也会在项目队列里被调用（一轮中间的 context 重建），等它会卡住同一条队。
 */
function 取通知(根, current) {
  const 通知 = current.notices?.length ? current.notices.map(n => n.text).join('\n\n') : ''
  if (通知) void 改名册(根, latest => ({ ...latest, rows: latest.rows.map(r => r.id === current.id
    ? { ...r, notices: (r.notices || []).filter(n => !current.notices.some(x => x.id === n.id)) } : r) }))
      .catch(e => console.log(`Blueprint node: 并入通知没清掉 —— ${e.message || e}`))
  return 通知
}

/**
 * 这次醒来时的任务表（选 33、任 1）：不放运行背景，免得别的节点一改状态就整份再追加一次。
 * 照名册现画：别的、已交回的工作各折成一行（座 10），发布入口换成绝对路径。
 */
async function 节点总表段(根, m, 读者) {
  const 总表 = await 给读者的任务表(根, m, 读者)
  return 总表?.trim() ? 一段('重置/节点总表', { 路径: 节点总表路径(根), 总表: 总表.trim() }) : ''
}

/** 职责保留节点文档原文；未写职责与没有纸条时使用附录 A2 的空值。再看项目经验（座位撤了，第三版 10-24）；最后是节点总表。 */
export async function 思考开头(根, 行) {
  const 文档 = await 读节点文档(根, 行)
  if (!文档) throw new Error(`节点文档缺失：${行.id}`)
  const 职责 = 文档.responsibility
  const m = await 读名册(根), current = 行Of(m, 行.id)
  const 缺简介 = (current.userDraft?.briefPending === true && !current.userDraft.pending) || await 需要项目短名(根, current.id)
  return [取通知(根, current), 缺简介 ? 一段('重置/分身简介') : '', 一段('重置/开头', { 职责: 职责.trim() ? 职责 : '还没有写下职责', ...await 未回纸条(根, 行.id) }),
    组织情境(m, 行.id, 根), await 项目经验段(根), await 节点总表段(根, m, current.id)].filter(Boolean).join('\n\n')
}

const 插页消息 = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: `plugin:${思考开头来路}` } })

/**
 * 这次醒来接在叫醒话（或用户的话）后面的插页，两条消息：开头（职责与纸条）、组织情境、项目经验、节点总表在前，
 * 选择机选出的阶段 → 那一阶段的页在最后。开头先放进这一步，选择机看到的就是节点要看到的那一份（同 1）；
 * 保留共享前缀供原生缓存复用，阶段页离模型下笔最近。选中回话也带开头。
 * `这一步` 是这一步新到、即将进对话的消息。
 * 插页只插新的（选 27）：没有新事、自己接着转进下一个阶段时（`有新事` 为假），只插阶段页和还没带过的并入通知；
 * 开头、组织情境上次插过还留在对话里，不重复。
 * 返回要接进对话的消息；转交给了别人返回 null。
 */
export async function 阶段插页(ctx, 根, 行, 这一步, { 有新事 = true, ...options } = {}) {
  const current = 行Of(await 读名册(根), 行.id)
  const 开头文 = 有新事 ? await 思考开头(根, 行) : 取通知(根, current)
  const 开头 = 开头文 ? [插页消息(开头文)] : []
  const 阶段 = await 阶段页(ctx, 根, 行.id, { ...options, 这一步: [...这一步, ...开头] })
  if (阶段 === null) return null
  return [...开头, ...(阶段 ? [插页消息(阶段)] : [])]
}

function 是新输入(m) {
  return m.role === 'user' && (['user', 'api'].includes(m.source?.kind)
    || 输入来路.some(kind => 消息来自(m, kind)))
}

const 是开工话 = m => m.content?.some(b => b.type === 'text' && b.text.includes(一段('重置/叫醒/开工')))
const 进了orient = 插页 => !!插页?.some(m => /^【环节：orient】/.test(m.content?.[0]?.text || ''))

/** Goal 自己开的一轮：节点闲下来，dsh 的 Goal 接着转（选 19）。 */
const 是Goal轮 = m => m?.source?.kind === 'goal' && m.source.round > 0

/** 每个会话最近一次过选择机的是哪一轮：一轮只在第一步过一次（选 14）。 */
const 选过的轮 = new WeakMap()

/** 用户亲口说的话（选 46）：spark 交给 helm 的那一页也走 api，但不是用户在说话，照旧过选择机。 */
const 是用户亲口说的 = m => 是用户的话(m) && m.source?.origin !== 'spark'

/** 在回话里用 next 交接了、等下一步过选择机的节点（选 46）：这一轮不收，下一步当场选环节、接着做。 */
const 回话开工 = new WeakSet()
export const 记回话开工 = agent => { if (agent) 回话开工.add(agent) }

function 已含开头(messages) {
  const 模板 = 一段('重置/开头', { 职责: '', 等你的: '', 你等的: '' })
  const 开头 = 模板.split('\n')[0]
  const 职责之问 = 模板.split('\n\n').map(文 => 文.trim()).filter(Boolean)[1]
  return messages.some(m => m.content?.some(b => b.type === 'text'
    && b.text.includes(开头) && b.text.includes(职责之问)))
}

async function 认节点(ctx, session) {
  if (!session || session.header?.origin === 'subagent') return null
  let 根
  try { 根 = 项目根(ctx, session.id) } catch { return null }
  const 名册 = await 读名册(根), 我 = 名册 && 我是谁(名册, session.id)
  return 我 ? { 根, 行: 行Of(名册, 我) } : null
}

export function 装思考开头(ctx) {
  // 每进入一个阶段前先过选择机：只在一轮的第一步过一次，它看的是节点这一步要发的那一份（同 1）。
  // 一轮中途到的输入马上送进去、不插页；它们已在对话里，下一次选择机直接看得到（选 14）。
  ctx.on('agent/pre-step', async (payload, next) => {
    // 只想不动手只管记下的那一步（则 8）：下一步一开始就撤掉。
    先想这一步.delete(payload.agent?.session?.id)
    const d = await next()
    if (d?.kind !== 'enter') return d
    // 回话里用 next 交接了（选 46）：这一步当场过选择机，开头、组织情境和选出的那一页接在 next 的回执后面，在这一轮里接着做。
    if (回话开工.has(payload.agent)) {
      回话开工.delete(payload.agent)
      const 节点 = await 认节点(ctx, payload.agent?.session)
      if (!节点) return d
      const 插页 = await 阶段插页(ctx, 节点.根, 节点.行, d.messages || [], { session: payload.agent.session, agent: payload.agent, signal: payload.signal })
      if (进了orient(插页)) 先想这一步.add(payload.agent.session.id)
      return 插页?.length ? { ...d, messages: [...(d.messages || []), ...插页] } : d
    }
    const 新输入 = (payload.messages || []).filter(是新输入)
    const Goal轮 = (payload.messages || []).some(是Goal轮)
    if ((!新输入.length && !Goal轮) || 已含开头(新输入) || 已含开头(d.messages || [])) return d
    const 节点 = await 认节点(ctx, payload.agent?.session)
    if (!节点) return d
    // spark 不过选择机、不分环节、没有 Goal：一问一答陪用户聊，聊清楚了用 finish 交那一页（十 56）。
    if (节点类型(节点.行) === 'spark') return d
    // run 不过选择机、不插阶段页：拿着请求直接做；交回后用户又对它说话，就重新开工（删 2）。
    if (节点类型(节点.行) === 'run') {
      if (节点.行.status === '完成' && 新输入.some(m => ['user', 'api'].includes(m.source?.kind))) await 重新开工(节点.根, 节点.行.id)
      // run 交回后又被叫去干活，重新开工就重开续跑；没交回的已经有 Goal，不动。
      开持续目标(ctx, payload.agent, 行Of(await 读名册(节点.根), 节点.行.id), { 重开续跑: true })
      // 开工那一步按工作等级接一页（级 1）：用户对它说话、叫回、改写都不接。
      const 开工页 = 新输入.some(是开工话) ? run开工页(节点.行.level) : ''
      if (开工页 && 节点.行.level === 'stunning') 先想这一步.add(payload.agent.session.id)
      return 开工页 ? { ...d, messages: [...(d.messages || []), 插页消息(开工页)] } : d
    }
    if (选过的轮.get(payload.agent) === payload.turn) return d
    选过的轮.set(payload.agent, payload.turn)
    // 用户亲口说的话开的一轮（选 46）：不过选择机，不插开头和组织情境，只接回话那一页，用户的话离它最近。
    // 回完不改状态：原来被按停的，页带「回话停下」、Goal 停用，答完照样停着；在等的、交回了的带「用户回话」，等的到了照常叫醒。
    // 要开工由它自己用 next 交接（工具.js 记下 回话开工，下一步再过选择机）。
    // 还没进过任何环节的节点（用户开的新分身，第一句话就是请求）照旧过选择机开工。
    // 用户从「新建阶段」进来、这一阶段的总 dock 还没派出（十 61）：要的是一个全新的总 dock，helm 直接进 plan，
    // 不走回话、不过选择机；用户的话、spark 交来的那一页都一样。
    const 新阶段 = 节点类型(节点.行) === 'helm' && 新输入.some(是用户的话) && 新阶段待开(await 读名册(节点.根), 节点.行.id)
    if (新输入.some(是用户亲口说的) && 节点.行.selector?.last && !新阶段) {
      const 停着 = 节点会话事实(ctx, payload.agent.session)?.userStopped ?? 用户停下的(payload.agent.session.ownEvents?.() || [])
      const 页 = await 阶段页(ctx, 节点.根, 节点.行.id, { session: payload.agent.session, 指定: 'reply', 重建: 新输入.some(是重建叫醒) })
      if (停着) 停用持续工作(ctx, [payload.agent])
      return { ...d, messages: [...(d.messages || []), createUserMessage({ content: [{ type: 'text', text: 页 }],
        source: { kind: `plugin:${思考开头来路}`, summary: 停着 ? 回话停下 : 用户回话 } })] }
    }
    // 用户直接说话开的轮、接续轮也走这里：还没有 Goal 的开工节点这时建（选 19）。
    开持续目标(ctx, payload.agent, 节点.行)
    // Goal 自己开的一轮没有新事：上一个阶段结没结束、交接是什么，选择机在问题那一段的「上一个阶段」里读到（断 1）。
    // 交回了的 helm 被用户叫去做事：一个座位始终一个 helm，原地重新开工（十 54），下面「交回了的节点被叫去干活」那段照常走。
    const 插页 = await 阶段插页(ctx, 节点.根, 节点.行, d.messages || [], {
      session: payload.agent.session,
      agent: payload.agent,
      signal: payload.signal,
      重建: 新输入.some(是重建叫醒),
      有新事: 新输入.length > 0,
      ...(新阶段 ? { 指定: 'plan' } : {}),
    })
    // 第一步的消息清空：这一轮不调模型就结束，用户的话不进旧对话（已经交给了新总分身）。
    if (插页 === null) return { ...d, messages: [] }
    if (!插页.length) return d
    if (进了orient(插页)) 先想这一步.add(payload.agent.session.id)
    // 交回了的节点被求助叫去干活（选的不是回话）：重新开工、重新建 Goal（选 23）。用户的话不走这里（选 46）。
    const 选中 = 插页.map(m => /^【环节：([a-z]+)】/.exec(m.content[0].text)?.[1]).find(Boolean)
    const 最新 = 行Of(await 读名册(节点.根), 节点.行.id)
    if (选中 && 选中 !== 'reply' && 最新.status === '完成') {
      await 重新开工(节点.根, 节点.行.id)
      const 名册 = await 读名册(节点.根)
      开持续目标(ctx, payload.agent, 行Of(名册, 节点.行.id), { 重开续跑: true })
    }
    return { ...d, messages: [...(d.messages || []), ...插页] }
  })
}
