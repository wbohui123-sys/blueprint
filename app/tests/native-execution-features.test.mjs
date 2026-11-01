// 官方运行器、MCP、Office 资源真实执行，模型仅为离线脚本。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { apply as features, inject as featureServices } from '../../blueprint/packages/node/src/执行能力.js'
import { 写执行能力, 读执行能力 } from '../../blueprint/packages/node/src/执行能力设置.js'
import { fixtureProjectRoot as 项目路径 } from './project-fixture-root.mjs'
import { 落新名册, 改名册, 记会话, 写工作文档, 新工作文档, 读名册 } from '../../blueprint/packages/roster/src/index.js'
import { 装 } from '../../blueprint/packages/context/src/index.js'
import { 装程序工具 } from '../../blueprint/packages/context/src/程序工具.js'
import { 装项目隔离, 原生提供方代码目录 } from '../../blueprint/packages/node/src/项目隔离.js'
import { 检查行动预测 } from '../../blueprint/packages/node/src/预测.js'
import { 数据根 } from '../../blueprint/packages/prompt/src/路径.js'

const require = createRequire(new URL('../package.json', import.meta.url))
const url = name => pathToFileURL(require.resolve('@deepseek-ai/' + name)).href
const names = ['cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools',
  'dsh-agent', 'dsh-agent-loop', 'dsh-fs-local', 'dsh-subprocess-local', 'dsh-working-directory', 'dsh-subagent',
  'dsh-subagent-spawn-in-process', 'dsh-sandbox-local', 'dsh-sandbox-policy', 'dsh-ptc-runtime-node', 'dsh-tool-fs',
  'dsh-skill', 'dsh-tool-skill', 'dsh-session-persistence-jsonl']
const sdk = Object.fromEntries(await Promise.all(names.map(async name => [name, await import(url(name))])))
const entries = Object.fromEntries(Object.entries({ presentation: 'dsh-agent-tool-presentation', workflow: 'dsh-workflow-ptc',
  workflowTool: 'dsh-tool-workflow', browserRegistry: 'dsh-browser-use', browserProvider: 'dsh-experimental-browser-use-playwright-mcp',
  office: 'dsh-skill-office', dependencies: 'dsh-tool-workspace-dependencies' }).map(([key, name]) => [key, url(name)]))
const call = (id, name, args) => ({ type: 'tool-call', id: sdk['dsh-llm'].ToolCallId(id), name, arguments: JSON.stringify(args) })
const resources = fileURLToPath(new URL('../.build/native-resources', import.meta.url))

async function fixture(t, options = {}, resourceRoot = resources, services = {}) {
  const root = await mkdtemp(join(项目路径, '官方执行能力核对-')), ctx = new sdk.cordis.Context(), requests = [], children = [], counts = new Map()
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  for (const [name, service] of Object.entries(services)) ctx.provide(name, service)
  for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent',
    'dsh-subprocess-local', 'dsh-working-directory', 'dsh-skill']) await ctx.plugin(sdk[name].default)
  await ctx.plugin(sdk['dsh-session-persistence-jsonl'].default, { root: join(root, '会话存储') })
  await ctx.plugin(sdk['dsh-fs-local'].default, { cwd: root })
  await ctx.plugin(sdk['dsh-agent-loop'].default, { agents: [] })
  await ctx.plugin(sdk['dsh-sandbox-local'].default)
  await ctx.plugin(sdk['dsh-sandbox-policy'].default, { mode: 'workspace-write', workspaceRoot: root })
  await ctx.plugin(sdk['dsh-subagent'].default)
  await ctx.plugin(sdk['dsh-subagent-spawn-in-process'], { providerName: 'blueprint-workflow' })
  await ctx.plugin(sdk['dsh-ptc-runtime-node'].default)
  await ctx.plugin(sdk['dsh-tool-fs']); await ctx.plugin(sdk['dsh-tool-skill'])
  // 只代替 preset 的 Loader 文件层；原生未发布 setup、子会话组合与工具作用域保持真实。
  ctx.provide('agentPresets', { composedPreset: () => 'blueprint', mount() {}, composeFrom() {} })
  await ctx.plugin({ name: 'execution-features-fixture', inject: featureServices, apply: features }, { resourceRoot, entries })
  装项目隔离(ctx, { 检查预测: 检查行动预测,
    只读代码目录: [...原生提供方代码目录([url('dsh-ptc-runtime-node')]), ...ctx.blueprintExecutionFeatures.readOnlyRoots] })
  let parent, response
  class Offline extends sdk['dsh-llm'].LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(request) {
      requests.push(request)
      const step = (counts.get(request.sessionId) || 0) + 1; counts.set(request.sessionId, step)
      const block = await response?.(request, step, request.sessionId === parent.id)
        || { type: 'text', text: '离线核对结束' }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['features-fixture'], new Offline())
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin === 'subagent') children.push(agent)
    else 装({ systemPrompt: agent.ctx.get('systemPrompt'), on: agent.ctx.on.bind(agent.ctx), sessions: ctx.sessions, get: agent.ctx.get.bind(agent.ctx) })
  })
  const roster = await 落新名册(root, '官方能力核对', '交回可核对的文件与结果')
  await 写执行能力(root, options, 0)
  parent = (await ctx.agents.create({ sessionId: sdk['dsh-session'].SessionId('features-' + root.split('/').at(-1)), meta: { cwd: root },
    agentOptions: { provider: 'features-fixture', model: 'offline' } })).agent
  await 改名册(root, value => 记会话(value, '0', parent.id))
  await 写工作文档(root, roster.rows[0], 新工作文档(roster.rows[0], '交回可核对的文件与结果', { responsibility: '核对批量计算和材料' }))
  return { ctx, root, parent, requests, children, respond(fn) { response = fn }, async run() {
    parent.followup(sdk['dsh-llm'].createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '本地离线核对' }] }))
    await parent.whenIdle()
    return parent.session.ownEvents().filter(event => event.type === 'tool/result').map(event => event.data.message)
  } }
}

