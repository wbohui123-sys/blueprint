/**
 * node —— 节点之间怎么协作。
 *
 * **接缝声明**：本包是**插件**，挂在座位卡上，跟着节点走。**名册唯一的写者**。
 * 它消费 dsh 的这几条缝：
 * - `ctx.tools.register()`：节点工具（`工具.js`）。
 * - `agent/request`：每次调模型，照项目的模型表发。
 * - `session/event`（`turn/end`）：一轮结束，execute 用 next 交了成果报告的（名册 `selector.report`），重建 context 叫醒它；
 *   否则只补送已经登记、尚未送达的孩子交齐汇总。
 * - `ctx.commands`：`/blueprint 名字：第一句话` 建项目（界面上的建项目调的是同一个 `建项目()`）。
 *
 * 状态权威只在 dsh 账本和 `系统文档/`；内存只合并在途效果、记已固化输入。
 *
 * ⚠️ 所有监听都在 `apply()` 里**同步**挂上：cordis 按 scope 投事件，异步补挂的监听器挂在哪个 scope 上说不准
 * （2026-09-03 实机：晚挂的那一只整格耳聋，一句错都不报）。
 *
 * @module @blueprint/node
 */

import { 协作模式Of } from '../../prompt/src/index.js'
import { 开spark } from './spark.js'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { 一段 } from '../../prompt/src/index.js'
import {
  项目根, 读名册, 我是谁, 落新名册, 首节点, 行Of, 排队, 写工作文档, 新工作文档, 验名字,
  文档夹名, 名册路径, 模型表路径, 读纸条, 改名册, 下一个编号, 没回纸条, 节点类型,
} from '../../roster/src/index.js'
import { 装工具 } from './工具.js'
import { 装节点文档 } from './节点文档.js'
import { 装思考开头 } from './思考开头.js'
import { 装策略 } from './策略.js'
import { 装纸条, 提醒欠求助, 报出事 } from './纸条.js'
import { 装纸条等待 } from './纸条等待.js'
import { 装条件等待 } from './条件等待.js'
import { 装收起工具 } from './上下文重建.js'
import { 装通用工具 } from './通用工具.js'
import { 开节点, 读模型表, 叫醒, 补送节点汇总 } from './会话.js'
import { 需补交齐, 拆命令 } from './规则.js'
import { 装用户分身 } from './用户分身.js'
export { 准备用户分身, 准备新阶段 } from './用户分身.js'
export { 删除分身 } from './删除分身.js'
export { 删除项目 } from './删除项目.js'
import { 装项目隔离, 原生提供方代码目录 } from './项目隔离.js'
import { 检查行动预测 } from './预测.js'
import { 装资料 } from './资料.js'
import { 装验证收据 } from './验证收据.js'
import { 装素材目录 } from './素材目录.js'
import { 装上架工具 } from './上架.js'
import { 装媒体工具 } from './媒体工具.js'
import { 装网页截图 } from './网页截图.js'
import { 项目路径 as 项目夹 } from '../../prompt/src/路径.js'
import { 规范技能选择, 写技能选择 } from '../../prompt/src/项目技能.js'
import { 规范项目附件, 附件需求原话, 保存项目附件 } from './项目附件.js'
import { 初始化项目名称 } from './项目名称.js'
import { Agent默认设置 } from './Agent默认设置.js'
import { 验子代理设置, 写子代理设置 } from './子代理开关.js'
import { 装会话事实 } from './会话事实.js'
import { 装持续工作, 接过阶段转换, 当前持续目标, 重新接上 } from './持续工作.js'
import { 装卡住提醒 } from './卡住提醒.js'
import { 继续节点, 认项目节点 } from './项目停下.js'
import { 继续补送 } from './继续补送.js'
import { 是用户续工输入, 是回话停下, 是用户回话, 用户停下的 } from './规则.js'
import { 装程序工具 } from '../../context/src/程序工具.js'

export { 准备节点续工 } from './会话.js'
export { 重启节点 } from './重启.js'
export { 在项目终端执行域 } from './项目隔离.js'
export { 关闭节点终端 } from './终端.js'
export { 操作持续目标 } from './持续工作.js'

/** Cordis 插件名。 */
export const name = 'blueprint-node'

export const inject = ['tools', 'sessions', 'llm', 'agents', 'commands', 'fs', 'subprocess', 'web', 'tokenMeter', 'blueprintToolCatalog', 'subagents', 'systemPrompt']

/** 新项目使用持久化的默认位置；已有项目继续按自己的会话 cwd 工作。 */
export { 项目夹 }

