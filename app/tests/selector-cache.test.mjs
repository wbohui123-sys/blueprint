import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime, createUserMessage } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { 落新名册, 排队, 写工作文档, 新工作文档, 模型表路径, 改名册, 记会话 } from '../../blueprint/packages/roster/src/index.js'
import { 节点前缀来路, 节点前缀版本 } from '../../blueprint/packages/context/src/拼.js'
import { 装 as 装上下文 } from '../../blueprint/packages/context/src/index.js'
import { 装思考开头 } from '../../blueprint/packages/node/src/思考开头.js'
import { 选择机输入, 选阶段 } from '../../blueprint/packages/node/src/选择机.js'

const tool = name => ({ name, description: name, parameters: { type: 'object', properties: {} } })
const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

// 经过原生 LlmRuntime 的工具历史投影和 DeepSeek Messages 序列化；只替换 HTTP 返回值。
function transport(t, toolUpdate) {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'https://cache-test.invalid/anthropic/v1/messages')
    requests.push({ body: JSON.parse(options.body), headers: options.headers })
    const events = [
      ['message_start', { message: { id: 'fixture', usage: { input_tokens: 10, output_tokens: 0 } } }],
      ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'plan' } }],
      ['content_block_stop', { index: 0 }],
      ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 1 } }],
      ['message_stop', {}],
    ]
    return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } })
  })
  const ctx = new Context(), llm = new LlmRuntime(ctx)
  const options = resolveAdapterOptions({ baseURL: 'https://cache-test.invalid/anthropic',
    models: [{ id: 'deepseek-flash', systemPromptUpdate: 'in-history', ...(toolUpdate ? { toolUpdate } : {}) }] })
  const dispose = llm.registerAdapter(['fixture'], new DeepSeekAdapter({ options: () => options,
    resolveAuth: async () => ({ headers: {} }), resolveUserId: () => 'cache-test-user',
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) }))
  t.after(dispose)
  return { ctx, llm, requests }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'blueprint-selector-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const roster = await 落新名册(root, '缓存核对', '核对原生请求前缀'), row = roster.rows[0]
  await 排队(root, () => 写工作文档(root, row, 新工作文档(row, '核对原生请求前缀')))
  const baseline = [tool('next'), tool('bash')], added = tool('web')
  const history = [
    { role: 'system', content: [{ type: 'text', text: '稳定的系统提示' }] },
    user('任务与稳定前缀'),
    { role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'deepseek-flash' }, content: [{ type: 'text', text: '开始工作。' }] },
    { id: 'tools-changed', role: 'developer', content: [
      { type: 'tool-addition', toolName: 'web' }, { type: 'tool-removal', toolName: 'bash' },
    ] },
    user('工具已更新'),
    { role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'deepseek-flash' }, content: [{ type: 'text', text: '继续工作。' }] },
  ]
  const toolHistory = { tools: baseline, updates: [{ messageId: 'tools-changed', additions: [added] }] }
  const header = { config: { provider: 'fixture', model: 'deepseek-flash', reasoningEffort: 'max' }, tools: [baseline[0], added] }
  const session = { id: 'cache-test-session', requestHeader: () => header, deriveMessages: () => history, toolHistory: () => toolHistory }
  return { root, row, history, header, session, toolHistory }
}

for (const mode of ['addition-only', 'in-history', undefined]) {
  test(`选择器与原生主请求复用相同工具及历史前缀：${mode ?? '不支持工具增量'}`, async t => {
    const { llm, requests } = transport(t, mode)
    const { root, row, history, header, session, toolHistory } = await fixture(t)
    for await (const chunk of llm.stream({ ...header.config, tools: header.tools, toolHistory,
      messages: [...history, user('继续主任务')], sessionId: session.id })) {
      assert.notEqual(chunk.reason?.kind, 'error', JSON.stringify(chunk))
    }
    assert.equal(await 选阶段({ llm }, root, row, { session }), 'plan')
    assert.equal(requests.length, 2)
    const [main, selector] = requests
    assert.deepEqual(selector.body.tools, main.body.tools, '工具声明及 defer_loading 必须复用原生投影')
    assert.equal(selector.body.system, main.body.system)
    assert.deepEqual(selector.body.messages.slice(0, -1), main.body.messages.slice(0, -1), '只允许末尾问题不同')
    assert.equal(selector.headers['x-deepseek-harness-session-id'], main.headers['x-deepseek-harness-session-id'])
    assert.equal(selector.body.output_config.effort, main.body.output_config.effort, '选择器继承节点档位，复用相同缓存前缀')
    assert.equal(main.body.output_config.effort, 'max', '主请求原有思考档位不变')
  })
}