test('项目入口启用官方 PTC，真实批量写读并通过同会话应用恢复 native', async t => {
  const f = await fixture(t, { ptc: true, workflow: false, office: false })
  f.respond((_request, step) => step === 1 ? call('ptc-entry', 'run_code', { description: '写读核对',
    code: "await tools.write({file_path:'批量成果.txt',content:'42'}); return await tools.read({file_path:'批量成果.txt'});" }) : undefined)
  const result = await f.run()
  assert.equal(result[0].isError, false, JSON.stringify(result))
  assert.deepEqual(f.requests[0].tools.map(row => row.name), ['run_code'])
  assert.equal(await readFile(join(f.root, '批量成果.txt'), 'utf8'), '42')
  const before = f.parent.session.ownEvents().length
  await 写执行能力(f.root, { ptc: false, workflow: false, office: false }, 1)
  const resumed = await f.ctx.blueprintExecutionFeatures.reload(f.parent)
  assert.equal(resumed.id, f.parent.id)
  assert.ok(resumed.session.ownEvents().length >= before)
  const assembly = await f.ctx.systemPrompt.assemble({ agent: resumed, scope: resumed })
  assert.ok(assembly.tools.some(row => row.name === 'write'))
  assert.ok(!assembly.tools.some(row => row.name === 'run_code'))
  await assert.rejects(写执行能力(f.root, {}, 1), /已改变/)
})

test('官方 Workflow 并行帮助得到职责情境、有界结果、正式节点保留整合责任', async t => {
  const f = await fixture(t, { office: false })
  f.respond((_request, step, parent) => parent ? step === 1 ? call('workflow-entry', 'workflow', {
    meta: { name: '并行核对', description: '计算两份输入' }, args: {},
    script: `const schema={type:'object',properties:{sum:{type:'integer'}},required:['sum'],additionalProperties:false};
      const values=await Promise.all([agent('计算 20',{schema}),agent('计算 22',{schema})]);
      return {sum:values.reduce((n,v)=>n+v.sum,0)};`,
  }) : undefined : call('worker-value', 'structured_output', { sum: step === 1 && _request.messages.some(m => JSON.stringify(m).includes('计算 20')) ? 20 : 22 }))
  const result = await f.run()
  assert.equal(result[0].isError, false, JSON.stringify(result))
  assert.match(JSON.stringify(result), /42/)
  assert.equal(f.children.length, 2)
  for (const child of f.children) {
    const request = f.requests.find(row => row.sessionId === child.id)
    assert.match(JSON.stringify(request), /核对批量计算和材料|本节点职责/)
    assert.ok(request.tools.every(row => !['workflow', 'run_code', 'finish', 'node_doc'].includes(row.name)))
    assert.ok(!f.ctx.agents.get(child.id))
  }
  assert.equal((await 读名册(f.root)).rows.length, 1)
  await f.ctx.blueprintExecutionFeatures.releaseResources([f.parent])
  assert.ok(!f.parent.ctx.tools.schemas(f.parent).some(row => row.name === 'workflow'))
})

