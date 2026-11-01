// Source regressions with isolated data. Desktop and live-task acceptance remain separate.
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(app, '..')
const args = process.argv.slice(2)
if (args.length > 1 || (args.length === 1 && args[0] !== '--full')) {
  console.error('Usage: node app/scripts/orchestration-check.mjs [--full]')
  process.exit(2)
}
const full = args[0] === '--full'
const packages = join(root, 'blueprint/packages')
const tests = [
  ...(full ? readdirSync(packages, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .flatMap(entry => readdirSync(join(packages, entry.name)).filter(name => name.endsWith('.test.js'))
      .map(name => `blueprint/packages/${entry.name}/${name}`)).sort() : [
    ...['会话事实', '原生纸条等待', '纸条等待持久化', '分工表', '验证收据', '资料', '上下文重建']
    .map(name => `blueprint/packages/node/${name}.test.js`),
    ...['核对', '工具文案', '等待入口'].map(name => `blueprint/packages/context/${name}.test.js`),
    ...(process.platform === 'darwin' ? ['纸条等待', '信息依赖等待', '选择机']
      .map(name => `blueprint/packages/node/${name}.test.js`) : []),
  ]),
  ...(full ? readdirSync(join(app, 'tests')).filter(name => name.endsWith('.test.mjs')).sort()
    : ['selector-cache.test.mjs', 'selector-request-trace.test.mjs'])
    .map(name => `app/tests/${name}`),
]
// Darwin 的 Unix socket 路径限长；使用短根，业务隔离另有真实系统临时目录回归覆盖。
const temporary = realpathSync(mkdtempSync(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bp-test-')))
try {
  const data = join(temporary, 'data'), documents = join(temporary, 'documents')
  mkdirSync(data)
  mkdirSync(join(documents, 'Blueprint', '项目'), { recursive: true })
  console.log(`${full ? 'Full App and packages' : 'Orchestration'} source regressions: ${tests.length} files (${process.platform}); desktop and live-task acceptance remain separate.`)
  const hook = `${pathToFileURL(join(app, 'scripts/native-node-protocol-check.mjs')).href}?register`
  const result = spawnSync(process.execPath, ['--import', hook, '--test', ...tests.map(file => join(root, file))], {
    cwd: root, stdio: 'inherit', env: { ...process.env, BLUEPRINT_PROTOCOL_ENGINE_ROOT: app,
      BLUEPRINT_DATA_HOME: data, BLUEPRINT_DOCUMENTS_HOME: documents },
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
