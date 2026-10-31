/**
 * 文字的唯一出处 —— 系统里模型读到的每一段话都住在这个包里。
 *
 * **本包只放文字和读文字的几个函数，不是插件，不进接线图。**
 * 系统提示怎么拼，归 `context` 包；这儿只负责「那段字在哪、读出来」。
 *
 * - `重置/`：2026-10-13 重置后的一套（canon、四类节点各一段、阶段页、选择机、新工具说明）。名字以 `重置/` 开头的段从这里读。
 * - `shells/分层前缀.md`：稳定信息的组合版式；不含本轮任务。
 * - `shells/<名>.md`：别的整段的话（节点前缀的模板、`叫醒/` 下机器递的那几句）。
 * - `工具/<工具名>.md`：一把工具一份说明书。
 * - `skill/<名>/SKILL.md`：一份 skill 一个文件夹，旁边可以带它自己的小脚本（`scripts/`）。dsh 从这儿发现 skill（座位卡上 `customSkillDirs`）。
 *
 * @module @blueprint/prompt
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { 文字路径 } from './路径.js'

/** 阶段页由选择机插入（`重置/阶段/`），技能目录里不再有节点本体的技能页。 */
export const 节点本体技能名 = Object.freeze([])

/** 节点的三种类型：helm（问题解决机，没有派出者）；执行节点按派出时上级写的角色分 dock（搭台、派下级、整合、验收）和 run（拿着请求一口气做到底交回）。 */
export const 节点类型们 = Object.freeze(['helm', 'dock', 'run', 'spark'])

/** 重置后的新文字住在 `重置/` 下；名字带这个前缀的段从那里读。 */
const 新文字前缀 = '重置/'
const 文件Of = 名 => String(名).startsWith(新文字前缀) ? `${名}.md` : `shells/${名}.md`
/** 一段话住在 prompt 包里哪个文件（相对包根）；界面的料单也照它找。 */
export const 文字出处 = 文件Of
/** 这一段话的文件在不在（几份文字并在一起、或还没写好时，程序挑着用）。 */
export const 有一段 = 名 => existsSync(join(文字路径, 文件Of(名)))
/** 一把工具的说明书住在哪个文件：有重置版用重置版。 */
export const 说明书出处 = 名 => existsSync(join(文字路径, `重置/工具/${名}.md`)) ? `重置/工具/${名}.md` : `工具/${名}.md`

/* ── 工具说明书 ────────────────────────────────────────────────────────────
   **一把工具一份 md，住 `packages/prompt/工具/<工具名>.md`。**

   2026-08-31 用户裁定，理由是他自己提的一个问题：「assign 在哪，为什么我的 prompt
   文件夹里看不见？」——**模型读到的字里有三成埋在 JS 字符串里，作者本人打不开。**
   所以它跟 `shells/` 并排单开一个夹，studio 顶栏给它一个自己的按钮（`tool`）——
   两个根互不重叠：`prompt` 装整段的话，`tool` 装工具的说明书。

   ⚠️ **不缓存**：说明书只在注册工具那一刻读一次，缓存白占地方，
   而且会让"改了 md 重起 dsh 生效"这件事多一层解释。

   **`{{占位}}` 是给"从表上长出来的那几行"留的口子** —— 凡是代码里有一张表、
   说明书又要提到的，手抄一次就会过期（付过代价：2026-08-24 删掉的三格在 archive 的
   说明里一直活到 08-26，模型每一轮照着它认柜子）。所以 md 里只放散文，表由调用方填。
   填漏了当场炸，不许静默留一个 `{{...}}` 给模型看。 */
export function 说明书(名, 填) {
  // 重置后的工具说明在 `重置/工具/`，没有新版的沿用 `工具/`。
  for (const 出处 of [`重置/工具/${名}.md`, `工具/${名}.md`]) {
    let 全文
    try { 全文 = readFileSync(join(文字路径, 出处), 'utf8').trim() } catch { continue }
    return 填空(全文, 填, 出处)
  }
  if (process.env.BLUEPRINT_ALLOW_UNISOLATED === '1') return `工具 ${名}：参数与约束见工具定义；按需调用，做完在汇报里说清结果。`
  throw new Error(`blueprint-prompt: 没有 packages/prompt/工具/${名}.md —— 工具说明书是文件，不写在代码里`)
}

