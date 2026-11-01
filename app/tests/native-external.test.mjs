// 真正的 alpha 管理器、工具、Inbox 与持久查询；后端合成结果，不使用用户认证或外部模型。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, readFile, rm, cp, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { parse } from 'yaml'
import { inspectNativeExternalPatch, ensureNativeExternalPatch } from '../scripts/native-external-patch.mjs'
import { readDesktopComposition } from '../runtime/composition.mjs'
import { 读取外部协助, 停止外部协助 } from '../../blueprint/packages/studio/src/外部协助.js'

const app = fileURLToPath(new URL('../', import.meta.url)), repo = resolve(app, '..')
const require = createRequire(join(app, 'package.json'))
await ensureNativeExternalPatch(join(app, 'node_modules'))
const names = ['cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools',
  'dsh-agent', 'dsh-agent-loop', 'dsh-subagent', 'dsh-session-persistence-jsonl', 'dsh-session-query-sqlite',
  'dsh-working-directory', 'dsh-fs-local', 'dsh-tool-subagent', 'dsh-tool-subagent-control']
const native = Object.fromEntries(await Promise.all(names.map(async name => [name,
  await import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)])))
const { LlmAdapter, ToolCallId, createUserMessage } = native['dsh-llm']
const input = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const call = (id, name, args) => ({ type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) })
const waitFor = async predicate => {
  for (let index = 0; index < 400; index++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('原生外部执行未达到预期状态')
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'Blueprint原生外部执行-')))
  const worktree = join(root, '独立工作树'), home = join(root, '原生会话')
  await mkdir(worktree)
  const runs = new Map(), started = [], ended = [], errors = [], script = []
  let ctx
  t.after(async () => {
    for (const row of runs.values()) { row.cleanup.resolve(); row.result.resolve({ output: [], stopReason: 'aborted' }) }
    await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true })
  })
  class FixtureModel extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream() {
      const calls = script.shift()
      if (calls) {
        for (const [index, block] of calls.entries()) {
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'block-end', index, block }
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '父节点保留结果与责任。' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  const open = async () => {
    ctx = new native.cordis.Context()
    for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools',
      'dsh-agent', 'dsh-fs-local', 'dsh-working-directory']) await ctx.plugin(native[name].default)
    await ctx.plugin(native['dsh-session-persistence-jsonl'].default, { root: home, compression: 'none' })
    await ctx.plugin(native['dsh-session-query-sqlite'].default, { path: ':memory:', openAt: 'never' })
    await ctx.plugin(native['dsh-agent-loop'].default, { agents: [] })
    await ctx.plugin(native['dsh-subagent'].default)
    ctx.on('subagent/start', info => started.push(info))
    ctx.on('subagent/end', info => ended.push(info))
    ctx.on('agent/error', (_agent, error) => errors.push(error))
    for (const provider of ['codex', 'claude-code']) {
      ctx.subagents.registerProvider({ name: provider, capabilities: native['dsh-subagent'].NO_START_CAPABILITIES,
        inheritsParentContext: false, async start(request) {
          if (request.label === '拒绝启动') throw new Error('合成后端启动失败')
          const id = `${provider}-${runs.size}`, result = Promise.withResolvers(), cleanup = Promise.withResolvers()
          const row = { id, request, result, cleanup, disposals: 0 }
          runs.set(id, row)
          request.signal.addEventListener('abort', () => result.resolve({ output: [], stopReason: 'aborted' }), { once: true })
          if (request.label === '立即交回') result.resolve({ output: [{ type: 'text', text: '立即成果' }], stopReason: 'completed' })
          else if (request.label === '异步失败') result.resolve({ output: [], stopReason: 'error' })
          if (['立即交回', '异步失败'].includes(request.label)) cleanup.resolve()
          return { id, result: result.promise, async dispose() { row.disposals++; await cleanup.promise } }
        } })
      await ctx.plugin(native['dsh-tool-subagent'], { provider, toolName: provider === 'codex' ? 'subagent_codex' : 'subagent_claude_code', maxDepth: 'provider-managed' })
    }
    await ctx.plugin(native['dsh-tool-subagent-control'])
    ctx.llm.registerAdapter(['external-fixture'], new FixtureModel())
    return ctx
  }
  await open()
  const parent = await ctx.agentLoop.create('external-parent', { provider: 'external-fixture', model: 'fixture' }, { cwd: root })
  await ctx.workingDirectory.set(parent, worktree)
  return { root, worktree, parent, runs, started, ended, script, errors, open,
    get ctx() { return ctx }, async close() { await ctx.fiber.dispose(); ctx = null } }
}

