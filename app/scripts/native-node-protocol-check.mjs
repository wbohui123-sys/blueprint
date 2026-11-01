// 使用 App 固定依赖验证源码；不重接正在运行的 profile，也不混用显式加载的隔离引擎。
import { registerHooks, createRequire } from 'node:module'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(appRoot, '..')
const engineRoot = resolve(process.env.BLUEPRINT_PROTOCOL_ENGINE_ROOT || appRoot)
const require = createRequire(join(engineRoot, 'package.json'))
const sourceRoots = [join(repository, 'blueprint'), join(appRoot, 'tests')].map(path => pathToFileURL(path + '/').href)
if (new URL(import.meta.url).searchParams.has('register')) {
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (sourceRoots.some(root => context.parentURL?.startsWith(root))
      && (specifier.startsWith('@deepseek-ai/') || specifier === 'zod' || specifier === 'yaml' || specifier === 'js-yaml')) {
      return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  } })
} else {
  const files = ['会话事实.test.js', '原生纸条等待.test.js', '纸条等待.test.js', '纸条等待持久化.test.js']
    .map(file => join(repository, 'blueprint/packages/node', file))
  console.log(`验证节点协议：DSH ${require('@deepseek-ai/dsh-llm/package.json').version}`)
  const hook = `${pathToFileURL(fileURLToPath(import.meta.url)).href}?register`
  // import 的查询参数避免把注册入口与父进程的测试调度混在一起。
  const result = spawnSync(process.execPath, ['--import', hook, '--test', ...files], {
    stdio: 'inherit', env: { ...process.env, BLUEPRINT_PROTOCOL_ENGINE_ROOT: engineRoot },
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}
