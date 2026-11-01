import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const source = readFileSync(new URL('./对话材料.js', import.meta.url), 'utf8');
const 界面语言 = readFileSync(new URL('../../../viewer/界面语言.js', import.meta.url), 'utf8').replace(/^export /gm, '');
function helpers(extra = {}) {
  const context = { react: { createContext: () => ({}) }, URL, URLSearchParams, encodeURIComponent, Set, Map,
    window: {}, location: { href: 'http://127.0.0.1:3090/' }, ...extra };
  vm.runInNewContext(界面语言 + '\n' + source + '\nthis.api={index:对话材料索引,group:过程材料,prose:正文材料,signature:材料变更签,read:读取对话材料,address:对话材料文件地址,open:打开对话材料};', context);
  return context.api;
}
const plain = value => JSON.parse(JSON.stringify(value));
const material = (path, refs) => ({ path, title: path, kind: 'image', available: true, history: refs });
const ref = (callId, seq = 1, extra = {}) => ({ session: 'current', callId, seq, source: '读取', ...extra });
const toolNode = root => ({ key: 'tool', kind: 'tool-call', data: { root } });
const snapshot = nodes => ({ nodes: { get: key => nodes.find(node => node.key === key), values: () => nodes } });

test('按真实 callId 匹配过程材料，含递归子调用，同一组同一路径只显示一次', () => {
  const h = helpers(), index = h.index([
    material('诊断.png', [ref('inner'), ref('outer', 2)]),
    material('网页记录', [ref('web')]),
    material('其他会话.png', [ref('inner', 3, { session: 'other' })]),
    material('上下文目录', [ref('outer', 4, { source: '上下文引用' })]),
  ], 'current');
  const root = { callId: 'outer', kind: 'tool-result', subCalls: [
    { callId: 'inner', kind: 'tool-result' }, { callId: 'inner', kind: 'tool-result' }, { callId: 'web', kind: 'tool-result' },
  ] };
  assert.deepEqual(plain(h.group(index, snapshot([toolNode(root)]), [{ key: 'tool' }])).map(entry => entry.item.path), ['诊断.png', '网页记录']);
});

test('运行中和失败的调用不能冒充成功取得材料，旧的其他步骤不挂到当前组', () => {
  const h = helpers(), index = h.index([material('诊断.png', [ref('call')])], 'current');
  for (const root of [{ callId: 'call' }, { callId: 'call', kind: 'tool-result', isError: true }, { callId: 'different', kind: 'tool-result' }])
    assert.deepEqual(plain(h.group(index, snapshot([toolNode(root)]), [{ key: 'tool' }])), []);
});

test('对话只画交付、写出、点名和亲眼看的画面声音；列目录、读文字、网页记录留在文件廊', () => {
  const h = helpers(), at = (path, kind, source) => ({ ...material(path, [ref('step', 1, { source })]), kind });
  const index = h.index([
    at('截图.png', 'image', '读取'), at('试听.wav', 'audio', '读取'), at('说明.md', 'document', '读取'),
    at('列出来的.png', 'image', '输出引用'), at('改了的.gd', 'document', '写入'), at('交付.mp4', 'video', '交付入口'),
    at('https://example.com/a', 'web', '读取网页'), at('https://example.com/b', 'web', '检索候选'),
  ], 'current');
  const root = { callId: 'step', kind: 'tool-result' };
  assert.deepEqual(plain(h.group(index, snapshot([toolNode(root)]), [{ key: 'tool' }])).map(entry => entry.item.path),
    ['截图.png', '试听.wav', '改了的.gd', '交付.mp4']);
});

test('正文与人类输入用持久 seq，思考和响应分段不重复画卡；上下文引用不穿透', () => {
  const h = helpers(), index = h.index([
    material('正文文件', [ref(null, 48, { source: '引用' })]),
    material('人类输入', [ref(null, 16, { source: '输入材料' })]),
    material('上下文路径', [ref(null, 48, { source: '上下文引用' })]),
  ], 'current');
  const node = { kind: 'assistant-step', data: { finalNode: { seq: 48 } } };
  assert.equal(h.prose(index, node, 'response').length, 1);
  assert.equal(h.prose(index, node, 'process').length, 0);
  assert.equal(h.prose(index, { ...node, data: {} }).length, 0);
  assert.equal(h.prose(index, { kind: 'user', data: { seq: 16 } }).length, 1);
});

test('分页读取超过一百项，重复路径合并来源，使用原只读接口和中断信号', async () => {
  const h = helpers(), signal = new AbortController().signal, requests = [];
  const pages = [
    { ok: true, items: [material('重复.png', [ref('first')]), material('第一页.png', [ref('page-one')])], offset: 0, limit: 100, more: true },
    { ok: true, items: [material('重复.png', [ref('second')]), material('第二页.png', [ref('page-two')])], offset: 100, limit: 100, more: false },
  ];
  const result = await h.read('current', { signal, fetcher: async (url, options) => {
    const parsed = new URL(url, 'http://local'); requests.push(parsed.searchParams.get('offset'));
    assert.equal(parsed.pathname, '/studio/api/materials'); assert.equal(parsed.searchParams.get('view'), 'used');
    assert.equal(parsed.searchParams.get('scope'), 'self'); assert.equal(parsed.searchParams.get('session'), 'current');
    assert.equal(options.signal, signal); assert.equal(options.credentials, 'same-origin');
    return { ok: true, json: async () => pages.shift() };
  } });
  assert.deepEqual(requests, ['0', '100']); assert.equal(result.items.length, 3);
  assert.equal(result.items[0].history.length, 2);
});

