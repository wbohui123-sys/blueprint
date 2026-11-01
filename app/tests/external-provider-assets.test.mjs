import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, realpath, cp, readdir } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createSocketServer } from 'node:net'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspectExternalProviderAssets, assertExternalProviderAssets } from '../scripts/external-provider-assets.mjs'

const engine = '0.2.1-alpha.2', codex = '0.153.4', sdk = '0.3.263', claude = '2.1.263'
// codexVersion: null＝跟提供方钉的版本；不给就读 App package.json 的 overrides（App 升过 Codex，见下面那条）。
const selected = { engineVersion: engine, codexVersion: null, platform: 'darwin', arch: 'arm64' }
// 本机真装的那份：Codex 认 App 定的版本。
const installed = { ...selected, codexVersion: undefined }
const appCodex = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).overrides['@openai/codex']
const json = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value)) }

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'Blueprint外部提供方载荷测试-'))), modules = join(root, 'node_modules')
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageFile = name => join(modules, name, 'package.json')
  await json(packageFile('@deepseek-ai/dsh-subagent-codex'), { name: '@deepseek-ai/dsh-subagent-codex', version: engine, dependencies: { '@openai/codex': codex } })
  await json(packageFile('@deepseek-ai/dsh-subagent-claude-code'), { name: '@deepseek-ai/dsh-subagent-claude-code', version: engine, dependencies: { '@anthropic-ai/claude-agent-sdk': sdk } })
  await json(packageFile('@openai/codex'), { name: '@openai/codex', version: codex, type: 'module', bin: { codex: 'bin/codex.js' },
    optionalDependencies: { '@openai/codex-darwin-arm64': `npm:@openai/codex@${codex}-darwin-arm64` } })
  await json(packageFile('@openai/codex-darwin-arm64'), { name: '@openai/codex', version: `${codex}-darwin-arm64` })
  await json(packageFile('@anthropic-ai/claude-agent-sdk'), { name: '@anthropic-ai/claude-agent-sdk', version: sdk, claudeCodeVersion: claude,
    type: 'module', exports: { '.': './sdk.mjs' }, optionalDependencies: { '@anthropic-ai/claude-agent-sdk-darwin-arm64': sdk } })
  await json(packageFile('@anthropic-ai/claude-agent-sdk-darwin-arm64'), { name: '@anthropic-ai/claude-agent-sdk-darwin-arm64', version: sdk })
  const wrapper = join(modules, '@openai/codex/bin/codex.js')
  const codexBinary = join(modules, '@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex')
  const claudeBinary = join(modules, '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude')
  for (const path of [wrapper, codexBinary, claudeBinary]) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, '') }
  await chmod(codexBinary, 0o755); await chmod(claudeBinary, 0o755)
  await writeFile(join(modules, '@anthropic-ai/claude-agent-sdk/sdk.mjs'), 'export const fixture = true')
  return { root, modules, packageFile, wrapper, codexBinary, claudeBinary,
    update: async (name, patch) => { const path = packageFile(name); await json(path, { ...JSON.parse(await readFile(path, 'utf8')), ...patch }) } }
}

test('载荷核对按官方包声明定位，不依赖PATH；SDK未导出package.json也能定位其平台包', async t => {
  const f = await fixture(t), result = await inspectExternalProviderAssets(f.modules, selected)
  assert.equal(result.engine, engine)
  assert.equal(result.codex.wrapper, f.wrapper); assert.equal(result.codex.binary, f.codexBinary)
  assert.equal(result.codex.version, codex); assert.equal(result.claudeCode.sdkVersion, sdk)
  assert.equal(result.claudeCode.version, claude); assert.equal(result.claudeCode.binary, f.claudeBinary)
  assert.deepEqual(result.codex.packageRoots, [join(f.modules, '@openai/codex'), join(f.modules, '@openai/codex-darwin-arm64')])
})

test('缺少所选平台optional载荷或二进制时提前失败，不采用宿主CLI或其他平台包', async t => {
  const f = await fixture(t)
  await rm(join(f.modules, '@anthropic-ai/claude-agent-sdk-darwin-arm64'), { recursive: true })
  await assert.rejects(inspectExternalProviderAssets(f.modules, selected), /缺少.*claude-agent-sdk-darwin-arm64.*optional/)
  await json(f.packageFile('@anthropic-ai/claude-agent-sdk-darwin-arm64'), { version: sdk })
  await assert.rejects(inspectExternalProviderAssets(f.modules, selected), /入口缺失或不可执行/)
})

