/**
 * 选择机：认阶段名、各类节点的菜单、喂给选择机的输入、选一次（假模型）、阶段页与交接。
 * 模型一律用假的：`ctx.llm.stream` 是 async generator，吐 dsh-llm `BlockAssembler` 认的 chunk。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { 一段 } from '../prompt/src/index.js'
import {
  落新名册, 排队, 写工作文档, 新工作文档, 改名册, 读名册, 行Of, 加行, 改纸条, 新纸条, 模型表路径, 读节点文档, 写节点结构, 就绪表,
} from '../roster/src/index.js'
import { 节点前缀格, 节点前缀来路 } from '../context/src/拼.js'
import { 拼公共前缀 } from '../context/src/index.js'
import { 认阶段, 菜单Of, 选择机输入, 选阶段, 阶段页, 结束阶段, 选择记录路径, 上一个阶段Of, agent模式段, 进过Of } from './src/选择机.js'
import { 写子代理开关 } from './src/子代理开关.js'
import { 整合表, 阶段整合表 } from '../roster/src/整合表.js'
import { 送未送纸条 } from './src/纸条.js'
import { 搭会话, 过一步 } from './测试会话.js'
// 每进一个环节，插页末尾接一句「这一段结束前先告诉用户……」（10-27，选 48；回话不接）。
const 收尾 = `\n\n${一段('重置/环节收尾')}`

// 设计页第三版（10-24）：helm 走 orient、plan、execute、complete（页在 重置/阶段/helm/）；dock 走 orient、plan、execute、integrate、complete（10-25 verify 并进 integrate）；都有回话。
const helm菜单 = ['orient', 'plan', 'execute', 'complete', 'reply']
const dock菜单 = ['orient', 'plan', 'execute', 'integrate', 'complete', 'reply']
/** dock 的 plan 那一页：阶段页后面接分工表的格式。helm 的 plan 只派一块总 dock，不接。 */
const plan页 = () => `${一段('重置/阶段/plan')}\n\n${一段('重置/分工表')}`
const helm页 = stage => 一段(`重置/阶段/helm/${stage}`)

/** 不带 git、不开会话的小项目：0 号（helm）、它的工作文档和模型表。 */
async function 小项目(t, { 模型表 = true } = {}) {
  const 根 = await mkdtemp(join(tmpdir(), '选择机核对-'))
  t.after(() => rm(根, { recursive: true, force: true }))
  const m = await 落新名册(根, '选择机核对', '做一个能玩的小游戏')
  await 排队(根, () => 写工作文档(根, m.rows[0], 新工作文档(m.rows[0], '做一个能玩的小游戏', { responsibility: '把小游戏做出来交给用户' })))
  if (模型表) await writeFile(模型表路径(根), JSON.stringify({ provider: 'fixture', model: 'selector-fixture' }))
  return 根
}

/** 加一个派出时角色写 dock 的孩子（1，p1）和一个 run（2），各写一份工作文档。 */
async function 加分身们(根) {
  await 改名册(根, m => {
    let 回 = 加行(m, '0', { name: '美术总监', task: '定画风', goal: '一页画风说明' }), 新 = 回.名册
    新 = { ...新, rows: 新.rows.map(r => r.id === 回.id ? { ...r, role: 'dock', p: 'p1' } : r) }
    回 = 加行(新, '0', { name: '关卡', task: '做三个关卡', goal: '三个能通关的关卡' })
    return 回.名册
  })
  const m = await 读名册(根)
  await 排队(根, async () => {
    await 写工作文档(根, 行Of(m, '1'), 新工作文档(行Of(m, '1'), '定画风：一页画风说明'))
    await 写工作文档(根, 行Of(m, '2'), 新工作文档(行Of(m, '2'), '做三个关卡'))
  })
}

/**
 * 假模型：每次 stream 取下一个回答。先吐一段思考（里面故意提到两个阶段名，选择机只该读正文），再吐正文。
 * `收到` 记下每次调用的参数。
 */
