import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { 后台工具环境, 后台工具命令, 用自带浏览器, 找无头专用版 } from './src/后台工具.js'
import { 隔离命令 } from './src/项目隔离.js'

const require = createRequire(import.meta.url)
const { 后台启动 } = require('./src/后台进程.cjs')
const repo = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)))
const env = { BLUEPRINT_BACKGROUND_WINDOW_LIBRARY: '/项目 空格/后台窗口.dylib', BLUEPRINT_BACKGROUND_OPEN: '/项目 空格/bin/open' }

test('Godot 后台保留参数、管道和取消信号；无窗口检查不改变渲染参数；环境与调用者不被修改', () => {
  const args = ['--path', '游戏 目录', '--write-movie', '/项目/实际画面.avi'], signal = new AbortController().signal
  const options = { env: { OWN_ENV: 'only' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], signal, detached: true }
  const original = structuredClone(options.env)
  const [file, actual, config] = 后台启动('/Applications/Godot.app/Contents/MacOS/Godot', args, options, env)
  assert.equal(file, '/Applications/Godot.app/Contents/MacOS/Godot')
  assert.deepEqual(actual, ['--audio-driver', 'Dummy', ...args])
  assert.equal(config.signal, signal)
  assert.equal(config.stdio, options.stdio)
  assert.equal(config.detached, true)
  assert.equal(config.env.DYLD_INSERT_LIBRARIES, env.BLUEPRINT_BACKGROUND_WINDOW_LIBRARY)
  assert.deepEqual(Object.keys(config.env).sort(), ['BLUEPRINT_BACKGROUND_TOOLS','DYLD_INSERT_LIBRARIES','OWN_ENV'])
  assert.deepEqual(options.env, original)
  assert.deepEqual(args, ['--path', '游戏 目录', '--write-movie', '/项目/实际画面.avi'])
  for (const flags of [['--headless','--import'], ['--display-driver','headless','--check-only']]) {
    const [, got, settings] = 后台启动('godot', flags, options, {})
    assert.deepEqual(got, flags)
    assert.deepEqual(settings.env, options.env)
  }
  assert.throws(() => 后台启动('godot', [], {}, {}), /后台渲染保护不可用/)
})

test('浏览器强制无窗口但保留 CDP 管道和 URL；浏览器辅助进程与普通工具不受改写', () => {
  const flags = ['--headless=false','--remote-debugging-pipe','data:text/html,<h1>检查页面</h1>']
  const [, actual] = 后台启动('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', flags, {}, env)
  assert.deepEqual(actual, ['--headless=new','--mute-audio', ...flags.slice(1)])
  const helper = ['--type=renderer','--lang=zh-CN']
  assert.deepEqual(后台启动('chrome', helper, {}, env)[1], helper)
  assert.deepEqual(后台启动('ffmpeg', ['-i','原片.mov'], {}, env)[1], ['-i','原片.mov'])
  assert.equal(后台启动('/usr/bin/open', ['https://example.com'], {}, env)[0], env.BLUEPRINT_BACKGROUND_OPEN)
})

test('直接 argv 与已有沙箱入口保留选定的程序版本，匹配启动包装；辅助进程保持原样', () => {
  const environment = { PATH:'/项目/bin:/usr/bin',BLUEPRINT_BACKGROUND_CHROME:'/default/chrome' }
  const actual = 后台工具命令(['/usr/bin/sandbox-exec','-p','(version 1)(allow default)','/custom/Google Chrome','--remote-debugging-pipe'],environment)
  assert.deepEqual(actual.slice(0,3),['/usr/bin/sandbox-exec','-p','(version 1)(allow default)'])
  assert.equal(actual[3],'/项目/bin/chromium')
  assert.equal(environment.BLUEPRINT_BACKGROUND_CHROME,'/custom/Google Chrome')
  const helper=['chrome','--type=gpu-process']
  assert.deepEqual(后台工具命令(helper,environment),helper)
  const godot = { PATH:'/项目/bin:/usr/bin' }
  assert.deepEqual(后台工具命令(['/Applications/Godot.app/Contents/MacOS/Godot','--path','游戏'],godot),['/项目/bin/godot','--path','游戏'])
  assert.equal(godot.BLUEPRINT_BACKGROUND_GODOT_TARGET,'/Applications/Godot.app/Contents/MacOS/Godot')
  const itself = { PATH:'/项目/bin:/usr/bin' }
  assert.deepEqual(后台工具命令(['/项目/bin/godot','--path','游戏'],itself),['/项目/bin/godot','--path','游戏'])
  assert.equal(itself.BLUEPRINT_BACKGROUND_GODOT_TARGET,undefined,'调用的就是包装时不记成目标，否则包装一直调自己')
})