test('provider、wrapper/SDK与平台包版本必须与官方精确固定相符', async t => {
  const f = await fixture(t)
  await f.update('@deepseek-ai/dsh-subagent-codex', { version: '0.2.1-alpha.1' })
  await assert.rejects(inspectExternalProviderAssets(f.modules, selected), /提供方版本不一致/)
  await f.update('@deepseek-ai/dsh-subagent-codex', { version: engine, dependencies: { '@openai/codex': `^${codex}` } })
  await assert.rejects(inspectExternalProviderAssets(f.modules, selected), /载荷版本不一致/)
  await f.update('@deepseek-ai/dsh-subagent-codex', { dependencies: { '@openai/codex': codex } })
  await f.update('@openai/codex-darwin-arm64', { version: '0.153.3-darwin-arm64' })
  await assert.rejects(inspectExternalProviderAssets(f.modules, selected), /平台载荷.*版本不一致/)
  await f.update('@openai/codex-darwin-arm64', { version: `${codex}-darwin-arm64` })
  await f.update('@anthropic-ai/claude-agent-sdk-darwin-arm64', { version: '0.3.262' })
  await assert.rejects(inspectExternalProviderAssets(f.modules, selected), /平台载荷.*版本不一致/)
})

// 2026-10-18：提供方钉的 Codex 0.153.4 拿不到新模型，App 在 overrides 里统一升；核对认 App 定的版本。
test('App 自己定了 Codex 版本：装的是它就过，还是提供方那版就报 App 固定的版本', async t => {
  const f = await fixture(t), 新 = '0.163.0'
  await assert.rejects(inspectExternalProviderAssets(f.modules, { ...selected, codexVersion: 新 }), /@openai\/codex 载荷版本不一致：0\.153\.4，App固定为 0\.163\.0/)
  await f.update('@openai/codex', { version: 新, optionalDependencies: { '@openai/codex-darwin-arm64': `npm:@openai/codex@${新}-darwin-arm64` } })
  await f.update('@openai/codex-darwin-arm64', { version: `${新}-darwin-arm64` })
  assert.equal((await inspectExternalProviderAssets(f.modules, { ...selected, codexVersion: 新 })).codex.version, 新)
  assert.equal(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).overrides['@openai/codex'], 新, 'App 的 package.json 定的就是这一版')
})

test('二进制权限损坏、包内入口越界和安装外软链接都不能通过核对', async t => {
  const f = await fixture(t)
  await chmod(f.claudeBinary, 0o644)
  await assert.rejects(inspectExternalProviderAssets(f.modules, selected), /不可执行/)
  await chmod(f.claudeBinary, 0o755)
  await f.update('@openai/codex', { bin: { codex: '../宿主入口.js' } })
  await assert.rejects(inspectExternalProviderAssets(f.modules, selected), /包内.*bin/)
  await f.update('@openai/codex', { bin: { codex: 'bin/codex.js' } })
  const outside = join(f.root, '安装外载荷'); await mkdir(outside)
  await json(join(outside, 'package.json'), { version: sdk }); await writeFile(join(outside, 'claude'), '')
  await rm(join(f.modules, '@anthropic-ai/claude-agent-sdk-darwin-arm64'), { recursive: true })
  await symlink(outside, join(f.modules, '@anthropic-ai/claude-agent-sdk-darwin-arm64'))
  await assert.rejects(inspectExternalProviderAssets(f.modules, selected), /所选安装外/)
})

test('实际版本探针拒绝声明相符而执行输出错误的载荷', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async t => {
  const f = await fixture(t)
  await writeFile(f.wrapper, 'console.log("codex-cli 0.153.3")')
  await assert.rejects(assertExternalProviderAssets(f.modules, selected), /可执行版本不一致/)
})

test('本机安装的官方固定载荷实际执行版本与元数据相符，无需用户配置或模型请求', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const modules = fileURLToPath(new URL('../node_modules', import.meta.url))
  const result = await assertExternalProviderAssets(modules, installed)
  assert.equal(result.codex.version, appCodex)
  assert.equal(result.claudeCode.sdkVersion, sdk)
  assert.equal(result.claudeCode.version, claude)
})

const nativePlatform = process.platform === 'darwin' && process.arch === 'arm64'
const modules = fileURLToPath(new URL('../node_modules', import.meta.url))
const native = name => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href)
async function deadline(promise) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('原生控制初始化超时')), 15000) })]) }
  finally { clearTimeout(timer) }
}

