// 阶段分界线（2026-10-19 用户定：左侧黑签、只写英文、只在换阶段的地方画）：从节点存储里按轮认选择机插的阶段页，
// 线插在那一轮开头那行下面。dsh 对话列表不显示插入的上下文，阶段页只在存储里、不在 order 里。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('./对话.js', import.meta.url), 'utf8')
// 生成时和旧对话的两个函数拼在一起（同 对话.test.js）。
const legacy = readFileSync(new URL('../../../viewer/stream-render.js', import.meta.url), 'utf8')
const take = name => { const start = legacy.indexOf(`  function ${name}(`); return legacy.slice(start, legacy.indexOf('\n  }', start) + 4) }
function load() {
  const react = { Fragment: 'Fragment', createContext: () => ({ Provider: 'Provider' }), useContext: () => null,
    useRef: current => ({ current }), useLayoutEffect: () => {}, useEffect: () => {}, useCallback: fn => fn }
  const context = vm.createContext({ h: (type, props, ...children) => ({ type, props, children }), react,
    BlueprintChatMaterials: 'Materials', ChatFlow: 'ChatFlow', 连接对话滚动: () => {}, useBlueprintPresentation() {},
    require: () => ({ createSnapshotStore: initial => ({ getSnapshot: () => initial, set() {}, subscribe: () => () => {} }) }) })
  vm.runInContext([take('verbOf'), take('参数里的文件'), source, 'this.api = { 阶段切换, 同一切换, 插阶段线, 注册对话呈现 };'].join('\n'), context)
  return context.api
}
const plain = value => JSON.parse(JSON.stringify(value))
// 照 installed dsh 的 chatNode 形状：key、kind、anchorSeq、location（第几轮）、visibility、data。
let seq = 0
const 节点 = (key, kind, turn, data, visibility = 'visible') => ({ key, kind, anchorSeq: ++seq, visibility,
  location: { kind: 'step', turn: { turn }, step: { step: 1 } }, data: { seq, ...data } })
const 插页 = (key, turn, text) => 节点(key, 'context', turn, { content: [{ type: 'text', text }], source: { kind: 'plugin:blueprint-thinking-opening' } }, 'hidden')
const 叫醒 = (key, turn, text = '<goal_round>') => 节点(key, 'turn-trigger', turn, { content: [{ type: 'text', text }], source: { kind: 'goal' } })
const 用户 = (key, turn, text) => 节点(key, 'user', turn, { content: [{ type: 'text', text }], source: { kind: 'user' } })
const 回答 = (key, turn) => 节点(key, 'assistant-step', turn, { blocks: [] })
function 快照(nodes) {
  const byKey = new Map(nodes.map(n => [n.key, n]))
  return { order: nodes.filter(n => n.visibility === 'visible').map(n => n.key), nodes: { get: key => byKey.get(key), values: () => [...byKey.values()] } }
}
// 照 10-19-3 的 2 号 dock：开工 rule、Goal 轮 orient → plan → execute，你问话后 divide、plan，第 7 轮选不出，再 reply、plan；
// 再加一轮同阶段（plan 只有一行）。
const 一段对话 = () => 快照([
  叫醒('t1', 1, '开工。请求在节点前缀里。'), 插页('p1', 1, '你的职责（原文）：…'), 插页('s1', 1, '【环节：rule】\n\n# 核心原则（rule）'), 回答('a1', 1),
  叫醒('t2', 2), 插页('s2', 2, '【环节：orient】\n\n# 粗略估计（orient）'), 回答('a2', 2),
  叫醒('t3', 3), 插页('s3', 3, '【环节：plan】\n\n# 校准定稿（plan）'), 回答('a3', 3),
  叫醒('t4', 4), 插页('s4', 4, '【环节：execute】\n\n# 执行（execute）'), 回答('a4', 4),
  用户('u5', 5, '为什么你没有分 gpt子节点去做'), 插页('s5', 5, '【环节：divide】\n\n# 分工（divide）'), 回答('a5', 5),
  用户('u6', 6, '你之前的 plan 阶段没想明白吗'), 插页('s6', 6, '【环节：plan】\n\n# 校准定稿（plan）'), 回答('a6', 6),
  用户('u7', 7, '【环节：reply】我自己打的字不算'), 回答('a7', 7),
  用户('u8', 8, '不许工作！'), 插页('s8', 8, '【环节：reply】\n\n# 回话（reply）'), 回答('a8', 8),
  用户('u9', 9, '下一轮的结构呢'), 插页('s9', 9, '【环节：plan】\n\n# 校准定稿（plan）'), 回答('a9', 9),
  叫醒('t10', 10), 插页('s10', 10, '【环节：plan】'), 回答('a10', 10),
])

