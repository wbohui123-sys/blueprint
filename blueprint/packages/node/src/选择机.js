/**
 * 选择机：每进入一个阶段前，在节点对话之外单独调用一次，只回答"下一步应该做什么"——一个阶段名。
 * 复用节点已提交的系统提示、工具历史和全部消息，首轮使用原生作用域装配；末尾接这一步的输入和选择问题。
 * 缓存由 DeepSeek 服务端管理；这里保留可复用前缀，不保证每次命中。
 * 机器把选出的那一阶段的页接在这一步的输入后面，节点自己干；选择过程不进节点对话，只记进 `系统文档/选择机.jsonl`。
 */
import { createHash } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { 保存选择机请求 } from './选择机请求.js'
import { 一段, 执行者文案 } from '../../prompt/src/index.js'
import { 节点前缀文, 有节点前缀了 } from '../../context/src/拼.js'
import { 拼公共前缀 } from '../../context/src/index.js'
import { 打开的执行者, 执行者们, 读子代理开关 } from './子代理开关.js'
import { 读名册, 改名册, 行Of, 读节点文档, 读模型表, 节点类型, 文档夹名, 就绪表, 新阶段待开, 孩子们 } from '../../roster/src/index.js'
import { 整合表, 阶段整合表 } from '../../roster/src/整合表.js'
import { 协作点页 } from './协作点.js'

/**
 * 每类节点能选的阶段；名字一样就是同一件事。reply（回话）不是一轮里的一步，人人都有（选 12）。run 不过选择机。
 * 设计页第三版（10-24）：rule 并进 orient，spark、dock 环节撤了。
 * - helm 是问题解决机：orient 勘明意图，plan 定阶段、用 divide 交给总 dock，execute 等它交回，complete 对照用户意图。
 * - dock 走四步：orient、plan、execute（搭台、派出台撑得起的那一批）、integrate（接上交来的、在自己这一层看过）、complete。
 *   10-25 精简（十 46）：verify 并进 integrate。
 */
export const 菜单们 = Object.freeze({
  helm: Object.freeze(['orient', 'plan', 'execute', 'complete', 'reply']),
  dock: Object.freeze(['orient', 'plan', 'execute', 'integrate', 'complete', 'reply']),
})
export function 菜单Of(类型) {
  return [...(菜单们[类型] || 菜单们.dock)]
}

/** 阶段页放在哪：helm 的四步在 `重置/阶段/helm/`，回话和执行节点共用一页（设计页第三版第一节）。 */
export const 阶段页名 = (类型, stage) => 类型 === 'helm' && stage !== 'reply' ? `重置/阶段/helm/${stage}` : `重置/阶段/${stage}`

export const 选择记录路径 = 根 => join(根, 文档夹名, '选择机.jsonl')

