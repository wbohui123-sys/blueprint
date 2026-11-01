/** 宿主准备项目内的后台启动入口；不改变宿主 PATH 或用户的应用设置。 */
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync, realpathSync, copyFileSync, renameSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, delimiter, basename, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { 数据根, 工具临时目录名 } from '../../prompt/src/路径.js'

const 原生源码 = fileURLToPath(new URL('./native/后台窗口.m', import.meta.url))
const 入口源码 = fileURLToPath(new URL('./native/后台入口.c', import.meta.url))
const 进程源码 = fileURLToPath(new URL('./后台进程.cjs', import.meta.url))
const 版本 = createHash('sha256').update(readFileSync(原生源码)).update(readFileSync(入口源码)).update(readFileSync(进程源码)).update(readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 16)
const 已准备 = new Map()
let 原生库
// 正式版 Google Chrome 每次启动都会叫醒 Google 的更新程序（加什么参数都拦不住），节点一天开几十次就堆成上百个。
// 换成 Playwright 一并装的无头专用版 chrome-headless-shell：不带更新程序，也不读钥匙串。
// 同目录的 Chrome for Testing 不行：它要读钥匙串，会弹密码框，后台没人点就一直卡住。
const 正式版Chrome = /\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome$/
let 自带浏览器 = ''
const 单引号 = value => "'" + String(value).replaceAll("'", "'\\''") + "'"
// 登录式 zsh 会重跑用户的 .zprofile（brew shellenv 把 Homebrew 排回最前），zsh 也不读 BASH_ENV；外部 run 的命令都走它（10-23）。
// 项目工具的 zsh 改读这里：每份先照常读用户自己的同名文件，再把后台入口排回最前。
const zsh启动文件 = ['.zshenv', '.zprofile', '.zshrc', '.zlogin', '.zlogout']
// zsh 5.9 从环境接含中文的 ZDOTDIR 会弄坏，连 .zshenv 都找不到（10-23 实测，项目路径常带中文）。这几份不分项目，放一份在系统临时目录的纯英文路径下；
// 文件里也不读接进来的 $ZDOTDIR，改回用 BLUEPRINT_BACKGROUND_ZSH。
const zsh启动 = name => `# 项目工具的 zsh 先照常读用户自己的 ${name}，再把后台入口排回最前。
ZDOTDIR=\${BLUEPRINT_BACKGROUND_ORIGINAL_ZDOTDIR:-$HOME}
if [[ -r $ZDOTDIR/${name} ]]; then source "$ZDOTDIR/${name}"; fi
if [[ $ZDOTDIR != \${BLUEPRINT_BACKGROUND_ORIGINAL_ZDOTDIR:-$HOME} ]]; then export BLUEPRINT_BACKGROUND_ORIGINAL_ZDOTDIR=$ZDOTDIR; fi
ZDOTDIR=$BLUEPRINT_BACKGROUND_ZSH
if [[ $BLUEPRINT_BACKGROUND_TOOLS == 1 ]]; then
  if [[ -n $BLUEPRINT_BACKGROUND_BIN && $PATH != "$BLUEPRINT_BACKGROUND_BIN":* ]]; then export PATH="$BLUEPRINT_BACKGROUND_BIN:$PATH"; fi
  if [[ -n $BLUEPRINT_BACKGROUND_ENTRY_LIBRARY ]]; then export DYLD_INSERT_LIBRARIES=$BLUEPRINT_BACKGROUND_ENTRY_LIBRARY; fi
fi
`

/** 浏览器资源目录里的无头专用版；没有就是空字符串。 */
export function 找无头专用版(目录) {
  const 读 = path => { try { return readdirSync(path) } catch { return [] } }
  for (const name of 读(目录).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()) {
    for (const sub of 读(join(目录, name))) {
      const file = join(目录, name, sub, 'chrome-headless-shell')
      try { if (statSync(file).isFile()) return file } catch {}
    }
  }
  return ''
}

