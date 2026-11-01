// 合成项目使用真实 alpha 服务、Git 和项目 Seatbelt；不读取用户会话或调用外部模型。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, access, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { parse } from 'yaml'
import { readDesktopComposition, prepareDesktopProfile } from '../runtime/composition.mjs'
import { 装项目隔离 } from '../../blueprint/packages/node/src/项目隔离.js'
import { 准备节点Git空间, 提交节点空间, 节点成果版本 } from '../../blueprint/packages/node/src/节点Git空间.js'
import { 检查产物 } from '../../blueprint/packages/node/src/产物.js'
import { 安全产物文件, 汇集产物, 产物引用 } from '../../blueprint/packages/studio/src/产物.js'
import { 发送预览文件 } from '../../blueprint/packages/studio/src/预览.js'
import { fixtureProjectRoot } from './project-fixture-root.mjs'

const appRoot = fileURLToPath(new URL('../', import.meta.url))
const repo = resolve(appRoot, '..')
const require = createRequire(join(appRoot, 'package.json'))
const load = name => import(pathToFileURL(require.resolve(name)).href)
const execute = promisify(execFile)
const textOf = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const yamlOptions = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ __jsExpr: value }) }] }

async function git(cwd, ...args) {
  const result = await execute('git', ['--no-lazy-fetch', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0',
      GIT_CONFIG_PARAMETERS: '', GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined },
  })
  return result.stdout.trim()
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(fixtureProjectRoot, '.原生工作树核验-')))
  const home = await realpath(await mkdtemp(join(tmpdir(), 'blueprint-native-worktree-profile-')))
  let ctx
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    try { await ctx?.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome }
  })
  const rows = [{ id: '0', parent: null, status: '开工' }, { id: '1', parent: '0', status: '开工' }]
  const roster = { rows }
  await 准备节点Git空间(root, rows[0], roster, { 新建项目: true })
  await writeFile(join(root, '作品/已提交.txt'), '来源快照\n')
  // 正式派出仍提交来源，此后原生工作树只从已提交的本地对象检出。
  await 准备节点Git空间(root, rows[1], roster)
  const source = join(root, '作品空间/1')
  const composition = await readDesktopComposition({ resourceRoot: join(appRoot, 'runtime'), sourceRoot: repo,
    promptDir: join(repo, 'blueprint/packages/prompt'), resolvePlugin: name => pathToFileURL(require.resolve(name)).href })
  const patches = [...composition.patches, {id:'sandbox-policy',config:{mode:'workspace-write',workspaceRoot:root}}]
  const toolIds = new Set(['tool-working-directory', 'tool-worktree', 'tool-fs', 'tool-bash'])
  const plugins = composition.plugins.filter(row => toolIds.has(row.id))
  const { boot, loadProfileDirectory, readProfilePatches, createRuntimeResolution, PluginPackages } = await load('@deepseek-ai/dsh-app-boot')
  const { LlmAdapter, ToolCallId } = await load('@deepseek-ai/dsh-llm')
  class DirectoryFixtureModel extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '目录事实已收到。' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const open = async () => {
    const prepared = await prepareDesktopProfile({ engineHome: home, installAnchor: join(appRoot, 'package.json'), cwd: root,
      patches, plugins, preset: composition.preset, clientPackages: composition.clientPackages })
    const profileContext = prepared.profileContext
    const profile = loadProfileDirectory('Blueprint-worktree-test', profileContext.dir, profileContext.installAnchor)
    assert.deepEqual(profile.skippedBundles, [])
    const resolution = await createRuntimeResolution({ installAnchor: profileContext.installAnchor, profile, home })
    const { provideCmdline } = await load('@deepseek-ai/dsh-cmdline')
    const readiness = new Set()
    ctx = await boot('Blueprint-worktree-test', prepared.configPath, readProfilePatches('Blueprint-worktree-test', profileContext, profile), async host => {
      host.provide('profileContext', profileContext)
      provideCmdline(host, {args:['--no-open','--port','0'], ready:{onReady:listener=>{readiness.add(listener);return ()=>readiness.delete(listener)}},exit:code=>{throw Error('unexpected exit '+code)}})
      await host.plugin(PluginPackages, { resolution })
    })
    for (const listener of readiness) listener()
    ctx.llm.registerAdapter(['worktree-fixture'], new DirectoryFixtureModel())
    // 使用生产 tools/execute 边界；此处没有修改原生 worktree 或项目隔离实现。
    装项目隔离(ctx)
    return ctx
  }
  await open()
  let sequence = 0
  const invoke = (agent, name, args = {}, signal = new AbortController().signal) => ctx.tools.execute({
    agent, name, arguments: args, callId: ToolCallId(`native-worktree-${++sequence}`), signal,
  })
  const ok = async (...args) => {
    const result = await invoke(...args)
    assert.notEqual(result.isError, true, textOf(result))
    return result
  }
  const create = async id => {
    const handle = await ctx.agents.create({ sessionId: id, meta: { cwd: root, agentPreset: 'blueprint' },
      agentOptions: { provider: 'worktree-fixture', model: 'directory' }, setup: async child => { await ctx.agentPresets.mount(child, 'blueprint') } })
    return handle.agent
  }
  return { root, source, home, roster, create, invoke, ok, open,
    get ctx() { return ctx }, async close() { await ctx.fiber.dispose(); ctx = null } }
}

