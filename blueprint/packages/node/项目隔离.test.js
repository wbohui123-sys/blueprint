import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, realpathSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { createServer as createSocketServer } from 'node:net'
import { once } from 'node:events'
import { get as httpGet } from 'node:http'
import { 装项目隔离, 隔离命令, 系统临时目录, 系统缓存目录, 离开工具执行, 文件许可, 会话附件文件, 在项目终端执行域, 工具执行目录, 用户私人位置 } from './src/项目隔离.js'
import { Context } from '@deepseek-ai/cordis'
import LocalFS from '@deepseek-ai/dsh-fs-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { 数据根 } from '../prompt/src/路径.js'

const repo = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)))
mkdirSync(join(数据根, '项目'), { recursive: true })
const projects = realpathSync(join(数据根, '项目'))

test('会话附件只接受收到的原件与同项目父链，普通文件工具只读，不能猜其他附件或访问其目录', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'Blueprint 节点附件只读-')))
  try {
    const own = join(base, '本项目'), other = join(base, '其他项目'), store = join(base, '宿主附件')
    mkdirSync(own); mkdirSync(other); mkdirSync(store)
    const paths = ['当前附件', '父节点附件', '其他项目附件', '未收到的附件'].map(name => join(store, name + '.txt'))
    for (const path of paths) writeFileSync(path, '参考材料')
    const block = path => ({type:'file',attachment:{attachmentId:path}})
    const parent = {id:'parent',header:{cwd:own,parentSession:'foreign'},deriveMessages:()=>[{role:'user',content:[block(paths[1])]}]}
    const foreign = {id:'foreign',header:{cwd:other},deriveMessages:()=>[{role:'user',content:[block(paths[2])]}]}
    const session = {id:'current',header:{cwd:own,parentSession:'parent'},deriveMessages:()=>[{role:'user',content:[block(paths[0])]}],
      ownEvents:()=>[{type:'user/message',data:{content:[block(paths[0])]}}]}
    const ctx = {get:()=>({fileHostPath:ref=>ref.attachmentId}),sessions:{get:id=>({parent,foreign})[id]}}
    const files = 会话附件文件(ctx,session)
    assert.deepEqual(files, paths.slice(0,2))
    const scope = {根:own,技能:own,附件文件:files}
    for (const path of paths.slice(0,2)) {
      assert.equal(文件许可(scope,path),path)
      assert.throws(()=>文件许可(scope,path,true),/PROJECT_ISOLATION/)
    }
    for (const path of [store,...paths.slice(2)]) assert.throws(()=>文件许可(scope,path),/PROJECT_ISOLATION/)
  } finally { rmSync(base,{recursive:true,force:true}) }
})

test('真实内核：收到的附件可读和复制到项目，宿主附件目录、其他附件与原件写入仍拒绝', () => {
  const base = mkdtempSync(join(projects, '.attachment-isolation-'))
  try {
    const own = join(base, '本项目'), store = join(base, '宿主附件')
    mkdirSync(own); mkdirSync(store)
    const file = join(store,'收到的参考.txt'), unknown = join(store,'未收到的参考.txt')
    writeFileSync(file,'收到的内容'); writeFileSync(unknown,'其他内容')
    const scope = {根:own,仓库:base,技能:own,附件文件:[file]}
    const run = argv => { const spec = 隔离命令({argv,cwd:own},scope); return spawnSync(spec.argv[0],spec.argv.slice(1),{cwd:own,env:{...process.env,...spec.env},encoding:'utf8'}) }
    assert.equal(run(['/bin/cat',file]).stdout,'收到的内容')
    assert.equal(run(['/bin/cp',file,join(own,'参考副本.txt')]).status,0)
    assert.equal(readFileSync(join(own,'参考副本.txt'),'utf8'),'收到的内容')
    assert.notEqual(run(['/bin/cat',unknown]).status,0)
    assert.notEqual(run(['/bin/ls',store]).status,0)
    assert.notEqual(run(['/bin/rm',file]).status,0)
    assert.notEqual(run(['/bin/cp',join(own,'参考副本.txt'),file]).status,0)
    assert.equal(readFileSync(file,'utf8'),'收到的内容')
  } finally { rmSync(base,{recursive:true,force:true}) }
})

