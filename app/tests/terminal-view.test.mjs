// 运行发布包的真实 ClientTerminals/RemoteStream 与真实 controller；DOM/xterm显示用轻量fixture。
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureTerminalClientAssets } from '../scripts/terminal-client-assets.mjs'
import { 终端操作, 终端流 } from '../../blueprint/packages/studio/src/终端.js'
import { fixture } from './helpers/terminal-controller.mjs'
// 旧 viewer 代码里的文字经 译() 出来；沙盒里没接 dsh 语言，就是中文原句。
import * as 界面语言 from '../../viewer/界面语言.js'

const app = fileURLToPath(new URL('../', import.meta.url))
const html = await readFile(new URL('../../viewer/studio.html', import.meta.url), 'utf8')
const transportSource = await readFile(new URL('../../viewer/terminal-transport.js', import.meta.url), 'utf8')
const viewSource = await readFile(new URL('../../viewer/terminal.js', import.meta.url), 'utf8')
const waitFor = async predicate => {
  for (let index = 0; index < 500; index++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail('终端视图未达到预期状态')
}
class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.textContent = ''; this.hidden = false; this.clientWidth = 800; this.clientHeight = 400; this.value = '' }
  append(...children) { for (const child of children) { this.children.push(child); child.parentElement = this } }
  replaceChildren(...children) { this.children = []; this.append(...children) }
  setAttribute(key, value) { this.attributes[key] = value }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this) }
  click() { if (!this.disabled) return this.onclick?.() }
}
const walk = node => [node, ...node.children.flatMap(walk)]
const textOf = node => walk(node).map(child => child.textContent).join(' ')
const storage = () => {
  const rows = new Map()
  return { get length() { return rows.size }, key: index => [...rows.keys()][index], getItem: key => rows.get(key) ?? null,
    setItem: (key, value) => rows.set(key, String(value)), removeItem: key => rows.delete(key), rows }
}
class Screen {
  constructor(options) { this.options = options; this.writes = []; this.textarea = new Element('textarea') }
  loadAddon() {} open(node) { this.node = node } reset() { this.writes = [] } resize(cols, rows) { this.cols = cols; this.rows = rows }
  write(data, callback) { this.writes.push(data); queueMicrotask(callback) }
  onData(listener) { this.input = listener; return { dispose() {} } }
  focus() {} dispose() { this.disposed = true }
}