/** 执行能力装配时告诉这里 App 带的无头专用版在哪；之后准备的项目都用它，没有就照旧用电脑上装的。 */
export function 用自带浏览器(path) {
  自带浏览器 = path || ''
  已准备.clear()
}

function zsh目录() {
  const 英文 = path => /^[\x20-\x7e]+$/.test(path)
  const base = [tmpdir(), '/private/tmp'].map(path => { try { return realpathSync(path) } catch { return '' } }).find(path => path && 英文(path))
  const dir = join(base || '/private/tmp', `blueprint-zsh-${process.getuid?.() ?? 0}-${版本}`)
  if (!existsSync(join(dir, zsh启动文件.at(-1)))) {
    mkdirSync(dir, { recursive: true })
    for (const name of zsh启动文件) writeFileSync(join(dir, name), zsh启动(name), { mode: 0o644 })
  }
  return dir
}

function 构建原生库() {
  if (原生库 !== undefined) return 原生库
  const cache = join(数据根, '.dsh', '工具缓存', '后台窗口-' + 版本)
  const target = join(cache, '后台窗口.dylib')
  const entry = join(cache, '后台入口.dylib')
  if (!existsSync(target) || !existsSync(entry)) {
    mkdirSync(cache, { recursive: true })
    const temporary = join(cache, `后台窗口-编译进程-${process.pid}.dylib`)
    const entryTemporary = join(cache, `后台入口-编译进程-${process.pid}.dylib`)
    try {
      execFileSync('/usr/bin/clang', ['-dynamiclib', '-fobjc-arc', '-framework', 'AppKit', 原生源码, '-o', temporary], { timeout: 30000, stdio: 'pipe' })
      execFileSync('/usr/bin/clang', ['-dynamiclib', 入口源码, '-o', entryTemporary], { timeout: 30000, stdio: 'pipe' })
      renameSync(temporary, target)
      renameSync(entryTemporary, entry)
    } catch {
      try { unlinkSync(temporary) } catch {}
      try { unlinkSync(entryTemporary) } catch {}
      return 原生库 = null
    }
  }
  return 原生库 = { window: target, entry }
}

function 可执行路径(name) {
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    const path = join(directory, name)
    try { return realpathSync(path) } catch {}
  }
  return ''
}