test('真实内核：项目可读写；邻居、父目录、账本和软链接不可读，已有沙箱不能绕过', () => {
  const base = mkdtempSync(join(projects, '.isolation-test-'))
  const own = join(base, 'own'), other = join(base, 'other')
  const skills = join(base, 'skills')
  mkdirSync(own); mkdirSync(other); mkdirSync(skills)
  writeFileSync(join(own, 'ok'), 'own')
  writeFileSync(join(other, 'secret'), 'OTHER_PROJECT_SECRET')
  symlinkSync(other, join(own, 'escape'))
  writeFileSync(join(own, 'entry.mjs'), 'import fs from "node:fs"; fs.realpathSync(import.meta.filename); console.log("node-mjs-ok")')
  writeFileSync(join(own, 'entry.cjs'), 'console.log("node-cjs-ok")')
  writeFileSync(join(skills, 'shared.mjs'), 'console.log("shared-skill-ok")')
  const scope = { 根: own, 仓库: base, 技能: skills }
  const run = (argv) => {
    const spec = 隔离命令({ argv, cwd: own }, scope)
    return spawnSync(spec.argv[0], spec.argv.slice(1), { cwd: own, env: { ...process.env, ...spec.env }, encoding: 'utf8' })
  }
  try {
    assert.equal(run(['/bin/cat', join(own, 'ok')]).stdout, 'own')
    for (const [file, expected] of [[join(own, 'entry.mjs'), 'node-mjs-ok'], [join(own, 'entry.cjs'), 'node-cjs-ok'], [join(skills, 'shared.mjs'), 'shared-skill-ok']]) {
      const r = run([process.execPath, file])
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout.trim(), expected)
    }
    assert.equal(run(['/bin/sh', '-c', 'echo changed > ok']).status, 0)
    for (const path of [join(other, 'secret'), join(own, 'escape/secret')]) {
      const r = run(['/bin/cat', path])
      assert.notEqual(r.status, 0, r.stderr)
      assert.ok(!r.stdout.includes('OTHER_PROJECT_SECRET'))
    }
    assert.notEqual(run(['/bin/ls', base]).status, 0)
    assert.notEqual(run(['/bin/sh', '-c', 'echo changed > ../other/secret']).status, 0)
    const nested = run(['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)', '/bin/cat', join(other, 'secret')])
    assert.notEqual(nested.status, 0)
    assert.equal(readFileSync(join(other, 'secret'), 'utf8'), 'OTHER_PROJECT_SECRET')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('真实内核：用户的个人文件夹不能列目录和读内容，项目在里面照常读写，用户终端不受这层限制', () => {
  const base = mkdtempSync(join(projects, '.private-folders-'))
  try {
    const home = join(base, 'home'), desktop = join(home, 'Desktop'), documents = join(home, 'Documents')
    const own = join(documents, 'Blueprint/项目/own'), skills = join(base, 'skills')
    for (const dir of [desktop, own, skills]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(desktop, '照片.txt'), 'PRIVATE')
    writeFileSync(join(documents, '合同.txt'), 'PRIVATE')
    writeFileSync(join(own, 'ok'), 'own')
    const scope = { 根: own, 仓库: join(base, 'ledger'), 技能: skills, 私人位置: [desktop, documents] }
    const run = (argv, extra = {}) => {
      const spec = 隔离命令({ argv, cwd: own }, { ...scope, ...extra })
      return spawnSync(spec.argv[0], spec.argv.slice(1), { cwd: own, env: { ...process.env, ...spec.env }, encoding: 'utf8' })
    }
    for (const argv of [['/bin/ls', desktop], ['/bin/ls', documents], ['/bin/cat', join(desktop, '照片.txt')], ['/bin/cat', join(documents, '合同.txt')]]) {
      const r = run(argv)
      assert.notEqual(r.status, 0, argv.join(' '))
      assert.ok(!r.stdout.includes('PRIVATE') && !r.stdout.includes('照片'))
    }
    // 整盘搜索碰到个人文件夹只报无权限，不会进去。
    const found = run(['/usr/bin/find', home, '-name', '*.txt'])
    assert.ok(!found.stdout.includes('照片.txt') && !found.stdout.includes('合同.txt'), found.stdout)
    // 文件夹本身看得见；项目在文稿里照常读写。
    assert.equal(run(['/bin/test', '-d', desktop]).status, 0)
    assert.equal(run(['/bin/cat', join(own, 'ok')]).stdout, 'own')
    assert.equal(run(['/bin/sh', '-c', 'echo changed > ok && cat ok']).stdout.trim(), 'changed')
    assert.equal(run(['/bin/cat', join(desktop, '照片.txt')], { 用户终端: true }).stdout, 'PRIVATE')
    // 原生 MCP 自己管理进程；原样启动不能顺带取得用户终端的私人目录权限。
    const native = 隔离命令({ argv: ['/bin/true'], cwd: own, env: { NODE_OPTIONS: '--trace-warnings', BROWSER: 'open' } },
      { ...scope, 原生命令: true })
    assert.equal(native.env.NODE_OPTIONS, '--trace-warnings')
    assert.equal(native.env.BROWSER, 'open')
    assert.equal(native.env.BLUEPRINT_BACKGROUND_TOOLS, undefined)
    assert.equal(run(['/bin/cat', join(own, 'ok')], { 原生命令: true }).stdout.trim(), 'changed')
    for (const path of [desktop, join(desktop, '照片.txt'), join(documents, '合同.txt')]) {
      assert.notEqual(run(['/bin/cat', path], { 原生命令: true }).status, 0, path)
    }
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('个人文件夹默认清单覆盖会触发 macOS 权限框的位置，只用字面路径', () => {
  const home = homedir()
  const 位置 = 用户私人位置()
  for (const name of ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Movies', 'Library/Containers', 'Library/Group Containers', 'Library/Mobile Documents', 'Library/CloudStorage']) {
    assert.ok(位置.includes(join(home, name)), name)
  }
  assert.ok(位置.includes('/Volumes'))
  assert.equal(用户私人位置('/Users/someone')[0], '/Users/someone/Desktop')
})

test('子进程临时目录在各自项目、缓存全机共用，不继承本机代理；环境不修改宿主', () => {
  const root = mkdtempSync(join(projects, '.isolation-env-')), other = mkdtempSync(join(projects, '.isolation-env-'))
  try {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:7897', PATH: process.env.PATH, UV_CACHE_DIR: '/old/cache', UV_PYTHON_INSTALL_DIR: '/old/python' }
    const spec = 隔离命令({ argv: ['/bin/true'], cwd: root, env }, { 根: root, 仓库: repo, 技能: join(repo, 'blueprint/packages/prompt/skill') })
    assert.equal(spec.env.HTTPS_PROXY, '')
    assert.equal(spec.env.http_proxy, '')
    assert.equal(spec.env.BLUEPRINT_PROJECT_ROOT, root)
    assert.equal(spec.env.TMPDIR, join(root, '.blueprint-tmp'))
    // 产 5（10-23）：公共工具夹建好、命令里叫 $BLUEPRINT_TOOLS。
    assert.equal(spec.env.BLUEPRINT_TOOLS, join(root, '.blueprint-tmp/公共工具'))
    assert.ok(existsSync(spec.env.BLUEPRINT_TOOLS))
    // 10-27：下载、安装缓存用各工具在用户缓存里的标准位置，两个项目拿到同一份，不再各下一遍。
    const 点缓存 = realpathSync(join(homedir(), '.cache')), 库缓存 = realpathSync(join(homedir(), 'Library/Caches'))
    const 缓存 = { UV_CACHE_DIR: join(点缓存, 'uv'), UV_PYTHON_INSTALL_DIR: join(点缓存, 'blueprint/python'), MPLCONFIGDIR: join(点缓存, 'blueprint/matplotlib'),
      PIP_CACHE_DIR: join(库缓存, 'pip'), HF_HOME: join(点缓存, 'huggingface'), XDG_CACHE_HOME: 点缓存, npm_config_cache: join(点缓存, 'blueprint/npm') }
    const 另一个 = 隔离命令({ argv: ['/bin/true'], cwd: other, env }, { 根: other, 仓库: repo, 技能: join(repo, 'blueprint/packages/prompt/skill') })
    for (const [key, value] of Object.entries(缓存)) {
      assert.equal(spec.env[key], value, key)
      assert.equal(另一个.env[key], value, key)
    }
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7897')
    assert.equal(env.UV_CACHE_DIR, '/old/cache')
    assert.equal(env.UV_PYTHON_INSTALL_DIR, '/old/python')
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }) }
})

test('管理端口逐次取原生服务事实，未就绪拒绝工具启动，调用环境不能扩大网络权限', async () => {
  const root = mkdtempSync(join(projects, '管理端口核对-'))
  const specs = [], service = { port: undefined }
  const subprocess = { spawn: spec => { specs.push(spec); return spec } }
  let dispatch, toolStarted = 0
  装项目隔离({ get: name => ({ fs: {}, subprocess, webServer: service }[name]), on: (_, fn) => { dispatch = fn } })
  const exec = { name: 'bash', agent: { session: { header: { cwd: root } } } }
  const next = () => { toolStarted++; return subprocess.spawn({ argv: ['/bin/true'], env: { TOOL_ENV: 'retained', 管理端口: '1', HTTPS_PROXY: 'http://127.0.0.1:7897' } }) }
  try {
    for (const port of [undefined, 0, -1, 65536, '3090', NaN]) {
      service.port = port
      await assert.rejects(dispatch(exec, next), /宿主管理服务尚未就绪/)
    }
    assert.equal(toolStarted, 0)
    assert.equal(specs.length, 0)
    for (const port of [23456, 34567]) {
      service.port = port
      const spec = await dispatch(exec, next)
      assert.ok(spec.argv[2].includes(`(remote ip "localhost:${port}")`))
      assert.ok(!spec.argv[2].includes('localhost:*'))
      assert.equal(spec.env.TOOL_ENV, 'retained')
      assert.equal(spec.env.HTTPS_PROXY, '')
    }
    assert.ok(!specs[1].argv[2].includes('localhost:23456'), '不缓存上一轮的实际端口')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('用户终端 API 绑定项目与原生当前目录，保留交互环境，不进入模型预测并传播取消', async () => {
  const root = realpathSync(mkdtempSync(join(projects, '用户终端边界核对-')))
  const cwd = join(root, '交互工作目录')
  mkdirSync(cwd)
  const subprocess = { spawnTerminal: async spec => spec }, webServer = { port: 23456 }
  let ensureSignal, predictions = 0
  const ctx = { get: name => ({ fs: {}, subprocess, webServer, workingDirectory: { ensure: async (_agent, signal) => { ensureSignal = signal; return cwd } } }[name]), on() {} }
  装项目隔离(ctx, { 检查预测: () => { predictions++; throw new Error('用户终端不进入此模型入口') } })
  const agent = { session: { header: { cwd: root } } }, signal = new AbortController().signal
  try {
    const spec = await 在项目终端执行域(ctx, agent, () => {
      assert.equal(工具执行目录(), cwd)
      return subprocess.spawnTerminal({ argv: ['/bin/zsh'], cwd, env: { TERM: 'xterm-256color', NODE_OPTIONS: '--trace-warnings', BROWSER: 'open' } })
    }, signal)
    assert.equal(ensureSignal, signal)
    assert.equal(predictions, 0)
    assert.equal(spec.cwd, cwd)
    assert.equal(spec.argv[3], '/bin/zsh')
    assert.ok(spec.argv[2].includes('localhost:23456'))
    assert.equal(spec.env.TERM, 'xterm-256color')
    assert.equal(spec.env.NODE_OPTIONS, '--trace-warnings')
    assert.equal(spec.env.BROWSER, 'open')
    assert.equal(spec.env.BLUEPRINT_BACKGROUND_TOOLS, undefined)
    assert.equal(工具执行目录(), undefined)
    const abort = new AbortController(); abort.abort(new Error('取消创建'))
    await assert.rejects(在项目终端执行域(ctx, agent, () => assert.fail('取消后不分配 PTY'), abort.signal), /取消创建/)
    webServer.port = undefined
    await assert.rejects(在项目终端执行域(ctx, agent, () => assert.fail('未就绪不分配 PTY')), /宿主管理服务尚未就绪/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

const 网络核对子进程 = String.raw`
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const { once } = require('node:events')
const { createHash } = require('node:crypto')
const config = JSON.parse(process.argv[2])
const get = options => new Promise((resolve, reject) => {
  const request = http.get({ ...options, agent: false }, response => {
    let text = ''; response.setEncoding('utf8'); response.on('data', chunk => text += chunk)
    response.on('end', () => resolve(text)); response.on('error', reject)
  })
  request.setTimeout(2000, () => request.destroy(new Error('HTTP_TIMEOUT')))
  request.on('error', reject)
})
const connect = path => new Promise((resolve, reject) => {
  const socket = net.createConnection(path)
  let text = ''; socket.setEncoding('utf8'); socket.on('data', chunk => text += chunk)
  socket.on('end', () => resolve(text)); socket.on('error', reject)
  socket.setTimeout(2000, () => socket.destroy(new Error('SOCKET_TIMEOUT')))
})
const deny = async action => {
  try { await action(); throw new Error('NETWORK_BOUNDARY_BYPASSED') }
  catch (error) { assert.equal(error.code, 'EPERM', error.stack); return error.code }
}
async function main() {
  const result = {}, sockets = new Set()
  const server = http.createServer((request, response) => response.end('PROJECT_HTTP_OK'))
  server.on('upgrade', (request, socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    const message = Buffer.from('PROJECT_WS_OK')
    socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]))
  })
  const socketServer = net.createServer(socket => socket.end('PROJECT_SOCKET_OK'))
  try {
    server.listen(0, config.host); await once(server, 'listening')
    socketServer.listen(config.ownSocket); await once(socketServer, 'listening')
    result.http = await get({ host: config.host, port: server.address().port, path: '/' })
    result.websocket = await new Promise((resolve, reject) => {
      const host = net.isIP(config.host) === 6 ? '[' + config.host + ']' : config.host
      const websocket = new WebSocket('ws://' + host + ':' + server.address().port + '/')
      const timeout = setTimeout(() => { websocket.close(); reject(new Error('WEBSOCKET_TIMEOUT')) }, 2000)
      websocket.addEventListener('message', event => { clearTimeout(timeout); resolve(event.data); websocket.close() }, { once: true })
      websocket.addEventListener('error', event => { clearTimeout(timeout); reject(event.error || new Error('WEBSOCKET_FAILED')) }, { once: true })
    })
    result.ownSocket = await connect(config.ownSocket)
    result.management = await deny(() => get({ host: config.host, port: config.managementPort, path: '/management-fixture' }))
    result.neighborSocket = await deny(() => connect(config.neighborSocket))
    result.socketSymlink = await deny(() => connect(config.socketSymlink))
    console.log(JSON.stringify(result))
  } finally {
    for (const socket of sockets) socket.destroy()
    server.closeAllConnections()
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => socketServer.close(resolve))])
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
`

for (const hostAddress of ['127.0.0.1', '::1']) test(`真实原生服务 ${hostAddress}：项目 HTTP、WebSocket、Unix socket 可用；实际管理端口与邻居 socket 拒绝`, async t => {
  const root = realpathSync(mkdtempSync(join(projects, '网络-')))
  const neighbor = realpathSync(mkdtempSync(join(projects, '邻网-')))
  const host = new Context(), processes = []
  const ownSocket = join(root, 'ipc.sock'), neighborSocket = join(neighbor, 'ipc.sock'), socketSymlink = join(root, '旁门.sock')
  assert.ok(Buffer.byteLength(ownSocket) < 104, '本机 Unix socket 使用短真实路径')
  let dispatch, managementCalls = 0, neighborCalls = 0
  const neighborServer = createSocketServer(socket => { neighborCalls++; socket.end('NEIGHBOR_SOCKET_RESPONSE') })
  t.after(async () => {
    try {
      for (const proc of processes) { proc.terminate(); await Promise.all([proc.done, proc.waitForExit()]) }
    } finally {
      try { await host.fiber.dispose() }
      finally {
        try { await new Promise(resolve => neighborServer.close(resolve)) }
        finally { rmSync(root, { recursive: true, force: true }); rmSync(neighbor, { recursive: true, force: true }) }
      }
    }
  })
  neighborServer.listen(neighborSocket); await once(neighborServer, 'listening')
  symlinkSync(neighborSocket, socketSymlink)
  await host.plugin(LocalFS, { diffBasisMaxBytes: 1000000 })
  await host.plugin(Subprocess)
  await host.plugin(WebServer, { host: hostAddress, port: 0 })
  const webServer = host.get('webServer')
  assert.ok(webServer.port > 0, '原生 webServer 返回 OS 分配的实际端口')
  webServer.register({ kind: 'exact', path: '/management-fixture', handler: (_, response) => { managementCalls++; response.end('HOST_MANAGEMENT_RESPONSE') } })
  const managementResponse = await new Promise((resolve, reject) => {
    const request = httpGet({ host: hostAddress, port: webServer.port, path: '/management-fixture', agent: false }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => text += chunk); response.on('end', () => resolve(text)); response.on('error', reject)
    })
    request.on('error', reject)
  })
  assert.equal(managementResponse, 'HOST_MANAGEMENT_RESPONSE', '管理端口确实在监听，拒绝不是连接不存在')
  managementCalls = 0
  writeFileSync(join(root, '网络核对.cjs'), 网络核对子进程)
  装项目隔离({ get: name => host.get(name), on: (_, fn) => { dispatch = fn } })
  const result = await dispatch({ name: 'bash', agent: { session: { header: { cwd: root } } } }, async () => {
    const proc = host.subprocess.spawn({ argv: [process.execPath, join(root, '网络核对.cjs'), JSON.stringify({ host: hostAddress, managementPort: webServer.port, ownSocket, neighborSocket, socketSymlink })],
      stdio: { stdin: 'ignore', stdout: { maxBytes: 10000 }, stderr: { maxBytes: 10000 } }, graceMs: 100, signal: AbortSignal.timeout(10000) })
    processes.push(proc)
    const completion = await proc.done
    assert.equal(completion.exitCode, 0, proc.collected.stderr.readFrom(0).text)
    return JSON.parse(proc.collected.stdout.readFrom(0).text)
  })
  assert.deepEqual(result, { http: 'PROJECT_HTTP_OK', websocket: 'PROJECT_WS_OK', ownSocket: 'PROJECT_SOCKET_OK', management: 'EPERM', neighborSocket: 'EPERM', socketSymlink: 'EPERM' })
  assert.equal(managementCalls, 0)
  assert.equal(neighborCalls, 0)
})

test('已安装的 uv 在真实项目隔离内可离线启动 Python，无需写用户缓存', t => {
  const uv = [join(homedir(), '.local/bin/uv'), '/opt/homebrew/bin/uv', '/usr/local/bin/uv'].find(existsSync)
  if (!uv || !existsSync('/usr/bin/python3')) return t.skip('未安装 uv 或系统 Python')
  const root = mkdtempSync(join(projects, '.uv 中文 空格-'))
  try {
    const spec = 隔离命令({ argv: [uv, 'run', '--offline', '--no-project', '--python', '/usr/bin/python3', '--no-python-downloads', 'python', '-c', 'print("uv-ok")'] }, { 根: root, 仓库: repo, 技能: join(repo, 'blueprint/packages/prompt/skill') })
    const result = spawnSync(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env }, encoding: 'utf8', timeout: 20000 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'uv-ok')
    assert.ok(existsSync(spec.env.UV_CACHE_DIR))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('工具执行域：并行项目互不混淆，子调用继承；宿主仍可读，两种文件路径都受限', async () => {
  const a = mkdtempSync(join(projects, '.isolation-a-'))
  const b = mkdtempSync(join(projects, '.isolation-b-'))
  writeFileSync(join(a, 'text'), 'a'); writeFileSync(join(b, 'text'), 'b')
  symlinkSync(b, join(a, 'escape'))
  const fs = {
    resolve: async (p, opts) => realpathSync(resolve(opts?.cwd || a, p)),
    processPath: p => p,
    readText: async p => readFileSync(p, 'utf8'),
  }
  let dispatch
  装项目隔离({ get: n => ({ fs, subprocess: {} }[n]), on: (_, fn) => { dispatch = fn } })
  const exec = cwd => ({ name: 'read', agent: { session: { header: { cwd } } } })
  try {
    const values = await Promise.all([a, b].map(cwd => dispatch(exec(cwd), async () => {
      await new Promise(r => setImmediate(r))
      assert.throws(() => fs.readText(join(cwd === a ? b : a, 'text')), /PROJECT_ISOLATION/)
      return fs.readText(await fs.resolve('text'))
    })))
    assert.deepEqual(values, ['a', 'b'])
    await assert.rejects(dispatch(exec(a), () => fs.resolve('escape/text', { cwd: a })), /PROJECT_ISOLATION/)
    assert.equal(await fs.readText(join(b, 'text')), 'b')
    assert.equal(await fs.resolve('text'), join(a, 'text'), '宿主解析保留原始默认目录')
    await assert.rejects(dispatch({ name: 'read' }, () => {}), /PROJECT_ISOLATION/)
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }) }
})

test('工具执行里开出或叫醒的节点离开执行域：它的宿主钩子（列技能往上找 .git）不再被当成工具调用拦下', async () => {
  const a = mkdtempSync(join(projects, '.isolation-leave-'))
  writeFileSync(join(a, 'text'), 'a')
  const fs = { processPath: p => p, readText: async p => readFileSync(p, 'utf8') }
  let dispatch
  装项目隔离({ get: n => ({ fs, subprocess: {} }[n]), on: (_, fn) => { dispatch = fn } })
  const 宿主路径 = fileURLToPath(new URL('./package.json', import.meta.url))
  try {
    await dispatch({ name: 'spawn', agent: { session: { header: { cwd: a } } } }, async () => {
      assert.throws(() => fs.readText(宿主路径), /PROJECT_ISOLATION/, '工具自己仍受边界')
      // 模拟 spawn 里开出的子节点：它的循环稍后才跑，宿主钩子读项目外的东西。
      const 子循环 = 离开工具执行(async () => { await new Promise(r => setImmediate(r)); return fs.readText(宿主路径) })
      assert.match(await 子循环, /"name"/)
    })
  } finally { rmSync(a, { recursive: true, force: true }) }
})

test('技能目录是宿主的事：工具执行域里（比如 do 那一轮）列技能、读页不被拦，模型自己的读取照样受边界', async () => {
  const a = mkdtempSync(join(projects, '.isolation-skills-'))
  const fs = { processPath: p => p, readText: async p => readFileSync(p, 'utf8') }
  const 宿主路径 = fileURLToPath(new URL('./package.json', import.meta.url))
  // 假的技能注册表：像 dsh 那样，列技能时去读项目外的东西（往上找 .git、用户 skill 目录）。
  const skills = { async list() { return [JSON.parse(await fs.readText(宿主路径)).name] }, async get() { return fs.readText(宿主路径) }, async snapshot() { return { skills: await this.list(), complete: true } } }
  let dispatch
  装项目隔离({ get: n => ({ fs, subprocess: {}, skills }[n]), on: (_, fn) => { dispatch = fn } })
  try {
    await dispatch({ name: 'skill', agent: { session: { header: { cwd: a } } } }, async () => {
      assert.throws(() => fs.readText(宿主路径), /PROJECT_ISOLATION/, '模型自己的读取仍受边界')
      assert.deepEqual(await skills.list(), ['@blueprint/node'])
      assert.match(await skills.get('intent'), /"name"/)
      assert.equal((await skills.snapshot()).complete, true)
    })
  } finally { rmSync(a, { recursive: true, force: true }) }
})

test('真实 dsh 服务：读取、搜索进程、shell 与子 shell 均受边界约束', async () => {
  const a = mkdtempSync(join(projects, '.isolation-live-a-'))
  const b = mkdtempSync(join(projects, '.isolation-live-b-'))
  writeFileSync(join(a, 'text'), 'own'); writeFileSync(join(b, 'text'), 'private')
  mkdirSync(join(a, 'demo 中文 空格'))
  const host = new Context()
  const fsFiber = await host.plugin(LocalFS, { diffBasisMaxBytes: 1000000 })
  const processFiber = await host.plugin(Subprocess)
  let dispatch
  装项目隔离({ get: n => host.get(n), on: (_, fn) => { dispatch = fn } })
  const exec = { name: 'read', agent: { session: { header: { cwd: a } } } }
  try {
    await dispatch(exec, async () => {
      const target = await host.fs.resolve('text')
      assert.equal(await host.fs.readText(target), 'own')
      assert.equal((await host.fs.lstat('text')).type, 'file')
      await assert.rejects(host.fs.resolve(join(b, 'text')), /PROJECT_ISOLATION/)
      const run = async argv => {
        const proc = host.subprocess.spawn({ argv, cwd: a, stdio: { stdin: 'ignore', stdout: { maxBytes: 1000 }, stderr: { maxBytes: 1000 } }, graceMs: 100 })
        return (await proc.done).exitCode
      }
      assert.equal(await run(['/bin/cat', join(a, 'text')]), 0)
      assert.notEqual(await run(['/usr/bin/grep', 'private', join(b, 'text')]), 0)
      assert.notEqual(await run(['/bin/sh', '-c', '/bin/cat "$1"', 'sh', join(b, 'text')]), 0)
      for (const [cwd, expected] of [[undefined, a], ['demo 中文 空格', join(a, 'demo 中文 空格')], [undefined, a]]) {
        const proc = host.subprocess.spawn({ argv: ['/bin/pwd'], ...(cwd ? { cwd } : {}), stdio: { stdin: 'ignore', stdout: { maxBytes: 1000 }, stderr: { maxBytes: 1000 } }, graceMs: 100 })
        const result = await proc.done
        assert.equal(result.exitCode, 0)
        assert.equal(proc.collected.stdout.readFrom(0).text.trim(), expected)
      }
    })
  } finally {
    await processFiber.dispose(); await fsFiber.dispose()
    rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true })
  }
})


test('原生系统临时目录可写，临时软链接不能写入其他项目或宿主目录', () => {
  const base = mkdtempSync(join(projects, '.isolation-native-temp-'))
  const native = mkdtempSync(join(系统临时目录(), 'blueprint-export-test-'))
  const own = join(base, 'own'), other = join(base, 'other')
  mkdirSync(own); mkdirSync(other)
  writeFileSync(join(other, 'protected'), 'unchanged')
  symlinkSync(other, join(native, 'escape'))
  const scope = { 根: own, 仓库: base, 技能: join(repo, 'blueprint/packages/prompt/skill') }
  const run = path => {
    const spec = 隔离命令({ argv: ['/bin/sh', '-c', 'printf test > "$1"', 'sh', path], cwd: own }, scope)
    return spawnSync(spec.argv[0], spec.argv.slice(1), { cwd: own, env: { ...process.env, ...spec.env }, encoding: 'utf8' })
  }
  try {
    assert.equal(run(join(native, 'project.binary')).status, 0)
    assert.equal(readFileSync(join(native, 'project.binary'), 'utf8'), 'test')
    assert.notEqual(run(join(native, 'escape/protected')).status, 0)
    assert.notEqual(run(join(base, 'outside')).status, 0)
    assert.equal(readFileSync(join(other, 'protected'), 'utf8'), 'unchanged')
  } finally {
    rmSync(native, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('项目位于原生临时目录时仍保护邻居的已有文件、新文件和软链接目标', () => {
  const base = mkdtempSync(join(系统临时目录(), 'blueprint-protected-'))
  const temporary = mkdtempSync(join(系统临时目录(), 'blueprint-unprotected-'))
  const own = join(base, 'own'), other = join(base, 'other')
  mkdirSync(own); mkdirSync(other)
  writeFileSync(join(other, 'existing'), 'unchanged')
  symlinkSync(other, join(own, 'escape'))
  const scope = { 根: own, 仓库: repo, 技能: join(repo, 'blueprint/packages/prompt/skill'), 保护根: [repo, base] }
  const write = path => {
    const spec = 隔离命令({ argv: ['/bin/sh', '-c', 'printf changed > "$1"', 'sh', path], cwd: own }, scope)
    return spawnSync(spec.argv[0], spec.argv.slice(1), { cwd: own, env: { ...process.env, ...spec.env }, encoding: 'utf8' })
  }
  try {
    assert.equal(write(join(own, 'own.txt')).status, 0)
    assert.equal(readFileSync(join(own, 'own.txt'), 'utf8'), 'changed')
    for (const path of [join(other, 'existing'), join(other, 'new'), join(own, 'escape/new')]) {
      assert.notEqual(write(path).status, 0, path)
    }
    assert.equal(readFileSync(join(other, 'existing'), 'utf8'), 'unchanged')
    assert.ok(!existsSync(join(other, 'new')))
    assert.equal(write(join(temporary, 'native-cache')).status, 0, '未受保护的系统临时目录仍可写')
    assert.equal(readFileSync(join(temporary, 'native-cache'), 'utf8'), 'changed')
  } finally {
    rmSync(base, { recursive: true, force: true })
    rmSync(temporary, { recursive: true, force: true })
  }
})

// 10-27 mini：Godot 的着色器缓存写不进，每次验收都从头编，一次两分多钟、10 核负载 50。缓存按类别整个放开。
test('三处缓存整个可写；Blueprint 自己的缓存、各 App 的更新状态和缓存以外照旧不能写', () => {
  const base = mkdtempSync(join(projects, '.isolation-cache-'))
  const own = join(base, 'own'); mkdirSync(own)
  const C = 系统缓存目录(), 库 = realpathSync(join(homedir(), 'Library/Caches')), 点 = realpathSync(join(homedir(), '.cache'))
  const tag = `blueprint-test-${process.pid}-${Date.now()}`
  const scope = { 根: own, 仓库: base, 技能: join(repo, 'blueprint/packages/prompt/skill') }
  // 节点的 bash 先经 dsh 的 bash 沙箱：照 dsh-sandbox-local/src/profiles.ts 的 seatbeltProfileArgs，先拦掉全部写入、再只放工作区和临时目录。
  // 只在自己的 deny 里排除不够，10-27 第一版部署到 mini 后照样被它拦住；两种入口都要过。
  const dsh = `(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null")) (allow file-write* (subpath ${JSON.stringify(own)}) (subpath "/private/tmp") (subpath ${JSON.stringify(realpathSync(tmpdir()))}))`
  let 入口 = []
  const 写 = path => {
    const spec = 隔离命令({ argv: [...入口, '/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && printf x > "$1"', 'sh', path], cwd: own }, scope)
    return spawnSync(spec.argv[0], spec.argv.slice(1), { cwd: own, env: { ...process.env, ...spec.env }, encoding: 'utf8' }).status
  }
  // 打包程序的显卡着色器缓存、没打包程序共用的那份、pip、uv。
  const 写得进 = [join(C, `org.test.${tag}/com.apple.metal/gpu/functions.data`), join(C, 'com.apple.metal', `${tag}.probe`), join(库, tag, 'pip/x'), join(点, tag, 'uv/x')]
  const 自己的 = [join(库, `com.blueprint.desktop.${tag}`), join(C, `com.github.Electron.${tag}`), join(点, `com.deepseek.dsh.${tag}`), join(库, `${tag}.ShipIt`)]
  const 拦住 = [...自己的.map(dir => join(dir, 'x')), join(库, 'electron', `${tag}.zip`),
    join(homedir(), 'Library/Preferences', `${tag}.plist`), join(homedir(), `.${tag}rc`)]
  try {
    for (const 这次 of [[], ['/usr/bin/sandbox-exec', '-p', dsh]]) {
      入口 = 这次
      assert.equal(写(join(own, 'own.txt')), 0, '项目里照常能写')
      for (const path of 写得进) { assert.equal(写(path), 0, path); assert.equal(readFileSync(path, 'utf8'), 'x') }
      for (const path of 拦住) { assert.notEqual(写(path), 0, path); assert.ok(!existsSync(path), path) }
    }
  } finally {
    for (const path of [join(C, `org.test.${tag}`), join(C, 'com.apple.metal', `${tag}.probe`), join(库, tag), join(点, tag), ...自己的, ...拦住]) rmSync(path, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('普通文档自由读写；文件工具与命令保护相同的机器文件，不能通过改名或软链接绕过', async () => {
  const root = mkdtempSync(join(projects, '.文档权限核对-[边界]-'))
  const evidenceGroup = '.blueprint-evidence/' + 'a'.repeat(24)
  for (const dir of ['系统文档', evidenceGroup, '.blueprint-evidence/media', '工作文档']) mkdirSync(join(root, dir), { recursive: true })
  const ledger = join(root, '系统文档/任务.db'), original = join(root, evidenceGroup, 'b'.repeat(24) + '.txt')
  const machineFiles = ['任务.db', '任务.db-journal', '纸条.yaml', '任务表.md', '素材检索目录.md', '模型.json', '技能.json', '用量.jsonl', '待回答.json', '工作时间.json', '工作时间.json.tmp']
    .map(name => join(root, '系统文档', name))
  machineFiles.push(original, join(root, '.blueprint-evidence/网页目录.md'),
    join(root, '.blueprint-evidence/media/12345678-1234-1234-1234-123456789abc.json'))
  for (const path of machineFiles) writeFileSync(path, '程序维护的原文')
  symlinkSync(join(root, '系统文档'), join(root, 'ledger-alias'))
  symlinkSync(ledger, join(root, '名册别名.yaml'))
  const fs = {
    processPath: p => p,
    readText: async p => readFileSync(p, 'utf8'),
    writeText: async (p, text) => writeFileSync(p, text),
    editText: async (p, text) => writeFileSync(p, text),
  }
  let dispatch
  装项目隔离({ get: n => ({ fs, subprocess: {} }[n]), on: (_, fn) => { dispatch = fn } })
  const scope = { 根: root, 仓库: repo, 技能: join(repo, 'blueprint/packages/prompt/skill') }
  const run = argv => {
    const spec = 隔离命令({ argv, cwd: root }, scope)
    return spawnSync(spec.argv[0], spec.argv.slice(1), { cwd: root, env: { ...process.env, ...spec.env }, encoding: 'utf8' })
  }
  const write = path => run(['/bin/sh', '-c', 'printf modified > "$1"', 'sh', path])
  const protectedFiles = [...machineFiles, join(root, 'ledger-alias/任务.db'), join(root, '名册别名.yaml'),
    join(root, '系统文档/任务.db.123.456.tmp'), join(root, '系统文档/.技能选择-12345678.json'),
    join(root, '.blueprint-evidence/media/12345678-1234-1234-1234-123456789abc.json.123.tmp'),
    join(root, evidenceGroup, 'c'.repeat(24) + '.txt')]
  const ordinaryFiles = ['总图景.md', '系统文档/目标与计划.md', '系统文档/取材认识.json', '工作文档/过程.md',
    '.blueprint-evidence/人工笔记.md', 'ledger-alias/补充背景.md', '名册.yaml'].map(name => join(root, name))
  try {
    await dispatch({ name: 'write', agent: { session: { header: { cwd: root } } } }, async () => {
      assert.equal(await fs.readText(ledger), '程序维护的原文')
      for (const path of protectedFiles) {
        assert.throws(() => fs.writeText(path, 'modified'), /MACHINE_STORAGE/)
        assert.throws(() => fs.editText(path, 'modified'), /MACHINE_STORAGE/)
      }
      for (const path of ordinaryFiles) {
        await fs.writeText(path, '自己的认识')
        await fs.editText(path, '修正后的认识')
        assert.equal(await fs.readText(path), '修正后的认识')
      }
    })
    for (const path of protectedFiles) assert.notEqual(write(path).status, 0, path)
    for (const path of ordinaryFiles) {
      const result = write(path)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(readFileSync(path, 'utf8'), 'modified')
    }
    for (const path of [ledger, original]) {
      assert.notEqual(run(['/bin/rm', path]).status, 0)
      assert.notEqual(run(['/bin/mv', path, join(root, '移走的机器文件')]).status, 0)
    }
    for (const path of ['系统文档', '.blueprint-evidence', evidenceGroup, '.blueprint-evidence/media']) {
      assert.notEqual(run(['/bin/mv', join(root, path), join(root, '移走的机器目录')]).status, 0, path)
    }
    assert.notEqual(run(['/bin/ln', ledger, join(root, '名册硬链接.yaml')]).status, 0)
    for (const path of machineFiles) assert.equal(readFileSync(path, 'utf8'), '程序维护的原文')
    assert.equal(run(['/bin/mv', ordinaryFiles[1], join(root, '系统文档/改名后的计划.md')]).status, 0)
    await fs.writeText(ledger, '宿主可写')
    const { 存证据 } = await import('./src/资料.js')
    const saved = await 存证据({ id: 'storage-test', header: { cwd: root } }, '宿主可靠归档', { source: 'test' })
    assert.equal(readFileSync(join(root, saved.path), 'utf8'), '宿主可靠归档')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