async function nativeFixture(t, { providerModules = modules, worktree = false } = {}) {
  const { Context } = await native('cordis'), { default: Llm, LlmAdapter } = await native('dsh-llm')
  const { fixtureProjectRoot: 项目路径 } = await import('./project-fixture-root.mjs')
  const { 只回一段字 } = await import('../../blueprint/packages/prompt/src/index.js')
  const { 装项目隔离, 原生提供方代码目录, 工具执行目录 } = await import('../../blueprint/packages/node/src/项目隔离.js')
  // 短而有含义的目录名，使项目内Unix socket落在macOS sockaddr_un长度以内。
  const root = await realpath(await mkdtemp(join(项目路径, 'ProviderProject-')))
  const neighbor = await realpath(await mkdtemp(join(项目路径, 'ProviderNeighbor-')))
  const isolated = await realpath(await mkdtemp('/private/tmp/Blueprint独立Provider载荷核对-'))
  let cwd = join(root, '当前目录 中文 空格')
  const ctx = new Context(), handles = [], servers = []
  t.after(async () => {
    try {
      for (const child of handles) { child.terminate(); await child.waitForExit(); await child.done.catch(() => {}) }
      for (const server of servers) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)) }
      await ctx.fiber.dispose()
    } finally { for (const path of [root, neighbor, isolated]) await rm(path, { recursive: true, force: true }) }
  })
  await mkdir(cwd); await mkdir(join(root, '系统文档'))
  await writeFile(join(cwd, '当前原文.txt'), 'CURRENT')
  await writeFile(join(neighbor, '邻居原文.txt'), 'OTHER')
  await writeFile(join(root, '系统文档/任务.db'), 'MACHINE')
  let managementRequests = 0, neighborConnections = 0
  const management = createHttpServer((_, response) => { managementRequests++; response.end('MANAGEMENT_MUST_NOT_BE_READ') })
  const neighborSocket = join(neighbor, 'neighbor.sock')
  const neighborServer = createSocketServer(socket => { neighborConnections++; socket.end('NEIGHBOR_MUST_NOT_BE_READ') })
  servers.push(management, neighborServer)
  await new Promise((resolve, reject) => { management.once('error', reject); management.listen(0, '127.0.0.1', resolve) })
  await new Promise((resolve, reject) => { neighborServer.once('error', reject); neighborServer.listen(neighborSocket, resolve) })
  const managementPort = management.address().port
  ctx.provide('webServer', { port: managementPort })
  if (worktree) {
    await writeFile(join(root, '工作树基线.md'), '原生提供方工作树基线')
    const git = args => promisify(execFile)('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8' })
    await git(['init', '--quiet'])
    await git(['add', '--', '工作树基线.md'])
    await git(['-c', 'user.name=Blueprint Provider Fixture', '-c', 'user.email=provider-fixture@example.invalid', 'commit', '--quiet', '-m', '原生提供方工作树基线'])
    cwd = join(root, '.agents/worktrees/Codex 当前工作树')
    await mkdir(dirname(cwd), { recursive: true })
    await git(['worktree', 'add', '--quiet', '-b', 'provider-command-fixture', cwd])
    await writeFile(join(cwd, '当前原文.txt'), 'CURRENT')
  }
  await ctx.plugin(Llm)
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-fs-local', 'dsh-subprocess-local', 'dsh-working-directory']) {
    await ctx.plugin((await native(name)).default)
  }
  await ctx.plugin((await native('dsh-agent-loop')).default, { agents: [] })
  class NoModel extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream() { throw new Error('载荷核对不能启动模型轮次') }
  }
  ctx.llm.registerAdapter(['native-assets-fixture'], new NoModel())
  const require = createRequire(join(providerModules, 'provider-test-anchor.cjs'))
  const entries = ['@deepseek-ai/dsh-subagent-codex', '@deepseek-ai/dsh-subagent-claude-code'].map(name => pathToFileURL(require.resolve(name)).href)
  const codeRoots = 原生提供方代码目录(entries), assets = await inspectExternalProviderAssets(providerModules, installed)
  assert.deepEqual(codeRoots.sort(), [...assets.codex.packageRoots, ...assets.claudeCode.packageRoots].sort())
  assert.deepEqual(原生提供方代码目录(), [])
  assert.throws(() => 原生提供方代码目录(['https://example.org/provider']), /部署解析的本地文件/)
  装项目隔离(ctx, { 只读代码目录: codeRoots })
  const handle = await ctx.agents.create({ sessionId: 'native-provider-assets', meta: { cwd: root }, agentOptions: { provider: 'native-assets-fixture', model: 'none' } })
  await ctx.workingDirectory.set(handle.agent, cwd)
  let execute, count = 0
  ctx.tools.register({ name: 'native_assets_probe', description: '无模型原生产品协议核对', parameters: { type: 'object', properties: {} }, output: 只回一段字,
    execute: async (_, exec) => { assert.equal(工具执行目录(), cwd); return { 文: JSON.stringify(await execute(exec)) } } })
  return { root, neighbor, isolated, cwd, ctx, agent: handle.agent, assets,
    network: { managementPort, neighborSocket, managementRequests: () => managementRequests, neighborConnections: () => neighborConnections },
    run: async operation => {
      execute = operation
      const result = await ctx.tools.execute({ name: 'native_assets_probe', arguments: {}, agent: handle.agent, callId: `native-assets-${++count}`, signal: new AbortController().signal })
      assert.equal(result.isError, false, JSON.stringify(result))
      return JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join(''))
    },
    spawn: (argv, env = {}, pipes = true) => {
      // 直接使用生产进程 seam 与本次工具 ALS 项目规则；没有另加测试 sandbox。
      const child = ctx.subprocess.spawn({ argv, cwd,
        env, stdio: { stdin: pipes ? 'pipe' : 'ignore', stdout: pipes ? 'pipe' : { maxBytes: 10000 }, stderr: { maxBytes: 20000 } }, graceMs: 100 })
      handles.push(child); return child
    },
  }
}