test('Office 官方技能与共享 Python 真正生成并重读 Word、Excel、PowerPoint', async t => {
  const f = await fixture(t, { workflow: false })
  f.respond((_request, step) => step === 1 ? call('office-deps', 'load_workspace_dependencies', {})
    : step === 2 ? call('office-skill', 'skill', { name: 'office-xlsx' }) : undefined)
  const result = await f.run()
  assert.ok(result.every(row => !row.isError), JSON.stringify(result))
  assert.match(JSON.stringify(result), /python3|python/)
  assert.match(JSON.stringify(result), /LibreOffice|libreoffice/)
  const python = join(resources, 'primary-runtime/dependencies/python/bin/python3')
  const code = `from pathlib import Path
from docx import Document
from pptx import Presentation
from openpyxl import Workbook,load_workbook
p=Path(${JSON.stringify(f.root)})
d=Document();d.add_paragraph('42');d.save(p/'核对文档.docx');assert Document(p/'核对文档.docx').paragraphs[0].text=='42'
w=Workbook();w.active['A1']=42;w.save(p/'核对表格.xlsx');assert load_workbook(p/'核对表格.xlsx').active['A1'].value==42
r=Presentation();r.slides.add_slide(r.slide_layouts[6]);r.save(p/'核对演示.pptx');assert len(Presentation(p/'核对演示.pptx').slides)==1
print('verified: three Office formats')`
  assert.match(execFileSync(python, ['-c', code], { encoding: 'utf8' }), /verified/)
  const catalog = await f.ctx.blueprintExecutionFeatures.officeCatalog()
  assert.deepEqual(catalog.map(row => row.name).sort(), ['office-docx', 'office-pptx', 'office-xlsx'])
})

test('只有打包无头浏览器、没有旧 manifest 的资源仍可用', async t => {
  const resourceRoot = await mkdtemp(join(项目路径, '无头资源核对-'))
  t.after(() => rm(resourceRoot, { recursive: true, force: true }))
  const executable = join(resourceRoot, 'browser/chromium_headless_shell-1/mac/chrome-headless-shell')
  await mkdir(join(executable, '..'), { recursive: true })
  await writeFile(executable, 'readiness fixture')
  const f = await fixture(t, { browser: false, workflow: false, office: false }, resourceRoot)
  assert.equal((await f.ctx.blueprintExecutionFeatures.readiness()).browser, true)
  assert.equal(f.ctx.blueprintExecutionFeatures.config.browserExecutable, executable)
})