test('App 和源码 bundle 使用同版官方工作树服务、随进程 Node 与共用目录工具', async () => {
  const version = await git(repo, '--version')
  const [, major, minor] = /git version (\d+)\.(\d+)/.exec(version)
  assert.ok(Number(major) > 2 || Number(major) === 2 && Number(minor) >= 45, version)
  const composition = await readDesktopComposition({resourceRoot:join(appRoot,'runtime'),sourceRoot:repo,promptDir:join(repo,'blueprint/packages/prompt'),resolvePlugin:name=>pathToFileURL(require.resolve(name)).href})
  const appRows = composition.patches.flatMap(row=>row.insert || [row])
  const patch = parse(await readFile(join(repo, 'blueprint/cordis.patch.yml'), 'utf8'), yamlOptions)
  const appWorktree = appRows.find(row => row.id === 'worktree')
  const sourceWorktree = patch.flatMap(row => row.insert || []).find(row => row.id === 'worktree')
  assert.deepEqual(appWorktree, sourceWorktree)
  assert.equal(appWorktree.name, '@deepseek-ai/dsh-experimental-worktree')
  assert.deepEqual(appWorktree.config, { nodeCommand: { __jsExpr: 'process.execPath' } })
  const canonical = parse(await readFile(join(repo, 'blueprint/agent.cordis.yml'), 'utf8'), yamlOptions)
  for (const [id, name] of [['tool-working-directory', '@deepseek-ai/dsh-tool-working-directory'],
    ['tool-worktree', '@deepseek-ai/dsh-experimental-tool-worktree']]) {
    assert.equal(canonical.find(row => row.id === id).name, name)
    assert.equal(require(`${name}/package.json`).version, '0.2.1-alpha.2')
  }
  assert.equal(require(`${appWorktree.name}/package.json`).version, '0.2.1-alpha.2')
})