/** 回答里认出一个菜单里的阶段名；认不出 → null。 */
export function 认阶段(回答, 菜单) {
  const 文 = String(回答 || '').trim().toLowerCase().replace(/^[`"'“”‘’「」【】\[\]()（）\s.。:：-]+|[`"'“”‘’「」【】\[\]()（）\s.。!！]+$/g, '')
  if (菜单.includes(文)) return 文
  const 见到 = [...new Set((文.match(/[a-z]+/g) || []).filter(词 => 菜单.includes(词)))]
  return 见到.length === 1 ? 见到[0] : null
}

/**
 * 选择机读到的「上一个阶段」。交接由 next 写，execute 里用 divide 派出时也写一句；没有交接就是这个阶段没结束（被按停、出错、没调工具就停），
 * 要写给它，不然被打断后它会当成做完了往后选（选 36）。reply 说完就停、complete 可以用 finish 交回，这两个本来就不留交接。
 */
const 不留交接 = new Set(['reply', 'complete'])
export function 上一个阶段Of(selector) {
  if (!selector?.last) return '（还没有，这是第一次）'
  if (selector.handoff) return `${selector.last}；交接：${selector.handoff}`
  return 不留交接.has(selector.last) ? selector.last : `${selector.last}；还没结束：没用 next 交接就停了`
}

/**
 * 机器知道、模型看不见的两件事（选 42，10-23 黑暗之魂 10-23-3）：这条线进过哪些环节（每进一个，阶段页 记进 selector.seen），
 * 结构段里有没有 plan 交上来的分工表。节点在 rule 里抢跑、把分工表塞进交接时，选择机光看交接会当 plan 做过了；
 * 有了这两件事实，它看得出那张表不是在 plan 页上写出来的。不收菜单，由它判断。
 */
export const 进过Of = selector => selector?.seen?.length ? selector.seen.join('、') : '（还没有）'
export const 结构段Of = doc => doc?.structure?.trim() ? '有分工表' : '还空着（plan 用 next 交的分工表才写进这里）'

const 选择机消息 = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin:blueprint-selector' } })

/**
 * 节点会话里还没有系统提示（开工第一轮，原生在这一步之后才放进去）：
 * 系统提示与工具取原生装配；离线调用没有 agent 时保留模板回退。
 * 节点前缀已由上下文插件插入时不再重复添加。
 */
async function 开工那份(根, 行) {
  const 名册 = await 读名册(根), doc = await 读节点文档(根, 行)
  return { system: 拼公共前缀(节点类型(行)), 开场: doc ? [选择机消息(节点前缀文(名册, 行.id, doc.request, 根, 一段))] : [] }
}

/**
 * 选择机那一次调用的输入：复用节点已提交的请求前缀，末尾接这一步的输入和问题。
 * `session`：节点的会话，从账本取请求头、消息及工具变更历史，交给原生 DSH 投影；
 * `这一步`：这一步新到、即将进节点对话的消息（叫醒话、用户的话、开头和情境）。
 */
export async function 选择机输入(根, 行, session, 这一步 = [], { assembly } = {}) {
  const 菜单 = 菜单Of(节点类型(行))
  const 问题 = 选择机消息(一段('重置/选择机', { 上一个阶段: 上一个阶段Of(行.selector), 进过: 进过Of(行.selector),
    结构段: 结构段Of(await 读节点文档(根, 行)), 菜单: 菜单.join('、') }))
  const header = session?.requestHeader?.()
  const 历史 = session?.deriveMessages?.() || []
  const toolHistory = header ? session?.toolHistory?.() : undefined
  const 开工 = 历史.some(m => m.role === 'system') ? null : await 开工那份(根, 行)
  const tools = header?.tools ?? assembly?.tools
  return {
    ...(开工 ? { system: assembly ? renderPrompt(assembly) : 开工.system } : {}),
    messages: [...(开工 && !有节点前缀了([...历史, ...这一步]) ? 开工.开场 : []), ...历史, ...这一步, 问题],
    // 工具照原样带上：dsh 没有禁用工具的开关，少了它前缀就和节点的请求对不上。
    ...(tools?.length ? { tools: [...tools] } : {}),
    // 仅有当前工具不够：原生投影还需要历史，才能保留增量声明和 developer 消息。
    ...(toolHistory ? { toolHistory } : {}),
    ...(session?.id ? { sessionId: session.id } : {}),
    菜单, 模型: header?.config,
  }
}

/** 沿用节点已生效的模型和思考档，避免辅助调用另开缓存前缀；首轮与管理节点一样尝试 max。 */
async function 调用配置(ctx, 根, 模型, 类型) {
  const 已生效 = 模型?.provider && 模型?.model
  const 选 = 已生效 ? 模型 : await 读模型表(根)
  if (!选?.provider || !选?.model) throw new Error('没有可用的模型')
  const route = { provider: 选.provider, model: 选.model }
  const effort = 已生效 ? 选.reasoningEffort : ['helm', 'dock'].includes(类型) ? 'max' : 选.reasoningEffort
  if (effort === undefined) return ctx.llm.resolveCallConfig(route)
  try { return await ctx.llm.resolveCallConfig({ ...route, reasoningEffort: effort }) }
  catch { return ctx.llm.resolveCallConfig(已生效 ? route : 选) }
}

async function 问一次(ctx, 配置, 输入, signal, 记录请求) {
  const options = { ...配置, ...(输入.system ? { system: 输入.system } : {}), messages: 输入.messages,
    ...(输入.tools ? { tools: 输入.tools } : {}), ...(输入.toolHistory ? { toolHistory: 输入.toolHistory } : {}),
    ...(输入.sessionId ? { sessionId: 输入.sessionId } : {}), maxTokens: 4096, ...(signal ? { signal } : {}) }
  const trace = await 保存选择机请求(options)
  记录请求(trace)
  const assembler = new BlockAssembler()
  let streamError
  try { for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk) }
  catch (error) { streamError = new Error(String(error?.message || error)) }
  const finish = assembler.finish
  if (!streamError && (finish?.kind === 'error' || finish?.kind === 'aborted')) streamError = new Error(finish.failure?.message || finish.kind)
  // 只认文字；带着工具清单，它也可能去调工具，那样就当没认出。
  return { 文: assembler.blocks().filter(b => b.type === 'text').map(b => b.text).join('').trim(), usage: assembler.usage, trace, error: streamError }
}

const 文字Of = 们 => 们.flatMap(m => (m.content || []).filter(b => b.type === 'text').map(b => b.text)).join('\n\n')

/**
 * 选一个阶段：解析不出或不在菜单里重问一次；还不行返回 null（这次不插页）。
 * 每次都记一行，供轨迹检验和界面使用；usage 里的 cacheReadTokens 看得出缓存命中多少。
 */
export async function 选阶段(ctx, 根, 行, { session, agent, 这一步 = [], signal } = {}) {
  const 起 = Date.now(), 记 = { at: new Date().toISOString(), node: 行.id, type: 节点类型(行) }
  let stage = null, attempts = 0, 回答们 = [], usage = [], requests = [], error
  try {
    if (typeof ctx.llm?.stream !== 'function') throw new Error('没有可用的模型')
    const assembly = agent && !session?.requestHeader?.() && typeof ctx.systemPrompt?.assemble === 'function'
      ? await ctx.systemPrompt.assemble(assembleContextFor(agent, signal)) : undefined
    const 输入 = await 选择机输入(根, 行, session, 这一步, { assembly })
    const 配置 = await 调用配置(ctx, 根, 输入.模型, 节点类型(行))
    记.sessionId = session?.id; 记.provider = 配置.provider; 记.model = 配置.model
    记.reasoningEffort = 配置.reasoningEffort; 记.maxTokens = 4096
    记.menu = 输入.菜单; 记.messages = 输入.messages.length; 记.tools = 输入.tools?.length || 0
    while (!stage && attempts < 2) {
      attempts++
      const 回 = await 问一次(ctx, 配置, 输入, signal, trace => requests.push({ attempt: attempts, usageIndex: null, ...trace }))
      回答们.push(回.文.slice(0, 200))
      if (回.usage) { requests.at(-1).usageIndex = usage.length; usage.push(回.usage) }
      if (回.error) throw 回.error
      stage = 认阶段(回.文, 输入.菜单)
    }
  } catch (e) { error = String(e?.message || e) }
  await mkdir(join(根, 文档夹名), { recursive: true })
  await appendFile(选择记录路径(根), JSON.stringify({ ...记, 这次: 文字Of(这一步).slice(0, 120), stage, attempts, answers: 回答们, usage, requests, ms: Date.now() - 起, ...(error ? { error } : {}) }) + '\n').catch(() => {})
  return stage
}

/**
 * 选出的阶段放进节点对话的那一段：阶段名一行，加那一阶段的页。
 * 和上一个阶段相同、中间没有重建、那一页的文字也没改过时，只写阶段名那一行（圈 9）。选不出 → 空字符串。
 * 记下这次选了什么，和放进来的那一页的指纹。
 * `转交(stage)` 返回真：这件事交给了别人（交回了的 helm 开新总分身，新 1），不放页、不记到这一行，返回 null。
 */
export async function 阶段页(ctx, 根, id, { session, agent, 这一步 = [], 重建 = false, signal, 转交, 指定 } = {}) {
  const 名册 = await 读名册(根), 行 = 行Of(名册, id)
  // `指定`：不问选择机，直接用这一环节（用户亲口说的话直接回话，选 46）。
  const stage = 指定 || await 选阶段(ctx, 根, 行, { session, agent, 这一步, signal })
  if (stage && 转交 && await 转交(stage)) return null
  // dock 的 plan 那页后面接分工表的格式，再接 agent 模式那段（叶 5）；helm 的 plan 只派一块总 dock，不接。
  // dock 进 execute：页后接就绪表——它名下登记着的块哪些现在能做、哪些还在等谁（设计页第三版第四节）。表变了页指纹跟着变，整页重给。
  // dock 进 integrate：页后接整合表——这一枝交上来、还没接进它手上成品的东西（10-25，合 3）。
  // helm 进 complete：页后接这一阶段总 dock 交回时还没接进成品的（合 7）。
  // helm 进 plan、用户刚从「新建阶段」进来（十 61）：页后接新阶段那段——开全新的总 dock，上一任还没交回的由系统收起。
  // 协作点（协 4）：helm 在 build 下定向（新建阶段在 plan）接协作预设；标了协作点的 dock 在对应环节接一段。
  const 类型 = 节点类型(行)
  const 页 = stage ? [一段(阶段页名(类型, stage)),
    ...(类型 === 'dock' && stage === 'plan' ? [一段('重置/分工表'), agent模式段(根, 行)] : []),
    ...(类型 === 'dock' && stage === 'execute' ? [就绪表(名册, String(id))] : []),
    ...(类型 === 'dock' && stage === 'integrate' ? [整合表(名册, String(id))] : []),
    ...(类型 === 'helm' && stage === 'complete' ? [阶段整合表(名册, String(id))] : []),
    ...(类型 === 'helm' && stage === 'plan' && 新阶段待开(名册, String(id)) ? [新阶段段(名册, String(id))] : []),
    ...(stage ? 协作点页(名册, 行, stage) : []),
  ].filter(Boolean).join('\n\n') : '', 页指纹 = createHash('sha1').update(页).digest('hex')
  await 改名册(根, m => {
    const r = 行Of(m, id), 旧 = r.selector || {}
    const selector = { ...旧, ...(stage ? { last: stage, 页指纹, seen: [...new Set([...(旧.seen || []), stage])] } : {}) }
    delete selector.handoff
    // 旧版记的中途到的事（选 14）：现在都在对话里，选择机直接看得到（同 1），留着的清掉。
    delete selector.pending
    // 用户这一轮的通过管到差异判断；进了 complete，这一轮就过去了（选 35）。
    if (stage === 'complete') delete selector.planApproved
    return { ...m, rows: m.rows.map(row => row.id === String(id) ? { ...row, selector } : row) }
  })
  if (!stage) return ''
  const 行文 = `【环节：${stage}】`
  // 每段结束前对用户说两句（10-27）：进哪个环节都接在末尾，同一环节重进只插阶段名时也带上；不算进页指纹。回话本来就在说话，不接。
  const 收尾 = stage === 'reply' ? '' : `\n\n${一段('重置/环节收尾')}`
  return (stage === 行.selector?.last && !重建 && 页指纹 === 行.selector?.页指纹 ? 行文 : `${行文}\n\n${页}`) + 收尾
}

/** 新阶段那段（十 61）：上一任总 dock 是谁、交没交回。还没派过总 dock 的写「还没有」。 */
export function 新阶段段(名册, id) {
  const 上一任 = 孩子们(名册, id).map(n => 行Of(名册, n)).filter(r => r.role === 'dock' && r.session && r.status !== '去掉').at(-1)
  const 说 = !上一任 ? '还没有' : `${上一任.id}「${上一任.name}」，${上一任.stageClosed ? '上次新建阶段时收起了，没交回' : 上一任.status === '完成' ? '已经交回' : '还没交回'}`
  return 一段('重置/新阶段', { 上一任: 说 })
}

/**
 * agent 模式那段（叶 5、7、8）：项目打开了 Codex／Claude Code，dock 在 plan 阶段那一页底下看到（外部 agent 只能当 run）；
 * 别的阶段、helm、run 都不给（10-18 用户：只塞进 plan 阶段那页，剩下都不需要知道）；都关着一个字不出现。
 * 每次进 plan 现读开关：拨了开关，页指纹跟着变，下次进 plan 整页重给。
 */
export function agent模式段(根, 行) {
  const 开着 = 节点类型(行) === 'dock' ? 打开的执行者(根) : []
  if (!开着.length) return ''
  const 说明 = 执行者文案(), { 偏好, 开关 } = 读子代理开关(根)
  // 选择偏好：只列开着的（DSH 关了就没有 DeepSeek 那句）；空着的不列。
  const 行们 = [...(开关.dsh ? [['DeepSeek（executor 不写）', 偏好.dsh]] : []), ...开着.map(key => [`${key}（${执行者们[key].名字}）`, 偏好[执行者们[key].开关]])]
    .filter(([, 文]) => 文?.trim()).map(([谁, 文]) => `- ${谁}：${文.trim()}`)
  return 一段('外部agent', { 打开的: 开着.map(key => `${执行者们[key].名字}（${说明[key]}）`).join('和 '),
    偏好: 行们.length ? 行们.join('\n') : '- （用户没写，你自己判断）', 关DeepSeek: 开关.dsh ? '' : 一段('外部agent关DeepSeek') }).replace(/\n{3,}/g, '\n\n')
}

/**
 * 结束这个阶段（next、execute 里 divide 派出）：只记下交接。节点闲下来 Goal 自己开下一轮，第一步先过选择机，交接写进问题那一段的「上一个阶段」（选 20）。
 */
export async function 结束阶段(ctx, agent, 根, id, 交接) {
  await 改名册(根, m => ({ ...m, rows: m.rows.map(r => r.id === String(id)
    ? { ...r, selector: { ...(r.selector || {}), handoff: 交接 } } : r) }))
}