async function codexHandshake(f, wrapper, home, { threads = false, extraArgs = [], verifyReadOnly = false, singleOuter = false } = {}) {
  const sqlite = join(f.root, '.blueprint-tmp', 'codex-state'); await mkdir(sqlite, { recursive: true })
  const child = f.spawn([process.execPath, wrapper, 'app-server', '--stdio', ...extraArgs], { CODEX_HOME: home, CODEX_SQLITE_HOME: sqlite, BLUEPRINT_FIXTURE_KEY: 'blueprint-fake-key' })
  const waits = new Map(), methods = []; let buffer = '', id = 0
  child.stdout.on('data', chunk => {
    buffer += chunk.toString(); let end
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      let frame; try { frame = JSON.parse(line) } catch { continue }
      const wait = waits.get(frame.id)
      if (wait) { waits.delete(frame.id); frame.error ? wait.reject(new Error(`原生控制错误 ${frame.error.code}`)) : wait.resolve(frame.result) }
    }
  })
  void child.done.then(outcome => { for (const wait of waits.values()) wait.reject(new Error(`原生进程退出 ${outcome.exitCode}`)); waits.clear() }, error => {
    for (const wait of waits.values()) wait.reject(error); waits.clear()
  })
  const rpc = (method, params) => {
    const requestId = ++id; methods.push(method)
    const promise = new Promise((resolve, reject) => waits.set(requestId, { resolve, reject }))
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n')
    return deadline(promise)
  }
  try {
    const init = await rpc('initialize', { clientInfo: { name: 'blueprint-assets-fixture', version: '0.1' }, capabilities: { experimentalApi: true } })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n')
    const config = await rpc('config/read', { includeLayers: false }), account = await rpc('account/read', { refreshToken: false })
    let never, approved
    if (threads) {
      never = await rpc('thread/start', { cwd: f.cwd, ephemeral: true, modelProvider: 'fixture', approvalPolicy: 'never' })
      approved = await rpc('thread/start', { cwd: f.cwd, ephemeral: true, modelProvider: 'fixture', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' })
    }
    let commandBoundary, unified
    if (verifyReadOnly) {
      const policy = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
      const echo = await rpc('command/exec', { command: ['/bin/echo', 'NATIVE_COMMAND_PROBE'], cwd: f.cwd, timeoutMs: 5000, sandboxPolicy: policy })
      const path = join(f.cwd, 'Codex原生命令写入核对.txt')
      const write = await rpc('command/exec', { command: ['/bin/sh', '-c', 'printf NATIVE_WRITE >"$1"', '原生命令写入核对', path], cwd: f.cwd, timeoutMs: 5000, sandboxPolicy: policy })
      commandBoundary = { echoExit: echo.exitCode, writeExit: write.exitCode, echoSandboxFailure: /sandbox_apply: Operation not permitted/.test(echo.stderr),
        writeSandboxFailure: /sandbox_apply: Operation not permitted/.test(write.stderr) }
      await assert.rejects(readFile(path), { code: 'ENOENT' }, '真实native双层sandbox失败没有被当作命令写入成功')
    }
    if (singleOuter) {
      const thread = await rpc('thread/start', { cwd: f.cwd, ephemeral: true, modelProvider: 'fixture', approvalPolicy: 'never', sandbox: 'danger-full-access' })
      const policy = { type: 'dangerFullAccess' }
      const echo = await rpc('command/exec', { command: ['/bin/echo', 'BLUEPRINT_SINGLE_OUTER'], cwd: f.cwd, timeoutMs: 5000, sandboxPolicy: policy })
      assert.equal(echo.exitCode, 0, echo.stderr)
      assert.equal(echo.stdout.trim(), 'BLUEPRINT_SINGLE_OUTER')
      const paths = { current: join(f.cwd, 'Codex统一隔离写入核对.txt'), auth: join(home, 'auth.json'), config: join(home, 'config.toml'),
        machine: join(f.root, '系统文档/任务.db'), other: join(f.neighbor, '邻居原文.txt') }
      const source = `const fs=require('node:fs'),p=JSON.parse(process.argv[1]),out={};for(const key of Object.keys(p)){try{fs.writeFileSync(p[key],'NATIVE_SINGLE_OUTER');out[key]='write'}catch(e){out[key]=e.code}}for(const key of ['auth','config']){const tmp=p[key]+'.atomic-replacement.tmp';fs.writeFileSync(tmp,'ATOMIC_ATTEMPT');try{fs.renameSync(tmp,p[key]);out[key+'Replace']='rename'}catch(e){out[key+'Replace']=e.code;fs.unlinkSync(tmp)}}try{fs.readFileSync(p.other);out.otherRead='read'}catch(e){out.otherRead=e.code}console.log(JSON.stringify(out))`
      const matrix = await rpc('command/exec', { command: [process.execPath, '-e', source, JSON.stringify(paths)], cwd: f.cwd, timeoutMs: 5000, sandboxPolicy: policy })
      assert.equal(matrix.exitCode, 0, matrix.stderr)
      unified = { sandbox: thread.sandbox, approvalPolicy: thread.approvalPolicy, echo: echo.stdout.trim(), matrix: JSON.parse(matrix.stdout) }
      assert.equal(await readFile(paths.current, 'utf8'), 'NATIVE_SINGLE_OUTER')
      // 原生控制协议走stdio；另实测项目HTTP/socket及宿主管理、邻居端点的实际边界。
      const socketPath = join(f.root, 'provider.sock')
      const endpoints = { currentSocket: socketPath, otherSocket: f.network.neighborSocket, managementPort: f.network.managementPort }
      const networkSource = `
        const net=require('node:net'),http=require('node:http'),fs=require('node:fs'),p=JSON.parse(process.argv[1]),out={};
        const listen=(server,address)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(address,resolve)});
        const close=server=>new Promise(resolve=>server.close(resolve));
        const socketRead=address=>new Promise(resolve=>{const socket=net.createConnection(address);let settled=false;const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();resolve(value)};const timer=setTimeout(()=>finish('ETIMEDOUT'),1000);socket.once('error',e=>finish(e.code));socket.once('data',data=>finish(data.toString()))});
        const httpRead=port=>new Promise(resolve=>{const request=http.get({host:'127.0.0.1',port,path:'/'},response=>{let body='';response.on('data',data=>body+=data);response.on('end',()=>finish(body))});let settled=false;const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);request.destroy();resolve(value)};const timer=setTimeout(()=>finish('ETIMEDOUT'),1000);request.once('error',e=>finish(e.code))});
        (async()=>{const socket=net.createServer(s=>s.end('LOCAL_SOCKET_FIXTURE'));const server=http.createServer((_,response)=>response.end('LOCAL_HTTP_FIXTURE'));
          try{await listen(socket,p.currentSocket);out.projectSocket=await socketRead(p.currentSocket);await listen(server,{host:'127.0.0.1',port:0});out.projectHttp=await httpRead(server.address().port);out.managementHttp=await httpRead(p.managementPort);out.neighborSocket=await socketRead(p.otherSocket)}
          finally{if(server.listening){server.closeAllConnections();await close(server)}if(socket.listening)await close(socket);try{fs.unlinkSync(p.currentSocket)}catch{}}
          console.log(JSON.stringify(out))})().catch(()=>process.exit(1))`
      try {
        const network = await rpc('command/exec', { command: [process.execPath, '-e', networkSource, JSON.stringify(endpoints)], cwd: f.cwd, timeoutMs: 5000, sandboxPolicy: policy })
        assert.equal(network.exitCode, 0, network.stderr)
        unified.network = JSON.parse(network.stdout)
      } finally { await rm(socketPath, { force: true }) }
    }
    return { initialized: true, versionMatches: init.userAgent.includes(appCodex), model: config.config.model,
      mockAuthType: account.account?.type, methods, sqliteFiles: await readdir(sqlite),
      ...(commandBoundary ? { commandBoundary } : {}),
      ...(unified ? { unified } : {}),
      ...(threads ? { never: { sandbox: never.sandbox, policy: never.approvalPolicy }, approved: { sandbox: approved.sandbox, policy: approved.approvalPolicy, reviewer: approved.approvalsReviewer } } : {}) }
  } finally { child.stdin.end(); child.terminate(); await child.waitForExit(); await child.done.catch(() => {}) }
}

async function claudeHandshake(f, sdkRoot, home, { model, settings, checkAutoDenied = false } = {}) {
  const sdk = await import(pathToFileURL(join(sdkRoot, 'sdk.mjs')).href)
  const controller = new AbortController(); let query, child, yielded = 0
  async function* prompt() {
    await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }))
    // 不产生用户消息；只初始化控制协议并关闭，绝不开始 query turn。
    if (!controller.signal.aborted) { yielded++; yield { type: 'user', message: { role: 'user', content: '不应投递的测试输入' } } }
  }
  try {
    query = sdk.query({ prompt: prompt(), options: { cwd: f.cwd, abortController: controller, persistSession: false, permissionMode: 'acceptEdits',
      ...(model ? { model } : {}), ...(settings ? { settings } : {}),
      env: { CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_TMPDIR: join(f.root, '.blueprint-tmp'), ANTHROPIC_API_KEY: 'blueprint-fake-key', ANTHROPIC_BASE_URL: 'https://127.0.0.1:1',
        DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      spawnClaudeCodeProcess: options => {
        child = f.spawn([options.command, ...options.args], options.env)
        const events = new EventEmitter(); events.on('error', () => {})
        let outcome, killed = false
        void child.done.then(value => { outcome = value; events.emit('exit', value.exitCode, value.signal) }, error => events.emit('error', error))
        return { stdin: child.stdin, stdout: child.stdout, get killed() { return killed }, get exitCode() { return outcome?.exitCode ?? null }, get signalCode() { return outcome?.signal ?? null },
          kill() { if (killed) return false; killed = true; child.terminate(); return true },
          on: (...args) => events.on(...args), once: (...args) => events.once(...args), off: (...args) => events.off(...args) }
      } } })
    const init = await deadline(query.initializationResult())
    let autoDenied
    if (checkAutoDenied) {
      try { await deadline(query.setPermissionMode('auto')); autoDenied = false }
      catch (error) { autoDenied = error.message }
    }
    return { initialized: true, models: init.models.length, commands: init.commands.length, yielded, ...(checkAutoDenied ? { autoDenied } : {}) }
  } finally { controller.abort(); query?.close(); if (child) { child.terminate(); await child.waitForExit(); await child.done.catch(() => {}) } }
}

