import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import LocalFS from '@deepseek-ai/dsh-fs-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Bash from '@deepseek-ai/dsh-bash-local'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import * as ToolFS from '@deepseek-ai/dsh-tool-fs'
import * as ToolSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolWorkingDirectory from '@deepseek-ai/dsh-tool-working-directory'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { 项目路径, 技能路径, 仓库根, 数据根, 项目位置们 } from '../prompt/src/路径.js'
import { 只回一段字 } from '../prompt/src/index.js'
import { 装项目隔离, 工具执行目录, 文件许可, 隔离命令, 隔离规则, 真路径 } from './src/项目隔离.js'
import { 进入产物空间 } from './src/会话.js'

const 文本 = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const 成功 = result => { assert.equal(result.isError, false, JSON.stringify(result)); return result }
const 拒绝 = result => { assert.equal(result.isError, true, JSON.stringify(result)); assert.match(JSON.stringify(result), /PROJECT_ISOLATION|MACHINE_STORAGE/); return result }

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(项目路径, '原生当前目录核对-')))
  const other = await realpath(await mkdtemp(join(项目路径, '目录隔离邻居核对-')))
  const persistence = await realpath(await mkdtemp(join(tmpdir(), 'Blueprint 原生目录持久化-')))
  const first = join(root, '当前目录 中文 空格'), second = join(root, '另一目录'), contexts = []
  for (const directory of [first, second, join(root, '系统文档')]) await mkdir(directory)
  await writeFile(join(root, '当前样本.txt'), 'ROOT_SAMPLE')
  await writeFile(join(first, '当前样本.txt'), 'CURRENT_SAMPLE')
  await writeFile(join(second, '当前样本.txt'), 'SECOND_SAMPLE')
  await writeFile(join(other, '秘密.txt'), 'OTHER_PROJECT_SECRET')
  await writeFile(join(root, '系统文档/任务.db'), '机器原文')
  await symlink(other, join(first, '越界目录'))
  t.after(async () => {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    for (const directory of [root, other, persistence]) await rm(directory, { recursive: true, force: true })
  })
  const requests = []
  let childTools = false
  async function host() {
    const ctx = new Context(); contexts.push(ctx)
    for (const plugin of [LlmRuntime, SessionStore, SessionProjections, SystemPrompt, Tools, Agents, LocalFS, Subprocess, WorkingDirectory]) await ctx.plugin(plugin)
    await ctx.plugin(SessionPersistence, { root: persistence, compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(ShellEnv, { dshHome: persistence })
    await ctx.plugin(Bash, { timeoutMs: 10000 })
    await ctx.plugin(ToolFS)
    await ctx.plugin(ToolSearch, { sampleOverCapGlobResults: false })
    await ctx.plugin(ToolBash, { enableRunInBackground: false })
    await ctx.plugin(ToolWorkingDirectory)
    await ctx.plugin(Subagents)
    await ctx.plugin(Spawn, { providerName: 'spawn' })
    装项目隔离(ctx)
    ctx.tools.register({ name: 'directory_probe', description: '核对本次工具的目录',
      parameters: { type: 'object', properties: {} }, output: 只回一段字,
      async execute() {
        const path = await ctx.fs.resolve('当前样本.txt')
        const stat = await ctx.fs.lstat('当前样本.txt')
        const process = ctx.subprocess.spawn({ argv: ['/bin/pwd'],
          stdio: { stdin: 'ignore', stdout: { maxBytes: 2000 }, stderr: { maxBytes: 2000 } }, graceMs: 100 })
        assert.equal((await process.done).exitCode, 0)
        return { 文: JSON.stringify({ path: ctx.fs.processPath(path), text: await ctx.fs.readText(path), type: stat.type,
          cwd: process.collected.stdout.readFrom(0).text.trim(), toolCwd: 工具执行目录() }) }
      },
    })
    class DirectoryModel extends LlmAdapter {
      async resolveModel(provider, model) { return { provider, id: model, name: model } }
      async *stream(options) {
        const agent = ctx.agents.requireInitiator()
        const firstCall = !requests.some(call => call.id === agent.id)
        requests.push({ id: agent.id, header: agent.session.header, cwd: ctx.workingDirectory.get(agent.session), options })
        if (childTools && agent.session.header.origin === 'subagent' && firstCall) {
          const calls = [['read', { file_path: '当前样本.txt' }], ['grep', { pattern: 'CURRENT_SAMPLE', path: '当前样本.txt' }], ['bash', { command: 'pwd && cat 当前样本.txt', description: '核对继承的有效目录' }]]
          for (let index = 0; index < calls.length; index++) {
            const [name, args] = calls[index]
            yield { type: 'block-start', index, blockType: 'tool-call' }
            yield { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(`directory-${name}`), name, arguments: JSON.stringify(args) } }
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '原生目录核对已交回。' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    }
    ctx.llm.registerAdapter(['directory-fixture'], new DirectoryModel())
    return ctx
  }
  const ctx = await host(), options = { provider: 'directory-fixture', model: 'directory-fixture' }
  const handle = await ctx.agents.create({ sessionId: 'native-directory-parent', meta: { cwd: root }, agentOptions: options })
  let callId = 0
  const call = (name, args = {}, agent = handle.agent, owner = ctx) => owner.tools.execute({ name,
    arguments: name === 'bash' ? { description: '核对命令的有效目录', ...args } : args, agent,
    callId: ToolCallId(`native-directory-${++callId}`), signal: new AbortController().signal })
  return { root, other, first, second, persistence, ctx, agent: handle.agent, handle, host, options, call, requests,
    childTools: () => { childTools = true } }
}

async function 核对工具目录(f, expected, marker, agent = f.agent, ctx = f.ctx) {
  assert.equal(文本(成功(await f.call('working_directory', {}, agent, ctx))), expected)
  assert.match(文本(成功(await f.call('read', { file_path: '当前样本.txt' }, agent, ctx))), new RegExp(marker))
  const grep = 成功(await f.call('grep', { pattern: marker, path: '当前样本.txt' }, agent, ctx))
  assert.equal(grep.value.matches.length, 1)
  assert.equal(grep.value.matches[0].line, marker)
  const glob = 成功(await f.call('glob', { pattern: '当前样本.txt' }, agent, ctx))
  assert.equal(glob.value.root, '.')
  assert.deepEqual(glob.value.paths.slice().sort(), (expected === f.root
    ? ['当前样本.txt', '另一目录/当前样本.txt'] : ['当前样本.txt']).sort())
  const bash = 成功(await f.call('bash', { command: 'pwd && cat 当前样本.txt' }, agent, ctx))
  assert.equal(bash.value.cwd, expected)
  assert.equal(bash.value.stdout.text.trim(), `${expected}\n${marker}`)
  const direct = JSON.parse(文本(成功(await f.call('directory_probe', {}, agent, ctx))))
  assert.deepEqual(direct, { path: join(expected, '当前样本.txt'), text: marker, type: 'file', cwd: expected, toolCwd: expected })
  assert.equal(agent.session.header.cwd, f.root, '目录切换不改项目身份')
  assert.equal(工具执行目录(), undefined, '宿主域不残留某次工具调用的目录')
}

test('原生 cd 后文件、搜索、Bash 与默认 provider 调用均采用当前目录，显式相对目录也一致', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  assert.equal(文本(成功(await f.call('working_directory', { cd: '当前目录 中文 空格' }))), f.first)
  await 核对工具目录(f, f.first, 'CURRENT_SAMPLE')
  成功(await f.call('write', { file_path: '本次写入.txt', content: '写在有效目录' }))
  成功(await f.call('edit', { file_path: '本次写入.txt', old_string: '有效目录', new_string: '当前目录' }))
  assert.equal(await readFile(join(f.first, '本次写入.txt'), 'utf8'), '写在当前目录')
  await assert.rejects(readFile(join(f.root, '本次写入.txt')), { code: 'ENOENT' })
  const bash = 成功(await f.call('bash', { command: 'pwd && cat 当前样本.txt', workdir: '../另一目录' }))
  assert.equal(await realpath(bash.value.cwd), f.second)
  assert.equal(bash.value.stdout.text.trim(), `${f.second}\nSECOND_SAMPLE`)
  assert.equal(f.ctx.workingDirectory.get(f.agent.session), f.first, '单次 bash workdir 不改变 Session 目录')
  // 程序保存的项目相对路径仍按项目根恢复，不借用该次工具的解析基准。
  assert.equal(文件许可({ 根: f.root, 目录: f.first, 技能: await realpath(技能路径) }, '系统文档/任务.db'), join(f.root, '系统文档/任务.db'))
})

test('切换目录后跨项目读、搜索、命令及 cd 都拒绝，机器写保护仍锚原项目', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  成功(await f.call('working_directory', { cd: f.first }))
  const paths = [join(f.other, '秘密.txt'), '越界目录/秘密.txt']
  for (const path of paths) {
    拒绝(await f.call('read', { file_path: path }))
    拒绝(await f.call('grep', { pattern: 'OTHER_PROJECT_SECRET', path }))
    const bash = 成功(await f.call('bash', { command: `cat '${path.replaceAll("'", "'\\''")}'`, workdir: f.first }))
    assert.notEqual(bash.value.exitCode, 0)
    assert.doesNotMatch(bash.value.stdout.text, /OTHER_PROJECT_SECRET/)
  }
  for (const directory of [f.other, '越界目录', 技能路径]) 拒绝(await f.call('working_directory', { cd: directory }))
  assert.equal(f.ctx.workingDirectory.get(f.agent.session), f.first)
  assert.equal(f.agent.session.ownEvents().filter(event => event.type === 'working-directory/change').length, 1, '拒绝切换不提交新的目录事实')
  拒绝(await f.call('write', { file_path: '../系统文档/任务.db', content: '越权改写' }))
  拒绝(await f.call('edit', { file_path: '../系统文档/任务.db', old_string: '机器原文', new_string: '越权改写' }))
  const denied = 成功(await f.call('bash', { command: 'printf forbidden > ../系统文档/任务.db' }))
  assert.notEqual(denied.value.exitCode, 0)
  assert.equal(await readFile(join(f.root, '系统文档/任务.db'), 'utf8'), '机器原文')
})

test('原生 glob 排序只获得内置 rg 的精确元数据，程序正文及其目录仍不可读取', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-tool-fs-search'))
  const program = await realpath(require('@vscode/ripgrep').rgPath)
  const scope = { 根: f.root, 仓库: await realpath(数据根), 技能: await realpath(技能路径),
    保护根: [...new Set([await realpath(数据根), await realpath(仓库根), ...项目位置们().map(真路径)])], 搜索: true }
  const spec = 隔离命令({ argv: [program, '--files', '--sort=modified', '--glob', '当前样本.txt'], cwd: f.first }, scope)
  const result = spawnSync(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), '当前样本.txt')
  const policy = '(version 1)\n(allow default)\n' + 隔离规则({ ...scope, 元数据文件: [program] })
  const run = argv => spawnSync('/usr/bin/sandbox-exec', ['-p', policy, ...argv], { cwd: f.first, encoding: 'utf8' })
  assert.equal(run(['/usr/bin/stat', '-f', '%m', program]).status, 0)
  for (const argv of [['/bin/cat', program], ['/bin/ls', dirname(program)], ['/bin/ls', f.other]]) {
    assert.notEqual(run(argv).status, 0, JSON.stringify(argv))
  }
})

