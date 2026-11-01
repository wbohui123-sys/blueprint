import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const run = promisify(execFile), repository = fileURLToPath(new URL('../../../', import.meta.url))

test('隔离宿主真实创建到文稿和更改后位置，旧项目仍可执行，内核拒绝读取两个位置的邻居项目', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'Blueprint存储执行核验-'))), data = join(base, '应用数据'), documents = join(base, '文稿')
  await mkdir(data); t.after(() => rm(base, { recursive: true, force: true }))
  const script = String.raw`
    import assert from 'node:assert/strict';
    import {mkdir,writeFile,readFile} from 'node:fs/promises';
    import {join} from 'node:path';
    import {spawnSync} from 'node:child_process';
    import {项目存储,项目路径,项目位置们,数据根,仓库根,技能路径} from './blueprint/packages/prompt/src/路径.js';
    import {项目夹,建项目} from './blueprint/packages/node/src/index.js';
    import {假宿主} from './blueprint/packages/node/测试会话.js';
    import {在项目终端执行域,工具执行目录,隔离命令} from './blueprint/packages/node/src/项目隔离.js';
    await 项目存储.initialize();
    const legacy = join(数据根,'项目','旧项目'); await mkdir(legacy,{recursive:true}); await writeFile(join(legacy,'原件.txt'),'旧项目保留');
    const f = 假宿主(), first = await 建项目(f.ctx,项目夹,'首页项目','明确的目标\nMode: solo',{},[]);
    assert.equal(first,join(process.env.BLUEPRINT_DOCUMENTS_HOME,'Blueprint','项目','首页项目'));
    assert.deepEqual(JSON.parse(await readFile(join(first,'系统文档','技能.json'),'utf8')).skills,[]);
    const selected = join(process.env.BLUEPRINT_DATA_HOME,'..','选择的保存位置');
    await 项目存储.setDefault(selected,0); assert.equal(项目路径,项目夹);
    const second = await 建项目(f.ctx,项目夹,'第二项目','另一个明确目标\nMode: solo',{},[]);
    assert.equal(second,join(selected,'第二项目'));
    const ctx = {get:()=>undefined,sessions:{get:()=>null}};
    for(const root of [legacy,first,second]) assert.equal(await 在项目终端执行域(ctx,{session:{header:{cwd:root}}},()=>工具执行目录()),root);
    await assert.rejects(在项目终端执行域(ctx,{session:{header:{cwd:process.env.BLUEPRINT_DATA_HOME}}},()=>{}),/PROJECT_ISOLATION/);
    const neighbour = join(selected,'邻居项目'); await mkdir(neighbour); await writeFile(join(neighbour,'原件.txt'),'其他项目');
    await writeFile(join(second,'本项目.txt'),'允许本项目');
    const scope = {根:second,仓库:数据根,技能:技能路径,保护根:[数据根,仓库根,...项目位置们()]};
    const read = path => {const spec=隔离命令({argv:['/bin/cat',path],cwd:second},scope);return spawnSync(spec.argv[0],spec.argv.slice(1),{cwd:second,env:{...process.env,...spec.env},encoding:'utf8'});};
    assert.equal(read(join(second,'本项目.txt')).stdout,'允许本项目');
    assert.notEqual(read(join(neighbour,'原件.txt')).status,0);
    assert.notEqual(read(join(legacy,'原件.txt')).status,0);
    assert.equal(await readFile(join(legacy,'原件.txt'),'utf8'),'旧项目保留');
    for(const off of f.收.效果.reverse()) off();
    console.log(JSON.stringify({createdAtDefault:true,createdAtSelected:true,legacyStillExecutable:true,neighboursDenied:true}));
  `
  const result = await run(process.execPath, ['--import', new URL('../../../app/scripts/native-node-protocol-check.mjs?register', import.meta.url).href, '--input-type=module', '-e', script], { cwd: repository, timeout: 60000,
    env: { ...process.env, BLUEPRINT_DATA_HOME: data, BLUEPRINT_DOCUMENTS_HOME: documents } })
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)), { createdAtDefault: true, createdAtSelected: true, legacyStillExecutable: true, neighboursDenied: true })
})