async function productHome(root, name) {
  const home = join(root, name); await mkdir(home, { recursive: true })
  await writeFile(join(home, 'config.toml'), 'model = "blueprint-native-settings-marker"\ncli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n[model_providers.fixture]\nname = "Blueprint fixture"\nbase_url = "https://127.0.0.1:1"\nwire_api = "responses"\nenv_key = "BLUEPRINT_FIXTURE_KEY"\nrequires_openai_auth = false\n[analytics]\nenabled = false\n')
  await writeFile(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'blueprint-fake-auth-from-file' }))
  return home
}

test('固定CLI/SDK从源码与独立载荷在原生工具沙箱完成无模型握手，默认权限、认证配置与真实状态库可核对', { skip: !nativePlatform, timeout: 90000 }, async t => {
  const f = await nativeFixture(t, { worktree: true }), copiedModules = join(f.isolated, 'runtime/node_modules')
  for (const path of [...f.assets.codex.packageRoots, ...f.assets.claudeCode.packageRoots,
    join(modules, '@deepseek-ai/dsh-subagent-codex'), join(modules, '@deepseek-ai/dsh-subagent-claude-code')]) {
    const target = join(copiedModules, relative(modules, path)); await mkdir(dirname(target), { recursive: true }); await cp(path, target, { recursive: true })
  }
  for (const shape of ['source', 'independent']) {
    const current = shape === 'source' ? f : await nativeFixture(t, { providerModules: copiedModules, worktree: true })
    const home = await productHome(current.cwd, `${shape}-原生配置`)
    const auth = await readFile(join(home, 'auth.json'), 'utf8'), config = await readFile(join(home, 'config.toml'), 'utf8')
    const result = await current.run(async () => ({ codex: await codexHandshake(current, current.assets.codex.wrapper, home, { threads: true, verifyReadOnly: true, singleOuter: true }),
      claude: await claudeHandshake(current, current.assets.claudeCode.packageRoots[0], home) }))
    assert.equal(result.codex.initialized, true); assert.equal(result.codex.versionMatches, true)
    assert.equal(result.codex.model, 'blueprint-native-settings-marker'); assert.equal(result.codex.mockAuthType, 'apiKey')
    assert.deepEqual(result.codex.methods, ['initialize', 'config/read', 'account/read', 'thread/start', 'thread/start', 'command/exec', 'command/exec', 'thread/start', 'command/exec', 'command/exec', 'command/exec'])
    assert.deepEqual(result.codex.commandBoundary, { echoExit: 71, writeExit: 71, echoSandboxFailure: true, writeSandboxFailure: true },
      '记录真实生产外层与Codex原生workspaceWrite的执行阻碍；握手通过不能代替命令可执行')
    assert.equal(result.codex.never.sandbox.type, 'readOnly'); assert.equal(result.codex.never.policy, 'never')
    assert.equal(result.codex.approved.sandbox.type, 'workspaceWrite'); assert.equal(result.codex.approved.policy, 'on-request')
    assert.equal(result.codex.approved.reviewer, 'auto_review')
    assert.equal(result.codex.unified.sandbox.type, 'dangerFullAccess'); assert.equal(result.codex.unified.approvalPolicy, 'never')
    assert.equal(result.codex.unified.echo, 'BLUEPRINT_SINGLE_OUTER')
    assert.deepEqual(result.codex.unified.matrix, { current: 'write', auth: 'EPERM', config: 'EPERM', machine: 'EPERM', other: 'EPERM', authReplace: 'EPERM', configReplace: 'EPERM', otherRead: 'EPERM' })
    assert.deepEqual(result.codex.unified.network, { projectSocket: 'LOCAL_SOCKET_FIXTURE', projectHttp: 'LOCAL_HTTP_FIXTURE', managementHttp: 'EPERM', neighborSocket: 'EPERM' })
    assert.equal(current.network.managementRequests(), 0)
    assert.equal(current.network.neighborConnections(), 0)
    assert.equal(await readFile(join(current.neighbor, '邻居原文.txt'), 'utf8'), 'OTHER')
    assert.equal(await readFile(join(current.root, '系统文档/任务.db'), 'utf8'), 'MACHINE')
    assert.ok(result.codex.sqliteFiles.some(file => /^state_.*\.sqlite$/.test(file)), '真实CLI将原生状态库写入项目cache')
    assert.ok(result.claude.models > 0); assert.ok(result.claude.commands > 0); assert.equal(result.claude.yielded, 0)
    assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), auth, '只使用mock原生认证；不复制或刷新任何用户认证')
    assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), config)
  }
  const boundary = await f.run(async () => {
    const providerCode = await f.ctx.fs.resolve(join(f.assets.codex.packageRoots[0], 'package.json'))
    assert.equal(f.ctx.fs.processPath(providerCode), join(f.assets.codex.packageRoots[0], 'package.json'), '部署声明的提供方代码只读可访问')
    assert.throws(() => f.ctx.fs.writeText(providerCode, 'ATTEMPT'), /PROJECT_ISOLATION/)
    await assert.rejects(f.ctx.fs.resolve(join(f.neighbor, '邻居原文.txt')), /PROJECT_ISOLATION/)
    const paths = { current: join(f.cwd, '当前原文.txt'), other: join(f.neighbor, '邻居原文.txt'), code: join(f.assets.codex.packageRoots[0], 'package.json'),
      sdk: join(f.assets.claudeCode.packageRoots[0], 'package.json'), machine: join(f.root, '系统文档/任务.db') }
    const source = `const fs=require('node:fs'),p=JSON.parse(process.argv[1]),out={};for(const key of ['current','other','code','sdk']){try{fs.readFileSync(p[key]);out[key]='read'}catch(e){out[key]=e.code}}for(const key of ['code','machine']){try{fs.writeFileSync(p[key],'ATTEMPT');out[key+'Write']='write'}catch(e){out[key+'Write']=e.code}}console.log(JSON.stringify(out))`
    const child = f.spawn([process.execPath, '-e', source, JSON.stringify(paths)], {}, false)
    assert.equal((await child.done).exitCode, 0)
    return JSON.parse(child.collected.stdout.readFrom(0).text)
  })
  assert.deepEqual(boundary, { current: 'read', other: 'EPERM', code: 'read', sdk: 'read', codeWrite: 'EPERM', machineWrite: 'EPERM' })
  assert.equal(f.agent.session.header.cwd, f.root)
  assert.equal(f.ctx.workingDirectory.get(f.agent.session), f.cwd)
})

