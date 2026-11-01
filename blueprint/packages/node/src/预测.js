/** 预测认识作为节点可选的工作记录；行动入口核验身份、依赖与已提交的审核。 */
import { createHash } from 'node:crypto'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { 项目根, 读名册, 我是谁, 行Of, 节点类型, run不用的工具, spark不用的工具 } from '../../roster/src/index.js'
import { 等前置, 等开工孩子 } from '../../roster/src/组织.js'
import { 退役技能名 } from '../../prompt/src/项目技能.js'
import { 一段 } from '../../prompt/src/index.js'
import { 调的工具 } from './规则.js'
import { 是迭代工作, 迭代禁用工具 } from '../../context/src/迭代工作.js'
import { 是程序协助, 是子run, 程序协助禁用工具 } from '../../context/src/程序协助.js'

// 第三版（10-24）：rule 并进 orient，spark 撤了。旧账里的 rule／spark 认识不再列，也不再接受新的。
export const 预测环 = Object.freeze(['orient', 'plan'])
export const 预测环名 = Object.freeze(['定向', '校准定稿'])
const 指纹 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const 报告数 = 文档 => (文档.record.match(/^【第 \d+ 圈 · 成果报告】$/gm) || []).length
export const 预测依据 = (行, 文档, reports = 报告数(文档)) => 指纹({ node: 行.id, request: 文档.request, writer: 行.requestWriter, reports })
export function 当前交接(行, 文档, reports) {
  return 行.prediction?.basis === 预测依据(行, 文档, reports) ? 行.prediction.steps || [] : []
}
// 旧项目的 steps 可能还含旧环；保留原始版本，已落定方案仍能按原依据恢复。
export const 预测版本 = (行, 文档, reports) => 指纹({ basis: 预测依据(行, 文档, reports), steps: 当前交接(行, 文档, reports), responsibility: 文档.responsibility })
export function 有效定稿(行, 文档, reports) {
  const review = 行.strategyReview
  return review?.status === 'ready' && review.execution?.completed === true && review.basis === 预测版本(行, 文档, reports)
}
export const 可执行调查 = 行 => 行.status === '开工'
export const 有效调查 = (行, 文档) => 可执行调查(行, 文档) && 行.prediction?.inquiry?.basis === 预测版本(行, 文档) ? 行.prediction.inquiry : null

/** 按需记录任一环；同一认识不重复记档，其他环的已有认识保留。 */
export function 交接认识(行, 文档, { phase, insight } = {}) {
  const index = 预测环.indexOf(phase)
  if (index < 0 || typeof insight !== 'string' || !insight.trim()) throw new Error(`prediction 要填写 phase（${预测环.join('／')}）和非空 insight（本环取得的认识）`)
  const byPhase = new Map(当前交接(行, 文档).map(step => [step.phase, step])), digest = 指纹(insight.trim())
  if (byPhase.get(phase)?.digest === digest) return { prediction: 行.prediction, record: '' }
  byPhase.set(phase, { phase, digest })
  return { prediction: { basis: 预测依据(行, 文档), steps: 预测环.flatMap(name => byPhase.has(name) ? [byPhase.get(name)] : []) },
    record: `【预测认识 · ${预测环名[index]}】\n${insight.trim()}` }
}
export function 调查预测(行, 文档, { purpose, expectation } = {}) {
  if (![purpose, expectation].every(value => typeof value === 'string' && value.trim())) throw new Error('inquiry 要说明 purpose（为了弄清什么）与 expectation（预计取得什么认识）')
  const inquiry = { basis: 预测版本(行, 文档), purpose: purpose.trim(), expectation: expectation.trim() }
  const same = JSON.stringify(有效调查(行, 文档)) === JSON.stringify(inquiry)
  // 局部调查保留已记录的认识，是否补充或修正由节点判断。
  return { prediction: { ...(行.prediction || { basis: 预测依据(行, 文档), steps: [] }), inquiry },
    record: same ? '' : `【调查预测】\n目的：${inquiry.purpose}\n预计：${inquiry.expectation}` }
}
export function 预测状态(行, 文档) {
  const steps = 当前交接(行, 文档).filter(step => 预测环.includes(step.phase))
  const 状态 = 有效定稿(行, 文档) ? '已有落定方案。按当前工作判断是继续、局部调整还是重新预测。'
    : steps.length ? `已记录：${steps.map(step => 预测环名[预测环.indexOf(step.phase)]).join('、')}。按当前认识决定下一步。` : '尚未记录预测认识；是否需要展开，由你判断。'
  const 调查 = 有效调查(行, 文档)
  return `【当前预测】\n${状态}${调查 ? `\n当前调查：${调查.purpose}\n预计：${调查.expectation}` : ''}`
}

const 入口工具 = new Set(['tool_info', 'call_tool', 'node_doc', 'note', 'wait', 'compact', 'skill', 'next',
  'read', 'read_image', 'glob', 'grep', 'web_fetch', 'web_search', 'media_catalog', 'job_list', 'job_output', 'job_kill', 'present_artifact',
  'get_goal', 'create_goal', 'update_goal', 'load_workspace_dependencies'])