test('选择器保留会话快照对象；旧会话接口和无请求头的开工仍可用', async t => {
  const { root, row, session, history, toolHistory } = await fixture(t)
  const input = await 选择机输入(root, row, session)
  assert.equal(input.toolHistory, toolHistory)
  for (let i = 0; i < history.length; i++) assert.equal(input.messages[i], history[i])
  const old = await 选择机输入(root, row, { requestHeader: session.requestHeader, deriveMessages: session.deriveMessages })
  assert.equal(old.toolHistory, undefined)
  assert.equal(old.sessionId, undefined)
  const first = await 选择机输入(root, row, { id: 'first', deriveMessages: () => [] })
  assert.ok(first.system)
  assert.equal(first.tools, undefined)
  assert.equal(first.sessionId, 'first')
})

test('首轮选择器使用原生作用域装配的系统提示与工具，不重复节点前缀', async t => {
  const { root, row, header } = await fixture(t), { llm, requests } = transport(t, 'addition-only')
  await writeFile(模型表路径(root), JSON.stringify(header.config))
  const session = { id: 'first-session', requestHeader: () => undefined, deriveMessages: () => [],
    toolHistory: () => ({ tools: [], updates: [] }) }
  const agent = { session }, signal = new AbortController().signal
  const assembly = { sections: [{ name: 'persona', text: '原生提示 {{value}}' },
    { name: 'tool:next', text: '原生工具指引' }], variables: { value: '完整内容' }, contexts: [], tools: header.tools }
  let assemblies = 0
  const systemPrompt = { async assemble(context) {
    assemblies++
    assert.equal(context.agent, agent); assert.equal(context.scope, agent); assert.equal(context.signal, signal)
    return assembly
  } }
  const prefix = createUserMessage({ content: [{ type: 'text', text: '已由上下文插件提供的节点前缀' }],
    source: { kind: `plugin:${节点前缀来路}`, summary: 节点前缀版本 } })
  const step = [prefix, user('首轮输入与运行背景')]
  for await (const chunk of llm.stream({ ...header.config, system: renderPrompt(assembly), tools: assembly.tools,
    messages: [...step, user('主任务阶段页')], sessionId: session.id })) assert.notEqual(chunk.reason?.kind, 'error')
  assert.equal(await 选阶段({ llm, systemPrompt }, root, row, { session, agent, signal, 这一步: step }), 'plan')
  assert.equal(assemblies, 1)
  assert.equal(requests[1].body.system, requests[0].body.system)
  assert.deepEqual(requests[1].body.tools, requests[0].body.tools)
  assert.equal(requests[1].body.output_config.effort, requests[0].body.output_config.effort)
  // 相邻 user 在适配器中合并为一条；比较末尾问题之前的内容块。
  assert.deepEqual(requests[1].body.messages[0].content.slice(0, -1), requests[0].body.messages[0].content.slice(0, -1))
})

test('真实 agent-loop 首轮：上下文插件与选择器共享系统、工具和本步消息前缀', async t => {
  const { root, header } = await fixture(t), { ctx, requests } = transport(t, 'addition-only')
  t.after(() => ctx.fiber.dispose())
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent']) {
    await ctx.plugin((await import('@deepseek-ai/' + name)).default)
  }
  await ctx.plugin((await import('@deepseek-ai/dsh-agent-loop')).default, { agents: [] })
  await writeFile(模型表路径(root), JSON.stringify(header.config))
  ctx.systemPrompt.tools(() => ({ schemas: [tool('fixture_tool')] }))
  const { agent } = await ctx.agents.create({ sessionId: 'native-cache-prefix',
    agentOptions: header.config, meta: { cwd: root } })
  await 改名册(root, roster => 记会话(roster, '0', agent.session.id))
  装上下文(agent.ctx)
  装思考开头(agent.ctx)
  const errors = []
  ctx.on('agent/error', ({ error }) => errors.push(String(error)))
  agent.followup(user('开工'))
  await agent.whenIdle()
  assert.deepEqual(errors, [])
  assert.equal(requests.length, 2)
  const [selector, main] = requests.map(request => request.body)
  assert.equal(selector.system, main.system)
  assert.deepEqual(selector.tools, main.tools)
  assert.equal(selector.output_config.effort, 'max')
  assert.equal(main.output_config.effort, 'max')
  assert.equal(selector.messages.length, main.messages.length)
  assert.deepEqual(selector.messages[0].content.slice(0, -1), main.messages[0].content.slice(0, -1))
  assert.ok(agent.session.toolHistory().tools.length > 0)
})