/** 原生工具的精简说明，一份出处；参数约束与执行仍由 dsh 提供。 */
export function 原生工具文案() {
  return JSON.parse(readFileSync(join(文字路径, '工具', '原生工具文案.json'), 'utf8'))
}

/** run 的外部执行者各一句：是谁、能做什么（divide 的 executor 那一条按开关挑着用）。 */
export function 执行者文案() {
  return JSON.parse(readFileSync(join(文字路径, '重置', '工具', '执行者.json'), 'utf8'))
}

/**
 * 把 `{{占位}}` 换成调用方给的值。**填漏了当场炸**，不许静默留一个 `{{...}}` 给模型看；
 * 多给的值不管（模板用不用哪一格，归写模板的人定）。
 */
function 填空(文, 填, 出处) {
  return String(文).replace(/\{\{([^}]+)\}\}/g, (_m, k) => {
    const v = 填 && 填[k.trim()]
    if (v === undefined) throw new Error(`blueprint-prompt: ${出处} 里的 {{${k}}} 没人填 —— 调用方得给`)
    return Array.isArray(v) ? v.join('\n') : String(v)
  })
}

/**
 * **工具交回一段字给模型的形状**（dsh 的 `tools.register` 必须声明 `output: { schema, render }`，缺了当场抛）。
 * 我们的工具都只交回一段字：execute 返回 `{ 文: '…' }`，模型看到的就是那段字本身，不是转义过的 JSON。
 * 一处定义，谁注册工具谁用。
 */
export const 只回一段字 = Object.freeze({
  schema: { type: 'object', additionalProperties: false, required: ['文'], properties: { 文: { type: 'string' } } },
  render: (_参数, 值) => [{ type: 'text', text: String(值.文) }],
})

/** 每份文本只有一个出处：本包 `shells/` 下那一个文件。 */
function read(part) {
  try {
    return readFileSync(join(文字路径, 文件Of(part)), 'utf8')
  } catch {
    /* 拼错名字要当场炸，不许静默少一段 —— 少一段的节点会带着半个世界观上岗，
       而且从输出上看不出来（2026-08-18 那次空转的病根）。 */
    throw new Error(`blueprint-prompt: 没有 ${文件Of(part)}`)
  }
}

/**
 * 整段的话（`shells/<名>.md` 的原文）。取不到当场炸。
 * 给了 `填`，就把里面的 `{{占位}}` 换掉（节点前缀、叫醒这种「模板写格式、机器填数」的段）。
 */
export function 一段(名, 填) {
  const 文 = read(String(名 || '')).trim()
  return 填 ? 填空(文, 填, 文件Of(名)) : 文
}

/** run 开工那一步按工作等级接的一页（`重置/run开工/<档>`，10-27 级 1）；没定等级的不接。 */
export const run开工页 = 档 => 档 && 有一段(`重置/run开工/${档}`) ? 一段(`重置/run开工/${档}`) : ''

/** 协作选项、界面文字与节点职责同出一份目录。 */
export function 协作模式们() {
  const 表 = JSON.parse(readFileSync(join(文字路径, 'shells/协作模式/名单.json'), 'utf8'))
  if (!Array.isArray(表) || !表.length) throw new Error('blueprint-prompt: 协作模式目录为空')
  const 已有 = new Set()
  for (const 项 of 表) {
    if (!项 || !/^[a-z][a-z0-9-]*$/.test(项.id) || 已有.has(项.id)
      || ['label', 'description', 'prompt'].some(k => typeof 项[k] !== 'string' || !项[k].trim())
      || !/^协作模式\/[^/]+$/.test(项.prompt) || !Array.isArray(项.aliases)
      || !Array.isArray(项.guide) || !项.guide.length || 项.guide.some(x => typeof x !== 'string' || !x.trim())) {
      throw new Error('blueprint-prompt: 协作模式目录格式不完整')
    }
    已有.add(项.id)
  }
  return 表
}

/** 保留用户原话，只解释最后一条 Mode；未知与缺失的模式不猜默认值。 */
export function 协作模式Of(原话) {
  let 值
  for (const 行 of String(原话 || '').split(/\r?\n|｜|；(?=\s*Mode\s*[:：])/)) {
    const m = 行.trim().match(/^Mode\s*[:：]\s*([a-z][a-z0-9-]*)(?:\s*[（(].*[）)])?\s*$/i)
    if (m) 值 = m[1].toLowerCase()
    else if (/^Mode\s*[:：]/.test(行.trim())) 值 = undefined
  }
  return 协作模式们().find(项 => 项.id === 值 || 项.aliases.includes(值)) || null
}