// 叶 6（2026-10-18）：两家提供方仍随宿主接线；节点组装里不再有调它们的工具，选了它们的 run 由 node 的外部 run 直接用命令行启动。
test('两家官方提供方随宿主接线、默认权限不变；节点组装里没有调它们的工具', async () => {
  const composition = await readDesktopComposition({ resourceRoot: join(app, 'runtime'), sourceRoot: repo,
    promptDir: join(repo, 'blueprint/packages/prompt'), resolvePlugin: name => pathToFileURL(require.resolve(name)).href })
  const host = composition.patches.flatMap(row => row.insert || [])
  const yamlOptions = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ __jsExpr: value }) }] }
  const source = parse(await readFile(join(repo, 'blueprint/cordis.patch.yml'), 'utf8'), yamlOptions).flatMap(row => row.insert || [])
  const preset = parse(await readFile(join(repo, 'blueprint/agent.cordis.yml'), 'utf8'), yamlOptions)
  for (const [id, , toolName, mode] of [['subagent-codex', 'codex', 'subagent_codex', 'dangerously-bypass-approvals-and-sandbox'],
    ['subagent-claude-code', 'claude-code', 'subagent_claude_code', 'acceptEdits']]) {
    assert.equal(host.filter(row => row.id === id).length, 1, '宿主只组合一份提供方')
    assert.deepEqual(host.find(row => row.id === id), source.find(row => row.id === id))
    assert.equal(host.find(row => row.id === id).config.permissionMode, mode)
    assert.equal(preset.find(row => row.config?.toolName === toolName), undefined, `${toolName} 不再给节点`)
  }
  // 10-28：子代理控制（send_message、interrupt_agent、list_agents）照 dsh standard 装回，只给 run（roster 的 只给run的工具）。
  assert.ok(preset.some(row => row.name === '@deepseek-ai/dsh-tool-subagent-control'))
})

test('官方工具的并行启动与立即交回都持久关联实际目录，原生查询不借助外部Session', async t => {
  const f = await fixture(t)
  f.script.push([
    call('start-codex', 'subagent_codex', { description: '并行甲', prompt: '执行甲' }),
    call('start-claude', 'subagent_claude_code', { description: '并行乙', prompt: '执行乙', cwd: '..' }),
    call('fast-codex', 'subagent_codex', { description: '立即交回', prompt: '快任务' }),
  ])
  f.parent.followup(input('开始并行任务'), { mode: 'queue' })
  await waitFor(() => f.runs.size === 3 && f.parent.status === 'idle')
  const receipts = f.parent.session.ownEvents().filter(event => event.type === 'tool/result').map(event => event.data.meta.blueprintExternal)
  assert.equal(receipts.length, 3)
  for (const receipt of receipts) {
    assert.equal(receipt.cwd, f.runs.get(receipt.id).request.cwd)
    assert.ok(receipt.provider === 'codex' || receipt.provider === 'claude-code')
    assert.equal(f.ctx.sessions.get(receipt.id), undefined)
  }
  await waitFor(() => f.ended.some(row => row.id === receipts[2].id))
  assert.equal(receipts[0].cwd, f.worktree)
  assert.equal(receipts[1].cwd, f.root)
  const live = f.ctx.subagents.listExternalActivations(f.parent.id)
  assert.equal(live.length, 2)
  live[0].status = 'tampered'
  assert.equal(f.ctx.subagents.listExternalActivations(f.parent.id)[0].status, 'running', '查询返回分离的只读事实值')
  assert.deepEqual(f.ctx.subagents.listExternalActivations('other-parent'), [])
  const rows = (await 读取外部协助(f.ctx, f.parent.id)).rows
  assert.equal(rows.length, 3)
  assert.equal(rows.filter(row => row.canStop).length, 2)
  assert.ok(rows.find(row => row.id === receipts[2].id).report.text.includes('立即成果'))
  for (const row of f.runs.values()) { row.cleanup.resolve(); row.result.resolve({ output: [{ type: 'text', text: '各自成果' }], stopReason: 'completed' }) }
  await waitFor(() => f.ctx.subagents.listExternalActivations().length === 0 && f.parent.status === 'idle')
  assert.ok([...f.runs.values()].every(row => row.disposals === 1))
  const notices = f.parent.session.ownEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'subagent-settled')
  assert.equal(notices.length, 3, '每个子任务只有原生一份完成通知')
  await f.ctx.sessions.flush(f.parent.session)
  await f.close(); await f.open()
  const cold = await 读取外部协助(f.ctx, f.parent.id)
  assert.deepEqual(cold.rows.map(row => [row.id, row.provider, row.cwd]), rows.map(row => [row.id, row.provider, row.cwd]))
  assert.ok(cold.rows.every(row => row.status === 'reported' && !row.canStop))
  assert.deepEqual(f.ctx.subagents.listExternalActivations(), [])
})