function 准备(根) {
  let value = 已准备.get(根)
  // 系统临时目录会被定期清理，zsh 那几份不在了就重新准备。
  if (value && existsSync(value.hook) && existsSync(join(value.zsh, zsh启动文件.at(-1)))) { 已准备.delete(根); 已准备.set(根, value); return value }
  const dir = join(根, 工具临时目录名, '后台工具-' + 版本), bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const hook = join(dir, '后台进程.cjs')
  copyFileSync(进程源码, hook)
  const native = 构建原生库()
  const library = native ? join(dir, '后台窗口.dylib') : ''
  const entry = native ? join(dir, '后台入口.dylib') : ''
  if (library) { copyFileSync(native.window, library); copyFileSync(native.entry, entry) }
  const bashEnv = join(dir, '后台Shell环境.sh')
  writeFileSync(bashEnv, `# Bash 启动后恢复被 macOS 系统程序清除的 DYLD 环境，覆盖绝对路径调用。
if [ -n "$BLUEPRINT_BACKGROUND_ORIGINAL_BASH_ENV" ] && [ "$BLUEPRINT_BACKGROUND_ORIGINAL_BASH_ENV" != "$BASH_ENV" ]; then
  . "$BLUEPRINT_BACKGROUND_ORIGINAL_BASH_ENV"
fi
if [ "$BLUEPRINT_BACKGROUND_TOOLS" = 1 ]; then
  if [ -z "$BLUEPRINT_BACKGROUND_ENTRY_LIBRARY" ]; then
    echo "后台启动保护无法构建，拒绝运行 Shell；请检查本机 clang。" >&2
    exit 126
  fi
  export DYLD_INSERT_LIBRARIES="$BLUEPRINT_BACKGROUND_ENTRY_LIBRARY"
  # bash -l 先跑用户的 profile 再读这里；profile 会把 Homebrew 排到后台入口前面。
  case "$PATH" in
    "$BLUEPRINT_BACKGROUND_BIN":*) ;;
    *) [ -n "$BLUEPRINT_BACKGROUND_BIN" ] && PATH="$BLUEPRINT_BACKGROUND_BIN:$PATH" && export PATH ;;
  esac
fi
`, { mode: 0o644 })
  const zsh = zsh目录()
  const godot = 可执行路径('godot')
  const chrome = [自带浏览器, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(path => path && existsSync(path)) || 可执行路径('chromium')
  const playwright = 可执行路径('playwright-cli')
  const open = join(bin, 'open')
  writeFileSync(open, '#!/bin/sh\necho "项目工具在后台运行，不打开桌面应用；网页请用无窗口浏览器，查看产物请交回 WebUI 预览。" >&2\nexit 1\n', { mode: 0o755 })
  // 在系统 shell 启动后设置 DYLD；sandbox-exec 与系统 shell（env、sh、zsh 等）会清除继承的 DYLD 环境。
  // 真 Godot 的路径只写在这里，不放进环境：放进去节点会拿它绕过包装（10-23 黑暗之魂 4 号 `exec env HOME=… "$godot_bin"`）。
  writeFileSync(join(bin, 'godot'), `#!/bin/sh
target=\${BLUEPRINT_BACKGROUND_GODOT_TARGET:-${单引号(godot)}}
if [ -z "$target" ]; then echo "未找到 Godot 可执行文件。" >&2; exit 127; fi
case " $* " in
  *" --headless "*|*" --display-driver headless "*) exec "$target" "$@" ;;
esac
library=\${BLUEPRINT_BACKGROUND_WINDOW_LIBRARY:-${单引号(library)}}
if [ -z "$library" ]; then
  echo "Godot 后台渲染保护不可用；检查和导出请使用 --headless。" >&2
  exit 1
fi
export BLUEPRINT_BACKGROUND_TOOLS=1 DYLD_INSERT_LIBRARIES="$library"
case " $* " in *" --audio-driver "*) ;; *) set -- --audio-driver Dummy "$@" ;; esac
exec "$target" "$@"
`, { mode: 0o755 })
  const browser = join(bin, 'chromium')
  writeFileSync(browser, `#!/bin/sh
if [ -z "$BLUEPRINT_BACKGROUND_CHROME" ]; then echo "未找到 Chromium 浏览器。" >&2; exit 127; fi
remaining=$#
while [ "$remaining" -gt 0 ]; do
  arg=$1; shift; remaining=$((remaining - 1))
  case "$arg" in --headless|--headless=*) ;; *) set -- "$@" "$arg" ;; esac
done
# 无头专用版默认用 CPU 画，游戏截图慢六七倍；让它用显卡。放在前面，调用者自己指定的仍然算数。
case "$BLUEPRINT_BACKGROUND_CHROME" in
  */chrome-headless-shell) exec "$BLUEPRINT_BACKGROUND_CHROME" --headless=new --mute-audio --use-angle=metal "$@" ;;
esac
exec "$BLUEPRINT_BACKGROUND_CHROME" --headless=new --mute-audio "$@"
`, { mode: 0o755 })
  for (const name of ['chrome', 'Google Chrome']) copyFileSync(browser, join(bin, name))
  writeFileSync(join(bin, 'playwright-cli'), `#!/bin/sh
if [ -z "$BLUEPRINT_BACKGROUND_PLAYWRIGHT" ]; then echo "未找到 Playwright CLI。" >&2; exit 127; fi
remaining=$#
while [ "$remaining" -gt 0 ]; do
  arg=$1; shift; remaining=$((remaining - 1))
  case "$arg" in --headed|--headed=*) ;; *) set -- "$@" "$arg" ;; esac
done
export PLAYWRIGHT_MCP_HEADLESS=true
exec "$BLUEPRINT_BACKGROUND_PLAYWRIGHT" "$@"
`, { mode: 0o755 })
  value = { dir, bin, hook, library, entry, bashEnv, zsh, godot, chrome, playwright, browser, open }
  已准备.set(根, value)
  if (已准备.size > 128) 已准备.delete(已准备.keys().next().value)
  return value
}

export function 后台工具环境(根, input = {}) {
  const tool = 准备(根)
  return {
    ...input,
    PATH: tool.bin + delimiter + (input.PATH ?? process.env.PATH ?? ''),
    NODE_OPTIONS: [input.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? '', '--require=' + JSON.stringify(tool.hook)].filter(Boolean).join(' '),
    BLUEPRINT_BACKGROUND_TOOLS: '1', BLUEPRINT_BACKGROUND_WINDOW_LIBRARY: tool.library,
    BLUEPRINT_BACKGROUND_ENTRY_LIBRARY: tool.entry, BASH_ENV: tool.bashEnv,
    BLUEPRINT_BACKGROUND_ORIGINAL_BASH_ENV: input.BLUEPRINT_BACKGROUND_ORIGINAL_BASH_ENV ?? input.BASH_ENV ?? process.env.BASH_ENV ?? '',
    BLUEPRINT_BACKGROUND_BIN: tool.bin, ZDOTDIR: tool.zsh, BLUEPRINT_BACKGROUND_ZSH: tool.zsh,
    BLUEPRINT_BACKGROUND_ORIGINAL_ZDOTDIR: input.BLUEPRINT_BACKGROUND_ORIGINAL_ZDOTDIR ?? input.ZDOTDIR ?? process.env.ZDOTDIR ?? '',
    // 交给节点的 Godot 是包装：脚本拿它当可执行文件、中间再过 env 也照样后台。
    BLUEPRINT_BACKGROUND_GODOT: join(tool.bin, 'godot'), BLUEPRINT_BACKGROUND_CHROME: tool.chrome,
    BLUEPRINT_BACKGROUND_PLAYWRIGHT: tool.playwright, BLUEPRINT_BACKGROUND_OPEN: tool.open,
    PLAYWRIGHT_MCP_HEADLESS: 'true', MPLBACKEND: 'Agg',
    ...(tool.chrome ? { HARNESS_CHROME: tool.browser } : {}),
    BROWSER: tool.open,
  }
}

/** 直接 argv 入口也走同一包装；保留调用者选定的可执行文件。 */
export function 后台工具命令(argv, env) {
  const result = [...argv], position = ['sandbox-exec','/usr/bin/sandbox-exec'].includes(result[0]) ? 3 : 0
  const file = result[position], name = basename(file || '').toLowerCase(), bin = env.PATH.split(delimiter)[0]
  const replace = (wrapper, key) => {
    // 调用的本来就是包装自己时不记成目标，否则包装会一直调自己。
    if (key && isAbsolute(file) && dirname(file) !== bin) env[key] = file
    result[position] = join(bin, wrapper)
  }
  if (/^godot(?:[._-].*)?$/.test(name)) replace('godot', 'BLUEPRINT_BACKGROUND_GODOT_TARGET')
  else if (['google chrome','google chrome for testing','chromium','chrome','chromium-browser','chrome-headless-shell'].includes(name)
    && !result.slice(position + 1).some(arg => String(arg).startsWith('--type='))) replace('chromium', 正式版Chrome.test(file) ? '' : 'BLUEPRINT_BACKGROUND_CHROME')
  else if (name === 'playwright-cli') replace('playwright-cli', 'BLUEPRINT_BACKGROUND_PLAYWRIGHT')
  else if (name === 'open') replace('open')
  return result
}
