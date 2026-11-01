import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { 落新名册 } from '../roster/src/index.js'
import { 读人工审核, 写solo } from '../node/src/人工审核.js'
import { 接问答链, 通过项目待审核 } from './src/问答链.js'
import { 协作HTTP } from './src/协作入口.js'
import { 写协作设置 } from '../node/src/协作设置.js'
import { 自动问答回答, 自动对话答复 } from '../node/src/回答.js'
import { 恢复回答正文 } from '../roster/src/问答.js'

const questions = [{ id: 'review', intent: { kind: 'plan-review', approve: '通过' }, options: [{ label: '退回' }, { label: '通过' }] }]
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'solo接口核对-')), root = join(base, '当前项目'), other = join(base, '另一个项目')
  t.after(() => rm(base, { recursive: true, force: true }))
  await 落新名册(root, '总制作人', 'Mode: co-create'); await 落新名册(other, '另一个总制作人', 'Mode: co-create')
  return { root, other }
}

test('协作设置（协 7）：改一处先存下，再按新的表放行当前项目挂着的；错误身份和非法值不修改设置', async t => {
  const { root, other } = await fixture(t), events = []
  const handle = 协作HTTP((res, status, body) => Object.assign(res, { status, body }), {
    projectRootOf: async session => { if (session !== 'current') throw new Error('项目身份不匹配'); return root },
    onChange: (_root, value) => events.push(['change', value.preset]),
    approvePending: async target => { assert.equal(target, root); events.push(['approve']); return { approved: 2, warnings: [] } },
  })
  const send = async (value, method = 'POST', url = '/studio/api/collab') => { const req = Readable.from(method === 'POST' ? [JSON.stringify(value)] : []), res = {}; req.method = method; req.url = url; await handle(req, res); return res }
  const 读 = await send({}, 'GET', '/studio/api/collab?session=current')
  assert.equal(读.body.value.preset, 'build', 'co-create（build）一开始就是「一起做」')
  const 全交 = await send({ session: 'current', preset: 'solo' })
  assert.equal(全交.body.ok, true); assert.equal(全交.body.value.preset, 'solo'); assert.equal(全交.body.value.approved, 2)
  assert.deepEqual(events, [['change', 'solo'], ['approve']])
  assert.equal((await 读人工审核(root)).enabled, false); assert.equal((await 读人工审核(other)).enabled, true)
  const 验收 = await send({ session: 'current', who: 'helm', point: 'accept', on: true })
  assert.equal(验收.body.value.preset, 'accept', '全交给你们再勾上总制作人的验收，就是「只验收结果」')
  assert.equal(events.filter(event => event[0] === 'approve').length, 2, '每改一处都按新的表复查一遍')
  assert.equal((await send({ session: 'other', preset: 'build' })).body.ok, false)
  assert.equal((await send({ session: 'current', who: 'helm', point: 'accept', on: 'true' })).body.ok, false)
  assert.equal((await send({ session: 'current', preset: 'everything' })).body.ok, false)
  assert.equal((await send({ session: 'current', who: '9', point: 'plan', on: true })).body.ok, false, '不是这一阶段的部分不能单独设')
  assert.equal((await send({}, 'PUT')).status, 405)
  assert.equal((await send({}, 'GET', '/studio/api/collab?session=current')).body.value.preset, 'accept')
})

