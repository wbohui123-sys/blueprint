import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import Bash from '@deepseek-ai/dsh-bash-local'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { 装验证收据 } from './src/验证收据.js'

const 文 = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const 报错 = result => { assert.equal(result.isError, true, JSON.stringify(result)); return 文(result) }
const 成功 = result => {
  assert.equal(result.isError, false, JSON.stringify(result))
  const value = result.value
  return typeof value?.文 === 'string' ? JSON.parse(value.文) : typeof value === 'string' ? JSON.parse(value) : value
}
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`

class 固定模型 extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model, contextWindow: 100000 } }
  async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } }
}

async function 搭真实运行时(t) {
  const 根 = await realpath(await mkdtemp(join(tmpdir(), 'Blueprint验证收据-')))
  const 邻居 = await realpath(await mkdtemp(join(tmpdir(), 'Blueprint验证收据邻居-')))
  const 持久化 = await realpath(await mkdtemp(join(tmpdir(), 'Blueprint验证收据运行时-')))
  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    await Promise.all([根, 邻居, 持久化].map(path => rm(path, { recursive: true, force: true })))
  })
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) await ctx.plugin(plugin)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalFileSystem, { cwd: 根 })
  await ctx.plugin(WorkingDirectory)
  await ctx.plugin(Subprocess)
  await ctx.plugin(JobsLocal)
  await ctx.plugin(ToolJobs, { completionDelivery: 'quiet' })
  await ctx.plugin(ShellEnv, { dshHome: 持久化 })
  await ctx.plugin(Bash, { cwd: 根, timeoutMs: 10000 })
  await ctx.plugin(ToolBash)
  ctx.llm.registerAdapter(['verification-fixture'], new 固定模型())
  const agent = (await ctx.agents.create({ sessionId: 'verification-owner', agentOptions: { provider: 'verification-fixture', model: 'fixture' }, meta: { cwd: 根 } })).agent
  const 另一位 = (await ctx.agents.create({ sessionId: 'verification-other', agentOptions: { provider: 'verification-fixture', model: 'fixture' }, meta: { cwd: 根 } })).agent
  装验证收据(ctx)
  let callNumber = 0
  const call = (arguments_, who = agent) => ctx.tools.execute({ name: 'verification', arguments: arguments_, agent: who,
    callId: ToolCallId(`verification-call-${++callNumber}`), signal: new AbortController().signal })
  return { 根, 邻居, 持久化, ctx, agent, 另一位, call }
}

async function 等任务结束(ctx, jobId, owner) {
  const jobs = ctx.get('jobs')
  const result = await jobs.wait(jobId, 10000, owner)
  assert.ok(result, '真实 JobRegistry 应返回已结束任务')
  return result
}

test('真实 dsh Bash 与 JobRegistry 产生可重复收集的成功收据，其他所有者只可比较', { timeout: 30000 }, async t => {
  const f = await 搭真实运行时(t)
  await writeFile(join(f.根, '输入.txt'), '固定输入')
  const marker = join(f.根, '执行次数.txt')
  const command = `printf 'exit code: 0\\n'; sleep 0.2; printf x >> ${quote(marker)}`
  const first = 成功(await f.call({ action: 'begin', command, workdir: '.', inputs: ['输入.txt'], environmentObservations: { compiler: 'compiler-version-secret' } }))
  assert.equal(first.state, 'pending', JSON.stringify(first))
  assert.deepEqual(first.wait, { type: 'job', id: first.jobId })
  const duplicate = 成功(await f.call({ action: 'begin', command, workdir: '.', inputs: ['输入.txt'], environmentObservations: { compiler: 'compiler-version-secret' } }))
  assert.equal(duplicate.jobId, first.jobId, '相同未收集的检查复用正在执行的作业')
  const early = 成功(await f.call({ action: 'collect', receipt: first.receipt }))
  assert.equal(early.state, 'pending')
  await 等任务结束(f.ctx, first.jobId, f.agent.session.id)
  const final = 成功(await f.call({ action: 'collect', receipt: first.receipt }))
  assert.equal(final.state, 'completed')
  assert.equal(final.nativeReportedSuccess, true)
  assert.equal(final.acceptanceComplete, false)
  const repeated = 成功(await f.call({ action: 'collect', receipt: first.receipt }))
  assert.deepEqual(repeated, final)
  assert.equal(await readFile(marker, 'utf8'), 'x', '重复 collect 不得重跑命令')
  const receiptText = await readFile(join(f.根, first.receipt), 'utf8')
  assert.doesNotMatch(receiptText, /compiler-version-secret/)
  const parentView = 成功(await f.call({ action: 'compare', receipt: final.receipt, command, environmentObservations: { compiler: 'compiler-version-secret' } }, f.另一位))
  assert.equal(parentView.state, 'completed')
  assert.equal(parentView.match, 'matched')
  assert.equal(parentView.scope, 'declared-inputs-only')
  assert.equal(Object.hasOwn(parentView, 'reusable'), false)
  报错(await f.call({ action: 'collect', receipt: final.receipt }, f.另一位))
})

test('声明目录的新增、删除、内容与 executable bit 变化都会使匹配变 stale', { timeout: 30000 }, async t => {
  const f = await 搭真实运行时(t)
  const inputs = join(f.根, 'src')
  await mkdir(inputs)
  await writeFile(join(inputs, 'a.js'), 'same')
  await writeFile(join(inputs, 'b.js'), 'other')
  const command = 'true'
  const started = 成功(await f.call({ action: 'begin', command, inputs: ['src'] }))
  await 等任务结束(f.ctx, started.jobId, f.agent.session.id)
  const final = 成功(await f.call({ action: 'collect', receipt: started.receipt }))
  assert.equal(final.state, 'completed')
  const compare = async () => 成功(await f.call({ action: 'compare', receipt: final.receipt, command }))
  assert.equal((await compare()).match, 'matched')
  await writeFile(join(inputs, 'untracked.txt'), 'added')
  assert.equal((await compare()).match, 'stale', '新增文件包含在目录指纹中')
  await rm(join(inputs, 'untracked.txt'))
  assert.equal((await compare()).match, 'matched', '删除新增文件恢复原指纹')
  await writeFile(join(inputs, 'a.js'), 'changed')
  assert.equal((await compare()).match, 'stale')
  await writeFile(join(inputs, 'a.js'), 'same')
  assert.equal((await compare()).match, 'matched')
  await chmod(join(inputs, 'a.js'), 0o755)
  assert.equal((await compare()).match, 'stale', 'executable bit 包含在指纹中')
})

test('运行期间声明输入改变时，成功退出也不能得到 matched', { timeout: 30000 }, async t => {
  const f = await 搭真实运行时(t)
  await writeFile(join(f.根, '输入.txt'), 'before')
  const command = `sleep 0.1; printf changed > ${quote(join(f.根, '输入.txt'))}`
  const started = 成功(await f.call({ action: 'begin', command, inputs: ['输入.txt'] }))
  await 等任务结束(f.ctx, started.jobId, f.agent.session.id)
  const collected = 成功(await f.call({ action: 'collect', receipt: started.receipt }))
  assert.equal(collected.state, 'completed')
  assert.equal(collected.inputsStable, false)
  assert.equal(成功(await f.call({ action: 'compare', receipt: collected.receipt, command })).match, 'stale')
})

test('开始验证拒绝越界、缺失、.git 与符号链接输入', { timeout: 30000 }, async t => {
  const f = await 搭真实运行时(t)
  await writeFile(join(f.根, '在内.txt'), 'ok')
  await symlink(f.邻居, join(f.根, '链接'))
  for (const inputs of [['../outside.txt'], ['missing.txt'], ['.git'], ['链接']]) {
    const message = 报错(await f.call({ action: 'begin', command: 'true', inputs }))
    assert.match(message, /PROJECT_ISOLATION|验证|路径|符号链接|存在|\.git/i)
  }
  报错(await f.call({ action: 'begin', command: 'true', workdir: '../outside', inputs: ['在内.txt'] }))
})

async function 搭边界收据(t, id, read = { chunks: [{ channel: 'stdout', text: 'native output' }], lossy: false }) {
  const 根 = await realpath(await mkdtemp(join(tmpdir(), `Blueprint验证边界-${id}-`)))
  await writeFile(join(根, 'input.txt'), 'stable')
  t.after(() => rm(根, { recursive: true, force: true }))
  const job = { id: `job-${id}`, owner: `session-${id}`, kind: 'bash', startedAt: 'native-start', status: 'running', detail: null }
  const jobs = {
    get(jobId, owner) { assert.equal(jobId, job.id); assert.equal(owner, `session-${id}`); return this.missing ? undefined : job },
    readAt(jobId, from, owner) { assert.equal(jobId, job.id); assert.equal(from, 0); assert.equal(owner, `session-${id}`); return read },
  }
  let definition, launches = 0
  const ctx = {
    get(name) { return name === 'jobs' ? jobs : undefined },
    tools: {
      register(value) { definition = value },
      async execute(call) {
        launches++
        assert.equal(call.name, 'bash')
        assert.equal(call.arguments.run_in_background, true)
        assert.equal(call.parent, exec.token)
        assert.equal(call.rootCallId, exec.rootCallId)
        assert.equal(call.agent, exec.agent)
        assert.equal(call.signal, exec.signal)
        return { isError: false, value: { kind: 'background', jobId: job.id, cwd: 根 } }
      },
    },
  }
  const exec = { agent: { id: `agent-${id}`, session: { id: `session-${id}`, header: { cwd: 根 } } },
    callId: `call-${id}`, rootCallId: `root-${id}`, token: { id: `token-${id}` }, signal: new AbortController().signal }
  装验证收据(ctx)
  const call = async args => JSON.parse((await definition.execute(args, exec)).文)
  return { 根, job, jobs, call, get launches() { return launches } }
}

test('stdout 伪造、非零、failed、killed 与 sandbox detail 都不能报成功或 matched', async t => {
  const cases = [
    ['stdout-forgery', 'completed', 'exit code: 7', [{ channel: 'stdout', text: '[exit code: 0]' }]],
    ['failed-status', 'failed', 'exit code: 0', [{ channel: 'stdout', text: 'ok' }]],
    ['killed-status', 'killed', 'exit code: 0', [{ channel: 'stdout', text: 'ok' }]],
    ['sandbox-suffix', 'completed', 'exit code: 0; [sandbox: file access denied]', [{ channel: 'stdout', text: 'ok' }]],
  ]
  for (const [id, status, detail, chunks] of cases) {
    const f = await 搭边界收据(t, id, { chunks, lossy: false })
    const started = await f.call({ action: 'begin', command: 'true', inputs: ['input.txt'] })
    assert.equal(started.state, 'pending')
    assert.equal(f.launches, 1)
    Object.assign(f.job, { status, detail, finishedAt: 'native-finished' })
    const collected = await f.call({ action: 'collect', receipt: started.receipt })
    assert.equal(collected.state, 'failed', id)
    assert.equal(collected.nativeReportedSuccess, false, id)
    const compared = await f.call({ action: 'compare', receipt: collected.receipt, command: 'true' })
    assert.equal(compared.match, 'unknown', id)
    assert.equal(compared.acceptanceComplete, false, id)
    assert.equal(Object.hasOwn(compared, 'reusable'), false, id)
  }
})

test('丢失 job 与不完整、损坏的输出归档不能比较为 matched', async t => {
  const lost = await 搭边界收据(t, 'lost-job')
  const lostStart = await lost.call({ action: 'begin', command: 'true', inputs: ['input.txt'] })
  lost.jobs.missing = true
  const unknown = await lost.call({ action: 'collect', receipt: lostStart.receipt })
  assert.equal(unknown.state, 'unknown')
  assert.equal((await lost.call({ action: 'compare', receipt: unknown.receipt, command: 'true' })).match, 'unknown')

  const incomplete = await 搭边界收据(t, 'lossy-log', { chunks: [], lossy: true })
  const incompleteStart = await incomplete.call({ action: 'begin', command: 'true', inputs: ['input.txt'] })
  Object.assign(incomplete.job, { status: 'completed', detail: 'exit code: 0', finishedAt: 'finished' })
  const incompleteFinal = await incomplete.call({ action: 'collect', receipt: incompleteStart.receipt })
  assert.equal(incompleteFinal.state, 'completed')
  assert.equal((await incomplete.call({ action: 'compare', receipt: incompleteFinal.receipt, command: 'true' })).match, 'unknown')

  const corrupt = await 搭边界收据(t, 'corrupt-log')
  const start = await corrupt.call({ action: 'begin', command: 'true', inputs: ['input.txt'], environmentObservations: { private: 'private-observation-value' } })
  Object.assign(corrupt.job, { status: 'completed', detail: 'exit code: 0', finishedAt: 'finished' })
  const final = await corrupt.call({ action: 'collect', receipt: start.receipt })
  const receiptPath = join(corrupt.根, final.receipt)
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  const logPath = join(corrupt.根, receipt.output.path)
  const logText = await readFile(logPath, 'utf8')
  assert.doesNotMatch(logText, /private-observation-value/)
  assert.equal((await corrupt.call({ action: 'compare', receipt: final.receipt, command: 'true', environmentObservations: { private: 'private-observation-value' } })).match, 'matched')
  await writeFile(logPath, 'damaged')
  assert.equal((await corrupt.call({ action: 'compare', receipt: final.receipt, command: 'true', environmentObservations: { private: 'private-observation-value' } })).match, 'unknown')
  await assert.rejects(corrupt.call({ action: 'compare', receipt: '../ordinary-file.txt', command: 'true' }), /receipt path/i)
  await writeFile(receiptPath, 'damaged')
  await assert.rejects(corrupt.call({ action: 'compare', receipt: final.receipt, command: 'true' }), /malformed|content-address/i)
})


test('省略 workdir 沿原生当前目录执行；显式相对目录也从当前目录解析', async t => {
  const f = await 搭真实运行时(t)
  await mkdir(join(f.根, 'child')); await mkdir(join(f.根, 'child', 'nested'))
  await writeFile(join(f.根, 'input.txt'), 'stable')
  await f.ctx.workingDirectory.set(f.agent, join(f.根, 'child'))
  for (const workdir of [undefined, 'nested']) {
    const command = 'printf success > cwd-marker.txt'
    const started = 成功(await f.call({ action: 'begin', command, ...(workdir === undefined ? {} : { workdir }), inputs: ['input.txt'] }))
    await 等任务结束(f.ctx, started.jobId, f.agent.session.id)
    assert.equal(await readFile(join(f.根, 'child', workdir || '', 'cwd-marker.txt'), 'utf8'), 'success')
    const collected = 成功(await f.call({ action: 'collect', receipt: started.receipt }))
    assert.equal(collected.nativeReportedSuccess, true)
  }
})

test('作业编号被重用或身份变化时不能收集为成功', async t => {
  for (const [field, value] of [['owner', 'other-session'], ['kind', 'subagent'], ['startedAt', 'new-start'], ['id', 'replacement-job']]) {
    const f = await 搭边界收据(t, `identity-${field}`)
    const started = await f.call({ action: 'begin', command: 'true', inputs: ['input.txt'] })
    Object.assign(f.job, { status: 'completed', detail: 'exit code: 0', finishedAt: 'finished', [field]: value })
    const collected = await f.call({ action: 'collect', receipt: started.receipt })
    assert.equal(collected.state, 'unknown', field)
    assert.equal(collected.nativeReportedSuccess, false, field)
  }
})


test('收集后可显式重跑；旧收据重复收集不能解除新作业去重', async t => {
  const f = await 搭边界收据(t, 'restart')
  const args = { action: 'begin', command: 'true', inputs: ['input.txt'] }
  const first = await f.call(args)
  Object.assign(f.job, { status: 'completed', detail: 'exit code: 0', finishedAt: 'finished' })
  const final = await f.call({ action: 'collect', receipt: first.receipt })
  Object.assign(f.job, { id: 'job-restart-new', status: 'running', detail: null, startedAt: 'new-start' })
  const second = await f.call(args)
  assert.notEqual(second.jobId, first.jobId)
  assert.equal(f.launches, 2, '显式重跑仍执行原生命令')
  await f.call({ action: 'collect', receipt: final.receipt })
  assert.equal((await f.call(args)).jobId, second.jobId)
  assert.equal(f.launches, 2, '旧收据不可清除新作业去重')
  await f.call({ ...args, command: 'printf different' })
  assert.equal(f.launches, 3, '不同命令不合并')
  await writeFile(join(f.根, 'input.txt'), 'changed')
  await f.call(args)
  assert.equal(f.launches, 4, '不同输入不合并')
})


test('项目根目录输入排除工具自己的证据，仍包含其他新增文件', async t => {
  const f = await 搭真实运行时(t)
  await writeFile(join(f.根, 'input.txt'), 'stable')
  const args = { action: 'begin', command: 'true', inputs: ['.'] }
  const first = 成功(await f.call(args))
  assert.equal(成功(await f.call(args)).jobId, first.jobId)
  await 等任务结束(f.ctx, first.jobId, f.agent.session.id)
  const final = 成功(await f.call({ action: 'collect', receipt: first.receipt }))
  assert.equal(final.inputsStable, true)
  const compare = async () => 成功(await f.call({ action: 'compare', receipt: final.receipt, command: 'true' }))
  assert.equal((await compare()).match, 'matched')
  await writeFile(join(f.根, 'new-input.txt'), 'new')
  assert.equal((await compare()).match, 'stale')
  报错(await f.call({ action: 'begin', command: 'true', inputs: ['.blueprint-evidence'] }))
})