test('按轮记下换了阶段的那几轮；同阶段只有一行的那轮、选不出的那轮、用户自己打的字都不算', () => {
  const { 阶段切换 } = load()
  assert.deepEqual(plain([...阶段切换(一段对话())]), [[1, 'rule'], [2, 'orient'], [3, 'plan'], [4, 'execute'], [5, 'divide'], [6, 'plan'], [8, 'reply'], [9, 'plan']])
  assert.equal(阶段切换(undefined).size, 0)
})

test('同一份 order 直接用上次的结果（流式输出不重扫）；内容一样的两份算同一份', () => {
  const { 阶段切换, 同一切换 } = load()
  const 快 = 一段对话(), 第一次 = 阶段切换(快)
  assert.equal(阶段切换({ ...快, nodes: { get: () => undefined, values: () => [] } }), 第一次)
  const 又一份 = 阶段切换(一段对话())
  assert.notEqual(又一份, 第一次)
  assert.equal(同一切换(第一次, 又一份), true)
  assert.equal(同一切换(第一次, new Map([[1, 'rule']])), false)
})

test('线插在那一轮开头那几行（叫醒行、用户的话）之后、过程组之前；没换阶段的轮不插', () => {
  const { 阶段切换, 插阶段线 } = load()
  const 快 = 一段对话(), 切换 = 阶段切换(快)
  // 对话列里的行：开头单独一行，过程组用组键（成员不在这里看）。
  const entries = [
    { kind: 'node', key: 't4' }, { kind: 'group', key: 'g4' }, { kind: 'node', key: 'a4' },
    { kind: 'node', key: 'u5' }, { kind: 'group', key: 'g5' },
    { kind: 'node', key: 'u7' }, { kind: 'node', key: 'a7' },
    { kind: 'node', key: 't10' }, { kind: 'group', key: 'g10' },
  ]
  const rows = entries.map(e => ({ row: e.key }))
  const out = 插阶段线(entries, rows, 快.nodes, 切换)
  assert.deepEqual(plain(out.map(r => r.row ?? `线:${r.children[0].children[0]}`)),
    ['t4', '线:execute', 'g4', 'a4', 'u5', '线:divide', 'g5', 'u7', 'a7', 't10', 'g10'])
  const 线 = out[1]
  assert.equal(线.props.className, 'bp-phase-line')
  assert.equal(线.props.key, 'bp-phase:4')
})

test('一轮几条开头连着（几张叫醒卡）时线在最后一条之后；刚开始的一轮后面没有行时线在末尾；没有换阶段表原样返回', () => {
  const { 插阶段线 } = load()
  const 快 = 快照([叫醒('x1', 3), 叫醒('x2', 3), 回答('y', 3), 用户('z', 4, '新的一句')])
  const 切换 = new Map([[3, 'plan'], [4, 'reply']])
  const entries = ['x1', 'x2', 'y', 'z'].map(key => ({ kind: 'node', key }))
  const out = 插阶段线(entries, entries.map(e => ({ row: e.key })), 快.nodes, 切换)
  assert.deepEqual(plain(out.map(r => r.row ?? `线:${r.children[0].children[0]}`)), ['x1', 'x2', '线:plan', 'y', 'z', '线:reply'])
  const rows = [{ row: 'x1' }]
  assert.equal(插阶段线([{ kind: 'node', key: 'x1' }], rows, 快.nodes, null), rows)
})

test('对话流外面套上这一份换阶段表', () => {
  const api = load()
  const native = { options: {}, component: () => null }
  const slots = { entries: name => name === 'conversation.chat.flow' ? [native] : [], subscribe: () => () => {}, inject: () => {} }
  api.注册对话呈现({ get: () => undefined, effect: fn => fn(), slots,
    inject(deps, callback) { assert.deepEqual([...deps], ['uiWorkspace', 'sessions']); return callback(this) } })
  const 快 = 一段对话()
  const 画出 = native.component({ sessionId: 's', t: key => key, useChat: select => select(快) })
  const 提供 = 画出.children[1].children[0].children[0]
  assert.equal(提供.type, 'Provider')
  assert.equal(提供.props.value.get(8), 'reply')
  assert.equal(提供.children[0].type, 'ChatFlow')
})

test('生成的 client.js 在 ChatFlow 收尾插线，过程组原样', () => {
  const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  assert.equal(client.split('return [...插阶段线(entries, rows, nodeStore, 阶段切换表), h(NativeChatFlow,').length, 2)
  assert.equal(client.includes('h(阶段线'), false)
})