test('关闭后处理本项目正在等待及暂停恢复的提问、审核和对话，保留其他项目及已有用户答复', async t => {
  const { root, other } = await fixture(t), pending = new Map(), records = new Map(), ports = new Map(), delivered = [], saved = []
  const review = (id, session = 'current', extra = {}) => ({ kind: 'question', rpcId: id, session, questions, ...extra })
  const add = (frame, directory = root) => { pending.set(frame.rpcId, frame); records.set(frame.rpcId, { root: directory, frame }) }
  add(review('live')); add(review('paused')); add(review('foreign', 'other'), other)
  add(review('ordinary', 'current', { questions: [{ id: 'direction', options: [{ label: 'A' }] }] }))
  add(review('dialog', 'current', { questions: [{ id: 'chat', question: '请说说你的判断' }] }))
  add(review('answered')); records.get('answered').answer = { answers: [{ id: 'review', selected: ['退回'] }] }
  pending.set('permission', { kind: 'approval', rpcId: 'permission', session: 'current' })
  ports.set('live', { 答: async value => { saved.push(['live', value]); pending.delete('live'); records.delete('live') } })
  ports.set('permission', { 答: async value => { saved.push(['permission', value]); pending.delete('permission') } })
  const deps = { pending, 持久问题: records, 答复口: ports, rootOf: async session => session === 'current' ? root : other,
    写问答: (_root, record) => saved.push(['persist', record.answer]), 送恢复回答: async record => { delivered.push(record); records.delete(record.frame.rpcId); pending.delete(record.frame.rpcId) } }
  assert.equal((await 通过项目待审核(root, deps)).approved, 0)
  await 写solo(root, true)
  const result = await 通过项目待审核(root, deps)
  assert.equal(result.approved, 5); assert.deepEqual(result.warnings, [])
  assert.deepEqual(saved.find(([name]) => name === 'live')[1].answers[0].selected, ['通过'])
  assert.equal(saved.find(([name]) => name === 'permission')[1], 'allowed-once')
  assert.equal(delivered.length, 3); assert.equal(delivered[0].frame.rpcId, 'paused')
  const ordinary = delivered.find(record => record.frame.rpcId === 'ordinary'), dialog = delivered.find(record => record.frame.rpcId === 'dialog')
  assert.deepEqual(ordinary.answer.answers[0].selected, []); assert.equal(ordinary.answer.answers[0].custom, 自动对话答复); assert.equal(ordinary.automatic, true)
  assert.equal(dialog.answer.answers[0].custom, 自动对话答复); assert.equal(dialog.automatic, true)
  assert.match(恢复回答正文(dialog), /系统对暂停前问题的自动答复/)
  assert.doesNotMatch(恢复回答正文(dialog), /用户回话|系统自动通过的结果/)
  assert.deepEqual([...pending.keys()].sort(), ['answered', 'foreign'])
  assert.equal((await 通过项目待审核(root, deps)).approved, 0)
})

test('放行挂着的期间另一窗口又改了表，接口最终返回最新设置', async t => {
  const { root } = await fixture(t)
  const handle = 协作HTTP((res, _status, body) => Object.assign(res, body), {
    projectRootOf: async () => root, approvePending: async () => { await 写协作设置(root, { preset: 'deep' }); return { approved: 0, warnings: [] } },
  })
  const req = Readable.from([JSON.stringify({ session: 'current', preset: 'solo' })]), res = {}; req.method = 'POST'
  await handle(req, res); assert.equal(res.ok, true); assert.equal(res.value.preset, 'deep')
})

test('关闭处理读取设置期间用户刚提交回答，不覆盖答案或改记成系统来源', async t => {
  const { root } = await fixture(t)
  await 写solo(root, true)
  const frame = { kind: 'question', rpcId: 'concurrent-answer', session: 'current', questions }
  const record = { root, frame }, records = new Map([[frame.rpcId, record]])
  const result = 通过项目待审核(root, { pending: new Map([[frame.rpcId, frame]]), 持久问题: records,
    答复口: new Map([[frame.rpcId, { 答: () => assert.fail('不应覆盖刚提交的用户回答') }]]) })
  record.answer = { answers: [{ id: 'review', selected: ['退回'], custom: '先调整方向' }] }
  assert.equal((await result).approved, 0)
  assert.equal(record.answer.answers[0].custom, '先调整方向')
  assert.equal(record.automatic, undefined)
})

