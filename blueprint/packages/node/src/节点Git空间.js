/**
 * 节点的 Git 分支与 worktree。机器只在三处替节点提交、合并：派出前提交来源空间（新节点从母节点此刻的样子长出）；
 * 交回时提交自己的空间，并把它的分支并进派它的节点的分支（一件工作的 helm 并进主线，即 0 号的分支）；
 * 请求被改写、接着用它之前，把派它的节点此刻的分支并进它的空间（轮 3）。
 * 并的时候撞上冲突：撤销这次合并，把冲突文件交给那个节点自己解决，机器不替它决定留哪边。
 *
 * 台（十步重置 10-24）：派出的块带着台（名册行的 bench，作品仓库里的一个目录）。它的 worktree 用 git 稀疏检出，
 * 磁盘上只有这个目录（这一份 worktree 自己的稀疏规则，非 cone 模式，台外的根目录文件也不检出），工作目录就设在这里。
 * 分支里的历史照旧是整棵树：交回时只提交台里的改动，并进上级照旧；接着用前并上级的分支，台外的变化只进版本、不上磁盘。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { 是节点号, 行Of, 派出者Of } from '../../roster/src/index.js'
import { 仓库根, 数据根, 技能路径, 项目位置们 } from '../../prompt/src/路径.js'
import { 一段 } from '../../prompt/src/index.js'
import { 文件许可, 隔离命令 } from './项目隔离.js'

const exec = promisify(execFile)
// Windows: git 输出的 worktree 路径用正斜杠、盘符大小写不定，直接比对会误判。
const 同路径 = (a, b) => process.platform === 'win32'
  ? String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase()
  : a === b

const 空间队 = new Map()

export const 节点分支 = id => {
  if (!是节点号(id)) throw new Error(`Git 空间：${id} 不是节点编号`)
  return `node-${id}`
}
export const 节点产物空间 = id => {
  节点分支(id)
  return String(id) === '0' ? '作品' : `作品空间/${id}`
}
/** 节点的工作目录（相对项目根）：有台的是 worktree 里的台目录，没有的是 worktree 根。 */
export const 节点工作目录 = 行 => 行.bench ? join(节点产物空间(行.id), 行.bench) : 节点产物空间(行.id)
/** 稀疏检出的规则：只要台这一个目录（非 cone 模式，前后带斜杠，只认这一个目录）。 */
const 稀疏规则 = bench => `/${bench.replace(/^\/+|\/+$/g, '')}/`
/** 节点开工那一刻的版本：空间建出来时记下，重启清除改动时回到这里。 */
const 起点引用 = id => `refs/blueprint-start/${节点分支(id)}`

