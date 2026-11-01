/** 官方能力在原生未发布 setup 中装配；本模块仅处理项目选择与帮助情境。 */
import { Service } from '@deepseek-ai/cordis'
import { readFile, mkdir, mkdtemp, rm, stat, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { 数据根, 仓库根, 技能路径, 项目位置们, 工具临时目录名 } from '../../prompt/src/路径.js'
import { 一段 } from '../../prompt/src/index.js'
import { 读技能选择 } from '../../prompt/src/项目技能.js'
import { 程序协助提供方, 程序协助禁用工具, 是程序协助, 求助情境 } from '../../context/src/程序协助.js'
import { 读执行能力, 写执行能力 } from './执行能力设置.js'
import { 隔离命令, 离开工具执行 } from './项目隔离.js'
import { 停用持续工作 } from './持续工作.js'
import { 装后台清理 } from './后台清理.js'
import { 用自带浏览器, 找无头专用版 } from './后台工具.js'

export const name = 'blueprint-execution-features'
export const inject = ['agents', 'subagents', 'sessions', 'agentPresets', 'tools']

class 执行能力服务 extends Service {
  constructor(ctx, config, modules) {
    super(ctx, 'blueprintExecutionFeatures')
    this.config = config; this.modules = modules; this.activations = new WeakMap()
    this.readOnlyRoots = config.readOnlyRoots
  }
  async readiness() {
    const file = async path => !!path && (await stat(path).catch(() => null))?.isFile() === true
    return { ptc: true, workflow: true, browser: await file(this.config.browserExecutable),
      office: await file(join(this.config.primaryRuntime, 'dependencies/python/bin/python3')) }
  }
  async officeCatalog() {
    if (!(await this.readiness()).office) return []
    if (!this.officeProvider) this.modules.office.apply({ skills: { registerProvider: create => {
      this.officeProvider = create({ invalidate() {} }); return () => {}
    } } }, { assetRoot: this.config.officeAssets, node: process.execPath })
    return this.officeProvider.list({})
  }
  async officeContent(name, signal) {
    const candidate = (await this.officeCatalog()).find(row => row.name === name)
    if (!candidate) throw new Error('没有这份官方 Office 技能')
    return (await this.officeProvider.get(candidate, { signal })).content
  }
  async officeDefaults() {
    try { return JSON.parse(await readFile(join(数据根, '默认官方技能.json'), 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error; return {} }
  }
  async setOfficeDefault(name, enabled) {
    if (!(await this.officeCatalog()).some(candidate => candidate.name === name) || typeof enabled !== 'boolean') throw new Error('官方技能选择无效')
    const value = { ...await this.officeDefaults(), [name]: enabled }
    await writeFile(join(数据根, '默认官方技能.json'), JSON.stringify(value, null, 2) + '\n')
  }
  async install(context, agent) {
    const service = this
    const presets = context.get('agentPresets'), preset = presets?.composedPreset(context)
    if (preset !== 'blueprint') return
    const root = agent.session.header.cwd
    if (!root) return
    const selected = (await 读执行能力(root)).options, ready = await this.readiness()
    const formal = agent.session.header.origin !== 'subagent', helper = 是程序协助(agent.session)
    const options = { ...selected, ptc: formal && selected.ptc, workflow: formal && selected.workflow,
      browser: formal && selected.browser && ready.browser, office: selected.office && ready.office }
    const previous = this.activations.get(agent)
    if (previous) return
    const handles = [], resources = []
    handles.push(await context.plugin(this.modules.presentation, { mode: options.ptc ? 'ptc' : 'native' }))
    if (options.workflow) {
      const scope = context.isolate('workflowEngine')
      resources.push(await scope.plugin(this.modules.workflow, { provider: 程序协助提供方 }))
      resources.push(await scope.plugin(this.modules.workflowTool, { enableRunInBackground: true }))
    }
    if (options.office) {
      const actual = context.get('skills'), scope = context.isolate('skills')
      scope.provide('skills', { registerProvider: create => actual.registerProvider(control => {
        const provider = create(control)
        return { ...provider, async list(view) {
          const selection = await 读技能选择(root)
          const defaults = await service.officeDefaults()
          const candidates = await provider.list(view)
          return candidates.map(candidate => ({ ...candidate, invocation: {
            ...candidate.invocation, modelInvocable: selection === null ? defaults[candidate.name] !== false : selection.includes(candidate.name),
            userInvocable: selection === null ? defaults[candidate.name] !== false : selection.includes(candidate.name),
          } }))
        }, async get(candidate, view) {
          const selection = await 读技能选择(root)
          if (selection === null ? (await service.officeDefaults())[candidate.name] === false : !selection.includes(candidate.name)) throw new Error('PROJECT_SKILL_DISABLED: 本项目未启用 ' + candidate.name)
          return provider.get(candidate, view)
        } }
      }) })
      handles.push(await scope.plugin(this.modules.office, { assetRoot: this.config.officeAssets, node: process.execPath }))
      handles.push(await context.plugin(this.modules.dependencies, { source: this.config.primaryRuntime }))
    }
    if (options.browser) await this.installBrowser(context, agent, resources)
    this.activations.set(agent, { options, handles, resources, helper })
  }
  async installBrowser(context, agent, handles) {
    const root = agent.session.header.cwd, temporary = join(root, 工具临时目录名, 'browser', String(agent.id))
    await mkdir(temporary, { recursive: true })
    // macOS Unix socket 长度有限；浏览器状态留在项目，短 socket 目录随原生进程释放。
    const sockets = await mkdtemp('/private/tmp/Blueprint-browser-')
    const cleanup = () => rm(sockets, { recursive: true, force: true })
    context.effect(() => cleanup)
    handles.push({ dispose: cleanup })
    const scope = context.isolate('browserUse'), readOnlyRoots = this.readOnlyRoots
    // MCP 与浏览器子进程继承项目 Seatbelt；macOS 不允许内层再应用 Chromium 的另一份策略。
    // 显式遮蔽本作用域的方法；给 ctx.plugin 赋值会改写共享 registry 的 accessor。
    Object.defineProperty(scope, 'plugin', { value: function (entry, config) {
      if (entry?.name === 'mcp-client' && config?.serverName === 'playwright-mcp') {
        const spec = 隔离命令({ argv: [config.command, ...(config.args || []), '--no-sandbox', '--output-dir', temporary], cwd: config.cwd,
          env: { ...config.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary, PWTEST_SOCKETS_DIR: sockets,
            PLAYWRIGHT_BROWSERS_PATH: join(temporary, 'playwright-cache') } }, {
          根: root, 仓库: 数据根, 技能: 技能路径, 保护根: [数据根, 仓库根, ...项目位置们()], 只读代码目录: readOnlyRoots,
          可写缓存目录: [sockets], 原生命令: true, 管理端口: context.get('webServer')?.port,
        })
        // ctx.plugin 是已绑定的方法；沿当前子作用域取 registry，资源才归其生命周期所有。
        return this.registry.plugin(entry, { ...config, command: spec.argv[0], args: spec.argv.slice(1), env: spec.env })
      }
      return this.registry.plugin(entry, config)
    } })
    handles.push(await scope.plugin(this.modules.browserRegistry))
    handles.push(await scope.plugin(this.modules.browserProvider, { mode: 'launch', headless: true, executablePath: this.config.browserExecutable }))
  }
  async read(root, agent) {
    return { ...await 读执行能力(root), ready: await this.readiness(), applied: this.activations.get(agent)?.options || null }
  }
  async save(root, options, revision) { return 写执行能力(root, options, revision) }
  async releaseResources(agents) {
    for (const agent of agents) {
      const state = this.activations.get(agent)
      if (!state) continue
      for (const fiber of state.resources.splice(0).reverse()) await fiber.dispose()
      state.options = { ...state.options, browser: false, workflow: false }
    }
  }
  async reload(agent) {
    const state = this.activations.get(agent)
    if (!state?.handle) throw new Error('这个部署尚未管理本节点能力；下次恢复时应用')
    if (agent.status !== 'idle') throw new Error('节点正在工作，先停止并等它停稳后应用')
    const preset = this.ctx.agentPresets.composedPreset(agent.ctx)
    const agentOptions = { ...agent.options }
    停用持续工作(this.ctx, [agent])
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    await agent.whenIdle(); await this.ctx.sessions.flush(agent.session)
    await state.handle.dispose()
    return (await this.ctx.agents.resume({ resumeSessionId: agent.id, agentOptions,
      setup: context => context.get('agentPresets').mount(context, preset) })).agent
  }
}

export async function apply(ctx, config) {
  const resources = resolve(config.resourceRoot)
  const presentationRoot = dirname(dirname(fileURLToPath(config.entries.presentation)))
  const modulesRoot = dirname(dirname(presentationRoot))
  const browser = await readFile(join(resources, 'browser/browser-manifest.json'), 'utf8').then(JSON.parse, error => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (browser && (browser.platform !== process.platform || browser.arch !== process.arch
    || browser.executable.startsWith('/') || browser.executable.split(/[\\/]/).includes('..'))) throw new Error('浏览器资源与本机不符')
  const headlessShell = 找无头专用版(join(resources, 'browser'))
  config = { ...config, primaryRuntime: join(resources, 'primary-runtime'), officeAssets: join(resources, 'office-skills'),
    browserExecutable: headlessShell || (browser ? join(resources, 'browser', browser.executable) : null),
    readOnlyRoots: [modulesRoot, ...(await stat(resources).catch(() => null) ? [resources] : [])] }
  用自带浏览器(headlessShell)
  const modules = Object.fromEntries(await Promise.all(Object.entries(config.entries).map(async ([key, path]) => {
    const entry = await import(path); return [key, entry.default || entry]
  })))
  for (const path of config.readOnlyRoots) await realpath(path)
  const service = new 执行能力服务(ctx, config, modules)
  for (const method of ['create', 'resume']) {
    const original = ctx.agents[method]
    function wrapped(options) {
      const setup = options.setup
      return original.call(this, { ...options, setup: async (context, agent) => {
        const commit = await setup?.(context, agent)
        await 离开工具执行(() => service.install(context, agent))
        return commit
      } }).then(handle => {
        const state = service.activations.get(handle.agent)
        if (state) state.handle = handle
        return handle
      })
    }
    ctx.agents[method] = wrapped
    ctx.effect(() => () => { if (ctx.agents[method] === wrapped) ctx.agents[method] = original })
  }
  const original = ctx.subagents.startActivation
  async function start(spec) {
    if (spec.provider !== 程序协助提供方) return original.call(this, spec)
    const parent = spec.request.parent, question = typeof spec.request.prompt === 'string' ? spec.request.prompt
      : spec.request.prompt.filter(block => block.type === 'text').map(block => block.text).join('\n')
    const context = await 求助情境(ctx, parent, question)
    const raw = typeof spec.request.prompt === 'string' ? [{ type: 'text', text: spec.request.prompt }] : spec.request.prompt
    // 官方 restriction 只接受实际存在的全局工具；父级专有 Workflow／浏览器不会组合给帮手。
    const denied = [...程序协助禁用工具].filter(name => ctx.tools.get(name))
    return original.call(this, { ...spec, request: { ...spec.request, persona: 一段('批量帮助'),
      prompt: [{ type: 'text', text: JSON.stringify(context) }, ...raw], toolFilter: denied.length ? { deny: denied } : undefined, maxDepth: 1 } })
  }
  ctx.subagents.startActivation = start
  ctx.effect(() => () => { if (ctx.subagents.startActivation === start) ctx.subagents.startActivation = original })
  // 本插件在宿主只装一次，节点留下的无头浏览器在这里定时收。
  装后台清理(ctx)
}