test('单项恢复失败保留待送答案，继续处理其他审核；重新打开开关后停止后续自动处理', async t => {
  const { root } = await fixture(t); await 写solo(root, true)
  const record = { root, frame: { kind: 'question', rpcId: 'paused', session: 'current', questions } }
  const pending = new Map([['paused', record.frame], ['permission', { kind: 'approval', session: 'current' }]]), records = new Map([['paused', record]])
  let permission = 0
  const result = await 通过项目待审核(root, { pending, 持久问题: records, rootOf: async () => root,
    答复口: new Map([['permission', { 答: async () => permission++ }]]), 写问答() {}, 送恢复回答: async () => { throw new Error('暂时离线') } })
  assert.deepEqual(result.warnings, ['暂时离线']); assert.equal(permission, 1)
  assert.deepEqual(record.answer.answers[0].selected, ['通过']); assert.equal(records.has('paused'), true)
  let retried = 0
  await 通过项目待审核(root, { pending: new Map(), 持久问题: records, rootOf: async () => root,
    送恢复回答: async () => { retried++ } })
  assert.equal(retried, 1, '已保存的自动批准在服务恢复后继续送达')
  records.clear(); await 写solo(root, false)
  assert.equal((await 通过项目待审核(root, { pending, 持久问题: records, rootOf: async () => root })).approved, 0)
})

test('关闭审核的原生权限请求直接返回一次授权，不生成等待卡或传给下一环', async () => {
  let handler, next = 0
  接问答链({ on: (_event, callback) => { handler = callback } }, 'approval/request', 'approval', {
    自动批准: async () => 'allowed-once', pending: new Map(), 持久问题: new Map(), 答复口: new Map(),
    send: () => assert.fail('不应生成等待卡'),
  })
  assert.equal(await handler({}, () => { next++; }), 'allowed-once'); assert.equal(next, 0)
})

test('首次核对后才关闭开关，新登记的审批仍自动通过，不漏在等待队列', async () => {
  let handler, checks = 0, next = 0
  const pending = new Map(), ports = new Map(), frames = []
  接问答链({ on: (_event, callback) => { handler = callback } }, 'approval/request', 'approval', {
    自动批准: async () => ++checks === 1 ? null : 'allowed-once', pending, 持久问题: new Map(), 答复口: ports,
    send: frame => frames.push(frame),
  })
  assert.equal(await handler({ agent: { id: 'node' } }, () => { next++ }), 'allowed-once')
  assert.equal(next, 0); assert.equal(pending.size, 0); assert.equal(ports.size, 0)
  assert.equal(frames.at(-1).type, 'blueprint.ask_done')
})

test('新问题直接代答；登记期间关闭开关的文字对话保存系统来源并收回等待卡', async () => {
  for (const race of [false, true]) {
    let handler, checks = 0, next = 0
    const pending = new Map(), records = new Map(), ports = new Map(), frames = [], saved = []
    const questions = [{ id: 'chat', question: '接下来怎么做？' }]
    接问答链({ on: (_event, callback) => { handler = callback }, sessions: { get: () => null } }, 'user-questions/request', 'question', {
      自动回答: async () => race && ++checks === 1 ? null : 自动问答回答(questions),
      我是谁: async () => ({ 号: '0' }), pending, 持久问题: records, 答复口: ports,
      写问答: (_root, record, remove) => { if (!remove) saved.push(structuredClone(record)) },
      记用户回答: async record => { assert.equal(record.automatic, true) }, send: frame => frames.push(frame),
    })
    const result = await handler({ agent: { session: { id: 'current', header: { cwd: '/当前项目' } } }, questions }, () => { next++; return new Promise(() => {}) })
    assert.equal(result.answers[0].custom, 自动对话答复); assert.equal(next, 0)
    assert.equal(pending.size, 0); assert.equal(records.size, 0); assert.equal(ports.size, 0)
    if (race) {
      assert.equal(saved.at(-1).automatic, true)
      assert.equal(frames.at(-1).type, 'blueprint.ask_done')
    } else assert.deepEqual(frames, [])
  }
})
