import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { 落新名册, 改名册, 加行, 记会话 } from '../roster/src/index.js'
import { 自动回答, 自动对话答复 } from '../node/src/回答.js'
import { 接问答链 } from './src/问答链.js'

async function fixture(t, mode) {
  const root = await mkdtemp(join(tmpdir(), 'mode-question-channel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await 落新名册(root, '问答链核对', `做游戏\nMode: ${mode}`)
  await 改名册(root, m => 加行(m, '0', { name: '承担者' }).名册)
  await 改名册(root, m => 记会话(m, '1', 'child-session'))
  let dispatch
  const frames = [], pending = new Map(), answers = new Map()
  const ctx = { sessions: { get: () => ({ header: { cwd: root } }) }, on: (_event, fn) => dispatch = fn }
  const install = kind => 接问答链(ctx, kind === 'approval' ? 'approval/request' : 'user-questions/request', kind,
    { 自动回答, pending, 答复口: answers, send: f => frames.push(f), 我是谁: async () => null })
  return { root, ctx, frames, pending, answers, install, run: (request, next) => dispatch(request, next) }
}
const 方案审核 = { id: 'review', question: '请审核方案', intent: { kind: 'plan-review', approve: '开始' }, options: [{ label: '开始' }, { label: '修改' }] }

test('co-create 子节点的方案审核自动通过，不创建人工待答或额外会话', async t => {
  const f = await fixture(t, 'co-create'); f.install('question')
  const result = await f.run({ agent: { session: { id: 'child-session' } }, questions: [方案审核] },
    () => assert.fail('自动通过不等待人工'))
  assert.deepEqual(result.answers[0].selected, ['开始'])
  assert.equal(f.frames.length, 0); assert.equal(f.pending.size, 0); assert.equal(f.answers.size, 0)
})

test('solo 与 co-create 的原生操作审批走同一通道，模式不额外拒绝或批准', async t => {
  for (const mode of ['solo', 'co-create']) {
    const f = await fixture(t, mode); f.install('approval')
    let calls = 0
    assert.equal(await f.run({ agent: { session: { id: 'session' } }, toolName: 'bash' }, async () => { calls++; return 'approved' }), 'approved')
    assert.equal(calls, 1)
    assert.equal(f.frames[0].kind, 'approval')
    assert.equal(f.pending.size, 0); assert.equal(f.answers.size, 0)
  }
})

test('solo 普通问题交回节点自己判断，不编造用户选择或创建人工等待', async t => {
  const f = await fixture(t, 'solo'); f.install('question')
  const result = await f.run({ agent: { session: { id: 'child-session' } }, questions: [{ id: 'feedback', question: '实际手感怎样？', options: [{ label: '偏重' }] }] },
    () => assert.fail('solo 普通问题不等待人工'))
  assert.deepEqual(result.answers[0], { id: 'feedback', selected: [], custom: 自动对话答复 })
  assert.equal(f.frames.length, 0); assert.equal(f.pending.size, 0); assert.equal(f.answers.size, 0)
})

test('build 普通问题留给人工，答了才返回，不报错也不编造', async t => {
  const f = await fixture(t, 'build'); f.install('question')
  const asked = f.run({ agent: { session: { id: 'child-session' } }, questions: [{ id: 'feedback', question: '实际手感怎样？' }] },
    () => assert.fail('人工通道由问答链自己出题'))
  for (let i = 0; i < 100 && !f.frames.length; i++) await new Promise(resolve => setTimeout(resolve, 5)) // 先读名册判断要不要代答
  assert.equal(f.frames.length, 1); assert.equal(f.pending.size, 1)
  const value = { answers: [{ id: 'feedback', selected: [], custom: '手感偏重' }] }
  await f.answers.get(f.frames[0].rpcId).答(value)
  assert.deepEqual(await asked, value)
  assert.equal(f.pending.size, 0)
})
