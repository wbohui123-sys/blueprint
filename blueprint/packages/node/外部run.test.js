import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile, mkdtemp } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { 搭会话, 调工具, 活节点, 交接测试预测, 测试方案, 搭总dock } from './测试会话.js'
import { 读名册, 行Of, 模型表路径, 读纸条 } from '../roster/src/index.js'
import { 推进组织 } from './src/会话.js'
import { 传纸条 } from './src/纸条.js'
import { 写子代理开关 } from './src/子代理开关.js'
import { 外部run设置, 停项目外部run, 外部run在跑, 外部run收尾中, 听外部run变化, 分类 } from './src/外部run.js'
import { 一段, run开工页 } from '../prompt/src/index.js'
import { 装假程序, 等到 } from './外部run假程序.js'

// 第三版（10-24）：外部 agent 只当 run；helm 一个阶段派一个总 dock（1 号），由它派 run（1.1、1.2）。
const 块 = (key, extra = {}) => ({ key, name: key, role: 'run', bench: `验收台/${key}`, situation: '项目里还没有这个文件',
  what: `做出${key}`, link: '为整件事服务', level: 'polished', ...extra })
async function fixture(t, key, 剧本) {
  const f = await 搭会话(t)
  await writeFile(模型表路径(f.根), JSON.stringify({ provider: '离线核对', model: '假模型' }))
  f.总 = await 搭总dock(f)
  await 写子代理开关(key, true, f.根)
  f.假 = await 装假程序(t, key, 剧本)
  t.after(() => 停项目外部run(f.根, '测试结束'))
  return f
}
async function 派(f, blocks, shared = '一块交给外部执行者') {
  await 交接测试预测(f, f.总)
  const { phase: _p, review_id: _r, ...submission } = 测试方案({ choice: 'dispatch', shared, blocks })
  return 调工具(f, 'divide', submission, f.总)
}
const 行 = async (f, id) => 行Of(await 读名册(f.根), id)
const 交回了 = (f, id) => 等到(async () => (await 行(f, id)).status === '完成' && (await 行(f, id)).external?.state === 'done', `${id} 号交回`)
const 提示 = call => call.argv[call.argv.length - 1]
function 改设置(t, 改) {
  const 旧 = { ...外部run设置 }
  Object.assign(外部run设置, 改)
  t.after(() => Object.assign(外部run设置, 旧))
}