function 假模型(回答们, { 只认默认档 = false } = {}) {
  const 收到 = [], 配置 = []
  return {
    收到, 配置,
    resolveCallConfig: async options => {
      配置.push(options)
      if (只认默认档 && options.reasoningEffort !== undefined) throw new Error('这个模型只认默认档')
      return options
    },
    async *stream(options) {
      收到.push(options)
      if (!回答们.length) throw new Error('假模型：被多问了一次')
      const 文 = 回答们.shift()
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: '想一想：plan 还是 execute？' }
      yield { type: 'block-start', index: 1, blockType: 'text' }
      yield { type: 'text-delta', index: 1, text: 文 }
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

const 话 = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
/** 假的节点会话：账本里已有的请求头和历史。 */
const 会话 = (历史, header = { config: { provider: 'node-route', model: 'node-model', reasoningEffort: 'high' }, tools: [{ name: 'next' }, { name: 'bash' }] }) =>
  ({ requestHeader: () => header, deriveMessages: () => 历史 })
const 已有历史 = () => [
  { role: 'system', content: [{ type: 'text', text: '节点的系统提示' }] },
  话('节点前缀与请求'),
  { role: 'assistant', content: [{ type: 'text', text: '我先读了现状。' }] },
]

const 记录们 = async 根 => (await readFile(选择记录路径(根), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l))
const 选择器 = async (根, id = '0') => 行Of(await 读名册(根), id).selector

test('认阶段：纯名字、带标点和括号、一句话里只有一个阶段名都认得出', () => {
  const 菜单 = 菜单Of('helm')
  assert.equal(认阶段('plan', 菜单), 'plan')
  assert.equal(认阶段('  Plan。\n', 菜单), 'plan', '大小写与首尾空白、句号')
  assert.equal(认阶段('【execute】', 菜单), 'execute')
  assert.equal(认阶段('`orient`', 菜单), 'orient')
  assert.equal(认阶段('"plan".', 菜单), 'plan')
  assert.equal(认阶段('「complete」！', 菜单), 'complete')
  assert.equal(认阶段('**plan**', 菜单), 'plan', 'markdown 加粗也认得出')
  assert.equal(认阶段('下一步应该做 execute，因为分工表已经定了。', 菜单), 'execute')
  assert.equal(认阶段('阶段：complete', 菜单), 'complete')
  assert.equal(认阶段('orient，orient。', 菜单), 'orient', '同一个名字说两遍仍是一个阶段')
})

test('认阶段：两个阶段名、不在菜单、空回答都认不出', () => {
  const 菜单 = 菜单Of('dock')
  assert.equal(认阶段('plan 还是 orient？', 菜单), null, '两个阶段名，不替它挑')
  for (const 撤掉的 of ['rule', 'spark', 'divide']) assert.equal(认阶段(撤掉的, 菜单), null, `${撤掉的} 撤了或并掉了，不在菜单`)
  assert.equal(认阶段('先 plan 再 execute', 菜单), null)
  assert.equal(认阶段('review', 菜单), null, '撤掉的 review 不在菜单')
  assert.equal(认阶段('dock', 菜单), null, '没有 dock 这个环节了')
  assert.equal(认阶段('planning', 菜单), null, '不是阶段名的词不算')
  assert.equal(认阶段('我也说不好', 菜单), null)
  assert.equal(认阶段('', 菜单), null)
  assert.equal(认阶段(undefined, 菜单), null)
})

// 选 12：回话（reply）人人都有，它不是一轮里的一步，所以排在工作阶段后面；页里写明不开工、不改节点文档。
test('菜单Of：helm 四步加回话；dock 多 integrate；rule、spark、dock、verify 环节都撤了；每个阶段都有自己的页', () => {
  assert.deepEqual(菜单Of('helm'), helm菜单)
  assert.deepEqual(菜单Of('dock'), dock菜单)
  for (const 撤掉的 of ['rule', 'spark', 'dock', 'verify']) for (const 类型 of ['helm', 'dock']) assert.ok(!菜单Of(类型).includes(撤掉的), `${类型} 没有 ${撤掉的}`)
  for (const 阶段 of helm菜单.filter(s => s !== 'reply')) assert.ok(helm页(阶段).trim(), `重置/阶段/helm/${阶段}.md 有内容`)
  for (const 阶段 of dock菜单) assert.ok(一段(`重置/阶段/${阶段}`).trim(), `重置/阶段/${阶段}.md 有内容`)
  assert.match(一段('重置/阶段/reply'), /不开工，不改节点文档/)
  assert.equal(认阶段('reply', 菜单Of('helm')), 'reply')
})

// 同 1：选择机看的就是节点这一步要发的那一份——账本里的历史、这一步新到的话原样在前，问题那一段在最后；工具和模型照请求头。
test('选择机输入：节点的历史和这一步的话原样在前，问题那一段在最后；工具、模型照请求头', async t => {
  const 根 = await 小项目(t)
  await 改名册(根, m => ({ ...m, rows: m.rows.map(r => r.id === '0' ? { ...r, selector: { last: 'orient', handoff: '做法定了：用 Godot' } } : r) }))
  const 历史 = 已有历史(), 这一步 = [话('用户说：再加一个 Boss 关。'), 话('开头与情境')]
  const 输入 = await 选择机输入(根, 行Of(await 读名册(根), '0'), 会话(历史), 这一步)
  assert.equal(输入.system, undefined, '系统提示已在历史里，不另给')
  assert.deepEqual(输入.messages.slice(0, -1), [...历史, ...这一步], '前面逐字照搬，和节点的请求共用前缀')
  const 问 = 输入.messages.at(-1)
  assert.equal(问.content[0].text, 一段('重置/选择机', { 上一个阶段: 'orient；交接：做法定了：用 Godot', 进过: '（还没有）', 结构段: '还空着（plan 用 next 交的分工表才写进这里）', 菜单: 菜单Of('helm').join('、') }))
  assert.equal(问.source.kind, 'plugin:blueprint-selector')
  assert.deepEqual(输入.tools.map(x => x.name), ['next', 'bash'], '工具照原样带上')
  assert.deepEqual(输入.模型, { provider: 'node-route', model: 'node-model', reasoningEffort: 'high' })
  assert.deepEqual(输入.菜单, 菜单Of('helm'))
  assert.ok(问.content[0].text.trimEnd().endsWith('只回答一个环节名，不调用工具。'))
})

// 开工第一轮原生还没把系统提示放进历史：照装配清单拼系统提示、照节点前缀拼第一条。
test('选择机输入：会话里还没有系统提示（开工第一轮）时，照装配清单拼系统提示、节点前缀放第一条', async t => {
  const 根 = await 小项目(t)
  await 加分身们(根)
  const m = await 读名册(根), 行 = 行Of(m, '1'), doc = await 读节点文档(根, 行)
  const 输入 = await 选择机输入(根, 行, 会话([], null), [话('开工。')])
  assert.equal(输入.system, 拼公共前缀('dock'))
  assert.equal(输入.messages[0].content[0].text, 一段('节点前缀', 节点前缀格(m, '1', doc.request, 根, 一段)))
  assert.equal(输入.messages[1].content[0].text, '开工。')
  assert.match(输入.messages.at(-1).content[0].text, /上一个环节：（还没有，这是第一次）/)
  assert.equal(输入.tools, undefined); assert.equal(输入.模型, undefined)
  assert.deepEqual(输入.菜单, dock菜单, '角色是 dock 的孩子走 dock 的菜单')
})

// 选 42（10-23 黑暗之魂 10-23-3）：helm 在 rule（现在并进 orient）里把分工表塞进交接，选择机光看交接当 plan 做过了。
// 机器把它知道的两件事写给选择机：这条线进过哪些环节、结构段里有没有分工表；不收菜单。
test('选择机看得到这条线进过的环节和结构段里有没有分工表：插页时记下进过的，结构段由 plan 交的分工表写进去', async t => {
  const 根 = await 小项目(t)
  await 改名册(根, m => ({ ...m, rows: m.rows.map(r => r.id === '0' ? { ...r, selector: { last: 'orient', seen: ['orient'], handoff: '# 分工表（第 1 轮）\n执行者 1：无' } } : r) }))
  let 问 = (await 选择机输入(根, 行Of(await 读名册(根), '0'), 会话(已有历史()), [])).messages.at(-1).content[0].text
  assert.match(问, /上一个环节：orient；交接：# 分工表（第 1 轮）[\s\S]*这条线进过的环节：orient\n结构段：还空着（plan 用 next 交的分工表才写进这里）/)
  await 写节点结构(根, 行Of(await 读名册(根), '0'), '## 分工表\n\n第一轮分工：搭骨架。\n执行者 1：无', new LocalFileSystem(new Context(), { cwd: 根, diffBasisMaxBytes: 10 * 1024 * 1024 }))
  问 = (await 选择机输入(根, 行Of(await 读名册(根), '0'), 会话(已有历史()), [])).messages.at(-1).content[0].text
  assert.match(问, /结构段：有分工表/)
  assert.equal(进过Of(undefined), '（还没有）')
  assert.equal(进过Of({ seen: ['orient', 'plan', 'execute'] }), 'orient、plan、execute')
  // 插页时记下：选出的环节进 seen，重复的不再记。
  const llm = 假模型(['plan', 'plan'])
  for (let i = 0; i < 2; i++) await 阶段页({ llm }, 根, '0', { session: 会话(已有历史()) })
  assert.deepEqual(行Of(await 读名册(根), '0').selector.seen, ['orient', 'plan'])
  // helm 的 plan 用 helm/ 下那一页，后面不接分工表（它只派一块总 dock）。
  assert.equal(await 阶段页({ llm: 假模型(['plan']) }, 根, '0', { 重建: true }), `【环节：plan】\n\n${helm页('plan')}${收尾}`)
})

// 选 36：交接只有 next 写。没有交接就是那个阶段被打断了，写给选择机，它才会回到原来的阶段；
// 10-18 真跑：rule（现在并进 orient）搜到一半被按停，「继续」后选择机读到的只有那个名字，跳去了下一个。
test('上一个阶段：有交接写交接；没交接写还没结束；reply、complete 本来不留交接，只写名字', () => {
  assert.equal(上一个阶段Of(undefined), '（还没有，这是第一次）')
  assert.equal(上一个阶段Of({ last: 'orient', handoff: '知识找齐了' }), 'orient；交接：知识找齐了')
  for (const 阶段 of ['orient', 'plan', 'execute', 'integrate']) assert.equal(上一个阶段Of({ last: 阶段 }), `${阶段}；还没结束：没用 next 交接就停了`)
  for (const 阶段 of ['reply', 'complete']) assert.equal(上一个阶段Of({ last: 阶段 }), 阶段)
  assert.equal(上一个阶段Of({ last: 'execute', handoff: '派出：1、2；接着用：无；登记：3；去掉：无。这一批记在第 1 轮。' }), 'execute；交接：派出：1、2；接着用：无；登记：3；去掉：无。这一批记在第 1 轮。', 'execute 里 divide 派出写的交接')
})

test('选阶段：第一次认不出重问一次，第二次认出就选中，attempts=2；用节点自己的模型、整份 context 与已生效思考档', async t => {
  const 根 = await 小项目(t)
  const llm = 假模型(['我想想……先把方向弄清楚吧', 'plan'])
  const 行 = 行Of(await 读名册(根), '0'), 历史 = 已有历史(), 这一步 = [话('开工。')]
  assert.equal(await 选阶段({ llm }, 根, 行, { session: 会话(历史), 这一步 }), 'plan')
  assert.equal(llm.收到.length, 2)
  const 输入 = await 选择机输入(根, 行, 会话(历史), 这一步)
  for (const 发 of llm.收到) {
    assert.equal(发.provider, 'node-route'); assert.equal(发.model, 'node-model')
    assert.equal(发.system, undefined)
    assert.deepEqual(发.messages.slice(0, -1), 输入.messages.slice(0, -1))
    assert.equal(发.messages.at(-1).content[0].text, 输入.messages.at(-1).content[0].text)
    assert.deepEqual(发.tools, 输入.tools)
    assert.equal(发.reasoningEffort, 'high')
  }
  const [记] = await 记录们(根)
  assert.equal(记.node, '0'); assert.equal(记.type, 'helm'); assert.equal(记.stage, 'plan'); assert.equal(记.attempts, 2)
  assert.deepEqual(记.menu, 菜单Of('helm'))
  assert.equal(记.messages, 历史.length + 2); assert.equal(记.tools, 2)
  assert.deepEqual(记.answers, ['我想想……先把方向弄清楚吧', 'plan'])
  assert.equal(记.usage.length, 2)
  assert.equal(记.这次, '开工。')
  assert.equal(记.error, undefined)
})

test('选阶段：两次都认不出 → null；会话没请求头又没有模型表、或没有 stream 也 → null；每次选都记一行', async t => {
  const 根 = await 小项目(t)
  const 行 = 行Of(await 读名册(根), '0')
  const llm = 假模型(['plan 或者 orient', 'review'])
  assert.equal(await 选阶段({ llm }, 根, 行, { 这一步: [话('纸条来了')] }), null)
  assert.equal(llm.收到.length, 2, '只重问一次')
  assert.equal(await 选阶段({ llm: { resolveCallConfig: async x => x } }, 根, 行, { 这一步: [话('没有 stream')] }), null)
  const 无表 = await 小项目(t, { 模型表: false }), 不该问 = 假模型(['plan'])
  assert.equal(await 选阶段({ llm: 不该问 }, 无表, 行Of(await 读名册(无表), '0'), { 这一步: [话('没有模型表')] }), null)
  assert.equal(不该问.收到.length, 0, '没有请求头也没有模型表就不调模型')
  const 记 = await 记录们(根)
  assert.equal(记.length, 2)
  assert.equal(记[0].stage, null); assert.equal(记[0].attempts, 2); assert.deepEqual(记[0].answers, ['plan 或者 orient', 'review'])
  assert.equal(记[1].stage, null); assert.equal(记[1].attempts, 0); assert.match(记[1].error, /没有可用的模型/)
  const [无表记] = await 记录们(无表)
  assert.match(无表记.error, /没有可用的模型/)
})

test('选阶段：首轮模型不认 max 就用默认档；流报错记进 error、不选', async t => {
  const 根 = await 小项目(t)
  const 行 = 行Of(await 读名册(根), '0')
  const llm = 假模型(['orient'], { 只认默认档: true })
  assert.equal(await 选阶段({ llm }, 根, 行, { 这一步: [话('开工。')] }), 'orient')
  assert.equal(llm.收到[0].reasoningEffort, undefined)
  assert.equal(llm.配置[0].reasoningEffort, 'max')
  const 坏流 = { resolveCallConfig: async x => x, async *stream() {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: '上游 502' } } }
  } }
  assert.equal(await 选阶段({ llm: 坏流 }, 根, 行, { 这一步: [话('开工。')] }), null)
  const 记 = await 记录们(根)
  assert.equal(记.length, 2)
  assert.match(记[1].error, /上游 502/)
})

