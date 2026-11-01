/** 模型常驻工具与按需目录；完整定义仍在原生工具注册表中。 */
import { Service } from '@deepseek-ai/cordis'

export const 通用工具名 = Object.freeze(['read', 'bash', 'skill', 'node_doc', 'wait', 'job_output'])
export const 工具入口名 = Object.freeze(['tool_info', 'call_tool'])

/** 只读接缝：node 通过服务取得 context 此刻允许显示的定义，不互相 import。 */
export class 工具目录 extends Service {
  constructor(ctx, list, guidance) {
    super(ctx, 'blueprintToolCatalog')
    this.list = list
    this.guidance = guidance
  }
}

export function 分层工具(tools = []) {
  // 没有入口时保留原生呈现，支持独立挂载 context；不制造不可调用的定义。
  if (!工具入口名.every(name => tools.some(t => t.name === name))) return { tools, callable: [] }
  const 常驻 = new Set([...通用工具名, ...工具入口名])
  return { tools: tools.filter(t => 常驻.has(t.name)), callable: tools.filter(t => !常驻.has(t.name)) }
}
