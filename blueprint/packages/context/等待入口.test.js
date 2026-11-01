import test from 'node:test'
import assert from 'node:assert/strict'
import { 分层工具 } from './src/可调用工具.js'
import { 精简工具文案 } from './src/工具文案.js'

test('事件等待与结果读取直接可见，保持原生定义及权限约束', () => {
  const tools = ['read', 'bash', 'wait', 'job_output', 'tool_info', 'call_tool', 'write'].map(name => ({ name, parameters: { type: 'object', additionalProperties: false } }))
  const view = 分层工具(tools)
  for (const name of ['wait', 'job_output']) {
    assert.equal(view.tools.find(tool => tool.name === name), tools.find(tool => tool.name === name))
    assert.equal(view.callable.some(tool => tool.name === name), false)
  }
  assert.ok(view.callable.some(tool => tool.name === 'write'))
  const withoutWait = tools.filter(tool => tool.name !== 'wait')
  assert.equal(分层工具(withoutWait).tools.some(tool => tool.name === 'wait'), false, '不为未获等待工具的角色制造入口')
  assert.equal(分层工具(tools.filter(tool => tool.name !== 'call_tool')).tools.length, tools.length - 1, '独立原生挂载仍原样显示')
})

test('后台 bash 引导使用作业事件而非 sleep 轮询，不修改参数约束', () => {
  const original = { type: 'boolean', default: false, description: 'Native background mode' }
  const tool = 精简工具文案({ name: 'bash', parameters: { type: 'object', properties: { run_in_background: original } } })
  const guidance = tool.parameters.properties.run_in_background
  assert.match(guidance.description, /wait/)
  assert.match(guidance.description, /job/)
  assert.equal(guidance.type, original.type)
  assert.equal(guidance.default, original.default)
  assert.equal(original.description, 'Native background mode')
})