/** 这个会话在哪个项目里；认不出 → null。 */
function 根Of(ctx, session) {
  if (!session) return null
  try { return 项目根(ctx, session.id) } catch { return null }
}

/** 这个会话是不是 helm 或 dock（档 6：它们的思考档不随品质档降）；名册读不出就当不是。 */
export async function 是决策节点(根, 会话) {
  try {
    const 名册 = await 读名册(根), id = 我是谁(名册, 会话)
    return id !== null && ['helm', 'dock'].includes(节点类型(行Of(名册, id)))
  } catch { return false }
}

/** 名册行 selector 的小记号：重试那一下的输入号（errorRetry）、出事了（incident）。 */
const 记重试 = (根, id, 输入号) => 改名册(根, m => ({ ...m, rows: m.rows.map(r => r.id === String(id)
  ? { ...r, selector: { ...(r.selector || {}), errorRetry: 输入号 } } : r) }))

/** 正常转完一轮：重试和出事了的记号清掉。 */
/** 清掉阶段报告的记号；早被清过就不写名册（同一轮的收尾事件可能来好几次）。 */
const 清报告记号 = (根, id) => 改名册(根, m => !行Of(m, String(id))?.selector?.report ? m : ({ ...m, rows: m.rows.map(r => {
  if (r.id !== String(id)) return r
  const { report, ...selector } = r.selector
  return { ...r, selector }
}) }))
const 清出事 = (根, id) => 改名册(根, m => ({ ...m, rows: m.rows.map(r => r.id === String(id) && (r.selector?.errorRetry || r.selector?.incident)
  ? { ...r, selector: Object.fromEntries(Object.entries(r.selector).filter(([k]) => k !== 'errorRetry' && k !== 'incident')) } : r) }))

/** 这一轮进来的输入号。 */
function 这一轮的输入(session, turn) {
  const ids = []
  let 在 = false
  for (const e of session.ownEvents()) {
    if (e.type === 'turn/start') 在 = e.data?.turn === turn
    else if (e.type === 'turn/end' && 在) break
    else if (在 && e.type === 'user/message' && e.data?.id) ids.push(e.data.id)
  }
  return ids
}

/**
 * 重试时说清坏在哪（选 31）。工具参数修补（app/patches/tool-json-repair）修不好时，dsh 报错首行之后一个坏调用一行：
 * 「工具; file 路径; 解析错误; near: …附近原文…」，附近原文在最后。别的错误照旧原文递上。
 */
function 重试话(错误) {
  const [头, ...坏的] = 错误.split('\n')
  if (!头.endsWith('tool input is invalid JSON:') || !坏的.length) return 一段('重置/叫醒/出错重试', { 错误 })
  const 坏处 = 坏的.map(行 => {
    const 附近起 = 行.indexOf('; near: '), 前段 = 附近起 < 0 ? 行 : 行.slice(0, 附近起)
    const 文件 = /; file (.+?)(?:; |$)/.exec(前段)?.[1]
    return `- ${前段.split('; ')[0]}${文件 ? `（${文件}）` : ''}${附近起 < 0 ? '' : `，出错处附近：${行.slice(附近起 + 8)}`}`
  }).join('\n')
  return 一段('重置/叫醒/工具参数坏了', { 坏处 })
}

/**
 * 出错断掉的一轮（选 13）：机器先原样叫醒重试一次；重试那一轮正常转完再把被 dsh 停用的 Goal 接上；
 * 重试的那一轮自己又出错，才算出事了。还在跑的节点和交回了、还欠着求助的节点都算。
 */
function 装出错重试(ctx) {
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end' || event.data?.reason?.kind !== 'error') return
    void (async () => {
      const 是 = await 认节点(ctx, session)
      if (!是) return
      const 行 = 行Of(是.名册, 是.我)
      const 欠求助 = 行.status === '完成' && 没回纸条(await 读纸条(是.根), 是.我).incoming.length
      if (行.status !== '开工' && !欠求助) return
      const 错误 = event.data.reason.error?.message || '未知错误'
      const 账 = ctx.root.agents.get(session.id)?.session || session
      if (行.selector?.errorRetry && 这一轮的输入(账, event.data.turn).includes(行.selector.errorRetry)) {
        await 报出事(ctx, 是.根, 是.我, `重试以后还是出错：${错误}`); return
      }
      const 输入号 = `blueprint-error:${session.id}:${event.data.turn}`
      await 记重试(是.根, 是.我, 输入号)
      await 叫醒(ctx, 是.根, 是.我, 重试话(错误), { inputId: 输入号 })
    })().catch(e => 喊('出错重试没递上', e))
  })
  // Goal 轮数用完、模型自己报卡住：Goal 被记成阻塞，按出事了处理（选 19）。
  ctx.on('goal/changed', ({ agent, change }) => {
    const code = change?.goal?.blockedReason?.code
    if (change?.operation !== 'block' || !['round-limit', 'model-reported'].includes(code)) return
    void (async () => {
      const 是 = await 认节点(ctx, agent?.session)
      if (!是) return
      await 报出事(ctx, 是.根, 是.我, code === 'round-limit' ? `转了 ${change.goal.roundsStarted ?? ''} 轮还没交回，Goal 轮数用完` : `自己说卡住了：${change.goal.blockedReason.message}`)
    })().catch(e => 喊('Goal 阻塞没报上', e))
  })
}