/**
 * 这一阶段实际怎么协作（十 55）：helm 行上记的这一阶段的模式（stageMode）优先，没有就看项目开头选的；
 * spark 只是前置组件，它交完以后按 solo 跑（十 56），标了协作点的块照样找用户（协 3）。返回 build 或 solo 那一项；认不出返回 null。
 */
export function 运行模式Of(原话, 阶段模式) {
  const 项 = 选的模式Of(原话, 阶段模式)
  return 项?.id === 'spark' ? 协作模式们().find(x => x.id === 'solo') : 项
}

/** 这一阶段用户选的是哪一种（不把 spark 换成 solo）：协作预设、协作点认这个（协 1）。spark 交完以后 helm 行记 stageMode=spark。 */
export function 选的模式Of(原话, 阶段模式) {
  const 表 = 协作模式们(), 找 = id => 表.find(项 => 项.id === id || 项.aliases.includes(id)) || null
  return (阶段模式 && 找(String(阶段模式).toLowerCase())) || 协作模式Of(原话)
}

/** 品质档（档 1）：只认最后一条 Quality 行里的 high／max／ultra；`段们` 是要接上的几段话，先三档共用的总述（档 8），再当前这一档。认不出返回 null，不猜默认。 */
export function 品质档Of(原话) {
  let 值
  for (const 行 of String(原话 || '').split(/\r?\n|｜|；(?=\s*(?:Quality|Mode)\s*[:：])/)) {
    const m = 行.trim().match(/^Quality\s*[:：]\s*([a-z]+)/i)
    if (m) 值 = m[1].toLowerCase()
    else if (/^Quality\s*[:：]/.test(行.trim())) 值 = undefined
  }
  return ['high', 'max', 'ultra'].includes(值) ? { id: 值, 段们: ['档位/总述', `档位/${值}`] } : null
}

/* ── skill 正文 ──────────────────────────────────────────────────────────── */

/**
 * 一页 skill 的正文（去掉 frontmatter）。节点读页走 dsh 原生的 skill 工具；
 * 这里供工具类 skill 的正文核对使用。
 */
export function 技能正文(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(String(name))) throw new Error(`blueprint-prompt: skill 名「${name}」不合法`)
  let 文
  try { 文 = readFileSync(join(文字路径, 'skill', name, 'SKILL.md'), 'utf8') } catch {
    throw new Error(`blueprint-prompt: 没有 skill/${name}/SKILL.md`)
  }
  const m = 文.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/)
  const 项 = m && parse(m[1])
  if (!m || 项?.name !== name || !m[2].trim()) throw new Error(`blueprint-prompt: skill/${name}/SKILL.md 的名称或正文不完整`)
  return m[2].trim()
}

/**
 * 按信息用途定义装配清单，context 与 SYS 查看共用；不含任务、节点编号或认知阶段。
 * helm／dock：canon → 公共前缀 → 使用情境 → 这类节点的专属一段。run：专属一段 → 公共前缀 → 使用情境，不读 canon。
 * 认不出的身份只拿 canon、公共前缀和使用情境。
 */
export function 提示结构(身份) {
  // spark（十 56）：陪用户理清要什么的前置组件，和 run 一样不读 canon，只有自己一页和操作提醒。
  if (身份 === 'spark') return { 模板: '分层前缀', 模块: [
    { 格: '目标与判断', 名: '重置/节点/spark' },
    { 格: '操作提醒', 名: '公共前缀' },
    { 格: '操作提醒', 名: '使用情境' },
  ] }
  if (身份 === 'run') return { 模板: '分层前缀', 模块: [
    { 格: '目标与判断', 名: '重置/节点/run' },
    { 格: '操作提醒', 名: '公共前缀' },
    { 格: '操作提醒', 名: '使用情境' },
  ] }
  return { 模板: '分层前缀', 模块: [
    { 格: '目标与判断', 名: '重置/canon' },
    { 格: '操作提醒', 名: '公共前缀' },
    { 格: '操作提醒', 名: '使用情境' },
    ...(节点类型们.includes(身份) ? [{ 格: '操作提醒', 名: `重置/节点/${身份}` }] : []),
  ] }
}