test('选阶段：已有请求头未指定思考档时沿用模型默认，不自行切档', async t => {
  const 根 = await 小项目(t), llm = 假模型(['plan'])
  const session = 会话(已有历史(), { config: { provider: 'fixture', model: 'fixture-model' }, tools: [] })
  assert.equal(await 选阶段({ llm }, 根, 行Of(await 读名册(根), '0'), { session }), 'plan')
  assert.equal(llm.收到[0].reasoningEffort, undefined)
})

test('选阶段：首轮不支持 max 时，与主节点一样回退项目模型表的档位', async t => {
  const 根 = await 小项目(t), llm = 假模型(['plan'])
  await writeFile(模型表路径(根), JSON.stringify({ provider: 'fixture', model: 'fixture-model', reasoningEffort: 'high' }))
  llm.resolveCallConfig = async options => {
    if (options.reasoningEffort === 'max') throw new Error('不支持 max')
    return { ...options, reasoningEffort: options.reasoningEffort ?? 'medium' }
  }
  assert.equal(await 选阶段({ llm }, 根, 行Of(await 读名册(根), '0')), 'plan')
  assert.equal(llm.收到[0].reasoningEffort, 'high')
})

test('阶段页：第一次给阶段行＋阶段页全文；同一阶段再选、没重建、页没改过只给一行；页改过、重建或换阶段又给全文', async t => {
  const 根 = await 小项目(t)
  const llm = 假模型(['orient', 'orient', 'orient', 'orient', 'plan']), ctx = { llm }
  const 页指纹Of = stage => createHash('sha1').update(helm页(stage)).digest('hex')
  assert.equal(await 阶段页(ctx, 根, '0'), `【环节：orient】\n\n${helm页('orient')}${收尾}`, 'helm 的 orient 用 helm/ 下那一页')
  assert.deepEqual(await 选择器(根), { last: 'orient', 页指纹: 页指纹Of('orient'), seen: ['orient'] })
  assert.equal(await 阶段页(ctx, 根, '0'), `【环节：orient】${收尾}`, '页已经在它眼前')
  // 阶段页的文字改过（名册记的还是旧指纹）：同一阶段也整页再给一次（圈 9）。
  await 改名册(根, m => ({ ...m, rows: m.rows.map(r => r.id === '0' ? { ...r, selector: { ...r.selector, 页指纹: '旧页' } } : r) }))
  assert.equal(await 阶段页(ctx, 根, '0'), `【环节：orient】\n\n${helm页('orient')}${收尾}`, '页改过了，再给全文')
  assert.equal((await 选择器(根)).页指纹, 页指纹Of('orient'), '记下新的那一页')
  assert.equal(await 阶段页(ctx, 根, '0', { 重建: true }), `【环节：orient】\n\n${helm页('orient')}${收尾}`, '重建后页不在了，再给全文')
  assert.equal(await 阶段页(ctx, 根, '0'), `【环节：plan】\n\n${helm页('plan')}${收尾}`, 'helm 的 plan 页不接分工表')
  assert.equal((await 选择器(根)).last, 'plan')
  assert.equal((await 记录们(根)).length, 5, '每次选都记一行')
})