test('交给 Codex 的 run 自己当这个节点：规矩页＋请求交给它，交回补上证据，并进派它的节点，带着的问题母节点看得到', async t => {
  const f = await fixture(t, 'codex', [{ write: { 'out.txt': '做好了\n' }, commands: [['node --test', 0], ['npm test', 1]],
    answer: { result: 'achieved', handoff: '改好了 out.txt，测试跑过。', question: '用户要哪种配色？' } }])
  await 派(f, [块('改代码', { executor: 'codex' })])
  const r = await 交回了(f, '1.1') && await 行(f, '1.1')
  assert.equal(r.session, undefined, '没有 DeepSeek 会话')
  assert.equal(r.external.last.文, '跑 node --test', '名册记着刚才那一步，砖第二行用')
  assert.equal(r.handoffQuestion, '用户要哪种配色？')
  assert.match(r.handoff, /^改好了 out\.txt，测试跑过。\n\n——以下由系统补上——/)
  assert.match(r.handoff, /执行者：Codex · gpt-6-astra · medium · 第 1 次/)
  assert.match(r.handoff, /改了的文件（1）：验收台\/改代码\/out\.txt/)
  assert.match(r.handoff, /跑过的命令（2 条，没成功的在前）：\n- 失败（1）：npm test\n- 成功：node --test/)
  assert.match(r.handoff, /用量：输入 12\.0 万 token（其中缓存 10\.0 万），输出 700/)
  assert.match(r.handoff, /过程记录：系统文档\/外部run\/1\.1\/第1次\.jsonl/)
  assert.equal(await readFile(join(f.根, '作品空间', '1', '验收台', '改代码', 'out.txt'), 'utf8'), '做好了\n', '在台里做，并进了派它的节点的分支')
  assert.match(await readFile(join(f.根, '系统文档', '外部run', '1.1', '第1次.jsonl'), 'utf8'), /turn\.completed/)
  const [call] = await f.假.调用们()
  assert.equal(realpathSync(call.cwd), realpathSync(join(f.根, '作品空间', '1.1', '验收台', '改代码')), '在台目录开工（十步重置）')
  for (const flag of ['exec', '--ignore-user-config', '--ignore-rules', '--json', '--ephemeral', '--output-schema', 'model="gpt-6-astra"', 'model_reasoning_effort="medium"']) assert.ok(call.argv.includes(flag), flag)
  assert.ok(提示(call).startsWith(一段('重置/外部run')), '规矩页在最前')
  assert.match(提示(call), /# 请求\n\n1 [^\n]* 请你帮忙。[\s\S]*做出改代码/)
  assert.ok(提示(call).endsWith(run开工页('polished')), '新开工按工作等级接一页在请求后面（级 1）')
  const 母 = await 活节点(f, '1')
  assert.match(母.递过.at(-1).content[0].text, /等你定：用户要哪种配色？/, '母节点在交差汇总里看到问题')
})

// 10-25 整合表（合 2）：外部 run 的交回格式也带 parts，每格都在 required 里（Codex 的 --output-schema 要这样）；写坏的那一行丢掉，不退掉整份交回。
test('外部 run 交回带 parts：记进整合表，写坏的那一行丢掉；交回格式里 parts 每格都必填', async t => {
  const f = await fixture(t, 'codex', [{ write: { 'out.txt': '做好了\n' }, answer: { result: 'achieved', handoff: '改好了。', question: '', parts: [
    { what: '打击特效', work: 'done', where: '交付/打击.png', effect: '', judge: 'human', reason: '' },
    { what: '', work: 'done', where: '', effect: '', judge: 'parent', reason: '' },
    { what: '影子层', work: 'todo', where: '', effect: '', judge: 'parent', reason: '要战斗那边画' },
  ] } }])
  await 派(f, [块('改代码', { executor: 'codex' })])
  await 交回了(f, '1.1')
  assert.deepEqual((await 行(f, '1.1')).parts.map(p => [p.n, p.what, p.work, p.at, p.judge, p.where, p.reason]),
    [[1, '打击特效', 'done', '1.1', 'human', '交付/打击.png', undefined], [2, '影子层', 'todo', undefined, 'parent', undefined, '要战斗那边画']])
  const [call] = await f.假.调用们()
  const 格式 = JSON.parse(await readFile(call.argv[call.argv.indexOf('--output-schema') + 1], 'utf8'))
  assert.deepEqual(格式.required, ['result', 'handoff', 'checked', 'question', 'parts'])
  assert.match(提示(call), /- checked：你怎么验的、验出了什么、证据在哪/)
  assert.deepEqual(格式.properties.parts.items.required, Object.keys(格式.properties.parts.items.properties))
  assert.match(提示(call), /- parts：你交出的东西，一样一行/)
})

// 10-25 用户：外部 run 做完时先从「在做」闪一下红色停止再变完成。进程退出到交回落进名册要几秒，这段要记着「收尾中」，
// 界面照旧画在做；收尾记号撤掉的那一下，名册上已经交回了。
test('进程退出到交回落进名册之间记着收尾中，不出现「running 却没进程」那一下；撤掉收尾时已经交回', { timeout: 15000 }, async t => {
  const f = await fixture(t, 'codex', [{ write: { 'out.txt': '做好了\n' }, answer: { result: 'achieved', handoff: '改好了。' } }])
  const 看到 = []
  const 释放 = Promise.withResolvers()
  let 见过收尾 = false
  t.after(听外部run变化(() => {
    const 在跑 = 外部run在跑(f.根, '1.1'), 收尾 = 外部run收尾中(f.根, '1.1')
    看到.push(行(f, '1.1').then(r => ({ 在跑, 收尾, 状态: r.status, state: r.external?.state }), () => ({ 在跑, 收尾 })))
    if (收尾) 见过收尾 = true
    if (见过收尾 && !在跑 && !收尾) 释放.resolve()
  }))
  await 派(f, [块('改代码', { executor: 'codex' })])
  await 交回了(f, '1.1')
  // 名册完成先于 finally 的收尾通知；等到被核验的真实事件，不能提前截取通知列表。
  await 释放.promise
  const 记 = await Promise.all(看到)
  assert.ok(记.some(x => x.在跑), '开工时喊过一声')
  assert.ok(记.some(x => !x.在跑 && x.收尾), '进程退出那一下记着收尾中')
  const 末 = 记.at(-1)
  assert.deepEqual([末.在跑, 末.收尾, 末.状态], [false, false, '完成'], '撤掉收尾时已经交回')
  assert.equal(外部run收尾中(f.根, '1.1'), false)
})

test('Claude Code：只带基本工具、不读个人设置，临时目录设进项目；报的额度记下来，交回写它估的金额', async t => {
  const f = await fixture(t, 'claudeCode', [{ write: { 'a.txt': 'a' }, quota: 0.42, answer: { result: 'achieved', handoff: '写好了 a.txt', question: '' } }])
  await 派(f, [块('写文件', { executor: 'claude_code' })])
  const r = await 交回了(f, '1.1') && await 行(f, '1.1')
  const [call] = await f.假.调用们()
  for (const flag of ['-p', '--output-format', 'stream-json', '--json-schema', 'bypassPermissions', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(call.argv.includes(flag), flag)
  assert.equal(call.argv[call.argv.indexOf('--setting-sources') + 1], 'project')
  assert.equal(call.argv[call.argv.indexOf('--tools') + 1], 'Bash,Read,Edit,Write,Glob,Grep')
  assert.equal(call.tmp, call.TMPDIR, 'CLAUDE_CODE_TMPDIR 指到项目的临时目录')
  assert.equal(r.external.quota.five_hour.used, 0.42)
  assert.match(r.handoff, /它自己估约 0\.11 美元/)
  assert.equal(r.handoffQuestion, undefined)
})

test('登录过期：停着按出事了报给母节点；平常的组织推进不重试，用户继续或全部启动时接着做', async t => {
  const f = await fixture(t, 'codex', [{ fail: { status: 401, message: 'unauthorized: please log in again' } },
    { write: { 'b.txt': 'b' }, answer: { result: 'achieved', handoff: '重新登录后做完了', question: '' } }])
  await 派(f, [块('改代码', { executor: 'codex' })])
  // 先记停着、再报出事：两样都落了再看，忙的时候不抢在报之前读。报出事先记记号、再传纸条给母节点，纸条也要等到。
  await 等到(async () => { const r = await 行(f, '1.1'); return r.external?.state === 'blocked' && !!r.selector?.incident
    && (await 读纸条(f.根)).some(n => n.from === '1.1' && n.to === '1') }, '停着等用户，报了出事')
  const r = await 行(f, '1.1')
  assert.match(r.external.reason, /登录过期了或没登录[\s\S]*「Agent 选择」页重新登录/)
  assert.ok(r.selector?.incident, '界面上看得见')
  const 纸 = (await 读纸条(f.根)).find(n => n.from === '1.1' && n.to === '1')
  assert.match(纸.text, /停下了，没能接着做：Codex 的登录过期了/)
  await 推进组织(f.ctx, f.根, null)
  assert.equal((await f.假.调用们()).length, 1, '不是用户动作就不重试')
  await 推进组织(f.ctx, f.根, null, { 用户动作: true })
  await 交回了(f, '1.1')
  const calls = await f.假.调用们()
  assert.equal(calls.length, 2)
  assert.match(提示(calls[1]), /上次出错停下了（Codex 的登录过期了/)
  assert.equal((await 行(f, '1.1')).selector?.incident, undefined, '再做时出事了的记号清掉')
})

test('服务忙：自动再试一次，再试的那次告诉它上次连不上', async t => {
  改设置(t, { 重试等: 20 })
  const f = await fixture(t, 'codex', [{ fail: { status: 503, message: 'Service Unavailable' } },
    { answer: { result: 'achieved', handoff: '第二次做完了', question: '' } }])
  await 派(f, [块('改代码', { executor: 'codex' })])
  await 交回了(f, '1.1')
  const calls = await f.假.调用们()
  assert.equal(calls.length, 2)
  assert.match(提示(calls[1]), /上次连不上服务（Codex 连不上服务（Service Unavailable）/)
})

test('按停（全部停止、Live 上停它）：正在做的停掉，组织推进不替它开，全部启动时重新开一次并告诉它上次停在哪；中途发给它的纸条当场退回', async t => {
  const f = await fixture(t, 'codex', [{ hang: true }, { answer: { result: 'achieved', handoff: '接着做完了', question: '' } }])
  await 派(f, [块('改代码', { executor: 'codex' })])
  await 等到(async () => 外部run在跑(f.根, '1.1') && (await f.假.调用们()).length === 1, '开始做')
  await assert.rejects(传纸条(f.ctx, f.根, '1', '1.1', '顺便改一下标题', { kind: 'tell' }), /1\.1 号由 Codex 在做，收不到纸条：要改它的活，由派它的节点（1 号）改写请求/)
  await 停项目外部run(f.根, '用户按了停', { 用户: true })
  assert.equal(外部run在跑(f.根, '1.1'), false)
  const 停后 = await 行(f, '1.1')
  assert.equal(停后.external.state, 'running'); assert.equal(停后.external.stopReason, '用户按了停')
  assert.equal(停后.external.userStopped, true)
  await 推进组织(f.ctx, f.根, null)
  assert.equal((await f.假.调用们()).length, 1, '用户按停的，机器推进组织不开工')
  await 推进组织(f.ctx, f.根, null, { 用户动作: true })
  await 交回了(f, '1.1')
  assert.equal((await 行(f, '1.1')).external.userStopped, undefined, '重新开工时去掉按停记号')
  assert.match(提示((await f.假.调用们())[1]), /上次做到一半停下了：用户按了停/)
})

test('很久没动静：停掉，照实交回 unmet；没按格式交回的也照实交回，附上它最后说的', async t => {
  改设置(t, { 静默: 300, 巡查: 50, 收尾等: 200 })
  const f = await fixture(t, 'codex', [{ hang: true }])
  await 派(f, [块('改代码', { executor: 'codex' })])
  await 交回了(f, '1.1')
  const r = await 行(f, '1.1')
  assert.equal(r.result, 'unmet')
  assert.match(r.handoff, /Codex 很久没有动静/)

  const g = await fixture(t, 'codex', [{ say: '我觉得做完了' }])
  await 派(g, [块('改代码', { executor: 'codex' })])
  await 交回了(g, '1.1')
  const s = await 行(g, '1.1')
  assert.equal(s.result, 'unmet')
  assert.match(s.handoff, /做完了，但没按格式交回结论。\n\n它最后说的：\n我觉得做完了/)
})

test('并入撞冲突：叫同一家解决一次，解决了再并；冲突那一轮的请求里写着冲突文件和要并的分支', async t => {
  const 夹 = realpathSync(await mkdtemp(join(tmpdir(), '外部run冲突-'))), 放行 = join(夹, 'go')
  const f = await fixture(t, 'codex', [
    { write: { 'out.txt': '甲\n' }, wait: 放行, answer: { result: 'achieved', handoff: '写了甲', question: '' } },
    { resolve: { 分支: 'node-1', 文件: { 'out.txt': '甲乙\n' } }, answer: { result: 'achieved', handoff: '冲突解决了，两边都留', question: '' } }])
  await 派(f, [块('改代码', { executor: 'codex' })])
  await 等到(() => 外部run在跑(f.根, '1.1'), '开始做')
  await writeFile(join(f.根, '作品空间', '1', '验收台', '改代码', 'out.txt'), '乙\n')
  await writeFile(放行, '')
  await 交回了(f, '1.1')
  const calls = await f.假.调用们()
  assert.equal(calls.length, 2)
  assert.match(提示(calls[1]), /撞上了冲突[\s\S]*- 验收台\/改代码\/out\.txt[\s\S]*git merge node-1/)
  assert.equal(await readFile(join(f.根, '作品空间', '1', '验收台', '改代码', 'out.txt'), 'utf8'), '甲乙\n')
  assert.match((await 行(f, '1.1')).handoff, /^冲突解决了，两边都留/)
})

// 十步重置：还没开工的块就是登记着的；登记时选了外部 agent，派出时那家关了，开团队时改回 DeepSeek。
const 登记 = (key, extra = {}) => ({ key, name: key, role: 'run', what: `做出${key}`, dispatch: false, ...extra })
const 派登记 = (f, id, key) => 派(f, [{ id, bench: `验收台/${key}`, situation: '先做的交回了', link: '为整件事服务', level: 'polished' }], '下一轮')

test('用户关掉了那一家：还没开工的块改回 DeepSeek 做', async t => {
  const f = await fixture(t, 'codex', [{ answer: { result: 'achieved', handoff: '不该被叫到', question: '' } }])
  await 派(f, [块('先做'), 登记('后做', { executor: 'codex' })])
  await 写子代理开关('codex', false, f.根)
  await 调工具(f, 'finish', { result: 'achieved', handoff: '先做的做完了' }, await 活节点(f, '1.1'))
  await 派登记(f, '1.2', '后做')
  const r = await 等到(async () => (await 行(f, '1.2')).session && await 行(f, '1.2'), '1.2 号有了会话')
  assert.equal(r.executor, undefined)
  assert.equal(r.external.switchedOff, 'Codex')
  assert.equal((await f.假.调用们()).length, 0)
})

// 用户 10-18：DSH 也关着时，开着什么用什么——关掉那家手上还没做的活交给开着的另一家。
test('DSH 关着时关掉一家外部：它还没开工的块交给开着的另一家，不改回 DeepSeek', async t => {
  const f = await fixture(t, 'claudeCode', [{ answer: { result: 'achieved', handoff: '先做的做完了', question: '' } },
    { write: { 'b.txt': 'b' }, answer: { result: 'achieved', handoff: '后做的也做完了', question: '' } }])
  const codex = await 装假程序(t, 'codex', [{ answer: { result: 'achieved', handoff: '不该被叫到', question: '' } }])
  await 写子代理开关('codex', true, f.根); await 写子代理开关('dsh', false, f.根)
  await 派(f, [块('先做', { executor: 'claude_code' }), 登记('后做', { executor: 'codex' })])
  await 写子代理开关('codex', false, f.根)
  await 交回了(f, '1.1')
  await 派登记(f, '1.2', '后做')
  const r = await 交回了(f, '1.2') && await 行(f, '1.2')
  assert.equal(r.executor, 'claude_code')
  assert.equal(r.external.switchedOff, 'Codex')
  assert.equal(r.session, undefined, '没开 DeepSeek 会话')
  assert.equal((await codex.调用们()).length, 0)
  assert.equal((await f.假.调用们()).length, 2)
})

test('出错怎么分：登录、额度、模型、网络、上下文、没按格式', () => {
  const c = { 名字: 'Codex' }, 态 = extra => ({ 回答: null, 静默: false, 失败: '', 失败码: null, 错: '', 最后说: '', code: 1, ...extra })
  assert.equal(分类(c, {}, 态({ 失败: JSON.stringify({ status: 401, error: { message: 'x' } }) })).类, '等用户')
  assert.match(分类(c, {}, 态({ 失败: 'You have hit your usage limit' })).原因, /额度用完了/)
  assert.match(分类(c, { model: 'gpt-x' }, 态({ 失败: "The 'gpt-x' model is not supported when using Codex with a ChatGPT account." })).原因, /用不了选的模型（gpt-x）/)
  assert.match(分类({ 名字: 'Claude Code' }, {}, 态({ 失败: "There's an issue with the selected model (x). It may not exist", 失败码: 404 })).原因, /用不了选的模型/)
  assert.equal(分类(c, {}, 态({ 失败: 'stream disconnected before completion' })).类, '重试')
  assert.equal(分类(c, {}, 态({ 失败码: 529, 失败: 'Overloaded' })).类, '重试')
  assert.match(分类(c, {}, 态({ 失败: 'context window exceeded' })).原因, /上下文撑满了/)
  assert.match(分类(c, {}, 态({ 最后说: '好了' })).原因, /没按格式交回/)
  assert.equal(分类(c, {}, 态({ 回答: { result: 'unmet', handoff: 'x', question: '' } })).类, '交回')
})
