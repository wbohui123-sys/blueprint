import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { sourceCliOptions, resolveSourceCli } from '../scripts/source-cli.mjs'

const run = promisify(execFile)
const app = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'))
let prepared
const options = sourceCliOptions(['--resolve'], manifest, app)
try { prepared = await resolveSourceCli(options) }
catch (error) {
  // 已安装但不完整的固定 CLI 必须报错；仅未准备源码安装时跳过。
  if (await access(join(options.localRoot, 'node_modules/@deepseek-ai/dsh/package.json')).then(() => true, () => false)) throw error
}

test('已准备的源码 CLI 真正 boot 和 mount canonical preset，拒绝借 App hook 掩盖 linked-root 依赖', { skip: !prepared && '须先 prepare:cli 准备固定源码引擎' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'blueprint-source-profile-runtime-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const unused = join(root, '不可使用的用户目录')
  const result = await run(process.execPath, [join(app, 'scripts/source-profile-check.mjs')], {
    cwd: root, timeout: 60000, maxBuffer: 1024 * 1024,
    env: { ...process.env, DSH_HOME: unused, BLUEPRINT_DATA_HOME: unused, BLUEPRINT_PROMPT_DIR: unused, NODE_OPTIONS: '' },
  })
  const reports = result.stdout.split('\n').filter(line => line.startsWith('{"engine":')).map(line => JSON.parse(line))
  assert.equal(reports.length, 1, '启动日志之外应有唯一的结构化核对结果')
  const [status] = reports
  assert.equal(status.passed, true)
  assert.equal(status.engine, manifest.dependencies['@deepseek-ai/dsh-llm'])
  assert.equal(status.sourceProfile, 'web')
  assert.equal(status.canonicalMounted, true)
  assert.equal(status.canonicalBaseVerified, true)
  assert.equal(status.declarationDisposed, true)
  assert.equal(status.modelRequested, false)
  assert.equal(status.userDataUsed, false)
  assert.equal(status.providerEntriesVerified, true)
  assert.equal(Object.keys(status.nativePluginVersions).length, 23)
  assert.equal(status.nativePluginVersions['@deepseek-ai/dsh-tool-goal'], status.engine)
  assert.ok(Object.values(status.nativePluginVersions).every(version => version === status.engine))
  assert.deepEqual(status.externalTools, [])
  assert.deepEqual(status.externalProviders, ['codex', 'claude-code'])
  assert.deepEqual(status.terminalTools, ['terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list'])
  assert.deepEqual(status.goalTools, ['get_goal', 'create_goal', 'update_goal'])
  assert.equal(status.goalServicesVerified, true)
  assert.equal(status.ralphVerified, true)
  assert.equal(status.terminalClientReady, true)
  assert.equal(status.terminalControllerVerified, true)
  assert.deepEqual(status.officeSkills, ['office-docx', 'office-pptx', 'office-xlsx'])
  await assert.rejects(access(unused), { code: 'ENOENT' })
  assert.ok(!result.stderr.includes('MODULE_NOT_FOUND'))
})