/**
 * 按停与继续（10-19 用户：停就停按的那一个）：按停由 dsh 原生做完——这一轮中止、这个节点的 Goal 暂停，机器的叫醒都认它停着，
 * 别的节点照常。这里只接继续：用户对它说话、或在目标面板恢复它，就继续这一个（`项目停下.js` 的 `继续节点`）。
 * 用户对没在跑的 helm、dock 说话直接回话（选 46）：回话页带标记的，这里不替它继续；它在回话里用 next 交接才继续（工具.js）。
 * run、spark 没有回话页，用户说话照旧就是继续。
 */
function 装按停继续(ctx) {
  // 机器自己恢复 Goal（出错重试接上）时它没停过，继续节点什么都不做。
  ctx.on('goal/changed', ({ agent, change }) => {
    if (change?.operation !== 'resume') return
    void (async () => {
      const 是 = await 认项目节点(ctx, agent?.session)
      if (是) await 继续节点(ctx, 是.根, agent, 是.行, 继续补送, { 补一句: true })
    })().catch(e => 喊('目标面板的恢复没接上', e))
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    const 用户说话 = (payload.messages || []).some(m => 是用户续工输入(m) && ['user', 'api'].includes(m.source?.kind))
    const d = await next()
    if (用户说话 && !(d?.messages || []).some(m => 是回话停下(m) || 是用户回话(m))) {
      const agent = payload.agent, 是 = await 认项目节点(ctx, agent?.session)
      if (是) void 继续节点(ctx, 是.根, agent, 是.行, 继续补送).catch(e => 喊('继续没接上这个节点', e))
    }
    return d
  }, { prepend: true })
}

/**
 * 被用户按停记进名册（达 3）：按停、回话停下时记上 userStopped，用户让它继续时清掉；任务表照它写「被用户按停」，
 * 上级看得出它为什么不动、纸条为什么叫不醒。判据就是 用户停下的()，只在轮尾和收到消息时看一次，变了才写。
 */
function 装按停记号(ctx) {
  ctx.on('session/event', (session, event) => {
    if (!['turn/end', 'user/message'].includes(event?.type)) return
    void (async () => {
      const 是 = await 认项目节点(ctx, session)
      if (!是 || 是.行.status !== '开工') return
      const 账 = ctx.root.agents.get(session.id)?.session?.ownEvents?.() || session.ownEvents?.() || []
      const 停 = 用户停下的(账)
      if (!!是.行.userStopped === 停) return
      await 改名册(是.根, m => ({ ...m, rows: m.rows.map(r => {
        if (r.id !== 是.行.id) return r
        const { userStopped: _旧, ...留 } = r
        return 停 ? { ...留, userStopped: true } : 留
      }) }))
    })().catch(e => 喊('按停记号没记上', e))
  })
}