async function 存在(path) {
  try { return await lstat(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
function 解析空间(text) {
  const rows = []; let row = {}
  for (const line of text.split('\0')) {
    if (!line) { if (row.worktree) rows.push(row); row = {}; continue }
    const at = line.indexOf(' ')
    row[at < 0 ? line : line.slice(0, at)] = at < 0 ? true : line.slice(at + 1)
  }
  if (row.worktree) rows.push(row)
  return rows
}

/** 新项目可初始化0；恢复只核验，新登记节点从母节点分支长出。 */
export async function 准备节点Git空间(根, 行, 名册, options = {}) {
  根 = await realpath(根)
  return 排进空间队(根, () => 准备空间(根, 行Of(名册, 行.id), 名册, options))
}

/** 同一项目的 Git 操作排成一队，worktree 登记与提交不交错。 */
async function 排进空间队(根, 做) {
  const previous = 空间队.get(根) || Promise.resolve()
  const next = previous.catch(() => {}).then(做)
  空间队.set(根, next)
  try { return await next } finally { if (空间队.get(根) === next) 空间队.delete(根) }
}

// 引擎缓存与依赖目录不进版本：它们会让每次提交变大，合并时在二进制缓存上冲突。写在仓库公共的 info/exclude，各 worktree 共用，节点看不到这份文件。
// 临时目录也不进：节点当前目录在自己的空间里，照相对路径写出的 .blueprint-tmp 不该随交回并进上级。只在建新项目时写入，旧项目的这份文件不补。
const 不进版本 = ['.DS_Store', '.godot/', 'node_modules/', '__pycache__/', '.venv/', '.blueprint-tmp/']

async function 空间环境(根, 标号) {
  const scope = {根, 仓库:await realpath(数据根), 技能:await realpath(技能路径),
    保护根:[await realpath(数据根), await realpath(仓库根), ...项目位置们()]}
  const repo = 文件许可(scope, join(根, '作品'), true)
  const mainGit = 文件许可(scope, join(repo, '.git'), true)
  const git = async (args, allowed = [], 时限 = 20000) => {
    const spec = 隔离命令({argv:['/usr/bin/git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'core.quotepath=false', ...args], cwd:根,
      env:{PATH:process.env.PATH, LANG:process.env.LANG || 'en_US.UTF-8', LC_ALL:'C', GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1'}}, scope)
    try {
      const {stdout} = await exec(spec.argv[0], spec.argv.slice(1), {cwd:spec.cwd, env:spec.env, encoding:'utf8', timeout:时限, maxBuffer:4*1024*1024})
      return stdout.trimEnd()
    } catch (error) {
      if (allowed.includes(error.code)) return null
      throw new Error(`Git 空间 ${标号}：${String(error.stderr || error.message).trim()}`, {cause:error})
    }
  }
  return {scope, repo, mainGit, git}
}

// 产物里可能有大文件，暂存与提交给足时间。
const 提交时限 = 120000

/** 这个空间稀疏检出时的台目录们（`git sparse-checkout list` 的规则去掉斜杠）；不是稀疏检出 → null。 */
async function 稀疏的台(git, 空间) {
  if (await git(['-C', 空间, 'config', '--get', 'core.sparseCheckout'], [1]) !== 'true') return null
  return String(await git(['-C', 空间, 'sparse-checkout', 'list'], [128]) || '').split('\n').map(s => s.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean)
}

/**
 * 一个已登记的节点空间里有改动就提交成一个版本；没有改动返回 null。
 * 稀疏检出的空间只收台里的改动：台外写出来的文件不在稀疏规则里，git add -A 碰到它们会报错退出（实验 10-24），也不该交上去。
 */
async function 提交空间(git, 空间, 说明) {
  const 台们 = await 稀疏的台(git, 空间)
  // 台目录还不在（刚换了台、上级的分支还没并进来）、版本里也没有它的文件：pathspec 对不上任何东西，git 会报错，跳过。
  const 要收 = []
  for (const 台 of 台们 || []) if (await 存在(join(空间, 台)) || await git(['-C', 空间, 'ls-files', '--', `:(top)${台}/`])) 要收.push(台)
  if (台们 && !要收.length) return null
  await git(['-C', 空间, 'add', '-A', ...(台们 ? ['--', ...要收.map(台 => `:(top)${台}/`)] : [])], [], 提交时限)
  if (await git(['-C', 空间, 'diff', '--cached', '--quiet'], [1]) !== null) return null
  await git(['-C', 空间, '-c', 'user.name=Blueprint', '-c', 'user.email=blueprint@localhost', 'commit', '-q', '-m', 说明], [], 提交时限)
  return git(['-C', 空间, 'rev-parse', 'HEAD'])
}

function 登记的空间(spaces, id, 空间) {
  return spaces.some(row => row.branch === `refs/heads/${节点分支(id)}` && row.worktree === 空间)
}

/** 交回时提交节点自己的空间；没有作品仓库或空间未登记的旧项目不动。返回新版本号或 null。 */
export async function 提交节点空间(根, id, 说明) {
  根 = await realpath(根)
  return 排进空间队(根, async () => {
    const {scope, repo, mainGit, git} = await 空间环境(根, id)
    if (!(await 存在(mainGit))) return null
    const 空间 = 文件许可(scope, join(根, 节点产物空间(id)), true)
    const spaces = 解析空间(await git(['-C', repo, 'worktree', 'list', '--porcelain', '-z']))
    if (!登记的空间(spaces, id, 空间) || !(await 存在(空间))) return null
    return 提交空间(git, 空间, 说明)
  })
}

/** 正式成果固定到真实 HEAD；即使本次没有新改动也返回版本。 */
export async function 节点成果版本(根, id) {
  根 = await realpath(根)
  return 排进空间队(根, async () => {
    const { repo, mainGit, git } = await 空间环境(根, id)
    if (!await 存在(mainGit)) return null
    const commit = await git(['-C', repo, 'rev-parse', '--verify', `${节点分支(id)}^{commit}`], [128])
    return commit ? { node: String(id), branch: 节点分支(id), path: 节点产物空间(id), commit } : null
  })
}

async function 准备空间(根, 行, 名册, {新建项目 = false} = {}) {
  const branch = 节点分支(行.id), path = 节点产物空间(行.id)
  const {scope, repo, mainGit, git} = await 空间环境(根, 行.id)
  const target = 文件许可(scope, join(根, path), true)
  const init = await 存在(mainGit)
  if (!init) {
    if (行.id !== '0' || !新建项目 || 行.session) throw new Error(`Git 空间：作品仓库缺失，不能恢复节点 ${行.id}`)
    if (await 存在(repo)) throw new Error('Git 空间：作品目录已存在但不是已登记仓库，拒绝覆盖')
    await mkdir(repo)
    await git(['init', '--template=', '-b', branch, repo])
    await mkdir(文件许可(scope, join(mainGit, 'info'), true), {recursive:true})
    await writeFile(文件许可(scope, join(mainGit, 'info', 'exclude'), true), 不进版本.join('\n') + '\n')
  } else if (!init.isDirectory()) throw new Error('Git 空间：作品/.git 须为本项目主仓库目录')
  const top = await git(['-C', repo, 'rev-parse', '--show-toplevel'])
  if (!同路径(await realpath(top), repo)) throw new Error('Git 空间：作品位置没有独立主仓库')
  const common = await git(['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!同路径(文件许可(scope, common), mainGit)) throw new Error('Git 空间：主仓库元数据位置不合')
  let hasBranch = await git(['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], [1]) !== null
  if (行.id === '0' && !hasBranch) {
    if (!新建项目 || 行.session) throw new Error('Git 空间：node-0 分支缺失，不能恢复既有节点')
    const head = await git(['-C', repo, 'symbolic-ref', '-q', 'HEAD'], [1])
    const commit = await git(['-C', repo, 'rev-parse', '--verify', 'HEAD'], [128])
    if (head !== 'refs/heads/node-0' || commit !== null) throw new Error('Git 空间：既有作品仓库不合新项目初始形状')
    await git(['-C', repo, '-c', 'user.name=Blueprint', '-c', 'user.email=blueprint@localhost', 'commit', '--allow-empty', '-m', '初始化节点作品空间'])
    await git(['-C', repo, 'update-ref', 起点引用('0'), 'HEAD'])
    hasBranch = true
  }
  let spaces = 解析空间(await git(['-C', repo, 'worktree', 'list', '--porcelain', '-z']))
  const reference = `refs/heads/${branch}`
  const registered = spaces.find(row => row.branch === reference)
  if (registered) {
    if (!同路径(registered.worktree, target)) throw new Error(`Git 空间：${branch} 已绑定其他 worktree，拒绝改绑`)
    if (!(await 存在(target))) throw new Error(`Git 空间：${path} worktree 文件缺失`)
    const actualBranch = await git(['-C', target, 'symbolic-ref', '-q', 'HEAD'], [1])
    const actualCommon = await git(['-C', target, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    if (actualBranch !== reference || 文件许可(scope, actualCommon) !== mainGit) throw new Error(`Git 空间：${path} worktree 与分支不合`)
    // 接着用时台换了（同一阶段里接着用的子 dock 换了台）：先把台里没提交的存一个版本，再换稀疏规则。
    if (行.bench && JSON.stringify(await 稀疏的台(git, target)) !== JSON.stringify([行.bench])) {
      await 提交空间(git, target, `${行.id} 换台之前的版本`)
      await git(['-C', target, 'sparse-checkout', 'set', '--no-cone', 稀疏规则(行.bench)])
    }
    return {分支:branch, 路径:path}
  }
  if (行.id === '0' || 行.session) throw new Error(`Git 空间：节点 ${行.id} 的既有分支或 worktree 缺失`)
  if (await 存在(target)) throw new Error(`Git 空间：${path} 已存在但未登记，拒绝覆盖`)
  // 新开的一件工作（没有派出者）从主线（0 号的分支）长出；别的从派它的节点的分支长出。
  const sourceId = 派出者Of(行.id, 名册) || '0'
  行Of(名册, sourceId)
  const sourceBranch = 节点分支(sourceId)
  if (await git(['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${sourceBranch}`], [1]) === null) {
    throw new Error(`Git 空间：来源分支 ${sourceBranch} 缺失`)
  }
  if (hasBranch && await git(['-C', repo, 'rev-parse', branch]) !== await git(['-C', repo, 'rev-parse', sourceBranch])) {
    throw new Error(`Git 空间：未绑定分支 ${branch} 已偏离来源，拒绝猜测归属`)
  }
  if (!hasBranch) {
    // 新节点从来源此刻的样子长出：来源空间里还没提交的改动先提交成一个版本。
    const 来源空间 = 文件许可(scope, join(根, 节点产物空间(sourceId)), true)
    // 提交不上不拦派人：新节点照样从来源上一个版本长出，来源的文件仍在原处可读。
    if (登记的空间(spaces, sourceId, 来源空间) && await 存在(来源空间)) {
      try { await 提交空间(git, 来源空间, `${sourceId} 的版本（${行.id} 从这里长出）`) }
      catch (error) { console.log(`Blueprint node: ⚠️ ${sourceId} 的空间没有提交上，${行.id} 从上一个版本长出 —— ${error.message || error}`) }
    }
  }
  // 台要在来源分支里：派出时核对过（验台在分支里），这里再看一次，免得稀疏检出出一个空空间。
  if (行.bench && !await 台在分支里(git, repo, sourceBranch, 行.bench)) throw new Error(`Git 空间：台目录 ${行.bench} 不在 ${sourceBranch} 里`)
  await mkdir(文件许可(scope, join(根, '作品空间'), true), {recursive:true})
  if (行.bench) {
    // 有台：先不检出，套上这一份 worktree 自己的稀疏规则，再检出——磁盘上只有台（git 自动给主仓库打开 extensions.worktreeConfig）。
    await git(['-C', repo, 'worktree', 'add', '--no-checkout', ...(hasBranch ? [] : ['-b', branch]), target, hasBranch ? branch : sourceBranch])
    await git(['-C', target, 'sparse-checkout', 'set', '--no-cone', 稀疏规则(行.bench)])
    await git(['-C', target, 'checkout', '-q', branch], [], 提交时限)
  } else await git(['-C', repo, 'worktree', 'add', ...(hasBranch ? [] : ['-b', branch]), target, hasBranch ? branch : sourceBranch])
  if (!hasBranch) await git(['-C', repo, 'update-ref', 起点引用(行.id), branch])
  spaces = 解析空间(await git(['-C', repo, 'worktree', 'list', '--porcelain', '-z']))
  if (!spaces.some(row => row.branch === reference && row.worktree === target)) throw new Error(`Git 空间：${branch} 未正确登记`)
  return {分支:branch, 路径:path}
}

/** 交回时并进谁：派它的节点；没有派出者的（一件工作的 helm）并进主线（0 号的分支）；0 号自己就是主线。 */
export function 并入目标(名册, id) {
  const 派出者 = 派出者Of(id, 名册)
  if (派出者 !== null) return 派出者
  return String(id) === '0' ? null : '0'
}

/**
 * 把交回节点的分支并进派它的节点的分支，在那个节点的空间里做；那边没提交的改动先存成一个版本。
 * @returns {Promise<null | {已在: true} | {并入: true, 目标: string} | {冲突: string[], 目标: string, 目标分支: string}>}
 */
export async function 并入派出者(根, 名册, id) {
  const 目标 = 并入目标(名册, id)
  if (目标 === null) return null
  根 = await realpath(根)
  return 排进空间队(根, async () => {
    const {scope, repo, mainGit, git} = await 空间环境(根, id)
    if (!(await 存在(mainGit))) return null
    const 目标空间 = 文件许可(scope, join(根, 节点产物空间(目标)), true)
    const spaces = 解析空间(await git(['-C', repo, 'worktree', 'list', '--porcelain', '-z']))
    if (!登记的空间(spaces, 目标, 目标空间) || !(await 存在(目标空间))) return null
    const 分支 = 节点分支(id)
    if (await git(['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${分支}`], [1]) === null) return null
    if (await git(['-C', 目标空间, 'merge-base', '--is-ancestor', 分支, 'HEAD'], [1]) !== null) return { 已在: true }
    try { await 提交空间(git, 目标空间, `${目标} 的版本（并入 ${id} 之前）`) }
    catch (error) { console.log(`Blueprint node: ⚠️ ${目标} 的空间没有提交上，照样并入 ${id} —— ${error.message || error}`) }
    const 回 = await 并进空间(git, 目标空间, 分支, ['--no-ff', '-m', `并入 ${id}`])
    return 回.冲突 ? { 冲突: 回.冲突, 目标, 目标分支: 节点分支(目标) } : { 并入: true, 目标, 变了: 回.变了 }
  })
}

/**
 * 在一个空间里并进一条分支：成了返回变了的文件；撞上冲突撤销这次合并，返回冲突文件。
 * 稀疏检出的空间：变了的只算台里的（台外的只进版本）；并完或撤销后重新套一次稀疏规则——撤销会把台外冲突过的文件留在磁盘上（实验 10-24）。
 */
async function 并进空间(git, 空间, 分支, 参数) {
  const 之前 = await git(['-C', 空间, 'rev-parse', 'HEAD']), 台们 = await 稀疏的台(git, 空间)
  const 在台里 = f => !台们 || 台们.some(台 => f === 台 || f.startsWith(`${台}/`))
  const 并 = await git(['-C', 空间, '-c', 'user.name=Blueprint', '-c', 'user.email=blueprint@localhost', 'merge', '--no-edit', ...参数, 分支], [1], 提交时限)
  if (并 !== null) {
    if (台们) await git(['-C', 空间, 'sparse-checkout', 'reapply'], [1, 128])
    return { 变了: String(await git(['-C', 空间, 'diff', '--name-only', 之前, 'HEAD']) || '').split('\n').filter(Boolean).filter(在台里) }
  }
  const 冲突 = String(await git(['-C', 空间, 'diff', '--name-only', '--diff-filter=U'], [1]) || '').split('\n').filter(Boolean)
  await git(['-C', 空间, 'merge', '--abort'], [1, 128])
  if (台们) await git(['-C', 空间, 'sparse-checkout', 'reapply'], [1, 128])
  return { 冲突 }
}

/** 台目录在这条分支的树里（git 不记空目录：只有空目录、或者里面全是不进版本的文件，就不在）。 */
async function 台在分支里(git, repo, 分支, bench) {
  return !!await git(['-C', repo, 'ls-tree', '-d', '--name-only', 分支, '--', bench.replace(/\/+$/, '')], [128])
}

/**
 * 有台的节点写在台外的文件（交回前看一眼）：稀疏空间里台外的改动和新文件不进版本、不并上去（提交空间只收台里的）。
 * 返回作品仓库里的相对路径；不是稀疏空间、空间没登记或读不出 → 空数组。
 */
export async function 台外的文件(根, id) {
  根 = await realpath(根)
  return 排进空间队(根, async () => {
    try {
      const {scope, repo, mainGit, git} = await 空间环境(根, id)
      if (!(await 存在(mainGit))) return []
      const 空间 = 文件许可(scope, join(根, 节点产物空间(id)), true)
      const spaces = 解析空间(await git(['-C', repo, 'worktree', 'list', '--porcelain', '-z']))
      if (!登记的空间(spaces, id, 空间) || !(await 存在(空间))) return []
      const 台们 = await 稀疏的台(git, 空间)
      if (!台们) return []
      const 段们 = String(await git(['-C', 空间, 'status', '--porcelain', '-z', '--untracked-files=all']) || '').split('\0')
      const 们 = []
      for (let i = 0; i < 段们.length; i++) {
        const 段 = 段们[i]
        if (!段) continue
        if (/^[RC]/.test(段)) i++
        们.push(段.slice(3))
      }
      return [...new Set(们)].filter(f => !台们.some(台 => f === 台 || f.startsWith(`${台}/`)))
    } catch { return [] }
  })
}

/**
 * 派出前核对每块的台都在派出者的分支里（设计页第九节第 3 条：派出的块，台目录要在）。
 * 派出者空间里没提交的先存一个版本（新节点本来就从这一刻长出）。返回不在的那些台；没有作品仓库的旧项目不核对。
 */
export async function 不在分支里的台(根, 派出者, 台们) {
  if (!台们.length) return []
  根 = await realpath(根)
  return 排进空间队(根, async () => {
    const {scope, repo, mainGit, git} = await 空间环境(根, 派出者)
    if (!(await 存在(mainGit))) return []
    const 空间 = 文件许可(scope, join(根, 节点产物空间(派出者)), true)
    const spaces = 解析空间(await git(['-C', repo, 'worktree', 'list', '--porcelain', '-z']))
    if (登记的空间(spaces, 派出者, 空间) && await 存在(空间)) await 提交空间(git, 空间, `${派出者} 的版本（派出之前）`)
    const 缺 = []
    for (const 台 of 台们) if (!await 台在分支里(git, repo, 节点分支(派出者), 台)) 缺.push(台)
    return 缺
  })
}

/**
 * 请求被改写、接着用一个节点之前：把派它的节点此刻的分支并进它的空间（轮 3）。
 * 交回时往上并，接着用时往下并：别的线交回并进上面的东西，它一开工就在自己空间里。
 * 两边没提交的改动先各存一个版本。撞上冲突：撤销，把冲突文件交给它自己解决，机器不替它决定留哪边。
 * @returns {Promise<null | {已在: true} | {并入: true, 来源: string, 变了: string[]} | {冲突: string[], 来源: string, 来源分支: string}>}
 */
export async function 并入派出者分支(根, 名册, id) {
  const 来源 = 并入目标(名册, id)
  if (来源 === null) return null
  根 = await realpath(根)
  return 排进空间队(根, async () => {
    const {scope, repo, mainGit, git} = await 空间环境(根, id)
    if (!(await 存在(mainGit))) return null
    const 空间 = 文件许可(scope, join(根, 节点产物空间(id)), true), 来源空间 = 文件许可(scope, join(根, 节点产物空间(来源)), true)
    const spaces = 解析空间(await git(['-C', repo, 'worktree', 'list', '--porcelain', '-z']))
    if (!登记的空间(spaces, id, 空间) || !(await 存在(空间))) return null
    const 来源分支 = 节点分支(来源)
    if (await git(['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${来源分支}`], [1]) === null) return null
    // 派出者此刻的样子：它空间里还没提交的改动先存成一个版本（同派出新节点前）。
    if (登记的空间(spaces, 来源, 来源空间) && await 存在(来源空间)) {
      try { await 提交空间(git, 来源空间, `${来源} 的版本（${id} 接着做之前）`) }
      catch (error) { console.log(`Blueprint node: ⚠️ ${来源} 的空间没有提交上，${id} 并它上一个版本 —— ${error.message || error}`) }
    }
    if (await git(['-C', 空间, 'merge-base', '--is-ancestor', 来源分支, 'HEAD'], [1]) !== null) return { 已在: true }
    try { await 提交空间(git, 空间, `${id} 的版本（并入 ${来源} 之前）`) }
    catch (error) { console.log(`Blueprint node: ⚠️ ${id} 的空间没有提交上，照样并入 ${来源} —— ${error.message || error}`) }
    const 回 = await 并进空间(git, 空间, 来源分支, ['-m', `并入 ${来源}（接着做之前）`])
    return 回.冲突 ? { 冲突: 回.冲突, 来源, 来源分支 } : { 并入: true, 来源, 变了: 回.变了 }
  })
}

/** 接着做前并入的结果写成一段话，接在改写的叫醒后面；什么都没变就不说。出错不拦开工。 */
export async function 接着做前并入话(根, 名册, id) {
  let 回
  try { 回 = await 并入派出者分支(根, 名册, id) }
  catch (error) { console.log(`Blueprint node: ⚠️ ${id} 接着做前没并上派出者的分支 —— ${error.message || error}`); return '' }
  if (!回 || 回.已在 || (回.并入 && !回.变了.length)) return ''
  const 来源行 = 行Of(名册, 回.来源), 来源 = `${来源行.id} ${来源行.name}`
  const 列 = 文件们 => 文件们.slice(0, 20).map(f => `- ${f}`).join('\n') + (文件们.length > 20 ? `\n- ……共 ${文件们.length} 个` : '')
  return 回.冲突 ? 一段('重置/叫醒/接着做前并入冲突', { 来源, 来源分支: 回.来源分支, 文件: 列(回.冲突) || '- （git 没列出文件）' })
    : 一段('重置/叫醒/接着做前并入', { 来源, 文件: 列(回.变了) })
}

/**
 * 一个节点此刻碰过哪些文件：相对它和 `基准` 节点分支的分叉点，已提交的、还没提交的、新建的都算。
 * 空间没登记或读不出 → 空数组（少报一条通知，不报错）。
 */
export async function 碰过的文件(根, id, 基准) {
  根 = await realpath(根)
  return 排进空间队(根, async () => {
    try {
      const {scope, repo, mainGit, git} = await 空间环境(根, id)
      if (!(await 存在(mainGit))) return []
      const 空间 = 文件许可(scope, join(根, 节点产物空间(id)), true)
      const spaces = 解析空间(await git(['-C', repo, 'worktree', 'list', '--porcelain', '-z']))
      if (!登记的空间(spaces, id, 空间) || !(await 存在(空间))) return []
      const 分叉 = await git(['-C', 空间, 'merge-base', 'HEAD', 节点分支(基准)], [1])
      const 改的 = 分叉 ? String(await git(['-C', 空间, 'diff', '--name-only', 分叉]) || '').split('\n') : []
      const 新的 = String(await git(['-C', 空间, 'ls-files', '--others', '--exclude-standard']) || '').split('\n')
      return [...new Set([...改的, ...新的].filter(Boolean))]
    } catch { return [] }
  })
}

/** 界面的实时文件清单：相对节点开工起点，包含已提交、未提交和新文件；只读，不暂存或提交。 */
export async function 节点空间文件(根, id) {
  根 = await realpath(根)
  const {scope, repo, mainGit, git} = await 空间环境(根, id)
  if (!await 存在(mainGit)) return null
  const 空间 = 文件许可(scope, join(根, 节点产物空间(id)), true)
  const spaces = 解析空间(await git(['--no-optional-locks', '-C', repo, 'worktree', 'list', '--porcelain', '-z']))
  if (!登记的空间(spaces, id, 空间) || !await 存在(空间)) return null
  const 起点 = await git(['--no-optional-locks', '-C', 空间, 'rev-parse', '--verify', `${起点引用(id)}^{commit}`], [128])
  if (!起点) return null
  const 改的 = String(await git(['--no-optional-locks', '-C', 空间, 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--name-only', '-z', 起点]) || '').split('\0')
  const 新的 = String(await git(['--no-optional-locks', '-C', 空间, 'ls-files', '--others', '--exclude-standard', '-z']) || '').split('\0')
  return [...new Set([...改的, ...新的].filter(Boolean))]
}

/**
 * 重启时清除改动：这个节点的空间回到开工那一刻，下层节点的空间拆掉。动手前各存一个版本，分支记录里找得回。
 * 已经交给上层的在上层的空间里，不动。
 */
export async function 回到起点(根, id, 下层们 = []) {
  根 = await realpath(根)
  return 排进空间队(根, async () => {
    const {scope, repo, mainGit, git} = await 空间环境(根, id)
    if (!(await 存在(mainGit))) return
    const spaces = 解析空间(await git(['-C', repo, 'worktree', 'list', '--porcelain', '-z']))
    const 空间Of = n => { const 空间 = 文件许可(scope, join(根, 节点产物空间(n)), true); return 登记的空间(spaces, n, 空间) ? 空间 : null }
    const 起点 = await 起点版本(git, repo, id)
    for (const n of [id, ...下层们]) if (空间Of(n) && await 存在(空间Of(n))) await 提交空间(git, 空间Of(n), `${n} 重启前的版本`)
    if (空间Of(id)) {
      await git(['-C', 空间Of(id), 'reset', '-q', '--hard', 起点])
      await git(['-C', 空间Of(id), 'clean', '-q', '-fdx'])
    }
    for (const n of 下层们) if (空间Of(n)) await git(['-C', repo, 'worktree', 'remove', '--force', 空间Of(n)])
  })
}

/** 记下的起点；旧项目没记：0 号是主线第一个版本，别的节点看分支记录里长出来的那一条。都没有就不猜。 */
async function 起点版本(git, repo, id) {
  const 记下的 = await git(['-C', repo, 'rev-parse', '-q', '--verify', 起点引用(id)], [1])
  if (记下的) return 记下的
  if (String(id) === '0') return (await git(['-C', repo, 'rev-list', '--max-parents=0', 节点分支(id)])).split('\n').at(-1)
  const 长出 = (await git(['-C', repo, 'reflog', 'show', '--format=%H %gs', 节点分支(id)])).split('\n').find(行 => / branch: Created from /.test(行))
  if (!长出) throw new Error(`Git 空间：找不到节点 ${id} 开工时的版本，没有清除改动`)
  return 长出.split(' ')[0]
}