test('仅可信官方Codex argv获得tmp与installation_id缓存，保持项目外原生auth/config只读，普通命令与入口别名无额外写权', { skip: !nativePlatform, timeout: 45000 }, async t => {
  const f = await nativeFixture(t), home = await productHome(f.isolated, '只读模拟原生配置')
  const before = await readFile(join(home, 'auth.json'), 'utf8'), config = await readFile(join(home, 'config.toml'), 'utf8')
  const result = await f.run(async () => {
    const codex = await codexHandshake(f, f.assets.codex.wrapper, home, { threads: true })
    const alias = f.assets.codex.wrapper.replace('/bin/codex.js', '/bin/../bin/codex.js')
    await assert.rejects(codexHandshake(f, alias, home), /原生进程退出 1/)
    await assert.rejects(codexHandshake(f, f.assets.codex.wrapper, home, { extraArgs: ['--config', 'log_dir="额外覆盖不能获缓存写权"'] }), /原生进程退出 1/)
    const paths = { auth: join(home, 'auth.json'), config: join(home, 'config.toml'), installation: join(home, 'installation_id'), cache: join(home, 'tmp/普通命令不得写入.txt') }
    const source = `const fs=require('node:fs'),p=JSON.parse(process.argv[1]),out={};for(const key of Object.keys(p)){try{fs.writeFileSync(p[key],'ATTEMPT');out[key]='write'}catch(e){out[key]=e.code}}console.log(JSON.stringify(out))`
    const child = f.spawn([process.execPath, '-e', source, JSON.stringify(paths)], {}, false)
    assert.equal((await child.done).exitCode, 0)
    const shell = f.spawn(['/bin/bash', '-c', 'if cat "$1" >/dev/null; then echo SDK_READ; else echo SDK_DENIED; fi; for path in "$2" "$3" "$4"; do if (printf ATTEMPT >"$path") 2>/dev/null; then echo WRITE; else echo DENIED; fi; done',
      '缓存权限核对', join(f.assets.claudeCode.packageRoots[0], 'package.json'), paths.cache, paths.auth, paths.config], {}, false)
    assert.equal((await shell.done).exitCode, 0)
    return { codex, ordinary: JSON.parse(child.collected.stdout.readFrom(0).text), shell: shell.collected.stdout.readFrom(0).text.trim(), claude: await claudeHandshake(f, f.assets.claudeCode.packageRoots[0], home) }
  })
  assert.equal(result.codex.initialized, true); assert.equal(result.codex.mockAuthType, 'apiKey')
  assert.equal(result.claude.initialized, true); assert.equal(result.claude.yielded, 0)
  assert.deepEqual(result.ordinary, { auth: 'EPERM', config: 'EPERM', installation: 'EPERM', cache: 'EPERM' })
  assert.equal(result.shell, 'SDK_READ\nDENIED\nDENIED\nDENIED')
  assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), before)
  assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), config)
  assert.deepEqual((await readdir(home)).sort(), ['auth.json', 'config.toml', 'installation_id', 'tmp'])
  // 官方进程确实用到了 tmp 的写权：0.153.4 建 tmp/arg0/codex-arg0…，0.163 建 tmp/arg0-macos（2026-10-18 随包升级）。
  const entries = await readdir(join(home, 'tmp'), { recursive: true })
  assert.ok(entries.some(name => /(^|\/)(codex-)?arg0/.test(name)), JSON.stringify(entries))
  await rm(join(home, 'tmp'), { recursive: true }); await symlink(f.neighbor, join(home, 'tmp'))
  await f.run(async () => {
    await assert.rejects(codexHandshake(f, f.assets.codex.wrapper, home), /缓存入口不能通过软链接/)
    return { refused: true }
  })
  await rm(join(home, 'tmp')); await mkdir(join(home, 'tmp'))
  await rm(join(home, 'installation_id')); await symlink(join(home, 'auth.json'), join(home, 'installation_id'))
  await f.run(async () => {
    await assert.rejects(codexHandshake(f, f.assets.codex.wrapper, home), /缓存入口不能通过软链接/)
    await assert.rejects(codexHandshake(f, f.assets.codex.wrapper, f.neighbor), /配置不能指向其他项目/)
    return { refused: true }
  })
  assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), before)
})