test('原生目录事件跨宿主冷恢复；当前目录消失时沿原生服务恢复项目根', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  成功(await f.call('working_directory', { cd: f.first }))
  await f.ctx.sessions.flush(f.agent.session)
  await f.ctx.fiber.dispose()
  const cold = await f.host()
  const { agent } = await cold.agents.resume({ resumeSessionId: f.agent.id, agentOptions: f.options })
  assert.equal(cold.workingDirectory.get(agent.session), f.first)
  await 核对工具目录(f, f.first, 'CURRENT_SAMPLE', agent, cold)
  assert.equal(agent.session.ownEvents().filter(event => event.type === 'working-directory/change').length, 1)
  await rm(f.first, { recursive: true })
  await 核对工具目录(f, f.root, 'ROOT_SAMPLE', agent, cold)
  assert.deepEqual(agent.session.ownEvents().filter(event => event.type === 'working-directory/change').map(event => event.data.cwd), [f.first, f.root])
})

test('节点出生时当前目录进入自己的产物空间，项目身份仍是项目根；0 号进入作品', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  for (const path of ['作品', '作品空间/3']) await mkdir(join(f.root, path), { recursive: true })
  for (const [id, space] of [['3', '作品空间/3'], ['0', '作品']]) {
    const { agent } = await f.ctx.agents.create({ sessionId: `native-directory-node-${id}`, meta: { cwd: f.root }, agentOptions: f.options,
      setup: (context, child) => 进入产物空间(context.get('workingDirectory'), child, f.root, id) })
    assert.equal(f.ctx.workingDirectory.get(agent.session), join(f.root, space))
    assert.equal(agent.session.header.cwd, f.root, '项目身份不变')
    assert.equal(成功(await f.call('bash', { command: 'pwd' }, agent)).value.cwd, join(f.root, space))
  }
})