// 10-18 用户：打开了哪几家只塞进 plan 阶段那一页，别的阶段不给；拨了开关，下次进 plan 整页重给。
test('阶段页：项目开了外部 agent，dock 进 plan 时页底下多 agent 模式那段；别的阶段、helm 没有', async t => {
  const 根 = await 小项目(t)
  await 加分身们(根)
  await 写子代理开关('codex', true, 根)
  const 段 = agent模式段(根, 行Of(await 读名册(根), '1'))
  assert.match(段, /^现在是 agent 模式：用户给这个项目打开了 Codex/)
  const ctx = { llm: 假模型(['execute', 'plan', 'plan', 'plan']) }
  assert.equal(await 阶段页(ctx, 根, '1'), `【环节：execute】\n\n${一段('重置/阶段/execute')}${收尾}`, 'execute 不给')
  assert.equal(await 阶段页(ctx, 根, '1'), `【环节：plan】\n\n${plan页()}\n\n${段}${收尾}`, '分工表在前，agent 模式那段在后')
  assert.equal(await 阶段页(ctx, 根, '1'), `【环节：plan】${收尾}`, '页已经在它眼前')
  await 写子代理开关('claudeCode', true, 根)
  assert.match(await 阶段页(ctx, 根, '1'), /打开了 Codex（能改文件、跑命令）和 Claude Code/, '拨了开关，整页重给')
  assert.equal(agent模式段(根, 行Of(await 读名册(根), '0')), '', 'helm 只派总 dock，不开 run')
  assert.equal(agent模式段(根, 行Of(await 读名册(根), '2')), '', 'run 不开节点')
})