test('真实 profile、Git 与 Seatbelt：自主工作树跟随当前目录，正式节点快照和交回保持独立', async t => {
  const f = await fixture(t)
  const agent = await f.create('native-worktree-owner')
  const peer = await f.create('native-worktree-peer')
  assert.equal(await git(f.source, 'branch', '--show-current'), 'node-1')
  await writeFile(join(f.source, '.gitattributes'), '*.txt filter=blueprint-native-check -text\n')
  await git(f.source, 'add', '.gitattributes')
  await git(f.source, '-c', 'user.name=Native worktree fixture', '-c', 'user.email=worktree@example.invalid', 'commit', '-m', '记录过滤器属性')
  const filter = join(f.root, '检出过滤器.cjs'), marker = join(f.root, '过滤器曾执行.txt')
  await writeFile(filter, `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write('filtered');\n`)
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  await git(f.source, 'config', 'filter.blueprint-native-check.clean', '/bin/cat')
  await git(f.source, 'config', 'filter.blueprint-native-check.smudge', `${quote(process.execPath)} ${quote(filter)}`)
  await git(f.source, 'config', 'filter.blueprint-native-check.required', 'true')
  const configuration = await readFile(join(f.root, '作品/.git/config'))
  const base = await git(f.source, 'rev-parse', 'HEAD')
  await writeFile(join(f.source, '已提交.txt'), '正式空间的未提交修正\n')
  await writeFile(join(f.source, '未跟踪.txt'), '本地草稿\n')
  await f.ok(agent, 'working_directory', { cd: f.source })
  const result = await f.ok(agent, 'create_worktree', { name: 'independent-draft' })
  const created = result.value
  assert.deepEqual(created, { path: join(f.source, '.agents/worktrees/independent-draft'), branch: 'independent-draft', baseCommit: base, repositoryRoot: f.source })
  assert.equal(f.ctx.worktrees.config.nodeCommand, process.execPath, 'Loader 实际解析运行时 Node 表达式')
  assert.equal(f.ctx.workingDirectory.get(agent.session), created.path)
  assert.equal(f.ctx.workingDirectory.get(peer.session), f.root, '同项目另一 Session 没有被切目录')
  assert.equal(agent.session.header.cwd, f.root, '项目身份仍是原项目根')
  assert.equal(await readFile(join(created.path, '已提交.txt'), 'utf8'), '来源快照\n')
  await assert.rejects(access(marker), { code: 'ENOENT' }, '官方检出没有执行仓库 smudge 过滤器')
  assert.deepEqual(await readFile(join(f.root, '作品/.git/config')), configuration, '检出不改仓库过滤器配置')
  await assert.rejects(access(join(created.path, '未跟踪.txt')), { code: 'ENOENT' })
  const writeReceipt = await f.ok(agent, 'write', { file_path: '自主产物.txt', content: '自主分支文件\n' })
  assert.match(textOf(await f.ok(agent, 'read', { file_path: '自主产物.txt' })), /自主分支文件/)
  const { createAssistantMessage, createToolResultMessage, ToolCallId } = await load('@deepseek-ai/dsh-llm')
  const directoryLog = agent.session.snapshotEvents()
  const seq = directoryLog.at(-1).seq + 1
  const outputEvents = [...directoryLog,
    { type: 'tool/call', seq, data: { callId: ToolCallId('actual-write'), name: 'write', arguments: { file_path: '自主产物.txt' } } },
    { type: 'tool/result', seq: seq + 1, data: { message: createToolResultMessage({ callId: ToolCallId('actual-write'), content: writeReceipt.content, isError: false }) } },
    { type: 'assistant/message', seq: seq + 2, data: { message: createAssistantMessage({ source: { provider: 'fixture', model: 'directory' },
      content: [{ type: 'text', text: '[当前分支产物](自主产物.txt)' }] }) } },
  ]
  const actualRefs = 产物引用(outputEvents, agent.session.id, f.root)
  assert.deepEqual(actualRefs.map(row => row.path), Array(2).fill('作品空间/1/.agents/worktrees/independent-draft/自主产物.txt'), '真实目录事件、绝对写入回执与相对正文指向同一工作树文件')
  const shell = await f.ok(agent, 'bash', { command: 'pwd', description: '核对当前目录' })
  assert.equal(shell.value.cwd, created.path)
  assert.match(textOf(shell), new RegExp(created.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  await f.ok(agent, 'write', { file_path: 'demo.html', content: '<title>原生工作树页面</title><link rel="stylesheet" href="demo.css"><img src="cover.png">' })
  await f.ok(agent, 'write', { file_path: 'demo.css', content: 'body { color: red }' })
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3AAAAABJRU5ErkJggg==', 'base64')
  await writeFile(join(created.path, 'cover.png'), image)
  const artifact = await 检查产物(f.root, { entry: 'demo.html', cover: 'cover.png' }, { cwd: created.path })
  const items = await 汇集产物(f.root, [{ ...artifact, kind: 'web', declaration: artifact, session: agent.session.id, seq: 1, time: 1, source: '交付入口' }], [], [])
  assert.equal(items[0].available, true)
  assert.equal(items[0].cover.path, artifact.coverPath)
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(1))
      await 发送预览文件(req, res, await 安全产物文件(f.root, path, { preview: true }))
    } catch { if (!res.headersSent) res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const pageURL = new URL(artifact.path.split('/').map(encodeURIComponent).join('/'), `http://127.0.0.1:${server.address().port}/`)
    const page = await fetch(pageURL)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /原生工作树页面/)
    const css = await fetch(new URL('demo.css', pageURL))
    assert.equal(css.status, 200)
    assert.match(css.headers.get('content-type'), /^text\/css/)
    assert.equal(await css.text(), 'body { color: red }')
    const cover = await fetch(new URL('cover.png', pageURL))
    assert.equal(cover.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await cover.arrayBuffer()), image)
    assert.equal((await fetch(new URL('.git', pageURL))).status, 404)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  const formal = await 提交节点空间(f.root, '1', '正式交回仍提交节点空间')
  assert.ok(formal)
  const receipt = await 节点成果版本(f.root, '1')
  assert.equal(receipt.path, '作品空间/1')
  assert.equal(receipt.branch, 'node-1')
  assert.equal(await git(created.path, 'rev-parse', 'HEAD'), base, '正式交回没有提交自主分支')
  assert.equal(await git(f.source, 'status', '--porcelain'), '')
  assert.match(await git(f.source, 'worktree', 'list', '--porcelain'), /作品空间\/1/)
  assert.ok(agent.session.ownEvents().some(event => event.type === 'working-directory/change' && event.data.cwd === created.path))
  const id = agent.session.id
  await agent.whenIdle()
  await f.close()
  await f.open()
  const handle = await f.ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'worktree-fixture', model: 'directory' },
    setup: async child => { await f.ctx.agentPresets.mount(child, 'blueprint') } })
  assert.equal(f.ctx.workingDirectory.get(handle.agent.session), created.path, 'JSONL 重启恢复当前目录')
  assert.equal((await f.ok(handle.agent, 'working_directory')).value.cwd, created.path)
  assert.equal(handle.agent.session.header.cwd, f.root)
  await rm(created.path, { recursive: true })
  assert.equal((await f.ok(handle.agent, 'working_directory')).value.cwd, f.root, '检出目录消失沿官方语义回原项目')
  assert.equal(await git(f.source, 'rev-parse', '--verify', 'refs/heads/independent-draft'), base, '目录恢复不删除保留的分支')
})