test('冷恢复只把还停在项目根的旧节点搬进产物空间，换过目录的不动', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, '作品空间/2'), { recursive: true })
  const 迁 = (context, child) => 进入产物空间(context.get('workingDirectory'), child, f.root, '2', { 只从项目根迁: true })
  await f.ctx.sessions.flush(f.agent.session)
  await f.ctx.fiber.dispose()
  let host = await f.host()
  let { agent } = await host.agents.resume({ resumeSessionId: f.agent.id, agentOptions: f.options, setup: 迁 })
  assert.equal(host.workingDirectory.get(agent.session), join(f.root, '作品空间/2'))
  成功(await f.call('working_directory', { cd: f.first }, agent, host))
  await host.sessions.flush(agent.session)
  await host.fiber.dispose()
  host = await f.host()
  ;({ agent } = await host.agents.resume({ resumeSessionId: f.agent.id, agentOptions: f.options, setup: 迁 }))
  assert.equal(host.workingDirectory.get(agent.session), f.first, '模型自己换过的目录不被搬回')
  assert.equal(agent.session.header.cwd, f.root)
})

test('真实 spawn 子会话继承父有效目录并独立保留项目身份，父后续切换不改变子目录', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  成功(await f.call('working_directory', { cd: f.first }))
  f.childTools()
  const run = await f.ctx.subagents.startActivation({ provider: 'spawn', delivery: 'caller', label: '目录继承核对',
    signal: new AbortController().signal, request: { parent: f.agent,
      prompt: [{ type: 'text', text: '读取本次目录里的样本，核对搜索与命令。' }],
      toolFilter: { allow: ['read', 'grep', 'bash'] } } })
  const result = await run.result
  assert.equal(result.stopReason, 'completed', JSON.stringify(result))
  const calls = f.requests.filter(call => call.id === run.childId)
  assert.equal(calls.length, 2, '子会话经过真实三工具一步与结果消费一步')
  for (const call of calls) {
    assert.equal(call.header.cwd, f.root)
    assert.equal(call.header.parentSession, f.agent.id)
    assert.equal(call.cwd, f.first)
  }
  const results = calls[1].options.messages.filter(message => message.role === 'tool')
  assert.equal(results.length, 3)
  assert.ok(results.every(message => message.isError === false))
  assert.ok(results.every(message => 文本(message).includes('CURRENT_SAMPLE')))
  成功(await f.call('working_directory', { cd: '../另一目录' }))
  const stored = await f.ctx.sessionPersistence.open(run.childId, 'read')
  try {
    const { events } = await stored.read()
    const { header } = await f.ctx.sessionPersistence.stat(run.childId)
    assert.equal(header.cwd, f.root)
    assert.equal(events.findLast(event => event.type === 'working-directory/change').data.cwd, f.first)
  } finally { await stored.close(); await run.dispose() }
  assert.equal(f.ctx.workingDirectory.get(f.agent.session), f.second)
})
