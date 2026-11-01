// 在临时 profile 核对源码 bundle，现用 profile、设置和会话不参与。
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, rm, readFile, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { sourceCliOptions, resolveSourceCli, alignProfileDependencies } from './source-cli.mjs'
import { inspectNativeExternalPatch } from './native-external-patch.mjs'
import { assertExternalProviderAssets } from './external-provider-assets.mjs'
import { ensureTerminalClientAssets } from './terminal-client-assets.mjs'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(appRoot, '..')
export async function checkSourceProfile() {
  const manifest = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'))
  const home = await mkdtemp(join(tmpdir(), 'Blueprint-native-source-profile-'))
  const previousCwd = process.cwd()
  const environmentKeys = ['DSH_HOME', 'DSH_TELEMETRY_DISABLED', 'BLUEPRINT_DATA_HOME', 'BLUEPRINT_DOCUMENTS_HOME', 'BLUEPRINT_PROMPT_DIR', 'BLUEPRINT_TERMINAL_ASSETS_DIR']
  const previousEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]))
  let ctx
  try {
    const profile = join(home, 'profiles/web')
    const modules = join(profile, 'node_modules')
    const options = sourceCliOptions(['--resolve', '--align-profile', '--profile-modules', modules], manifest)
    const cli = await resolveSourceCli(options)
    const nativeModules = dirname(dirname(cli))
    assert.equal((await inspectNativeExternalPatch(nativeModules)).alreadyApplied, true, '源码启动前必须安装精确外部执行扩展')
    await assertExternalProviderAssets(nativeModules, { engineVersion: options.version })
    const terminalAssets = await ensureTerminalClientAssets(nativeModules)
    await alignProfileDependencies(cli, options)
    await mkdir(join(modules, '@blueprint'), { recursive: true })
    const dependencies = {}
    for (const name of ['bundle', 'context', 'node', 'prompt', 'studio', 'layout', 'canvas', 'brand', 'files', 'feed', 'workspace', 'skill', 'media']) {
      const path = join(repository, name === 'bundle' ? 'blueprint' : `blueprint/packages/${name}`)
      await symlink(path, join(modules, '@blueprint', name))
      dependencies[`@blueprint/${name}`] = `link:${path}`
    }
    await mkdir(profile, { recursive: true })
    // 新建默认 profile，不复制用户的 settings、patch、认证或会话。
    const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@blueprint/bundle']
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'blueprint-source-profile-check', private: true,
      dependencies, dsh: { profile: { bundles } } }, null, 2) + '\n')
    await writeFile(join(profile, 'cordis.yml'), '[]\n')
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
    const dumped = spawnSync(process.execPath, [join(cli, 'lib/bin.js'), '--profile', 'web', '--dump-config'], {
      cwd: repository, env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }, encoding: 'utf8', timeout: 60000,
    })
    if (dumped.error) throw dumped.error
    assert.equal(dumped.status, 0, dumped.stderr)
    for (const id of ['preset-blueprint', 'blueprint-media', 'agent-preset-registry', 'working-directory', 'worktree', 'config-editor',
      'subagent-codex', 'subagent-claude-code']) {
      assert.ok(dumped.stdout.includes(`id: ${id}`), `原生组合中应有 ${id}`)
    }
    assert.ok(dumped.stdout.includes('default: blueprint'))
    assert.ok(!dumped.stdout.includes("name: '@deepseek-ai/dsh-agent-presets'"))

    // 使用所选 CLI 的 boot/resolution，不借 App 安装来代替源码版。
    const require = createRequire(join(cli, 'package.json'))
    const load = name => import(pathToFileURL(require.resolve(name)).href)
    const { boot, loadProfileDirectory, readProfilePatches, createRuntimeResolution, PluginPackages, resolvePluginResource } = await load('@deepseek-ai/dsh-app-boot')
    const { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } = await load('@deepseek-ai/dsh-launch-environment')
    const { provideCmdline } = await load('@deepseek-ai/dsh-cmdline')
    const { parse } = await load('yaml')
    const project = join(home, '合成项目')
    await mkdir(project)
    process.env.DSH_HOME = home
    process.env.DSH_TELEMETRY_DISABLED = '1'
    process.env.BLUEPRINT_DATA_HOME = home
    process.env.BLUEPRINT_DOCUMENTS_HOME = join(home, '模拟文稿')
    process.env.BLUEPRINT_PROMPT_DIR = join(repository, 'blueprint/packages/prompt')
    process.env.BLUEPRINT_TERMINAL_ASSETS_DIR = terminalAssets.directory
    process.chdir(project)
    const profileContext = { name: 'web', dir: profile, patchPath: join(profile, 'cordis.patch.yml'),
      installAnchor: join(cli, 'package.json'), cwd: project, home, startedBundles: bundles, overlays: [], telemetryDisabledEnv: '1' }
    const loaded = loadProfileDirectory('Blueprint-source-check', profile, profileContext.installAnchor)
    assert.deepEqual(loaded.skippedBundles, [])
    const resolution = await createRuntimeResolution({ installAnchor: profileContext.installAnchor, profile: loaded, home })
    const readiness = new Set()
    ctx = await boot('Blueprint-source-check', join(profile, 'cordis.yml'), readProfilePatches('Blueprint-source-check', profileContext, loaded), async host => {
      host.provide('profileContext', profileContext)
      host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }]))
      await host.plugin(PluginPackages, { resolution })
      provideCmdline(host, { args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
        ready: { onReady: listener => { readiness.add(listener); return () => readiness.delete(listener) } },
        exit: code => { throw new Error(`源码核对不应请求进程退出：${code}`) } })
      await import(pathToFileURL(createRequire(join(profile, 'package.json')).resolve('@blueprint/studio/media-settings')).href)
    })
    for (const listener of readiness) listener()
    assert.ok(ctx.webServer.port > 0)
    const execution = ctx.get('blueprintExecutionFeatures')
    assert.equal((await execution.readiness()).office, true, `Office 资源目录：${execution.config.primaryRuntime}`)
    const officeSkills = (await execution.officeCatalog()).map(row => row.name).sort()
    assert.deepEqual(officeSkills, ['office-docx', 'office-pptx', 'office-xlsx'])
    for (const name of officeSkills) assert.match(await execution.officeContent(name), /Installed LibreOffice Kit/)
    const skillsResponse = await fetch(`http://127.0.0.1:${ctx.webServer.port}/studio/api/skills`)
    const skillCatalog = await skillsResponse.json()
    assert.equal(skillCatalog.ok, true)
    for (const name of officeSkills) assert.ok(skillCatalog.行们.some(row => row.名 === name), `项目技能目录应包含 ${name}`)
    assert.equal(typeof ctx.get('terminalController')?.create, 'function')
    assert.equal([...ctx.loader.entries()].filter(row => row.options.id === 'terminal-controller').length, 1,
      '源码组合沿官方同名 controller 条目保持单一实例')
    const canonical = await realpath(join(repository, 'blueprint/agent.cordis.yml'))
    const canonicalBaseUrl = pathToFileURL(canonical).href
    const pluginNames = new Set()
    function collectPlugins(rows) {
      for (const row of rows) {
        if (row.name?.startsWith('@deepseek-ai/')) pluginNames.add(row.name)
        if (row.group && Array.isArray(row.config)) collectPlugins(row.config)
      }
    }
    collectPlugins(parse(await readFile(canonical, 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ __jsExpr: value }) }] }))
    const agent = await ctx.agentLoop.create('blueprint-source-canonical-check', { provider: 'unused-source-check', model: 'no-request' }, { cwd: project })
    assert.deepEqual(await ctx.agentPresets.mount(agent.ctx, 'blueprint'), { id: 'blueprint' })
    assert.ok(ctx.agentPresets.serviceFor(agent, 'blueprintToolCatalog'))
    const [composition] = ctx.agentPresets.inspectCompositions(agent.ctx)
    assert.equal(composition?.id, 'blueprint')
    const nativePluginVersions = {}
    for (const name of pluginNames) {
      const mounted = composition.modules.filter(row => row.moduleName === name)
      assert.ok(mounted.length, `canonical 原生插件须实际挂载：${name}`)
      for (const row of mounted) {
        assert.equal(row.baseUrl, canonicalBaseUrl, '实际原生声明须从 canonical 的真实文件解析')
        const metadata = ctx.pluginPackages.packageOf(name, row.baseUrl)
        // 子路径入口（如 dsh-tool-subagent-control/list-agents）属于同一个包。
        assert.equal(metadata?.name, name.split('/').slice(0, 2).join('/'), `canonical 原生插件须可定位：${name}`)
        assert.equal(metadata.version, options.version, `canonical 原生插件不得混入旧版：${name}`)
        assert.equal(await realpath(resolvePluginResource(name, row.baseUrl)), await realpath(require.resolve(name)),
          `实际原生声明的插件须来自所选 CLI：${name}`)
        nativePluginVersions[name] = metadata.version
      }
    }
    const terminalTools = ['terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list']
    const goalTools = ['get_goal', 'create_goal', 'update_goal']
    const tools = ['working_directory', 'create_worktree', ...terminalTools, ...goalTools, 'ralph']
    for (const name of tools) assert.ok(ctx.tools.get(name, agent), `真正挂载的 canonical preset 应有工具 ${name}`)
    for (const name of ['subagent_codex', 'subagent_claude_code']) assert.ok(!ctx.tools.get(name, agent),
      '外部 run 由宿主启动，不再给节点暴露外部委派工具')
    const externalProviders = ['codex', 'claude-code']
    for (const name of externalProviders) assert.ok(ctx.subagents.getProvider(name), `宿主仍须注册外部提供方 ${name}`)
    assert.equal(typeof ctx.get('goals')?.resume, 'function')
    for (const id of ['goal', 'goal-round-driver', 'command-goal']) assert.equal(
      [...ctx.loader.entries()].filter(row => row.options.id === id).length, 1, `源码 Goal 接官方 ${id} 单一实例`)
    const roster = await import(pathToFileURL(join(repository, 'blueprint/packages/roster/src/index.js')).href)
    await roster.落新名册(project, 'Goal 按需目录核对', '核对官方 Goal 接缝')
    await roster.改名册(project, value => roster.记会话(value, '0', agent.id))
    const toolInfo = ctx.tools.get('tool_info', agent)
    for (const name of goalTools) {
      const info = await toolInfo.execute({ name }, { agent })
      assert.ok(info.文.includes(name), `正式节点可按需调用 ${name}`)
      assert.match(info.文, /at least 3 consecutive goal rounds/, '按需指引保留官方目标策略')
    }
    assert.match((await toolInfo.execute({ name: 'ralph' }, { agent })).文, /ONLY when the direct human explicitly asks/)
    assert.equal(ctx.ptcRuntime.language, 'typescript')
    const ralphProvider = ctx.subagents.getProvider('blueprint-ralph')
    assert.equal(ralphProvider.inheritsParentContext, false)
    assert.equal(ralphProvider.capabilities.outputSchema, true)
    const ptc = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-ptc-runtime-node')).href)
    assert.equal(ctx.registry.get(ptc.default).fibers.length, 1, '源码复用 base 的官方 PTC Runtime')
    const nodePlugin = await import(pathToFileURL(join(repository, 'blueprint/packages/node/src/index.js')).href)
    const nodeFibers = [...ctx.registry.get(nodePlugin).fibers]
    assert.equal(nodeFibers.length, 1)
    assert.deepEqual(nodeFibers[0].config.executionRuntimeEntries, [pathToFileURL(require.resolve('@deepseek-ai/dsh-ptc-runtime-node')).href])
    const providers = ['@deepseek-ai/dsh-subagent-codex', '@deepseek-ai/dsh-subagent-claude-code']
    assert.deepEqual(nodeFibers[0].config.externalProviderEntries, providers.map(name => pathToFileURL(require.resolve(name)).href),
      '实际 node 插件的 provider 代码入口须来自原生 installAnchor')
    for (const name of providers) {
      assert.equal(ctx.pluginPackages.packageOf(name, pathToFileURL(profileContext.installAnchor).href)?.version, options.version)
    }
    assert.equal(agent.status, 'idle')
    assert.ok(!agent.session.ownEvents().some(event => /^(assistant\/|request\/)/.test(event.type)), '挂载核对不得产生模型请求')
    assert.deepEqual(ctx.subagents.listExternalActivations(), [])
    const declaration = [...ctx.loader.entries()].find(row => row.options.id === 'preset-blueprint')
    assert.ok(declaration?.fiber)
    await declaration.fiber.dispose()
    assert.ok(!(await ctx.agentPresets.list()).some(row => row.id === 'blueprint'), '卸载声明须通过原生 disposer 撤回注册')
    return { engine: options.version, sourceProfile: 'web', passed: true, userDataUsed: false,
      canonicalMounted: true, canonicalBaseVerified: true, nativePluginVersions, providerEntriesVerified: true, declarationDisposed: true,
      externalTools: [], externalProviders, terminalTools, goalTools, goalServicesVerified: true, ralphVerified: true,
      terminalControllerVerified: true, terminalClientReady: terminalAssets.ready, officeSkills, modelRequested: false }
  } finally {
    try { await ctx?.fiber.dispose() }
    finally {
      process.chdir(previousCwd)
      for (const key of environmentKeys) {
        if (previousEnvironment[key] === undefined) delete process.env[key]; else process.env[key] = previousEnvironment[key]
      }
      await rm(home, { recursive: true, force: true })
    }
  }
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => undefined) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await checkSourceProfile())) }
  catch (error) { console.error(error); process.exitCode = 1 }
}