test('真实项目边界与冲突：目录工具和工作树不能切到其他项目，失败不改变调用 Session', async t => {
  const f = await fixture(t)
  const agent = await f.create('native-worktree-refusal')
  const other = await realpath(await mkdtemp(join(repo, '项目/.原生工作树邻居-')))
  t.after(() => rm(other, { recursive: true, force: true }))
  await writeFile(join(other, '秘密.txt'), 'OTHER_PROJECT_SECRET')
  await symlink(other, join(f.root, '跨项目软链接'))
  for (const cd of [other, join(f.root, '跨项目软链接'), '..']) {
    const result = await f.invoke(agent, 'working_directory', { cd })
    assert.equal(result.isError, true)
    assert.match(textOf(result), /PROJECT_ISOLATION/)
    assert.equal(f.ctx.workingDirectory.get(agent.session), f.root)
  }
  await f.ok(agent, 'working_directory', { cd: f.source })
  for (const request of [{ name: 'node-1' }, { name: '../escape' }, { name: 'missing-object', from: 'absent-local-ref' }]) {
    const result = await f.invoke(agent, 'create_worktree', request)
    assert.equal(result.isError, true)
    assert.equal(f.ctx.workingDirectory.get(agent.session), f.source)
  }
  await assert.rejects(access(join(f.source, '.agents')), { code: 'ENOENT' })
  const read = await f.invoke(agent, 'read', { file_path: join(other, '秘密.txt') })
  assert.equal(read.isError, true)
  assert.ok(!textOf(read).includes('OTHER_PROJECT_SECRET'))
  const shell = await f.ok(agent, 'bash', { command: `/bin/cat '${join(other, '秘密.txt')}'`, description: '核对项目读取边界' })
  assert.notEqual(shell.value.exitCode, 0)
  assert.ok(!textOf(shell).includes('OTHER_PROJECT_SECRET'))
})