test('Codex专用生成规则的真实内核阻止项目内auth/config直接写、原子替换与邻居读取；只准精确缓存', { skip: !nativePlatform }, async t => {
  const f = await nativeFixture(t), home = await productHome(f.cwd, '项目内只读原生认证')
  const { 隔离命令 } = await import('../../blueprint/packages/node/src/项目隔离.js')
  const { scrubbedParentEnv } = await native('dsh-subprocess')
  const { 数据根, 仓库根, 技能路径 } = await import('../../blueprint/packages/prompt/src/路径.js')
  const auth = await readFile(join(home, 'auth.json'), 'utf8'), config = await readFile(join(home, 'config.toml'), 'utf8')
  const paths = { auth: join(home, 'auth.json'), config: join(home, 'config.toml'), other: join(f.neighbor, '邻居原文.txt'), machine: join(f.root, '系统文档/任务.db'),
    cache: join(home, 'tmp/原生缓存核对.txt'), installation: join(home, 'installation_id') }
  await mkdir(join(home, 'tmp'))
  const source = `const fs=require('node:fs'),p=JSON.parse(process.argv[1]),out={};for(const key of ['auth','config','machine','cache','installation']){try{fs.writeFileSync(p[key],'ATTEMPT');out[key]='write'}catch(e){out[key]=e.code}}for(const key of ['auth','config']){const tmp=p[key]+'.replacement.tmp';fs.writeFileSync(tmp,'ATOMIC_ATTEMPT');try{fs.renameSync(tmp,p[key]);out[key+'Replace']='rename'}catch(e){out[key+'Replace']=e.code;fs.unlinkSync(tmp)}}try{fs.readFileSync(p.other);out.other='read'}catch(e){out.other=e.code}console.log(JSON.stringify(out))`
  const scope = { 根: f.root, 目录: f.cwd, 仓库: await realpath(数据根), 技能: await realpath(技能路径),
    保护根: [await realpath(数据根), await realpath(仓库根)], Codex入口: f.assets.codex.wrapper,
    只读代码目录: [...f.assets.codex.packageRoots, ...f.assets.claudeCode.packageRoots] }
  const spec = 隔离命令({ argv: [process.execPath, f.assets.codex.wrapper, 'app-server', '--stdio'], cwd: f.cwd, env: { CODEX_HOME: home } }, scope)
  // 检查生产函数为可信Codex生成的同一profile；这是内核权限证据，不冒充native command/exec执行成功。
  const result = await promisify(execFile)(spec.argv[0], [spec.argv[1], spec.argv[2], process.execPath, '-e', source, JSON.stringify(paths)], { cwd: spec.cwd, env: { ...scrubbedParentEnv(), ...spec.env }, encoding: 'utf8' })
  assert.deepEqual(JSON.parse(result.stdout), { auth: 'EPERM', config: 'EPERM', machine: 'EPERM', cache: 'write', installation: 'write', authReplace: 'EPERM', configReplace: 'EPERM', other: 'EPERM' })
  assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), auth)
  assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), config)
})

test('固定Claude SDK控制协议明确拒绝被设置关闭或不支持模型的auto，不投递模型输入', { skip: !nativePlatform, timeout: 45000 }, async t => {
  const f = await nativeFixture(t)
  const disabled = await productHome(f.cwd, 'Claude auto显式关闭核对')
  const unsupported = await productHome(f.cwd, 'Claude auto旧模型核对')
  const result = await f.run(async () => ({
    disabled: await claudeHandshake(f, f.assets.claudeCode.packageRoots[0], disabled, { model: 'claude-sonnet-4-6', settings: { permissions: { disableAutoMode: 'disable' } }, checkAutoDenied: true }),
    unsupported: await claudeHandshake(f, f.assets.claudeCode.packageRoots[0], unsupported, { model: 'claude-3-haiku-20240307', checkAutoDenied: true }),
  }))
  assert.equal(result.disabled.initialized, true); assert.equal(result.disabled.yielded, 0)
  assert.equal(result.unsupported.initialized, true); assert.equal(result.unsupported.yielded, 0)
  assert.match(result.disabled.autoDenied, /auto mode disabled by settings/i)
  assert.match(result.unsupported.autoDenied, /auto mode unavailable for this model/i)
})