// 设计页第三版第一节：helm 的四步页在 重置/阶段/helm/，和执行节点分开；回话共用一页。第四节：dock 进 execute，页后接就绪表。
test('阶段页：helm 用 helm/ 下自己的页，dock 用执行节点的页；回话共用；dock 进 execute 页后接它名下登记着的块的就绪表', async t => {
  const 根 = await 小项目(t)
  await 加分身们(根)
  const ctx = { llm: 假模型(['complete', 'complete', 'integrate', 'reply', 'reply', 'execute', 'execute']) }
  assert.equal(await 阶段页(ctx, 根, '1'), `【环节：complete】\n\n${一段('重置/阶段/complete')}${收尾}`)
  assert.equal(await 阶段页(ctx, 根, '0'), `【环节：complete】\n\n${helm页('complete')}${收尾}`)
  assert.equal(await 阶段页(ctx, 根, '1'), `【环节：integrate】\n\n${一段('重置/阶段/integrate')}${收尾}`)
  assert.equal(await 阶段页(ctx, 根, '0'), `【环节：reply】\n\n${一段('重置/阶段/reply')}`, 'helm 的回话也是那一页')
  assert.equal(await 阶段页(ctx, 根, '1'), `【环节：reply】\n\n${一段('重置/阶段/reply')}`)
  assert.equal(await 阶段页(ctx, 根, '1'), `【环节：execute】\n\n${一段('重置/阶段/execute')}${收尾}`, '名下没有登记着的块，不接就绪表')
  await 改名册(根, m => {
    const 回 = 加行(m, '1', { name: '配乐', task: '画面定了再配', goal: '画面定了再配' })
    return { ...回.名册, rows: 回.名册.rows.map(r => r.id === 回.id ? { ...r, status: '待做', role: 'run', p: 'p2', needs: ['p1'], organizationOwner: '1' } : r) }
  })
  const 表 = 就绪表(await 读名册(根), '1')
  assert.match(表, /^## 就绪表\n你名下登记着的块：现在能做 0 个，还在等 1 个。[\s\S]*- p2 · 1\.1 配乐（run）：画面定了再配 · 等 p1（1 美术总监，在 0 名下，在做）$/)
  assert.equal(await 阶段页(ctx, 根, '1'), `【环节：execute】\n\n${一段('重置/阶段/execute')}\n\n${表}${收尾}`, '表变了页指纹跟着变，整页重给')
})

// 10-25 整合表（合 3）：dock 进 integrate，页后接这一枝交上来、还没接进它手上成品的东西。
test('阶段页：dock 进 integrate 页后接整合表；表变了整页重给，什么都没有就不接', async t => {
  const 根 = await 小项目(t)
  await 加分身们(根)
  await 改名册(根, m => {
    const 回 = 加行(m, '1', { name: '特效', task: '打击特效', goal: '打击特效' })
    return { ...回.名册, rows: 回.名册.rows.map(r => r.id === 回.id ? { ...r, role: 'run', status: '完成', result: 'achieved', handoff: '交了',
      parts: [{ n: 1, what: '血雾特效', work: 'done', at: 回.id, judge: 'parent', where: '交付/资源/血雾.png' }] } : r) }
  })
  const ctx = { llm: 假模型(['integrate', 'integrate', 'integrate']) }
  const 表 = 整合表(await 读名册(根), '1')
  assert.match(表, /^## 整合表\n你这一枝交上来、还没接进你手上成品的：1 样。[\s\S]*\| 1\.1#1 \| 血雾特效 \| 做了 \| 1\.1 \|/)
  assert.equal(await 阶段页(ctx, 根, '1'), `【环节：integrate】\n\n${一段('重置/阶段/integrate')}\n\n${表}${收尾}`)
  assert.equal(await 阶段页(ctx, 根, '1'), `【环节：integrate】${收尾}`, '页已经在它眼前')
  await 改名册(根, m => ({ ...m, rows: m.rows.map(r => r.id === '1.1' ? { ...r, parts: [{ ...r.parts[0], at: '1' }] } : r) }))
  assert.match(await 阶段页(ctx, 根, '1'), /已经接上的 1 样/, '表变了，整页重给')
})

// 合 7：helm 进 complete，页后接这一阶段总 dock 交回时还没接进成品的。
test('阶段页：helm 进 complete 页后接总 dock 的整合表；总 dock 还在做就不接', async t => {
  const 根 = await 小项目(t)
  await 加分身们(根)
  await 改名册(根, m => {
    const 回 = 加行(m, '1', { name: '场景', task: '最终场景', goal: '最终场景' })
    return { ...回.名册, rows: 回.名册.rows.map(r => r.id === 回.id ? { ...r, role: 'run', status: '完成', result: 'achieved', handoff: '交了',
      parts: [{ n: 1, what: '最终场景', work: 'done', at: 回.id, judge: 'parent' }] } : r.id === '2' ? { ...r, status: '去掉' } : r) }
  })
  const ctx = { llm: 假模型(['complete', 'complete']) }
  assert.equal(await 阶段页(ctx, 根, '0'), `【环节：complete】\n\n${helm页('complete')}${收尾}`, '总 dock 还在做')
  await 改名册(根, m => ({ ...m, rows: m.rows.map(r => r.id === '1' ? { ...r, status: '完成', result: 'achieved', handoff: '交了' } : r) }))
  const 页 = await 阶段页(ctx, 根, '0')
  assert.equal(页, `【环节：complete】\n\n${helm页('complete')}\n\n${阶段整合表(await 读名册(根), '0')}${收尾}`)
  assert.match(页, /## 整合表 · 总 dock 1 美术总监\n它交回时，手上的成品还没接进去的：1 样。/)
})

test('阶段页：选不出给空字符串，上一个阶段不变', async t => {
  const 根 = await 小项目(t)
  const ctx = { llm: 假模型(['execute', '不知道', '还是不知道']) }
  await 阶段页(ctx, 根, '0')
  assert.equal(await 阶段页(ctx, 根, '0'), '')
  assert.equal((await 选择器(根)).last, 'execute')
})

// 选 35：plan 那次用户通过管到同一轮 execute 里的 divide；orient、reply、execute 不清，进了 complete 才清掉。
test('阶段页：选到 complete 时清掉 plan 那次用户通过，orient、reply、execute 不清', async t => {
  const 根 = await 小项目(t)
  const ctx = { llm: 假模型(['orient', 'reply', 'execute', 'complete']) }
  await 改名册(根, m => ({ ...m, rows: m.rows.map(r => r.id === '0' ? { ...r, selector: { ...(r.selector || {}), planApproved: '这一轮的依据' } } : r) }))
  for (const stage of ['orient', 'reply', 'execute']) {
    await 阶段页(ctx, 根, '0')
    assert.equal((await 选择器(根)).planApproved, '这一轮的依据', stage)
  }
  await 阶段页(ctx, 根, '0')
  assert.equal((await 选择器(根)).planApproved, undefined, 'complete')
})

// 同 1：中途到的事本来就进了对话，选择机直接看得到，不再另记；旧名册里留着的 pending 选完清掉。
test('阶段页：旧名册留着的 selector.pending 不再给选择机，选完和交接一起清掉', async t => {
  const 根 = await 小项目(t)
  await 改名册(根, m => ({ ...m, rows: m.rows.map(r => r.id === '0' ? { ...r, selector: { last: 'orient', handoff: '做法定了', pending: '旧版记下的中途' } } : r) }))
  const llm = 假模型(['plan'])
  assert.equal(await 阶段页({ llm }, 根, '0', { 这一步: [话('接着做')] }), `【环节：plan】\n\n${helm页('plan')}${收尾}`)
  assert.ok(!JSON.stringify(llm.收到[0].messages).includes('旧版记下的中途'))
  const s = await 选择器(根)
  assert.equal(s.pending, undefined); assert.equal(s.handoff, undefined); assert.equal(s.last, 'plan')
})

// 选 20：结束一个阶段只记交接；节点闲下来 Goal 自己开下一轮、先过选择机，交接写进问题那一段的「上一个阶段」。
test('结束阶段：只把交接写进 selector.handoff，不另送叫醒', async t => {
  const 根 = await 小项目(t)
  await 结束阶段({}, { id: 'agent' }, 根, '0', '做法定了：用 Godot')
  assert.deepEqual(await 选择器(根), { handoff: '做法定了：用 Godot' })
  await 结束阶段({}, { id: 'agent' }, 根, '0', '又改了：用 Phaser')
  assert.deepEqual(await 选择器(根), { handoff: '又改了：用 Phaser' }, '后一次交接盖掉前一次')
})

// 选 21：纸条是一件事，投递时原样送；它开的那一轮第一步（思考开头的 pre-step）才过选择机。
// 同 1：开头先放进这一步、选择机看到的就是它；阶段页单独一条接在最后。
test('纸条叫醒原样送、投递时不过选择机；它开的那一轮第一步过一次：开头在前、阶段行与阶段页在最后，选择机看到纸条和开头', async t => {
  const f = await 搭会话(t)
  await writeFile(模型表路径(f.根), JSON.stringify({ provider: 'fixture', model: 'selector-fixture' }))
  const llm = 假模型(['orient'])
  f.ctx.llm.stream = llm.stream
  await 改名册(f.根, m => {
    const 新 = 加行(m, '0', { name: '美术', task: '定画风', goal: '画风说明' }).名册
    return { ...新, rows: 新.rows.map(r => r.id === '0' ? { ...r, selector: { last: 'execute' } } : r) }
  })
  await 改纸条(f.根, 纸条 => 新纸条(纸条, { from: '1', to: '0', kind: 'ask', text: '画风定像素还是手绘？' }).纸条)
  assert.equal(await 送未送纸条(f.ctx, f.根, '0'), 1)
  const 递 = f.零.递过.at(-1), 文 = 递.content[0].text
  // 求助（kind=ask）用求助模板投递：写明要回（选 16）。投递的就是这一句，后面不接东西。
  assert.equal(文, 一段('重置/叫醒/求助', { 编号: 'N1', 来自: '1 · run · 美术', 内容: '画风定像素还是手绘？' }))
  assert.match(文, /^求助 N1，来自 1 · run · 美术（要回）：画风定像素还是手绘？/)
  assert.equal(llm.收到.length, 0, '投递时不调选择机')
  assert.deepEqual(await 记录们(f.根), [])
  assert.deepEqual(await 选择器(f.根), { last: 'execute' }, '投递时名册的选择记录不动')
  const 出 = await 过一步(f, f.零, [递])
  assert.deepEqual(出.messages[0], 递, '纸条原样进这一步')
  const [开头, 阶段] = 出.messages.slice(1)
  for (const m of [开头, 阶段]) assert.equal(m.source.kind, 'plugin:blueprint-thinking-opening')
  const 开头之问 = 一段('重置/开头', { 职责: '', 等你的: '', 你等的: '' }).split('\n\n').map(s => s.trim()).filter(Boolean)[1]
  assert.ok(开头.content[0].text.includes(开头之问), '先是开头')
  assert.equal(阶段.content[0].text, `【环节：orient】\n\n${helm页('orient')}${收尾}`, '阶段页单独一条，在最后')
  assert.equal(llm.收到.length, 1)
  const 选择机看到 = llm.收到[0].messages.slice(-3, -1)
  assert.deepEqual(选择机看到, [递, 开头], '选择机看到的就是节点这一步要看到的：纸条和开头')
  const 记 = await 记录们(f.根)
  assert.equal(记.length, 1)
  assert.match(记[0].这次, /画风定像素还是手绘？/)
  assert.equal((await 选择器(f.根)).last, 'orient', '这一轮选的阶段记下了')
})