test('接口失败、不前进的分页和撤销都明确结束，不把空数据当成功', async () => {
  const h = helpers();
  await assert.rejects(h.read('current', { fetcher: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
  await assert.rejects(h.read('current', { fetcher: async () => ({ ok: true, json: async () => ({ ok: true, items: [], more: true, offset: 0, limit: 0 }) }) }), /分页/);
  const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
  await assert.rejects(h.read('current', { fetcher: async () => { throw abort; } }), error => error === abort);
});

test('刷新签只跟来源落盘和历史窗口变化，不跟每片思考文字变化', () => {
  const h = helpers(), root = { callId: 'call' }, node = toolNode(root);
  const before = h.signature(snapshot([node]));
  root.detail = '更多流式文字'; assert.equal(h.signature(snapshot([node])), before);
  root.kind = 'tool-result'; assert.notEqual(h.signature(snapshot([node])), before);
  const settled = h.signature(snapshot([node])); root.isError = true;
  assert.notEqual(h.signature(snapshot([node])), settled);
});

test('打开图片沿当前记录会话，网页走原浏览器入口，危险协议不能打开', async () => {
  const resources = [], browsers = [], h = helpers();
  const ctx = { get: () => ({ openResource: value => resources.push(value), openTab: (kind, args) => browsers.push({ kind, args }) }) };
  await h.open(ctx, { available: true, session: 'session-原始', path: '作品空间/诊断 图.png', kind: 'image' });
  assert.equal(resources[0], 'dsh-resource://file/session/session-%E5%8E%9F%E5%A7%8B/%E4%BD%9C%E5%93%81%E7%A9%BA%E9%97%B4/%E8%AF%8A%E6%96%AD%20%E5%9B%BE.png');
  await h.open(ctx, { available: true, url: 'https://docs.phaser.io/', kind: 'web' });
  assert.equal(browsers[0].kind, 'browser'); assert.equal(browsers[0].args.params.url, 'https://docs.phaser.io/');
  await assert.rejects(h.open(ctx, { available: true, url: 'javascript:alert(1)', kind: 'web' }), /网页地址/);
});

test('对话视频与音频沿文件廊同一预览地址，内置浏览器接受，应用同源地址仍被拒绝', async () => {
  const require = createRequire(new URL('../../../app/package.json', import.meta.url));
  const browser = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-sidebar-browser/client'), 'utf8');
  const parseStart = browser.indexOf('\t\tfunction parseBrowserAddress('), parseEnd = browser.indexOf('\t\t//#endregion', parseStart);
  assert.ok(parseStart >= 0 && parseEnd > parseStart);
  const parse = vm.runInNewContext(browser.slice(parseStart, parseEnd) + '\nparseBrowserAddress', { URL });
  const studio = readFileSync(new URL('../../../viewer/studio.html', import.meta.url), 'utf8');
  const urlStart = studio.indexOf('function 预览网址('), urlEnd = studio.indexOf('\nasync function 打开文件链接', urlStart);
  const session = 'current-session';
  for (const hostname of ['127.0.0.1', 'localhost']) {
    const location = new URL(`http://${hostname}:3090/`), browsers = [], h = helpers({ location });
    const galleryURL = vm.runInNewContext(studio.slice(urlStart, urlEnd) + '\n预览网址', { URL, window: {}, location });
    const ctx = { get: () => ({ openTab: (_kind, options) => browsers.push(options.params.url), openResource: () => assert.fail('音视频不应进入文本预览') }) };
    for (const [kind, path] of [['video', '导出/残阳圣堂-声音TEMP-A-圣堂安魂-60s.mp4'],
      ['video', '导出/残阳圣堂-声音TEMP-B-落日丧钟-60s.mp4'], ['audio', '作品空间/4/audio/temp A.wav']]) {
      await h.open(ctx, { available: true, session, path, kind, opening: 'preview' });
      const target = browsers.at(-1);
      assert.equal(target, galleryURL(session, path));
      assert.equal(parse(target, location.origin).ok, true);
      assert.notEqual(new URL(target).origin, location.origin);
      assert.equal(decodeURIComponent(new URL(target).pathname), `/studio/preview/${session}/${path}`);
    }
    assert.equal(parse(`${location.origin}/studio/preview/${session}/导出/视频.mp4`, location.origin).reason, 'application-origin');
  }
});

test('桌面对话媒体保留已授权预览地址；无法生成地址时明确报错，不打开空白页', async () => {
  const calls = [], opened = [], signed = new URL('http://localhost:3100/studio/preview/session~' + 'a'.repeat(64) + '/导出/视频.mp4').href;
  let url = signed;
  const h = helpers({ window: { blueprintDesktop: { previewURL: (session, path) => { calls.push([session, path]); return url; } } } });
  const ctx = { get: () => ({ openTab: (_kind, options) => opened.push(options.params.url) }) };
  const item = { available: true, session: 'session', path: '导出/视频.mp4', kind: 'video' };
  await h.open(ctx, item); assert.equal(opened[0], signed); assert.deepEqual(calls, [['session', item.path]]);
  url = null;
  await assert.rejects(h.open(ctx, item), /无法创建项目预览地址/);
  assert.equal(opened.length, 1);
});