test('取消与检出失败保留官方语义：不抢改目录，不删除已经建立的分支与工作树', async t => {
  const f = await fixture(t)
  const agent = await f.create('native-worktree-cancel-failure')
  await f.ok(agent, 'working_directory', { cd: f.source })
  const controller = new AbortController()
  controller.abort(new Error('工作树调用已取消'))
  await assert.rejects(f.ctx.worktrees.create(agent, { name: 'cancelled-before-start' }, controller.signal), /工作树调用已取消/)
  assert.equal(f.ctx.workingDirectory.get(agent.session), f.source)
  assert.equal(await git(f.source, 'branch', '--list', 'cancelled-before-start'), '')
  const afterAdd = new AbortController()
  const spawn = f.ctx.subprocess.spawn
  let allocationCompleted = false
  f.ctx.subprocess.spawn = function (spec) {
    const child = spawn.call(this, spec)
    if (!(spec.argv.includes('worktree') && spec.argv.includes('add') && spec.argv.includes('cancelled-after-add'))) return child
    const done = child.done.then(outcome => {
      allocationCompleted = outcome.exitCode === 0
      afterAdd.abort(new Error('登记完成后取消'))
      return outcome
    })
    return new Proxy(child, { get(target, key) {
      if (key === 'done') return done
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  try {
    const cancelled = await f.invoke(agent, 'create_worktree', { name: 'cancelled-after-add' }, afterAdd.signal)
    assert.equal(allocationCompleted, true, '取消发生在真实 git worktree add 完成之后')
    assert.equal(cancelled.isError, true)
    assert.equal(f.ctx.workingDirectory.get(agent.session), f.source)
    assert.match(await git(f.source, 'branch', '--list', 'cancelled-after-add'), /cancelled-after-add/)
    await access(join(f.source, '.agents/worktrees/cancelled-after-add/.git'))
    await assert.rejects(access(join(f.source, '.agents/worktrees/cancelled-after-add/已提交.txt')), { code: 'ENOENT' })
  } finally { f.ctx.subprocess.spawn = spawn }
  const included = join(f.root, '分支专用无效配置')
  await writeFile(included, '[invalid configuration\n')
  await git(f.source, 'config', 'includeIf.onbranch:failed-checkout.path', included)
  const failure = await f.invoke(agent, 'create_worktree', { name: 'failed-checkout' })
  assert.equal(failure.isError, true)
  assert.match(textOf(failure), /Any created checkout and branch are retained/)
  assert.equal(f.ctx.workingDirectory.get(agent.session), f.source)
  assert.match(await git(f.source, 'branch', '--list', 'failed-checkout'), /failed-checkout/)
  await access(join(f.source, '.agents/worktrees/failed-checkout/.git'))
  await assert.rejects(access(join(f.source, '.agents/worktrees/failed-checkout/已提交.txt')), { code: 'ENOENT' })
  const repeated = await f.invoke(agent, 'create_worktree', { name: 'failed-checkout' })
  assert.equal(repeated.isError, true)
  assert.match(textOf(repeated), /branch already exists/)
})
