import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { 创建Agent默认设置 } from './src/Agent默认设置.js'
import { 验子代理设置 } from './src/子代理开关.js'

const run = promisify(execFile), repository = fileURLToPath(new URL('../../../', import.meta.url))
async function 临时数据(t) {
  const root = await mkdtemp(join(tmpdir(), 'Blueprint-Agent默认设置核验-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('新建默认持久化，重建实例恢复整份选择，仅记录配置且保留主动清空的偏好', async t => {
  const root = await 临时数据(t), store = 创建Agent默认设置(root)
  assert.deepEqual(await store.read(), { ...验子代理设置(), 设过: false })
  const settings = { 开关: { dsh: false, codex: true }, 模型: { codex: { model: 'gpt-6.1-sol', effort: 'max' } },
    偏好: { codex: '', dsh: '  程序实现  ' }, 检查: { token: '不得保存' }, 测试: { codex: { 通过: true } }, 全局模型: { model: '不属于这份设置' } }
  const expected = 验子代理设置(settings)
  assert.deepEqual(await store.write(settings), { ...expected, 设过: true })
  assert.deepEqual(await 创建Agent默认设置(root).read(), { ...expected, 设过: true })
  assert.deepEqual(JSON.parse(await readFile(join(root, 'Agent默认设置.json'), 'utf8')), { version: 1, 设置: expected })
  await assert.rejects(store.write({ 模型: { codex: { model: '不合法的 model' } } }), /名字不对/)
  assert.deepEqual(await store.read(), { ...expected, 设过: true })
})

test('损坏的默认记录如实报错，不悄悄回到初始配置', async t => {
  const root = await 临时数据(t), store = 创建Agent默认设置(root)
  for (const raw of ['{', '{"version":99,"设置":{}}', '{"version":1,"设置":{"开关":{"codex":"yes"}}}']) {
    await writeFile(join(root, 'Agent默认设置.json'), raw)
    await assert.rejects(store.read(), /Agent 默认设置读不懂/)
    assert.equal(await readFile(join(root, 'Agent默认设置.json'), 'utf8'), raw)
  }
})

test('真实建项目在启动首节点前写入默认，下一轮沿用，改默认不改变旧项目，显式配置优先', async t => {
  const base = await 临时数据(t)
  await mkdir(join(base, '应用数据'))
  const script = String.raw`
    import assert from 'node:assert/strict';
    import {join} from 'node:path';
    import {stat} from 'node:fs/promises';
    import {Agent默认设置} from './blueprint/packages/node/src/Agent默认设置.js';
    import {读子代理开关,验子代理设置} from './blueprint/packages/node/src/子代理开关.js';
    import {建项目} from './blueprint/packages/node/src/index.js';
    import {假宿主} from './blueprint/packages/node/测试会话.js';
    import {子代理HTTP} from './blueprint/packages/studio/src/子代理.js';
    import {Readable} from 'node:stream';
    const settings = 验子代理设置({开关:{dsh:false,codex:true},模型:{codex:{model:'gpt-6.1-sol',effort:'max'}},偏好:{codex:'视觉实现',dsh:''}});
    await Agent默认设置.write(settings);
    const f=假宿主(), get=f.ctx.get, observations=[];
    f.ctx.get = name => name === 'sessionController' ? {create: async options => {
      const value=读子代理开关(options.cwd);
      assert.equal(value.设过,true,'首节点启动前已有项目自己的设置');
      observations.push(验子代理设置(value));
      return get(name).create(options);
    }} : get(name);
    try {
      const parent=join(process.env.BLUEPRINT_DATA_HOME,'项目');
      const first=await 建项目(f.ctx,parent,'首个项目','明确的任务',{},[]);
      const second=await 建项目(f.ctx,parent,'下一轮项目','另一个任务',{},[]);
      assert.deepEqual(observations,[settings,settings]);
      assert.deepEqual(验子代理设置(读子代理开关(first)),settings);
      assert.deepEqual(验子代理设置(读子代理开关(second)),settings);
      const projectSettings={...settings,偏好:{dsh:'后来修改的程序偏好',codex:'后来修改的语音与视觉偏好',claudeCode:''}};
      const handle=子代理HTTP((res,_status,body)=>{res.body=body},{默认设置:Agent默认设置,项目根Of:async()=>first});
      const req=Readable.from([JSON.stringify({session:'current-project',...projectSettings})]);req.method='POST';req.url='/api/subagents/save';
      const res={};await handle(req,res,req.url);assert.equal(res.body.ok,true,res.body.message);
      const fromProjectSave=await 建项目(f.ctx,parent,'项目内修改后新建','任务',{},[]);
      assert.deepEqual(验子代理设置(读子代理开关(fromProjectSave)),projectSettings,'当前项目保存的三家偏好逐字继承到真正新建出的项目');
      assert.deepEqual(验子代理设置(读子代理开关(second)),settings,'更早的其他项目不被改写');
      const next=验子代理设置({偏好:{dsh:'更新后的默认偏好'}});
      await Agent默认设置.write(next);
      const third=await 建项目(f.ctx,parent,'更新后项目','任务',{},[]);
      assert.deepEqual(验子代理设置(读子代理开关(third)),next);
      assert.deepEqual(验子代理设置(读子代理开关(first)),projectSettings,'旧项目不跟着改');
      const custom=验子代理设置({偏好:{dsh:'这个项目的例外'}});
      const fourth=await 建项目(f.ctx,parent,'显式配置项目','任务',{},[],[],{子代理:custom});
      assert.deepEqual(验子代理设置(读子代理开关(fourth)),custom);
      assert.deepEqual(验子代理设置(await Agent默认设置.read()),next,'API显式传值不覆盖用户保存的默认');
      await assert.rejects(建项目(f.ctx,parent,'无效设置项目','任务',{},[],[],{子代理:{开关:{codex:'yes'}}}),/只能是开或关/);
      await assert.rejects(stat(join(parent,'无效设置项目')),{code:'ENOENT'});
      console.log(JSON.stringify({beforeFirstNode:true,nextCreation:true,existingProjectsIndependent:true,explicitSettingsPreferred:true,savedProjectPreferencesInherited:true}));
    } finally {for(const off of f.收.效果.reverse())off();}
  `
  const result = await run(process.execPath, ['--import', new URL('../../../app/scripts/native-node-protocol-check.mjs?register', import.meta.url).href, '--input-type=module', '-e', script], { cwd: repository, timeout: 45000,
    env: { ...process.env, BLUEPRINT_DATA_HOME: join(base, '应用数据'), BLUEPRINT_DOCUMENTS_HOME: join(base, '文稿') } })
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)), {
    beforeFirstNode: true, nextCreation: true, existingProjectsIndependent: true, explicitSettingsPreferred: true, savedProjectPreferencesInherited: true,
  })
})
