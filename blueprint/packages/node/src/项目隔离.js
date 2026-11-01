/** 项目工具的读隔离。宿主仍可管理所有项目；工具执行按会话绑定边界。
 * 文件服务检查真实路径；命令与搜索在 macOS Seatbelt 内运行，子进程继承。
 * 不修改 dsh 本体，也不把 cwd 当成权限边界。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFileSync } from 'node:child_process'
import { realpathSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve, relative, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { 仓库根, 数据根, 项目父目录, 项目位置们, 技能路径, 工具临时目录名, 公共工具夹名 } from '../../prompt/src/路径.js'
import { 文档夹名, 证据夹名, 名册文件名, 纸条文件名, 节点总表文件名 } from '../../roster/src/index.js'
import { 后台工具环境, 后台工具命令 } from './后台工具.js'
import { 记下留下的进程 } from './留下的进程.js'

const 执行域 = new AsyncLocalStorage()
const 已包装 = Symbol('blueprint-project-isolation')
const 仓库 = realpathSync(数据根)
const 技能 = 技能路径

export function 在内(根, 路径) {
  const r = relative(根, 路径)
  return r === '' || (!r.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && r !== '..' && !isAbsolute(r))
}

/** 部署声明的官方 provider 入口决定可执行代码，不接受模型请求扩大读取范围。 */
export function 原生提供方代码目录(entries = []) {
  const roots = new Set()
  for (const value of Array.isArray(entries) ? entries : Object.values(entries || {})) {
    const url = new URL(value)
    if (url.protocol !== 'file:') throw new Error('PROJECT_ISOLATION: 外部提供方入口须为部署解析的本地文件。')
    const entry = realpathSync(fileURLToPath(url)), require = createRequire(entry)
    const provider = JSON.parse(readFileSync(join(dirname(dirname(entry)), 'package.json'), 'utf8'))
    const packageRoot = (name, from = require, asEntry = false) => {
      const root = realpathSync(dirname(from.resolve(asEntry ? name : `${name}/package.json`)))
      return { root, metadata: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')), require: createRequire(join(root, 'package.json')) }
    }
    if (provider.name === '@deepseek-ai/dsh-subagent-codex') {
      // Codex 的精确版本由 App 定（package.json 的 overrides，2026-10-18 起 0.163.0，提供方钉的 0.153.4 拿不到新模型），打包时 external-provider-assets 核对；
      // 这里只认从提供方解析到的那一份官方包，和它的平台载荷对得上。
      const cli = packageRoot('@openai/codex')
      if (cli.metadata.name !== '@openai/codex' || !/^\d+\.\d+\.\d+$/.test(cli.metadata.version || '')) throw new Error('PROJECT_ISOLATION: Codex 载荷不是官方正式版本。')
      const platform = packageRoot(`@openai/codex-${process.platform}-${process.arch}`, cli.require)
      if (platform.metadata.version !== `${cli.metadata.version}-${process.platform}-${process.arch}`) throw new Error('PROJECT_ISOLATION: Codex 平台载荷版本不一致。')
      roots.add(cli.root); roots.add(platform.root)
    } else if (provider.name === '@deepseek-ai/dsh-subagent-claude-code') {
      const sdk = packageRoot('@anthropic-ai/claude-agent-sdk', require, true)
      if (sdk.metadata.version !== provider.dependencies?.['@anthropic-ai/claude-agent-sdk']) throw new Error('PROJECT_ISOLATION: Claude SDK 未采用提供方固定版本。')
      const platform = packageRoot(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`, sdk.require)
      if (platform.metadata.version !== sdk.metadata.version) throw new Error('PROJECT_ISOLATION: Claude 平台载荷版本不一致。')
      roots.add(sdk.root); roots.add(platform.root)
    } else if (provider.name === '@deepseek-ai/dsh-ptc-runtime-node' && provider.version === '0.2.1-alpha.2') {
      roots.add(dirname(dirname(entry)))
    } else throw new Error('PROJECT_ISOLATION: 只接纳部署固定的官方执行提供方入口。')
  }
  return [...roots]
}

// 新文件尚不存在时，逐级解析最近的现存祖先，不能把软链接当作边界。
export function 真路径(路径) {
  try { return realpathSync(路径) } catch (e) {
    if (e.code !== 'ENOENT') throw e
    const 父 = dirname(路径)
    if (父 === 路径) throw e
    return resolve(真路径(父), relative(父, 路径))
  }
}

// 名册是 SQLite 库（任务.db），写的时候旁边会有一份回滚日志，一样只许机器写。
const 系统机器文件名 = [名册文件名, `${名册文件名}-journal`, 纸条文件名, 节点总表文件名,
  '素材检索目录.md', '模型.json', '项目名称.json', '项目名称.json.tmp', '技能.json', '执行能力.json', '子代理.json', '用量.jsonl', '待回答.json', '工作时间.json', '工作时间.json.tmp']
const 转正则 = path => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Seatbelt 不支持 {n}；展开定长字符类，让两种入口匹配完全相同的文件名。
const 证据哈希式 = '[0-9a-f]'.repeat(24), 媒体编号式 = '[0-9a-f-]'.repeat(36)

/** 文件工具与命令共用机器文件清单；目录仍可存放普通文档，只防止整体搬走机器文件。 */
function 机器保护(根) {
  const 文件 = new Set(), 目录 = new Set([根, 真路径(根)]), 文件式 = [], 目录式 = []
  const 入口们 = path => [...new Set([path, 真路径(path)])]
  for (const name of 系统机器文件名) {
    const path = join(根, 文档夹名, name)
    for (const entry of 入口们(path)) {
      文件.add(entry)
      文件式.push(`^${转正则(entry)}[.][^/]+[.]tmp$`)
      for (let dir = dirname(entry); 在内(根, dir); dir = dirname(dir)) {
        目录.add(dir)
        if (dir === 根) break
      }
    }
  }
  for (const entry of 入口们(join(根, 证据夹名, '网页目录.md'))) 文件.add(entry)
  for (const dir of [join(根, 文档夹名), join(根, 证据夹名)]) for (const entry of 入口们(dir)) 目录.add(entry)
  for (const base of 入口们(join(根, 文档夹名))) 文件式.push(`^${转正则(base)}/[.]技能选择-[0-9a-f-]+[.]json$`)
  for (const base of 入口们(join(根, 证据夹名))) {
    const prefix = 转正则(base)
    文件式.push(`^${prefix}/${证据哈希式}/${证据哈希式}[.]txt$`,
      `^${prefix}/media/${媒体编号式}[.]json([.][^/]+[.]tmp)?$`)
    目录式.push(`^${prefix}/${证据哈希式}$`)
  }
  for (const entry of 入口们(join(根, 证据夹名, 'media'))) 目录.add(entry)
  return { 文件: [...文件], 目录: [...目录], 文件式, 目录式 }
}

export function 文件许可(范围, 路径, 写 = false, 基准 = 范围.根) {
  const 入口 = resolve(基准, 路径), 实际 = 真路径(入口)
  if (写 && !范围.机器写入) {
    const 保护 = 机器保护(范围.根)
    if ([入口, 实际].some(path => 保护.文件.includes(path) || 保护.目录.includes(path)
      || [...保护.文件式, ...保护.目录式].some(式 => new RegExp(式).test(path)))) {
      throw new Error('MACHINE_STORAGE: 这个文件由程序维护，请通过对应工具更新；总图景、计划与研究等普通文档可直接读写。')
    }
  }
  if (在内(范围.根, 实际) || (!写 && (在内(范围.技能, 实际) || 范围.附件文件?.includes(实际)
    || 范围.只读代码目录?.some(root => 在内(root, 实际))))) return 实际
  throw new Error('PROJECT_ISOLATION: 只能访问当前项目的文件（公共技能只读）；不能访问其他项目、父目录或宿主账本。')
}

/** 附件原件由宿主保存；只接纳当前会话及同项目父链已收到的耐久引用。 */
export function 会话附件文件(ctx, session) {
  const store = ctx.get('attachments'), files = new Set(), seen = new Set()
  if (!store || !session?.header?.cwd) return []
  const root = 真路径(session.header.cwd)
  for (let current = session; current && !seen.has(current.id);) {
    if (!current.header.cwd || 真路径(current.header.cwd) !== root) break
    seen.add(current.id)
    const messages = [
      ...(current.deriveMessages?.() || []).filter(message => message.role === 'user'),
      ...(current.ownEvents?.() || []).filter(event => event.type === 'user/message').map(event => event.data),
    ]
    for (const message of messages) for (const block of message.content || []) {
      if (!block.attachment) continue
      try {
        const path = block.type === 'file' ? store.fileHostPath(block.attachment)
          : block.type === 'image' ? store.imageHostPath(block.attachment) : null
        if (path) files.add(realpathSync(path))
      } catch { /* 无效引用或已缺失的文件不扩大读取范围。 */ }
    }
    const parent = current.header.parentSession
    current = parent ? ctx.sessions?.get(parent) || ctx.root?.agents?.get(parent)?.session : null
  }
  return [...files]
}

// 部分原生软件直接查询 Darwin 临时目录，不使用 TMPDIR。由宿主读取并缓存，
// 不接受工具参数指定额外写入范围，也不放开整个 /var/folders 或 /tmp。
let 原生临时目录
export function 系统临时目录() {
  if (!原生临时目录) {
    const path = execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', timeout: 5000 }).trim()
    const real = realpathSync(path)
    if (!/^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/.test(real)) {
      throw new Error('PROJECT_ISOLATION: 无法确认当前用户的系统临时目录。')
    }
    原生临时目录 = real
  }
  return 原生临时目录
}

let 原生缓存目录
/** 用户缓存目录（`…/C`，系统的显卡着色器缓存在这里），同样由宿主读取。 */
export function 系统缓存目录() {
  if (!原生缓存目录) {
    const path = execFileSync('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR'], { encoding: 'utf8', timeout: 5000 }).trim()
    const real = realpathSync(path)
    if (!/^\/private\/var\/folders\/[^/]+\/[^/]+\/C$/.test(real)) {
      throw new Error('PROJECT_ISOLATION: 无法确认当前用户的系统缓存目录。')
    }
    原生缓存目录 = real
  }
  return 原生缓存目录
}

/** 缓存整台电脑共用，不按项目分：丢了能重建，各项目各存一份只会重做、重下。
 * 写不进时有两种后果：报错的，节点自己绕（把 HOME 改到项目里）；不报错的只是每次重做，谁也看不见——
 * 10-27 mini 上系统存不下 Godot 编好的显卡着色器，一次验收两分多钟、10 核负载 50；放开后第二次起 3 秒。
 * 所以 macOS 给缓存划的三处整个可写：用户缓存目录（`…/C`）、`~/Library/Caches`、`~/.cache`（跨平台工具的默认位置，没有就建）。
 * 例外：Blueprint、dsh 自己的缓存（源码版用 Electron 的名字），开发机打包用的 Electron 下载，各 App 的自动更新状态（`*.ShipIt`，不是缓存）。 */
let 缓存位置
export function 共用缓存位置(home = homedir()) {
  if (!缓存位置 || 缓存位置.home !== home) {
    const 点缓存 = join(home, '.cache')
    mkdirSync(点缓存, { recursive: true })
    const 根们 = [系统缓存目录(), realpathSync(join(home, 'Library/Caches')), realpathSync(点缓存)]
    const 任一 = `(${根们.map(转正则).join('|')})`
    缓存位置 = { home, 根们, 点缓存: 根们[2], 库缓存: 根们[1], 自己的式: [
      `^${任一}/(com[.]blueprint[.](desktop|studio)|com[.]github[.]Electron|com[.]deepseek[.]dsh)([.][^/]*)?(/|$)`,
      `^${任一}/[^/]+[.]ShipIt(/|$)`,
      `^${转正则(根们[1])}/(electron|electron-builder)(/|$)`,
    ] }
  }
  return 缓存位置
}

const 引号 = s => JSON.stringify(s)

/** 用户的个人文件夹（10-23）：节点为找一个库跑 `find /`，一路扫进桌面、下载、照片、音乐，macOS 挨个弹框，都算在 Blueprint 头上。
 * Seatbelt 先拒，系统就不会去问（实测：拒读的路径 tccd 收不到请求）。项目、附件、技能放在这些位置里照旧放行；
 * 文件夹本身只给元数据，命令看得见它在，不能列目录、读内容。只写字面路径：宿主去解析它们的真实路径，本身就可能惊动系统。 */
export function 用户私人位置(home = homedir()) {
  return [...['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Movies',
    'Library/Containers', 'Library/Group Containers', 'Library/Mobile Documents', 'Library/CloudStorage',
    'Library/Application Support/AddressBook', 'Library/Calendars'].map(name => join(home, name)), '/Volumes']
}

/** deny 条件排除自己与公共技能，不给父目录列目录的权利。 */
export function 隔离规则({ 根, 仓库, 技能, 保护根 = [仓库], 私人位置 = 用户私人位置(), 附件文件 = [], 元数据文件 = [], 只读代码目录 = [], 可写缓存目录 = [], 可写缓存文件 = [], 只读配置文件 = [], 管理端口 }) {
  if (管理端口 !== undefined && (!Number.isInteger(管理端口) || 管理端口 < 1 || 管理端口 > 65535)) {
    throw new Error('PROJECT_ISOLATION: 宿主管理服务尚未就绪，不能启动项目工具。')
  }
  const 机器 = 机器保护(根)
  const 读保护 = [...保护根, ...私人位置]
  const 祖先 = new Set()
  for (const 起点 of [根, 技能, ...附件文件, ...元数据文件, ...只读代码目录]) {
    for (let p = dirname(起点); 读保护.some(base => 在内(base, p)); p = dirname(p)) {
      祖先.add(p)
      if (p === dirname(p)) break
    }
  }
  const 范围外 = `(require-all (require-any ${读保护.map(base => `(subpath ${引号(base)})`).join(' ')}) (require-not (subpath ${引号(根)})) (require-not (subpath ${引号(技能)})) ${只读代码目录.map(path => `(require-not (subpath ${引号(path)}))`).join(' ')} ${附件文件.map(path => `(require-not (literal ${引号(path)}))`).join(' ')})`
  const 缓存 = 共用缓存位置()
  return [
    `(deny file-read-data ${范围外})`,
    // realpath/lstat 需要沿祖先路径走到本项目；只给目录元数据，不给列目录或文件内容。
    `(deny file-read-metadata (require-all ${范围外} ${[...祖先, ...元数据文件, ...私人位置].map(p => `(require-not (literal ${引号(p)}))`).join(' ')}))`,
    // dsh 的 bash 沙箱先 (deny file-write*) 再只放工作区和临时目录，这里接在它后面：缓存要明说放行，光是自己不拦不够（10-27 部署到 mini 后照样拦）。
    `(allow file-write* ${缓存.根们.map(path => `(subpath ${引号(path)})`).join(' ')})`,
    // 项目外只额外允许当前用户的原生临时目录和缓存；软链接目标仍受内核边界检查。
    `(deny file-write* (require-all (require-not (subpath ${引号(根)})) (require-not (literal "/dev/null")) (require-not (subpath ${引号(系统临时目录())})) ${缓存.根们.map(path => `(require-not (subpath ${引号(path)}))`).join(' ')} ${可写缓存目录.map(path => `(require-not (subpath ${引号(path)}))`).join(' ')} ${可写缓存文件.map(path => `(require-not (literal ${引号(path)}))`).join(' ')}))`,
    // 项目位置可设在临时目录或缓存下；这些通用写权限不能覆盖邻居项目与宿主账本的保护。
    ...(保护根.length ? [`(deny file-write* (require-all (require-any ${保护根.map(path => `(subpath ${引号(path)})`).join(' ')}) (require-not (subpath ${引号(根)}))))`] : []),
    // 缓存里 Blueprint、dsh 自己的和各 App 的更新状态照旧不能写。
    `(deny file-write* ${缓存.自己的式.map(式 => `(regex ${引号(式)})`).join(' ')})`,
    // 目标路径也拒绝原子替换；即便用户把原生配置放在项目内，仍不能由产品任务改写登录和设置。
    ...只读配置文件.map(path => `(deny file-write* (literal ${引号(path)}))`),
    // 只保护程序维护的文件；普通文档不因目录或预测阶段而失去写权限。
    ...机器.文件.map(path => `(deny file-write* (literal ${引号(path)}))`),
    ...机器.文件式.map(式 => `(deny file-write* (regex ${引号(式)}))`),
    ...机器.目录.map(path => `(deny file-write-unlink (literal ${引号(path)}))`),
    ...机器.目录式.map(式 => `(deny file-write-unlink (regex ${引号(式)}))`),
    // 项目本地服务可互通；只隔离实际宿主管理端口与项目外 Unix 端点。
    ...(管理端口 === undefined ? [] : [`(deny network-outbound (remote ip "localhost:${管理端口}"))`]),
    `(deny network-outbound (require-all (remote unix-socket) (require-not (subpath ${引号(根)})) ${可写缓存目录.map(path => `(require-not (subpath ${引号(path)}))`).join(' ')} (require-not (literal "/private/var/run/mDNSResponder"))))`,
    '(deny appleevent-send)',
  ].join('\n')
}

export function 隔离命令(spec, 范围) {
  if (process.platform !== 'darwin') throw new Error('PROJECT_ISOLATION: 当前部署的硬隔离仅支持 macOS；拒绝无隔离执行。')
  const cwd = 文件许可(范围, spec.cwd || 范围.目录 || 范围.根, false, 范围.目录 || 范围.根)
  // 用户 PTY 与宿主管理的原生命令自行管理启动；后者仍遵守工具的私人目录限制。
  const 原样启动 = 范围.用户终端 || 范围.原生命令
  const 后台环境 = 原样启动 ? { ...spec.env } : 后台工具环境(范围.根, spec.env)
  const argv = 原样启动 ? [...spec.argv] : 后台工具命令(spec.argv, 后台环境)
  // 原生 glob 的排序先 stat 当前 rg 可执行文件；只给这一个实际入口与祖先元数据，正文仍受隔离。
  const program = argv[argv[0] === 'sandbox-exec' || argv[0] === '/usr/bin/sandbox-exec' ? 3 : 0]
  const position = argv[0] === 'sandbox-exec' || argv[0] === '/usr/bin/sandbox-exec' ? 3 : 0
  // 只匹配部署解析的官方 package-local app-server，以及外部 run 启动的 `codex exec`（范围里带 外部run，只有 node 自己的启动入口给），
  // 普通 bash/Node 不获得用户目录写权限。
  const codex = 范围.Codex入口 && program === process.execPath && argv[position + 1] === 范围.Codex入口
    && ((argv[position + 2] === 'app-server' && argv[position + 3] === '--stdio' && argv.length === position + 4)
      || (范围.外部run === true && argv[position + 2] === 'exec'))
  let 缓存 = {}, sqlite
  if (codex) {
    const home = 真路径(resolve(后台环境.CODEX_HOME || process.env.CODEX_HOME || join(后台环境.HOME || process.env.HOME || homedir(), '.codex')))
    if (范围.保护根?.some(root => 在内(root, home)) && !在内(范围.根, home)) throw new Error('PROJECT_ISOLATION: Codex 原生配置不能指向其他项目或宿主账本。')
    const temporary = join(home, 'tmp'), installation = join(home, 'installation_id')
    if (真路径(temporary) !== temporary || 真路径(installation) !== installation) throw new Error('PROJECT_ISOLATION: Codex 缓存入口不能通过软链接扩大写入范围。')
    const settings = ['auth.json', 'config.toml'].flatMap(name => { const path = join(home, name); return [path, 真路径(path)] })
    缓存 = { 可写缓存目录: [temporary], 可写缓存文件: [installation], 只读配置文件: [...new Set(settings)] }
    sqlite = 文件许可(范围, join(范围.根, 工具临时目录名, 'codex-state'), true)
    mkdirSync(sqlite, { recursive: true })
  }
  // 用户终端是用户亲手敲的命令：他去看下载文件夹，系统该问就问，不替他拦。
  const 规则 = 隔离规则({ ...范围, ...缓存, 元数据文件: 范围.搜索 && isAbsolute(program) && /[/\\]rg$/.test(program) ? [真路径(program)] : [],
    ...(范围.用户终端 ? { 私人位置: [] } : {}) })
  // 原 bash-sandbox 已使用 Seatbelt：合并配置，不嵌套 sandbox-exec。
  if (argv[0] === 'sandbox-exec' || argv[0] === '/usr/bin/sandbox-exec') {
    if (argv[1] !== '-p' || typeof argv[2] !== 'string') throw new Error('PROJECT_ISOLATION: 无法合并命令沙箱，拒绝执行。')
    argv[2] += '\n' + 规则
  } else {
    argv.unshift('/usr/bin/sandbox-exec', '-p', '(version 1)\n(allow default)\n' + 规则)
  }
  const 临时目录 = 文件许可(范围, join(范围.根, 工具临时目录名), true)
  // 公共工具夹（产 5，10-23）：节点装的工具放这里、在 目录.md 记一行，别的节点也能用。
  const 公共工具 = join(临时目录, 公共工具夹名)
  mkdirSync(公共工具, { recursive: true })
  const 共用 = 共用缓存位置()
  // PWD 跟着这条命令的工作目录：继承宿主的，指着项目外，`/bin/pwd` 这类先读 $PWD 的程序读不到它的元数据就报错（10-27）。
  // 没有语言环境就补 UTF-8：从访达开的 App 不带 LANG，终端里 bash 的行编辑把中文路径的字节当快捷键吃掉，cd 到项目里的中文目录就失败（10-27）。
  const env = {
    ...后台环境, PWD: cwd, LANG: 后台环境.LANG || process.env.LANG || 'en_US.UTF-8',
    BLUEPRINT_PROJECT_ROOT: 范围.根, TMPDIR: 临时目录, TMP: 临时目录, TEMP: 临时目录,
    BLUEPRINT_TOOLS: 公共工具,
    // 下载、安装缓存全机共用（10-27）：各工具在用户缓存里的标准位置，用户自己下过的模型、包节点直接用上；
    // 默认不在缓存位置的（npm、matplotlib、uv 装的 Python）放 ~/.cache/blueprint。
    UV_CACHE_DIR: join(共用.点缓存, 'uv'), UV_PYTHON_INSTALL_DIR: join(共用.点缓存, 'blueprint/python'),
    MPLCONFIGDIR: join(共用.点缓存, 'blueprint/matplotlib'),
    PIP_CACHE_DIR: join(共用.库缓存, 'pip'), HF_HOME: join(共用.点缓存, 'huggingface'),
    XDG_CACHE_HOME: 共用.点缓存, npm_config_cache: join(共用.点缓存, 'blueprint/npm'),
    ...(sqlite ? { CODEX_SQLITE_HOME: sqlite } : {}),
  }
  // 子进程直连公网；不继承指向本机的代理，否则既误伤联网，也能经代理绕回 studio。
  // 空值覆盖 subprocess 服务稍后合入的宿主环境，不能只 delete 当前对象的键。
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[key] = ''
  return { ...spec, cwd, argv, env }
}

/**
 * 宿主操作离开工具执行域。工具执行域只该管那一次工具调用自己读写什么；在它里面开出来的 agent 循环会把它一路带下去
 * （AsyncLocalStorage），于是那些循环里的宿主钩子也被当成模型的工具调用拦下。2026-10-07 冒烟实测两处：
 * - spawn、finish 开出或叫醒的节点：`会话.js` 开节点、叫醒先离开（节点自己的每次工具调用照样在 tools/execute 里重新绑定）。
 * - do：dsh 在节点的 `do` 工具执行里开它，没有入口可离开；列技能的地方单独包（见 `装项目隔离()` 里的 skills）。
 */
export const 离开工具执行 = (fn) => 执行域.exit(fn)
/** 只读该次工具调用的原生有效目录；宿主域没有工具调用基准。 */
export const 工具执行目录 = () => 执行域.getStore()?.目录

/** 服务实例只包一层；AsyncLocalStorage 区分并行项目，宿主操作不在工具执行域内。 */
function 包方法(service, name, wrap) {
  const 原 = service[name]
  if (typeof 原 !== 'function' || 原[已包装]) return
  function 包装(...args) { return wrap.call(this, 原, args, 执行域.getStore()) }
  包装[已包装] = true
  service[name] = 包装
}

async function 项目执行范围(ctx, agent, options = {}, signal) {
  signal?.throwIfAborted()
  const cwd = agent?.session?.header?.cwd
  if (!cwd) throw new Error('PROJECT_ISOLATION: 执行缺少项目身份，拒绝启动。')
  const 根 = realpathSync(cwd)
  if (!项目父目录(根)) throw new Error('PROJECT_ISOLATION: 会话不在独立项目目录中，拒绝执行。')
  const webServer = ctx.get('webServer')
  const 管理端口 = webServer == null ? undefined : webServer.port
  if (webServer != null && (!Number.isInteger(管理端口) || 管理端口 < 1 || 管理端口 > 65535)) {
    throw new Error('PROJECT_ISOLATION: 宿主管理服务尚未就绪，不能启动项目工具。')
  }
  const 范围 = { 根, 仓库, 技能: realpathSync(技能), 附件文件: 会话附件文件(ctx, agent.session),
    保护根: [...new Set([仓库, realpathSync(仓库根), ...项目位置们().map(root => { try { return 真路径(root) } catch { return resolve(root) } })])], 管理端口, ...options }
  const workingDirectory = ctx.get('workingDirectory')
  范围.目录 = 文件许可(范围, typeof workingDirectory?.ensure === 'function'
    ? await workingDirectory.ensure(agent, signal) : 根)
  if (!在内(根, 范围.目录)) throw new Error('PROJECT_ISOLATION: 当前工作目录须在所属项目内。')
  return 范围
}

/** 用户 API 只绑定项目进程边界，不进入模型角色、预测或审批管线。 */
export async function 在项目终端执行域(ctx, agent, fn, signal) {
  const 范围 = await 项目执行范围(ctx, agent, { 用户终端: true }, signal)
  signal?.throwIfAborted()
  return 执行域.run(范围, fn)
}

export function 装项目隔离(ctx, { 检查预测, 只读代码目录 = [] } = {}) {
  const 代码目录 = [...new Set(只读代码目录.map(path => realpathSync(path)))]
  let Codex入口
  for (const root of 代码目录) {
    let metadata
    try { metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (metadata.name === '@openai/codex' && metadata.bin?.codex) {
      const entry = realpathSync(resolve(root, metadata.bin.codex))
      if (!在内(root, entry)) throw new Error('PROJECT_ISOLATION: Codex wrapper 须位于部署声明的官方包内。')
      if (Codex入口 && Codex入口 !== entry) throw new Error('PROJECT_ISOLATION: 不能同时使用两套 Codex wrapper。')
      Codex入口 = entry
    }
  }
  // 每个节点与 do 都挂 node；服务是宿主共享的，但边界来自当前调用。
  const fs = ctx.get('fs'), subprocess = ctx.get('subprocess')
  if (!fs || !subprocess) throw new Error('PROJECT_ISOLATION: 缺少 fs/subprocess，不能安全加载项目工具。')
  for (const 方法 of ['stat', 'readText', 'streamText', 'readBytes', 'readByteRange', 'listDir', 'writeText', 'editText']) {
    包方法(fs, 方法, function (原, args, 范围) {
      if (范围) {
        文件许可(范围, this.processPath(args[0]), 方法 === 'writeText' || 方法 === 'editText')
      }
      return 原.apply(this, args)
    })
  }
  包方法(fs, 'resolve', async function (原, args, 范围) {
    if (范围) {
      args[1] = { ...args[1], cwd: 文件许可(范围, args[1]?.cwd || 范围.目录 || 范围.根, false, 范围.目录 || 范围.根) }
      文件许可(范围, resolve(args[1].cwd, args[0]))
    }
    const target = await 原.apply(this, args)
    if (范围) 文件许可(范围, this.processPath(target))
    return target
  })
  包方法(fs, 'lstat', function (原, args, 范围) {
    if (范围) {
      args[1] = { ...args[1], cwd: 文件许可(范围, args[1]?.cwd || 范围.目录 || 范围.根, false, 范围.目录 || 范围.根) }
      文件许可(范围, resolve(args[1].cwd, args[0]))
    }
    return 原.apply(this, args)
  })
  // 技能目录是宿主的事：dsh 列技能要往上找 .git、读用户 skill 目录，按模型的工具调用拦，整张清单就失败。
  // 不管谁、什么时候问（每一步的技能清单、skill 工具读页、do 那一轮），都在工具执行域外查；读到的只是宿主配置的 skill 根目录。
  const skills = ctx.get('skills')
  if (skills) for (const 方法 of ['list', 'get', 'snapshot']) {
    包方法(skills, 方法, function (原, args) { return 离开工具执行(() => 原.apply(this, args)) })
  }
  for (const 方法 of ['spawn', 'spawnTerminal']) {
    包方法(subprocess, 方法, function (原, args, 范围) {
      if (范围) args[0] = 隔离命令(args[0], { 只读代码目录: 代码目录, Codex入口, ...范围 })
      const handle = 原.apply(this, args)
      // 命令留下的进程组记在节点名下，节点的后台任务停掉时一起关；终端另有 关闭节点终端。
      if (方法 === 'spawn' && 范围?.会话) 记下留下的进程(范围.会话, handle)
      return handle
    })
  }
  ctx.on('tools/execute', async (exec, next) => {
    const 范围 = await 项目执行范围(ctx, exec.agent, { 只读代码目录: 代码目录, Codex入口, 搜索: exec.name === 'glob' || exec.name === 'grep',
      会话: exec.agent?.session?.id }, exec.signal)
    const 根 = 范围.根
    const 预测 = 检查预测 ? await 检查预测(ctx, exec) : { mode: 'entry' }
    // header 保留项目身份；该次调用的相对路径基准由原生目录服务验证与恢复，不另存 cwd。
    if (exec.name === 'working_directory' && typeof exec.arguments?.cd === 'string'
      && !在内(根, 文件许可(范围, exec.arguments.cd, false, 范围.目录))) {
      throw new Error('PROJECT_ISOLATION: 工作目录只能切换到所属项目内。')
    }
    // 搜索参数也先拒绝越界；内核沙箱还会拦住搜索途中遇到的软链接。
    if (exec.name === 'glob' || exec.name === 'grep') 文件许可(范围, exec.arguments?.path || '.', false, 范围.目录)
    if (预测.mode === 'inquiry' && exec.name === 'shelve') {
      // 上架可把收集的资料保存为素材；不能移动正式工作文件来伪装成取材。
      for (const path of exec.arguments?.paths || []) {
        const source = 文件许可(范围, path, false, 范围.目录)
        if (![工具临时目录名, '素材'].some(name => 在内(真路径(join(根, name)), source))) throw new Error('HELPER_SCOPE: 协助上架只接收 .blueprint-tmp 中的样本或已上架素材。')
      }
    }
    return 执行域.run(范围, next)
  }, { prepend: true })
}