test('交给节点的 Godot 是包装：经过 env、登录式 bash/zsh 与 zsh 的绝对路径都加载窗口保护（10-23）', () => {
  // 「部」的 UTF-8 里有 zsh 的转义字节 0x83：ZDOTDIR 若放在项目里，zsh 连启动文件都找不到。
  const root = mkdtempSync(join(repo,'项目/后台 外部中转验证-'))
  try {
    const source = join(root,'探针.c'), probe = join(root,'godot_probe')
    writeFileSync(source,`#include <stdio.h>
      #include <stdlib.h>
      int main(int c,char**v){const char*g=getenv("BLUEPRINT_WINDOW_GUARD_LOADED");printf("GUARD=%s ARG=%s\\n",g?g:"none",c>1?v[c-1]:"");return 0;}\n`)
    const compile=spawnSync('/usr/bin/clang',[source,'-o',probe],{encoding:'utf8',timeout:20000})
    assert.equal(compile.status,0,compile.stderr)
    const scope={根:root,仓库:repo,技能:join(repo,'blueprint/packages/prompt/skill')}
    const run=(argv,input={})=>{
      const spec=隔离命令({argv,env:input,cwd:root},scope)
      assert.equal(spec.env.BLUEPRINT_BACKGROUND_GODOT,join(spec.env.BLUEPRINT_BACKGROUND_BIN,'godot'),'不把真 Godot 的路径放进环境')
      const result=spawnSync(spec.argv[0],spec.argv.slice(1),{cwd:root,env:{...process.env,...spec.env},encoding:'utf8',timeout:15000})
      assert.equal(result.status,0,result.stderr)
      return {out:result.stdout.trim().split('\n').pop(),bin:spec.env.BLUEPRINT_BACKGROUND_BIN}
    }
    // 黑暗之魂 4 号的写法：系统 env 会清掉 DYLD，包装自己再挂上。
    assert.equal(run(['/bin/bash','-c','env HOME="$TMPDIR" "$BLUEPRINT_BACKGROUND_GODOT" 经过env'],{BLUEPRINT_BACKGROUND_GODOT_TARGET:probe}).out,'GUARD=1 ARG=经过env')
    // 登录式 shell 读用户的 profile 后，后台入口仍排在最前；项目路径带中文和空格。
    for (const shell of [['/bin/zsh','-lc'],['/bin/bash','-lc']]) {
      const {out,bin}=run([...shell,'echo "$(command -v godot)|$(command -v open)"'])
      assert.equal(out,`${join(bin,'godot')}|${join(bin,'open')}`,shell.join(' '))
    }
    for (const shell of [['/bin/zsh','-lc'],['/bin/zsh','-c'],['/bin/bash','-lc']]) {
      assert.equal(run([...shell,`${JSON.stringify(probe)} 绝对路径`]).out,'GUARD=1 ARG=绝对路径',shell.join(' '))
    }
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('正式版 Google Chrome 换成 App 带的无头专用版（正式版会叫醒 Google 更新程序）；别的浏览器仍按调用者选的', () => {
  const 正式版 = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 自带 = '/App/browser/chrome-headless-shell'
  const [file, actual] = 后台启动(正式版, ['--remote-debugging-port=0'], {}, { ...env, BLUEPRINT_BACKGROUND_CHROME: 自带 })
  assert.equal(file, 自带)
  assert.deepEqual(actual, ['--headless=new', '--mute-audio', '--use-angle=metal', '--remote-debugging-port=0'], '无头专用版用显卡画，调用者的参数在后面仍算数')
  assert.equal(后台启动(正式版, [], {}, env)[0], 正式版, '没有可换的浏览器就照旧')
  assert.equal(后台启动('/custom/Google Chrome', [], {}, { ...env, BLUEPRINT_BACKGROUND_CHROME: 自带 })[0], '/custom/Google Chrome')
  const environment = { PATH: '/项目/bin:/usr/bin', BLUEPRINT_BACKGROUND_CHROME: 自带 }
  assert.deepEqual(后台工具命令([正式版, '--remote-debugging-pipe'], environment), ['/项目/bin/chromium', '--remote-debugging-pipe'])
  assert.equal(environment.BLUEPRINT_BACKGROUND_CHROME, 自带)
})

test('浏览器资源目录里找无头专用版：取最新一版，没有就是空', () => {
  const dir = mkdtempSync(join(tmpdir(), '浏览器资源-'))
  try {
    assert.equal(找无头专用版(dir), '')
    for (const version of ['1200', '1243']) {
      const shell = join(dir, `chromium_headless_shell-${version}`, 'chrome-headless-shell-mac-arm64')
      mkdirSync(shell, { recursive: true }); writeFileSync(join(shell, 'chrome-headless-shell'), '')
    }
    mkdirSync(join(dir, 'chromium-1243'))
    assert.equal(找无头专用版(dir), join(dir, 'chromium_headless_shell-1243', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'))
    assert.equal(找无头专用版(join(dir, '不存在')), '')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('真实项目环境：脚本里写死正式版 Chrome，实际由无头专用版取回网页', t => {
  const 正式版 = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const 资源 = join(repo, 'app/.build/native-resources'), 自带 = 找无头专用版(join(资源, 'browser'))
  if (!existsSync(正式版) || !自带) return t.skip('本机没有正式版 Chrome 或 App 带的无头专用版')
  const root = mkdtempSync(join(repo, '项目/自带浏览器验证-'))
  用自带浏览器(自带)
  try {
    const command = `import {spawnSync} from 'node:child_process';
      const r=spawnSync(${JSON.stringify(正式版)},['--no-sandbox','--user-data-dir=${join(root, '.blueprint-tmp/资料')}','--dump-dom','data:text/html;charset=utf-8,<h1>自带</h1>'],{encoding:'utf8',timeout:30000});
      console.log(r.stdout.trim())`
    // 运行时 App 资源目录是沙箱里的只读代码目录（index.js 装项目隔离时传入）。
    const scope = { 根: root, 仓库: repo, 技能: join(repo, 'blueprint/packages/prompt/skill'), 只读代码目录: [realpathSync(资源)] }
    const spec = 隔离命令({ argv: [process.execPath, '--input-type=module', '-e', command], cwd: root }, scope)
    assert.equal(spec.env.BLUEPRINT_BACKGROUND_CHROME, 自带)
    const result = spawnSync(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env }, encoding: 'utf8', timeout: 40000 })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /<h1>自带<\/h1>/)
  } finally { 用自带浏览器(''); rmSync(root, { recursive: true, force: true }) }
})

test('真实项目环境：嵌套 Node 与 ESM 启动入口覆盖有窗口调用，shell 参数与显式环境保持原样', () => {
  const root = mkdtempSync(join(repo, '项目/后台工具 空格验证-'))
  try {
    const probe = join(root, 'Google Chrome')
    const quoted = value => "'" + value.replaceAll("'", "'\\''") + "'"
    const probeCode = 'console.log(JSON.stringify({args:process.argv.slice(1),env:process.env.OWN_ENV,hidden:process.env.BLUEPRINT_BACKGROUND_TOOLS}))'
    writeFileSync(probe, `#!/bin/sh\nexec ${quoted(process.execPath)} -e ${quoted(probeCode)} -- "$@"\n`, { mode: 0o755 })
    const command = `import {spawnSync,execFile,execFileSync} from 'node:child_process';import {promisify} from 'node:util';
      const file=${JSON.stringify(probe)};
      const args=['--headless=false','--remote-debugging-pipe','页面 空格'];
      console.log(spawnSync(file,args,{encoding:'utf8',env:{OWN_ENV:'only'}}).stdout.trim());
      console.log(execFileSync(file,args,{encoding:'utf8',env:{OWN_ENV:'only'}}).trim());
      await new Promise((ok,fail)=>execFile(file,args,{encoding:'utf8',env:{OWN_ENV:'only'}},(error,out)=>error?fail(error):(console.log(out.trim()),ok())));
      const pending=promisify(execFile)(file,args,{encoding:'utf8',env:{OWN_ENV:'only'}});if(!pending.child?.pid)throw Error('Promise 缺少 child 句柄');const outcome=await pending;if(typeof outcome.stderr!=='string')throw Error('Promise 缺少 stderr');console.log(outcome.stdout.trim());`
    const scope = { 根: root, 仓库: repo, 技能: join(repo, 'blueprint/packages/prompt/skill') }
    const spec = 隔离命令({ argv: [process.execPath, '--input-type=module', '-e', command], cwd: root }, scope)
    const result = spawnSync(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: {...process.env,...spec.env},encoding:'utf8',timeout:20000 })
    assert.equal(result.status, 0, result.stderr)
    const rows = result.stdout.trim().split('\n').map(line=>JSON.parse(line))
    assert.equal(rows.length, 4)
    for (const row of rows) {
      assert.deepEqual(row.args, ['--headless=new','--mute-audio','--remote-debugging-pipe','页面 空格'])
      assert.equal(row.env, 'only')
      assert.equal(row.hidden, undefined, '不能把调用者清除的环境重新灌入子进程')
    }
    const blocked = spawnSync(join(spec.env.PATH.split(':')[0],'open'), ['https://example.com'], {env:{...process.env,...spec.env},encoding:'utf8'})
    assert.equal(blocked.status, 1)
    assert.match(blocked.stderr, /不打开桌面应用/)
  } finally { rmSync(root, {recursive:true,force:true}) }
})

test('原生窗口保护不激活、不接收鼠标；重复显示、设置透明度与抢焦点仍保持后台', () => {
  const root = mkdtempSync(join(tmpdir(), 'Blueprint 后台窗口验证-'))
  try {
    const environment = 后台工具环境(root)
    assert.ok(environment.BLUEPRINT_BACKGROUND_WINDOW_LIBRARY, '本机必须能构建保护库')
    const source = join(root,'后台窗口探针.m'), binary = join(root,'后台窗口探针')
    writeFileSync(source, `#import <AppKit/AppKit.h>
      int main(){@autoreleasepool {
        if(!getenv("BLUEPRINT_WINDOW_GUARD_LOADED"))return 99;
        NSApplication *app=[NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        NSWindow *w=[[NSWindow alloc] initWithContentRect:NSMakeRect(20,20,160,120) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        [w setReleasedWhenClosed:NO];
        [w setAlphaValue:1];[w setIgnoresMouseEvents:NO];[w makeKeyAndOrderFront:nil];
        [app activateIgnoringOtherApps:YES];[[NSRunningApplication currentApplication] activateWithOptions:NSApplicationActivateIgnoringOtherApps];
        [w makeKeyWindow];[w makeMainWindow];[w orderFrontRegardless];
        BOOL ok=w.alphaValue==0&&w.ignoresMouseEvents&&!w.keyWindow&&!w.mainWindow&&!app.active&&app.activationPolicy==NSApplicationActivationPolicyAccessory;
        printf("hidden=%d active=%d key=%d\\n",ok,app.active,w.keyWindow);[w close];return ok?0:1;
      }}\n`)
    const compile=spawnSync('/usr/bin/clang',['-fobjc-arc','-framework','AppKit',source,'-o',binary],{encoding:'utf8',timeout:20000})
    assert.equal(compile.status,0,compile.stderr)
    const result=spawnSync(binary,[],{env:{...process.env,...environment,DYLD_INSERT_LIBRARIES:environment.BLUEPRINT_BACKGROUND_WINDOW_LIBRARY},encoding:'utf8',timeout:10000})
    assert.equal(result.status,0,result.stderr)
    assert.match(result.stdout,/hidden=1 active=0 key=0/)
  } finally { rmSync(root,{recursive:true,force:true}) }
})

test('Shell 启动环境保留原有入口，普通原生工具不加载 AppKit，宿主环境不变', () => {
  const root = mkdtempSync(join(repo,'项目/后台 Shell 入口验证-'))
  try {
    const startup = join(root,'原有Shell环境.sh'), source = join(root,'普通命令探针.c'), binary = join(root,'普通命令探针')
    writeFileSync(startup,'export ORIGINAL_STARTUP=kept\n')
    writeFileSync(source,`#include <mach-o/dyld.h>
      #include <stdio.h>
      #include <stdlib.h>
      #include <string.h>
      int main(){for(uint32_t i=0;i<_dyld_image_count();i++){if(strstr(_dyld_get_image_name(i),"AppKit.framework"))return 1;}
        if(!getenv("ORIGINAL_STARTUP")||strcmp(getenv("ORIGINAL_STARTUP"),"kept"))return 2;
        puts("ORDINARY_TOOL_HAS_NO_APPKIT=true");return 0;}\n`)
    const compile=spawnSync('/usr/bin/clang',[source,'-o',binary],{encoding:'utf8',timeout:20000})
    assert.equal(compile.status,0,compile.stderr)
    const input={BASH_ENV:startup}, original=process.env.BASH_ENV
    const scope={根:root,仓库:repo,技能:join(repo,'blueprint/packages/prompt/skill')}
    const spec=隔离命令({argv:['/bin/bash','-c','"$1"','bash',binary],env:input,cwd:root},scope)
    const result=spawnSync(spec.argv[0],spec.argv.slice(1),{cwd:root,env:{...process.env,...spec.env},encoding:'utf8',timeout:10000})
    assert.equal(result.status,0,result.stderr)
    assert.match(result.stdout,/ORDINARY_TOOL_HAS_NO_APPKIT=true/)
    assert.deepEqual(input,{BASH_ENV:startup})
    assert.equal(process.env.BASH_ENV,original)
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('真实 Godot 在项目沙箱中后台渲染动态画面，PNG 像素变化且正常退出', t => {
  if(!existsSync('/opt/homebrew/bin/godot'))return t.skip('本机未安装 Godot')
  const root=mkdtempSync(join(repo,'项目/后台 Godot 验证-'))
  try {
    writeFileSync(join(root,'project.godot'),'config_version=5\n[application]\nconfig/name="后台渲染验证"\nrun/main_scene="res://后台渲染场景.tscn"\n[display]\nwindow/size/viewport_width=320\nwindow/size/viewport_height=240\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[debug]\nfile_logging/enable_file_logging=false\n')
    writeFileSync(join(root,'后台渲染场景.tscn'),'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://后台渲染场景.gd" id="1"]\n[node name="后台渲染验证" type="Node2D"]\nscript = ExtResource("1")\n')
    writeFileSync(join(root,'后台渲染场景.gd'),`extends Node2D
func _ready():
\tif OS.get_environment("BLUEPRINT_WINDOW_GUARD_LOADED") != "1":
\t\tget_tree().quit(99)
\t\treturn
\tvar rect = ColorRect.new()
\trect.size = Vector2(320,240)
\trect.color = Color(1,0,0,1)
\tadd_child(rect)
\tawait RenderingServer.frame_post_draw
\tawait RenderingServer.frame_post_draw
\tvar image = get_viewport().get_texture().get_image()
\timage.save_png("res://后台渲染红色.png")
\tif image.get_pixel(120,120).r < 0.9:
\t\tget_tree().quit(2)
\t\treturn
\trect.color = Color(0,1,0,1)
\tawait RenderingServer.frame_post_draw
\tawait RenderingServer.frame_post_draw
\timage = get_viewport().get_texture().get_image()
\timage.save_png("res://后台渲染绿色.png")
\tif image.get_pixel(120,120).g < 0.9:
\t\tget_tree().quit(3)
\t\treturn
\tprint("BACKGROUND_RENDER_CHANGED=true")
\tget_tree().quit(0)
`)
    const scope={根:root,仓库:repo,技能:join(repo,'blueprint/packages/prompt/skill')}
    const commands = [
      'godot --path "$BLUEPRINT_PROJECT_ROOT" --quit-after 120',
      'G=/Applications/Godot.app/Contents/MacOS/Godot; "$G" --path "$BLUEPRINT_PROJECT_ROOT" --quit-after 120',
      '/bin/bash -c \'G=/Applications/Godot.app/Contents/MacOS/Godot; "$G" --path "$BLUEPRINT_PROJECT_ROOT" --quit-after 120\'',
      'env HOME="$TMPDIR" "$BLUEPRINT_BACKGROUND_GODOT" --path "$BLUEPRINT_PROJECT_ROOT" --quit-after 120',
      '/bin/zsh -lc \'godot --path "$BLUEPRINT_PROJECT_ROOT" --quit-after 120\'',
      '/bin/zsh -c \'G=/Applications/Godot.app/Contents/MacOS/Godot; "$G" --path "$BLUEPRINT_PROJECT_ROOT" --quit-after 120\'',
    ]
    for (const command of commands) {
      for (const name of ['后台渲染红色.png','后台渲染绿色.png']) rmSync(join(root,name),{force:true})
      const spec=隔离命令({argv:['/bin/bash','-c',command],cwd:root},scope)
      const result=spawnSync(spec.argv[0],spec.argv.slice(1),{cwd:spec.cwd,env:{...process.env,...spec.env},encoding:'utf8',timeout:15000})
      assert.equal(result.status,0,result.stderr)
      assert.match(result.stdout,/BACKGROUND_RENDER_CHANGED=true/)
      assert.notDeepEqual(readFileSync(join(root,'后台渲染红色.png')),readFileSync(join(root,'后台渲染绿色.png')))
      assert.match(result.stdout,/OpenGL API|Metal|Vulkan/)
    }
    writeFileSync(join(root,'无窗口检查探针.gd'),`extends SceneTree
func _initialize():
\tif OS.get_environment("BLUEPRINT_WINDOW_GUARD_LOADED") == "1":
\t\tquit(99)
\telse:
\t\tprint("HEADLESS_HAS_NO_WINDOW_GUARD=true")
\t\tquit(0)
`)
    const headless=隔离命令({argv:['/bin/bash','-c','G=/Applications/Godot.app/Contents/MacOS/Godot; "$G" --headless --path "$BLUEPRINT_PROJECT_ROOT" --script res://无窗口检查探针.gd'],cwd:root},scope)
    const check=spawnSync(headless.argv[0],headless.argv.slice(1),{cwd:root,env:{...process.env,...headless.env},encoding:'utf8',timeout:10000})
    assert.equal(check.status,0,check.stderr)
    assert.match(check.stdout,/HEADLESS_HAS_NO_WINDOW_GUARD=true/)
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('实际 Playwright 即使指定 headless=false 也用后台 Chrome 渲染截图并关闭', t => {
  const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const playwright=createRequire(new URL('../../../app/package.json',import.meta.url)).resolve('playwright-core')
  if(!existsSync(chrome))return t.skip('本机未安装 Chrome')
  const root=mkdtempSync(join(repo,'项目/后台浏览器验证-'))
  try {
    const screenshot=join(root,'后台网页截图.png')
    const command=`const {chromium}=require(${JSON.stringify(playwright)});
      (async()=>{const browser=await chromium.launch({executablePath:${JSON.stringify(chrome)},headless:false,args:['--enable-automation','--no-sandbox','--disable-gpu-sandbox','--disable-crash-reporter','--disable-breakpad','--disable-component-update'],timeout:15000});
        try{const cdp=await browser.newBrowserCDPSession();const {arguments:args}=await cdp.send('Browser.getBrowserCommandLine');if(!args.includes('--headless=new'))throw Error('未启用后台模式');
          const page=await browser.newPage({viewport:{width:320,height:240}});await page.setContent('<html><body style="background:#1252dd"><h1>后台浏览器</h1></body></html>');await page.screenshot({path:${JSON.stringify(screenshot)}});console.log('BACKGROUND_BROWSER_RENDERED=true');
        }finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1})`
    const scope={根:root,仓库:repo,技能:join(repo,'blueprint/packages/prompt/skill'),只读代码目录:[dirname(playwright)]}
    const spec=隔离命令({argv:['/bin/bash','-c','"$1" -e "$2"','bash',process.execPath,command],cwd:root},scope)
    const result=spawnSync(spec.argv[0],spec.argv.slice(1),{cwd:spec.cwd,env:{...process.env,...spec.env},encoding:'utf8',timeout:25000})
    assert.equal(result.status,0,result.stderr)
    assert.match(result.stdout,/BACKGROUND_BROWSER_RENDERED=true/)
    assert.ok(readFileSync(screenshot).length>1000)
  }finally{rmSync(root,{recursive:true,force:true})}
})