async function browserFixture(t) {
  const host = await fixture(t), directory = await mkdtemp(join(tmpdir(), 'Blueprint-terminal-client-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const assets = await ensureTerminalClientAssets(join(app, 'node_modules'), { directory })
  assert.equal(assets.ready, true)
  const bundle = await readFile(join(directory, 'native-terminal.js'), 'utf8')
  const saved = storage(), calls = [], streams = new Set(), screens = []
  let online = true
  const fault = error => ({ code: error.code || 'terminal/internal', message: error.message, details: error.details || {} })
  const response = result => new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
  const request = async (input, options = {}) => {
    if (!online) throw new Error('carrier offline')
    if (options.method === 'POST') {
      const payload = JSON.parse(options.body); calls.push(payload)
      try { return response({ ok: true, value: await 终端操作(host.api, payload, options.signal || new AbortController().signal, host.scope) }) }
      catch (error) { return response({ ok: false, error: fault(error) }) }
    }
    const url = new URL(input, 'http://studio/'), payload = Object.fromEntries(url.searchParams)
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, options.signal])
    const iterator = 终端流(host.api, payload, signal)[Symbol.asyncIterator]()
    let first
    try { first = await iterator.next() }
    catch (error) { return response({ ok: false, error: fault(error) }) }
    const row = { abort, controller: null }
    const body = new ReadableStream({
      start(controller) { row.controller = controller; streams.add(row) },
      async pull(controller) {
        try {
          const result = first || await iterator.next(); first = undefined
          if (result.done) { streams.delete(row); controller.close() }
          else controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ value: result.value })}\n\n`))
        } catch (error) { streams.delete(row); try { controller.error(error) } catch {} }
      },
      async cancel() { streams.delete(row); abort.abort(); await iterator.return?.() },
    })
    signal.addEventListener('abort', () => { try { row.controller.error(signal.reason) } catch {} }, { once: true })
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const create = (current, pane = new Element()) => {
    const realm = vm.createContext({ ...界面语言,  console, document: { createElement: tag => new Element(tag) },
      localStorage: saved, crypto: webcrypto, fetch: request, URL, URLSearchParams, TextEncoder, TextDecoder,
      AbortController, AbortSignal, setTimeout, clearTimeout, queueMicrotask, ResizeObserver: class { observe() {} disconnect() {} },
      Terminal: class extends Screen { constructor(options) { super(options); screens.push(this) } },
      FitAddon: { FitAddon: class { proposeDimensions() { return { cols: 60, rows: 20 } } } } })
    vm.runInContext(bundle, realm)
    vm.runInContext(transportSource, realm); vm.runInContext(viewSource, realm)
    const panel = realm.BlueprintTerminalPanel({ pane, current })
    t.after(() => panel.dispose())
    return { realm, panel, pane }
  }
  return { host, saved, calls, screens, create,
    disconnect() { online = false; for (const row of streams) { row.abort.abort(); try { row.controller.error(new Error('carrier disconnected')) } catch {} } streams.clear() },
    reconnect() { online = true }, }
}

test('发布包真实客户端创建多标签、串行输入和resize；切节点保留用户终端并不把输出递进对话', async t => {
  const f = await browserFixture(t), at = { sessionId: 'node-a', projectSessionId: 'project-a', visible: true }
  const browser = f.create(() => at)
  await browser.panel.sync()
  const add = walk(browser.pane).find(node => node.tagName === 'BUTTON' && node.textContent === '新终端')
  add.click(); await waitFor(() => f.host.spawns.length === 1 && f.screens[0].options.disableStdin === false)
  f.screens[0].input('pwd\r'); f.screens[0].input('\t')
  await waitFor(() => f.host.spawns[0].written.length === 2)
  assert.deepEqual(f.host.spawns[0].written, ['pwd\r', '\t'])
  await waitFor(() => f.host.spawns[0].resized.some(([cols, rows]) => cols === 60 && rows === 20))
  add.click(); await waitFor(() => f.host.spawns.length === 2)
  assert.equal(walk(browser.pane).filter(node => node.attributes.role === 'tab').length, 2)
  at.sessionId = 'project-b'; at.projectSessionId = 'project-b'; await browser.panel.sync()
  assert.equal(f.host.spawns.length, 2); assert.ok(f.host.spawns.every(row => row.terminateCount === 0))
  assert.equal(f.calls.some(row => /prompt|message/.test(row.method)), false)
  const layout = [...f.saved.rows].filter(([key]) => key.startsWith('blueprint.terminal.tab.v1.')).map(([, value]) => JSON.parse(value))
  assert.ok(layout.every(row => !Object.hasOwn(row, 'state') && !Object.hasOwn(row, 'screen') && !Object.hasOwn(row, 'cwd')))
})

test('物理断线和页面重建都复用官方绑定与屏幕，不重发create或输入，不静默重启丢失进程', async t => {
  const f = await browserFixture(t), at = { sessionId: 'node-a', projectSessionId: 'project-a', visible: true }
  const first = f.create(() => at); await first.panel.sync()
  walk(first.pane).find(node => node.textContent === '新终端').click()
  await waitFor(() => f.host.spawns.length === 1 && f.screens[0].options.disableStdin === false)
  f.host.spawns[0].output.write('BUILD READY\r\n')
  await waitFor(() => f.screens[0].writes.join('').includes('BUILD READY'))
  f.disconnect(); await waitFor(() => f.screens[0].options.disableStdin === true)
  f.reconnect(); await waitFor(() => f.screens[0].options.disableStdin === false)
  assert.equal(f.host.spawns.length, 1); assert.equal(f.calls.filter(row => row.method === 'create').length, 1)
  await first.panel.dispose()
  assert.equal(f.host.spawns[0].terminateCount, 0)
  const rebuilt = f.create(() => at); await rebuilt.panel.sync()
  await waitFor(() => f.screens.at(-1).writes.join('').includes('BUILD READY'))
  assert.equal(f.host.spawns.length, 1)
  const id = f.host.controller.list('node-a')[0].id
  await f.host.invoke('close', { id }); await rebuilt.panel.dispose()
  const missing = f.create(() => at); await missing.panel.sync()
  await waitFor(() => textOf(missing.pane).includes('missingTerminal') || textOf(missing.pane).includes('不存在') || textOf(missing.pane).includes('无法使用'))
  assert.equal(f.host.spawns.length, 1, '恢复不存在的身份不创建替代 Shell')
})

test('DOM关闭显示等待释放；native Client close失败保留跨刷新重试意图，成功才清理', async t => {
  const f = await browserFixture(t), at = { sessionId: 'node-a', projectSessionId: 'project-a', visible: true }
  const browser = f.create(() => at); await browser.panel.sync()
  walk(browser.pane).find(node => node.textContent === '新终端').click()
  await waitFor(() => f.host.spawns.length === 1 && f.screens[0].options.disableStdin === false)
  f.host.spawns[0].release = Promise.withResolvers(); f.host.spawns[0].failClose = true
  walk(browser.pane).find(node => node.attributes['aria-label'] === '关闭终端并释放进程').click()
  await waitFor(() => f.host.spawns[0].terminateCount > 0)
  assert.match(textOf(browser.pane), /等待原生进程释放/)
  assert.ok([...f.saved.rows.keys()].some(key => key.startsWith('dsh.terminal.close.v1.')))
  f.host.spawns[0].release.resolve()
  await waitFor(() => textOf(browser.pane).includes('关闭失败'))
  walk(browser.pane).find(node => node.textContent === '重试关闭').click()
  await waitFor(() => f.host.controller.list('node-a').length === 0)
  await waitFor(() => ![...f.saved.rows.keys()].some(key => key.startsWith('dsh.terminal.close.v1.')))
})

test('旧服务读新版HTML但terminal脚本404时，真实buildFlow保护保留主界面', () => {
  const start = html.indexOf("  const terminal = document.createElement('div');")
  const end = html.indexOf('  traceOverview?.destroy();', start)
  assert.ok(start >= 0 && end > start)
  const flow = new Element(), old = new Element('div')
  const realm = vm.createContext({ ...界面语言,  document: { createElement: tag => new Element(tag) }, flow,
    tabs: old, chat: new Element(), artifacts: new Element(), trace: new Element(), feed: new Element(), 身: new Element(), stats: new Element(), 用户终端: null })
  assert.doesNotThrow(() => vm.runInContext(html.slice(start, end), realm))
  assert.equal(flow.children.length, 8)
  assert.match(flow.children[3].textContent, /用户终端需要新版服务/)
})

function htmlFunction(name) {
  const start = html.indexOf('async function ' + name + '(')
  const end = html.indexOf('\n}\n', start) + 3
  assert.ok(start >= 0 && end > start); return html.slice(start, end)
}

test('Stop All 等取消完成后才收回节点执行终端；等待释放期间切项目仍使用原项目，失败明确显示', async () => {
  const cancel = Promise.withResolvers(), close = Promise.withResolvers(), calls = [], messages = []
  const at = { 在: 'project', 项目: 'project-a' }
  const realm = vm.createContext({ ...界面语言,  S: { at }, 全停字: null, 稍等: async () => {}, refresh() {}, toast: value => messages.push(value),
    写停字: value => { realm.全停字 = value }, rpc: async (method, payload) => {
      calls.push([method, payload.projectSessionId])
      if (method === 'session.list') return { ok: true, value: { projectSessionId: payload.projectSessionId, canCloseAgentTerminals: true,
        items: [{ sessionId: 'node-a', running: false }], external: [{ id: 'codex-a', parentSessionId: 'node-a', status: 'unknown' }] } }
      if (method === 'project.closeAgentTerminals') { await close.promise; return { ok: false, message: '原生终端仍有未释放的所属活动' } }
      await cancel.promise; return { ok: true }
    } })
  vm.runInContext(['会话表', '停一个', '全停'].map(htmlFunction).join('\n'), realm)
  const stopping = realm.全停()
  await waitFor(() => calls.length === 3)
  assert.deepEqual(calls.map(row => row[0]), ['session.list', 'session.cancel', 'external.interrupt'])
  at.项目 = 'project-b'; cancel.resolve()
  await waitFor(() => calls.length === 5)
  assert.deepEqual(calls.slice(3), [['project.stopExternalRuns', 'project-a'], ['project.closeAgentTerminals', 'project-a']])
  assert.deepEqual(calls.at(-1), ['project.closeAgentTerminals', 'project-a'])
  assert.equal(realm.全停字, '…PTY'); assert.deepEqual(messages, [])
  close.resolve(); await stopping
  assert.equal(realm.全停字, null); assert.match(messages[0], /节点终端关闭失败.*未释放/)
})

test('旧服务未声明节点终端关闭能力时，Stop All 不发送新 RPC；单节点 Stop 始终保留shell', async () => {
  const calls = [], messages = []
  const realm = vm.createContext({ ...界面语言,  S: { at: { 在: 'project', 项目: 'project-a' } }, 全停字: null,
    稍等: async () => {}, refresh() {}, toast: value => messages.push(value), 写停字: value => { realm.全停字 = value },
    rpc: async (method, payload) => {
      calls.push(method)
      return method === 'session.list' ? { ok: true, value: { projectSessionId: payload.projectSessionId,
        items: [{ sessionId: 'node-a', running: false }] } } : { ok: true }
    } })
  vm.runInContext(['会话表', '停一个', '全停'].map(htmlFunction).join('\n'), realm)
  await realm.全停(); assert.deepEqual(calls, ['session.list', 'session.cancel', 'project.stopExternalRuns'])
  calls.length = 0; await realm.停一个('node-a', { 在跑: true }, 'project-a')
  assert.deepEqual(calls, ['session.cancel']); assert.match(messages[0], /Stop All/)
})