/** 只由明确的阶段转换或待送交齐事实续工；普通收尾保持原生 idle。 */
export function 装收尾续工(ctx) {
  装会话事实(ctx)
  装出错重试(ctx)
  装按停继续(ctx)
  装按停记号(ctx)
  装卡住提醒(ctx)
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    const actor = ctx.root.agents.get(session.id)
    // 写成果报告时工具里已经挡住了 Goal（这里是追加事件的回调，不能再挡）；这一轮没正常结束就直接放开。
    const release = 接过阶段转换(actor)
    if (event.data?.reason?.kind !== 'completed') {
      void release()
      // 这一轮没正常结束（按停、出错）：交过的成果报告已经在记录里，这次不另叫重建；记号只活到这一轮结束。
      void (async () => {
        const 是 = await 认节点(ctx, session)
        if (是 && 行Of(是.名册, 是.我).selector?.report) await 清报告记号(是.根, 是.我)
      })().catch(e => 喊('阶段报告记号没清掉', e))
      return
    }
    void (async () => {
      const 是 = await 认节点(ctx, session)
      if (!是) return
      // 重试那一轮正常转完：dsh 出错时停用的 Goal 这时再接上（先接上会和重试抢着开轮）。
      // 接上放在这次的叫醒送出之后，免得 Goal 抢在阶段报告的重建叫醒前面开一轮。
      const 重试过 = !!行Of(是.名册, 是.我).selector?.errorRetry
      if (重试过 || 行Of(是.名册, 是.我).selector?.incident) await 清出事(是.根, 是.我)
      if (行Of(是.名册, 是.我).selector?.report) {
        // execute 用 next 交了成果报告（选 25）：按节点文档重建 context，叫醒它再选下一步。记号只活到这一轮结束。
        await 清报告记号(是.根, 是.我)
        await 叫醒(ctx, 是.根, 是.我, 一段('重置/叫醒/阶段报告'), { 重建: true, inputId: `blueprint-stage-report:${session.id}:${event.data.turn}` })
      } else if (需补交齐(是.名册, 是.我, event, await 读纸条(是.根))) {
        await 补送节点汇总(ctx, 是.根, 是.我)
      } else {
        // 停下时还欠着求助：叫醒它去回，交回了也一样（选 17）。Goal 还在转就不另叫：求助到的那一步开头里已经列着，
        // 之后每次有新事或重建也列着；另发一张会排在 Goal 下一轮后面，到时多半已经回过了。
        const goal = actor && 当前持续目标(ctx, actor)
        if (!(goal?.phase === 'active' && goal.activation === 'armed')) await 提醒欠求助(ctx, 是.根, 是.我, event.data.turn)
      }
      if (重试过) 重新接上(ctx, actor)
    })().finally(release).catch(e => 喊('一轮结束，阶段转换或交齐事实没有递上', e))
  })
}

/** 这个会话是不是节点：是 → `{根, 名册, 我}`，不是 → null。 */
async function 认节点(ctx, session) {
  const 根 = 根Of(ctx, session)
  const 名册 = 根 && await 读名册(根)
  const 我 = 名册 && 我是谁(名册, session.id)
  return 我 ? { 根, 名册, 我 } : null
}

const 喊 = (话, e) => console.log(`Blueprint node: ⚠️ ${话} —— ${(e && e.message) || e}`)

/**
 * 建一个项目：项目文件夹 → 名册（0 ＝ worker，默认名字 ＝ 制作人 A）→ 0 的工作文档（意图 ＝ 用户第一句话）
 * → 模型表 → 开 0、叫醒它。0 的派出者是用户。
 *
 * 两处调它：`/blueprint` 命令、界面上的建项目（studio）。**一份实现**。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} 项目夹 项目放在哪个文件夹下（平时就是本模块的 `项目夹`；核对时换成临时文件夹）
 * @param {{provider?: string, model?: string, reasoningEffort?: string}} 模型 这个项目用哪个模型（一个项目一套）
 * @param {string[] | undefined} 技能 项目可用的 skill；省略时沿用全局开关
 * @param {Array<{name: string, data: string}>} 附件 Brief 中选择的文件与图片
 * @param {{自动命名?: boolean, 子代理?: object}} 选项 显示名是否自动命名；Agent 选择省略时沿用本机默认
 * @returns {Promise<string>} 项目文件夹
 */
export async function 建项目(ctx, 项目夹, 名字, 原话, 模型 = {}, 技能, 附件 = [], { 自动命名 = false, 子代理 } = {}) {
  验名字(名字)
  const Agent设置 = 验子代理设置(子代理 === undefined ? await Agent默认设置.read() : 子代理)
  const 选择 = 技能 === undefined ? undefined : 规范技能选择(技能)
  const 文件们 = 规范项目附件(附件)
  const 原始需求 = 原话
  原话 = 附件需求原话(原话, 文件们)
  const 根 = join(项目夹, 名字)
  if (existsSync(名册路径(根))) throw new Error(`「${名字}」已经有名册了 —— 换个名字`)
  await mkdir(join(根, 文档夹名), { recursive: true })
  const 名册 = await 落新名册(根, '制作人 A', 原话, { originalRequest: 原始需求 })
  await 初始化项目名称(根, 自动命名 ? '' : 名字)
  const 行 = 行Of(名册, 首节点)
  await 排队(根, async () => {
    await 写工作文档(根, 行, 新工作文档(行, 原话))
  })
  await writeFile(模型表路径(根), JSON.stringify({ provider: 模型.provider, model: 模型.model, reasoningEffort: 模型.reasoningEffort }, null, 2) + '\n')
  if (选择 !== undefined) await 写技能选择(根, 选择)
  await 写子代理设置(根, Agent设置)
  await 保存项目附件(根, 文件们)
  // spark 模式（十 55、十 56）：helm 先开着不叫醒，用户的话先交给一个 spark；spark 交出那一页，helm 才拿着它开工。
  if (协作模式Of(原话)?.id === 'spark') {
    await 开节点(ctx, 根, 首节点, null, { 新建项目: true, 叫醒: false })
    await 开spark(ctx, 根, { 原话 })
    return 根
  }
  await 开节点(ctx, 根, 首节点, null, { 新建项目: true })
  return 根
}