const 拒绝行动 = (code, message) => { throw new HarnessError(`${code}: ${message}`, code) }

/**
 * 进 orient 的那一步、stunning 的 run 开工的那一步只想不动手（则 8）：记的是会话 id，思考开头记下、下一步开头撤掉。
 * 这一步只放行存认识、交接和搜索；只看工具名，不看写了什么。
 */
export const 先想这一步 = new Set()
const 先想可用 = new Set(['tool_info', 'node_doc', 'next', 'web_search', 'web_fetch'])

/** 工具可直接使用；只核验角色范围、正式依赖和正在审核的方案。 */
export async function 检查行动预测(ctx, exec) {
  const { name, arguments: args = {}, agent } = exec
  if (先想这一步.has(agent?.session?.id) && !先想可用.has(调的工具({ name, arguments: args }))) 拒绝行动('THINK_FIRST', 一段('重置/先想这一步'))
  if (['tool_info', 'call_tool', 'job_kill'].includes(name)) return { mode: 'entry' }
  const session = agent?.session, 根 = 项目根(ctx, session?.id), 名册 = await 读名册(根)
  const 我 = 名册 && 我是谁(名册, session?.id)
  if (!我 && 是程序协助(session)) {
    const parent = ctx.root.agents.get(session.header.parentSession)
    if (!parent || !我是谁(名册, parent.id) || 程序协助禁用工具.has(name)) 拒绝行动('WORKFLOW_SCOPE', '批量帮助只承担发起节点的本次任务。')
    await 检查行动预测(ctx, { ...exec, name: 'workflow', agent: parent })
    return { mode: 'execute', helper: true }
  }
  if (!我 && 是子run(session)) {
    const parent = ctx.root.agents.get(session.header.parentSession)
    if (!parent || !我是谁(名册, parent.id) || 程序协助禁用工具.has(name)) 拒绝行动('SUBAGENT_SCOPE', 'subagent 只承担叫它的那个节点交的事。')
    await 检查行动预测(ctx, { ...exec, name: 'subagent', agent: parent })
    return { mode: 'execute', helper: true }
  }
  if (!我 && 是迭代工作(session)) {
    const parent = ctx.root.agents.get(session.header.parentSession)
    if (!parent || !我是谁(名册, parent.id) || 迭代禁用工具.has(name)) 拒绝行动('RALPH_SCOPE', '迭代工作只承担请求节点的工作区任务。')
    await 检查行动预测(ctx, { ...exec, name: 'ralph', agent: parent })
    return { mode: 'execute', helper: true }
  }
  if (!我) 拒绝行动('NODE_REQUIRED', '不在名册上的会话不能动手。')
  const 行 = 行Of(名册, 我)
  // 提问卡只给 run（照 dsh 原样，10-28）；solo 时由系统替用户答（node 的 回答.js）。
  if (name === 'ask_user_question' && 节点类型(行) !== 'run') 拒绝行动('NO_QUESTION_CARD', '提问卡已经拆掉。要问用户的，照协作说明在对话里说。')
  if (节点类型(行) === 'run' && run不用的工具.includes(name)) 拒绝行动('RUN_SCOPE', `run 不用 ${name}：照请求做完交回，不开节点、不走环节，要整块交出去的一块用 subagent；做不下去就用 finish 交回，写清卡在哪。`)
  if (节点类型(行) === 'spark' && spark不用的工具.includes(name)) 拒绝行动('SPARK_SCOPE', `spark 不用 ${name}：只陪用户把要什么理清，写成一页用 finish 交给 helm；派人、走环节、等待、纸条都是 helm 的事。`)
  // subagent 给执行节点（dock、run）做不需要创造力的重活（设计页第三版第三节 plan）；helm 的活交给总 dock。
  if (name === 'subagent' && 节点类型(行) === 'helm') 拒绝行动('SUBAGENT_SCOPE', 'helm 不用 subagent：这一阶段的活用 divide 交给总 dock。')
  if (name === 'skill' && 退役技能名.includes(args.name)) throw new Error(`${args.name} 技能已退役，不能读取。`)
  if (name === 'verification' && ['collect', 'compare'].includes(args.action)) return { mode: 'entry' }
  if (入口工具.has(name)) return { mode: 'entry' }
  if (name === 'finish' && 行.status === '完成') return { mode: 'entry' }
  if (行.status !== '开工') 拒绝行动('NODE_ACTION_UNAVAILABLE', '本节点已交回，不能继续执行其工作。')
  if (name === 'divide') return { mode: 'entry' }
  const 前置 = 等前置(名册, 我), 下层 = 等开工孩子(名册, 我)
  if (前置.length || 下层.length) 拒绝行动('NODE_DEPENDENCY_PENDING', `工作尚在等待${前置.length ? `正式前置：${前置.join('、')}` : `下层交回：${下层.join('、')}`}。可查看情况或协调。`)
  const review = 行.strategyReview?.finalReview
  if (['pending', 'revision'].includes(review?.status) && !行.strategyReview.execution) {
    拒绝行动('PLAN_REVIEW_PENDING', '当前提交的方案尚未通过用户审核，先处理审核反馈；查看情况和协调不受影响。')
  }
  return { mode: 'execute' }
}