test('官方浏览器 MCP 实际进程继承项目边界，点击输入可用且释放全部资源', async t => {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<input aria-label="数字"><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">核对</button><output></output>') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  let managementCalls = 0
  const management = createServer((req, res) => { if (req.url !== '/health') managementCalls++; res.end('management is listening') })
  await new Promise(resolve => management.listen(0, '::', resolve))
  t.after(() => new Promise(resolve => management.close(resolve)))
  const port = management.address().port
  for (const hostname of ['127.0.0.1', '[::1]']) {
    const health = await fetch(`http://${hostname}:${port}/health`)
    assert.equal(health.status, 200)
    assert.equal(await health.text(), 'management is listening')
  }
  const f = await fixture(t, { browser: true, workflow: false, office: false }, resources, { webServer: { port } })
  const snapshotOf = async request => {
    const links = request.messages.flatMap(message => (message.content || []).flatMap(block =>
      [...(block.text || '').matchAll(/\[Snapshot\]\(([^)]+)\)/g)].map(match => match[1])))
    assert.ok(links.length, '浏览器应返回真实快照文件')
    const path = await realpath(resolve(f.root, links.at(-1)))
    assert.ok(relative(await realpath(f.root), path).startsWith('.blueprint-tmp/browser/'), '快照必须位于本项目的浏览器产物目录')
    return readFile(path, 'utf8')
  }
  f.respond(async (request, step) => {
    if (step === 1) return call('browser-page', 'mcp__playwright-mcp__browser_navigate', { url: `http://127.0.0.1:${server.address().port}` })
    if (step === 2) {
      const snapshot = await snapshotOf(request)
      const reference = snapshot.match(/textbox .*?\[ref=(e\d+)\]/)?.[1]
      assert.ok(reference, snapshot)
      return call('browser-input', 'mcp__playwright-mcp__browser_type', { target: reference, text: '42', element: '数字输入' })
    }
    if (step === 3) {
      const reference = (await snapshotOf(request)).match(/button .*?\[ref=(e\d+)\]/)?.[1]
      assert.ok(reference)
      return call('browser-click', 'mcp__playwright-mcp__browser_click', { target: reference, element: '核对按钮' })
    }
    if (step === 4) return call('browser-value', 'mcp__playwright-mcp__browser_evaluate', { function: '() => document.querySelector("output").textContent' })
    if (step === 5) return call('browser-management-v4', 'mcp__playwright-mcp__browser_navigate', { url: `http://127.0.0.1:${port}` })
    if (step === 6) return call('browser-management-v6', 'mcp__playwright-mcp__browser_navigate', { url: `http://[::1]:${port}` })
  })
  const result = await f.run()
  assert.equal(result.length, 6, JSON.stringify(result))
  assert.ok(result.slice(0, 4).every(row => !row.isError), JSON.stringify(result))
  assert.match(JSON.stringify(result[3]), /42/)
  assert.ok(result.slice(4).every(row => row.isError), '浏览器不能访问宿主管理端口')
  assert.equal(managementCalls, 0)

  // 对真实 MCP、浏览器、渲染器与网络进程查询内核策略；不以页面的 file:// 限制替代 OS 隔离。
  const processes = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,command='], { encoding: 'utf8' })
    .trim().split('\n').map(line => {
      const row = line.trim().split(/\s+/)
      return { pid: Number(row[0]), ppid: Number(row[1]), started: row.slice(2, 7).join(' '), command: row.slice(7).join(' ') }
    })
  const live = processes()
  const mcp = live.filter(row => row.ppid === process.pid && row.command.includes(`--output-dir ${join(f.root, '.blueprint-tmp/browser', String(f.parent.id))}`))
  assert.equal(mcp.length, 1, '须定位本项目唯一的真实 MCP 进程')
  const pids = new Set([mcp[0].pid])
  for (let previous = 0; previous !== pids.size;) {
    previous = pids.size
    for (const row of live) if (pids.has(row.ppid)) pids.add(row.pid)
  }
  const owned = live.filter(row => pids.has(row.pid))
  assert.ok(owned.filter(row => row.command.includes('chrome-headless-shell')).length >= 2, '必须包含实际浏览器及子进程')
  // 只提取本次子进程的 socket 路径，不输出其环境。
  const environment = execFileSync('/bin/ps', ['eww', '-p', String(mcp[0].pid), '-o', 'command='], { encoding: 'utf8' })
  const sockets = environment.match(/(?:^| )PWTEST_SOCKETS_DIR=(\/private\/tmp\/Blueprint-browser-[^ ]+)/)?.[1]
  assert.ok(sockets)
  await realpath(sockets)
  const neighbor = await mkdtemp(join(项目路径, '浏览器邻居-'))
  const host = await mkdtemp(join(数据根, '浏览器宿主-'))
  t.after(async () => { await rm(neighbor, { recursive: true, force: true }); await rm(host, { recursive: true, force: true }) })
  const own = join(f.root, '允许读写.txt'), other = join(neighbor, '禁止读写.txt'), ledger = join(host, '禁止读写.txt')
  for (const path of [own, other, ledger]) await writeFile(path, 'synthetic boundary fixture')
  const cases = [
    ['file-read-data', own, 0], ['file-write-data', own, 0],
    ['file-read-data', other, 1], ['file-write-data', other, 1],
    ['file-read-data', ledger, 1], ['file-write-data', ledger, 1],
    ['file-write-data', await realpath(join(f.root, '系统文档/任务.db')), 1],
    ['file-read-data', await realpath(join(homedir(), 'Downloads')), 1],
  ]
  const python = join(resources, 'primary-runtime/dependencies/python/bin/python3')
  const audit = `import ctypes,json,os,sys
lib=ctypes.CDLL('/usr/lib/libsandbox.dylib',use_errno=True)
check=lib.sandbox_check;check.restype=ctypes.c_int;check.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int]
flag=1|ctypes.c_int.in_dll(lib,'SANDBOX_CHECK_NO_REPORT').value
pids,cases=json.loads(sys.argv[1])
assert check(os.getpid(),None,0)==0,'audit host must be unsandboxed'
for pid in pids:
 assert check(pid,None,0)>0,('sandbox missing',pid)
 for op,path,expected in cases:
  result=check(pid,op.encode(),flag,ctypes.c_char_p(os.fsencode(path)))
  assert result>=0 and bool(result)==bool(expected),(pid,op,path,result,expected)
print('verified actual process policies')`
  assert.match(execFileSync(python, ['-c', audit, JSON.stringify([[...pids], cases])], { encoding: 'utf8' }), /verified/)
  const afterAudit = processes()
  assert.ok(owned.every(row => afterAudit.some(current => current.pid === row.pid && current.started === row.started && current.command === row.command)), '核验期间进程身份保持不变')
  await f.ctx.blueprintExecutionFeatures.releaseResources([f.parent])
  assert.equal(f.ctx.blueprintExecutionFeatures.activations.get(f.parent).options.browser, false)
  const remains = () => { const now = processes(); return owned.some(row => now.some(current => current.pid === row.pid && current.started === row.started)) }
  for (const deadline = Date.now() + 5000; remains() && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(remains(), false, '释放能力后 MCP 及浏览器进程均须退出：' + JSON.stringify(processes().filter(row => pids.has(row.pid)).map(row => ({ pid: row.pid, ppid: row.ppid, program: row.command.split(' ')[0] }))))
  await assert.rejects(realpath(sockets), { code: 'ENOENT' })
})