/**
 * 开一件新工作：总 seat 上的一个新分身（helm），和已有的工作并行。
 * 名册多一行（没有派出者，请求写入者是用户）→ 它的工作文档（请求 ＝ 用户原话）→ 开会话、叫醒。
 * 它的产物空间从主线（0 号的分支）长出，交回时并进主线。spark 撤了（第三版 10-24）：一律按 build 开。
 * @returns {Promise<string>} 新工作的会话号
 */
export async function 开工作(ctx, 根, 名字, 原话) {
  验名字(名字)
  if (typeof 原话 !== 'string' || !原话.trim()) throw new Error('这件工作要做什么，得写一句')
  const { id } = await 改名册(根, async m => {
    const 新id = 下一个编号(m, null)
    const 行 = { id: 新id, kind: 'worker', parent: null, name: 名字, task: 原话.trim(), status: '开工', requestWriter: 'user' }
    await 写工作文档(根, 行, 新工作文档(行, 原话.trim()))
    return { 名册: { ...m, rows: [...m.rows, 行] }, id: 新id }
  })
  return 开节点(ctx, 根, id, null)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx 座位卡平面的上下文
 */
export function apply(ctx, config = {}) {
  装素材目录(ctx)
  装上架工具(ctx)
  装项目隔离(ctx, { 检查预测: 检查行动预测, 只读代码目录: [...原生提供方代码目录([
    ...Object.values(config.externalProviderEntries || []), ...Object.values(config.executionRuntimeEntries || []),
  ]), ...(ctx.get('blueprintExecutionFeatures')?.readOnlyRoots || [])] })
  装资料(ctx)
  装验证收据(ctx)
  装媒体工具(ctx)
  装网页截图(ctx)
  装工具(ctx)
  装策略(ctx)
  装纸条(ctx)
  装节点文档(ctx)
  装程序工具(ctx)
  装思考开头(ctx)
  装通用工具(ctx)
  装纸条等待(ctx)
  装条件等待(ctx)
  装收起工具(ctx)
  装持续工作(ctx)
  装用户分身(ctx)

  /* 每次调模型：照项目的模型表发。挂最外层，dsh 自己那几钩跑完，这儿最后定。
     上限和档位按这个模型自己的重算，不留上一家的。
     helm 和 dock 每一档都用最高思考档（档 6）；模型不认 max 就照模型表。run 照模型表。 */
  ctx.on('agent/request', async ({ agent }, next) => {
    const 发 = await next()
    const 根 = 根Of(ctx, agent && agent.session)
    const 选 = 根 && await 读模型表(根)
    if (!选 || !选.provider || !选.model) return 发
    const { maxTokens: _上限, reasoningEffort: _档, ...余 } = 发
    if (await 是决策节点(根, agent.session.id)) {
      try { return { ...余, ...(await ctx.llm.resolveCallConfig({ ...选, reasoningEffort: 'max' })) } } catch {}
    }
    return { ...余, ...(await ctx.llm.resolveCallConfig(选)) }
  }, { prepend: true })

  装收尾续工(ctx)

  /* 建项目的命令（跟界面上的建项目调同一个 `建项目()`）。 */
  ctx.effect(() => ctx.commands.register({
    name: 'blueprint',
    description: '建一个 Blueprint 项目：/blueprint 项目名字：你想要什么',
    handler: async (invocation) => {
      try {
        const { 名字, 原话 } = 拆命令(invocation.rawInput)
        const o = (invocation.agent && invocation.agent.options) || {}
        const 根 = await 建项目(ctx, 项目夹, 名字, 原话, { provider: o.provider, model: o.model, reasoningEffort: o.reasoningEffort })
        return { kind: 'success', text: `建好了：${根}\n0 号节点已经开工。` }
      } catch (e) {
        return { kind: 'error', text: String((e && e.message) || e) }
      }
    },
  }), 'blueprint-node: /blueprint')
}