test('停止先取消后等待清理，不能误停并行兄弟；失败启动不公布居民或伪成功回执', async t => {
  const f = await fixture(t)
  f.script.push([
    call('stop-owner', 'subagent_codex', { description: '停这份', prompt: '等待' }),
    call('keep-sibling', 'subagent_claude_code', { description: '留这份', prompt: '等待' }),
    call('reject-start', 'subagent_codex', { description: '拒绝启动', prompt: '启动错误' }),
    call('error-result', 'subagent_claude_code', { description: '异步失败', prompt: '异步错误' }),
  ])
  f.parent.followup(input('开始取消检查'), { mode: 'queue' })
  await waitFor(() => f.runs.size === 3 && f.parent.status === 'idle')
  const first = [...f.runs.values()].find(row => row.request.label === '停这份')
  const sibling = [...f.runs.values()].find(row => row.request.label === '留这份')
  const members = [{ sessionId: f.parent.id, cwd: f.root }, { sessionId: 'other-project', cwd: join(f.root, '其他项目') }]
  await assert.rejects(停止外部协助(f.ctx, members, { projectSessionId: 'other-project', parentSessionId: f.parent.id, childSessionId: first.id }), /不属于/)
  assert.equal(first.request.signal.aborted, false)
  await 停止外部协助(f.ctx, members, { projectSessionId: f.parent.id, parentSessionId: f.parent.id, childSessionId: first.id })
  assert.ok(first.request.signal.aborted)
  assert.equal(sibling.request.signal.aborted, false)
  await waitFor(() => first.disposals === 1)
  assert.equal(f.ctx.subagents.listExternalActivations(f.parent.id).find(row => row.id === first.id).status, 'stopping')
  assert.equal(f.ended.some(row => row.id === first.id), false, '资源释放之前不公布已收尾')
  first.cleanup.resolve()
  await waitFor(() => f.ended.some(row => row.id === first.id))
  assert.equal(f.ended.find(row => row.id === first.id).stopReason, 'aborted')
  assert.ok(f.ctx.subagents.listExternalActivations().some(row => row.id === sibling.id))
  const results = f.parent.session.ownEvents().filter(event => event.type === 'tool/result')
  assert.equal(results.find(event => event.data.message.toolCallId === 'reject-start').data.message.isError, true)
  assert.equal(results.find(event => event.data.message.toolCallId === 'reject-start').data.meta?.blueprintExternal, undefined)
  assert.ok(f.ended.some(row => row.stopReason === 'error'))
  sibling.cleanup.resolve()
  await f.ctx.subagents.drainChildren(f.parent, [sibling.id])
  assert.deepEqual(f.ctx.subagents.listExternalActivations(), [])
  assert.ok([...f.runs.values()].every(row => row.disposals === 1))
})

test('精确扩展拒绝版本漂移及部分改写，安装可重复核对', async t => {
  const root = await mkdtemp(join(tmpdir(), 'Blueprint外部协议扩展核对-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of ['@deepseek-ai/dsh-subagent', '@deepseek-ai/dsh-tool-subagent']) await cp(join(app, 'node_modules', name), join(root, name), { recursive: true })
  const patch = join(app, 'patches/native-external-0.2.1-alpha.2.patch')
  execFileSync('/usr/bin/patch', ['-s', '-f', '-R', '-d', root, '-p0', '-i', patch])
  assert.equal((await inspectNativeExternalPatch(root)).alreadyApplied, false)
  await ensureNativeExternalPatch(root)
  assert.equal((await ensureNativeExternalPatch(root)).alreadyApplied, true)
  const manifestPath = join(root, '@deepseek-ai/dsh-subagent/package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: '0.2.1-alpha.3' }))
  await assert.rejects(ensureNativeExternalPatch(root), /仅核对/)
  await writeFile(manifestPath, JSON.stringify(manifest))
  const entry = join(root, '@deepseek-ai/dsh-tool-subagent/lib/index.js')
  await writeFile(entry, (await readFile(entry, 'utf8')).replace('blueprintExternal:', 'unexpectedExternal:'))
  await assert.rejects(ensureNativeExternalPatch(root), /未安装/)
})
