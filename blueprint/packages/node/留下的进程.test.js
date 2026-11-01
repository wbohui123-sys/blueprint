import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalFS from '@deepseek-ai/dsh-fs-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { 装项目隔离 } from './src/项目隔离.js'
import { 停止后台 } from './src/会话.js'
import { 留下的进程数 } from './src/留下的进程.js'
import { 数据根 } from '../prompt/src/路径.js'

const repo = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)))
const 无头Chrome = join(repo, 'app/.build/native-resources/browser/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell')
const 活着 = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const 等到 = async (条件, ms = 8000) => { const end = Date.now() + ms; while (!条件() && Date.now() < end) await new Promise(r => setTimeout(r, 50)); return 条件() }

// 10-26：节点在 bash 里 `chrome … &` 测游戏，命令结束后任务表上没了它，交回、按停都碰不到，两个开了七八个小时。
test('真实 dsh 服务：命令里 & 放出去的浏览器和服务，开它的节点交回时整组关掉，别的节点的不动', async () => {
  mkdirSync(join(数据根, '项目'), { recursive: true })
  const root = realpathSync(mkdtempSync(join(数据根, '项目/.留下的进程-')))
  const host = new Context()
  const fsFiber = await host.plugin(LocalFS, { diffBasisMaxBytes: 1000000 })
  const processFiber = await host.plugin(Subprocess)
  const 有Chrome = existsSync(无头Chrome)
  let dispatch
  // 正式部署把 App 带的浏览器目录列为只读代码目录，否则沙箱里读不到它自己的资源、一启动就退。
  装项目隔离({ get: n => host.get(n), on: (_, fn) => { dispatch = fn } }, { 只读代码目录: 有Chrome ? [join(repo, 'app/.build/native-resources/browser')] : [] })
  const 节点 = id => ({ session: { id, header: { cwd: root } } })
  const 甲 = 节点('留下的进程-甲'), 乙 = 节点('留下的进程-乙')
  // 像节点那样：一条普通命令，后台开一个常驻服务（这里用 sleep 代替）和一个无头浏览器，命令本身马上结束。
  const 甲的命令 = [
    'sleep 600 >/dev/null 2>&1 & echo $!',
    有Chrome ? `"${无头Chrome}" --headless=new --no-sandbox --disable-gpu --user-data-dir=.blueprint-tmp/甲/Chrome档 about:blank >/dev/null 2>&1 & echo $!` : '',
  ].filter(Boolean).join('\n')
  const 跑 = (agent, command) => dispatch({ name: 'bash', agent }, async () => {
    const proc = host.subprocess.spawn({ argv: ['/bin/bash', '-c', command], cwd: root, stdio: { stdin: 'ignore', stdout: { maxBytes: 10000 }, stderr: { maxBytes: 10000 } }, graceMs: 100 })
    const result = await proc.done
    return { result, pids: proc.collected.stdout.readFrom(0).text.trim().split('\n').filter(Boolean).map(Number) }
  })
  let 全部 = []
  try {
    const 甲跑 = await 跑(甲, 甲的命令), 乙跑 = await 跑(乙, 'sleep 600 >/dev/null 2>&1 & echo $!')
    全部 = [...甲跑.pids, ...乙跑.pids]
    assert.equal(甲跑.result.exitCode, 0)
    assert.equal(甲跑.pids.length, 有Chrome ? 2 : 1)
    // 命令结束了，放出去的还活着，这正是原来没人管的那批；浏览器多等一会儿，确认不是自己退的。
    await new Promise(r => setTimeout(r, 1500))
    assert.ok(全部.every(活着), '命令结束后放出去的进程还在')
    assert.equal(留下的进程数(甲.session.id), 1)
    assert.equal(留下的进程数(乙.session.id), 1)

    await 停止后台({ get: () => undefined }, [甲])
    assert.ok(await 等到(() => 甲跑.pids.every(pid => !活着(pid))), '甲交回后它留下的服务和浏览器都关了')
    assert.ok(乙跑.pids.every(活着), '乙的不受影响')
    assert.ok(await 等到(() => 留下的进程数(甲.session.id) === 0), '组里没人了，记录自己掉')
    assert.equal(留下的进程数(乙.session.id), 1)

    await 停止后台({ get: () => undefined }, [乙])
    assert.ok(await 等到(() => 乙跑.pids.every(pid => !活着(pid))))
    // 已经没了的再关一次，什么也不发生。
    await 停止后台({ get: () => undefined }, [甲, 乙])
  } finally {
    for (const pid of 全部) try { process.kill(pid, 'SIGKILL') } catch {}
    await processFiber.dispose(); await fsFiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
