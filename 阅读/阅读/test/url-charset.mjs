/**
 * URL / 编码 / JS 沙箱 兼容性测试
 *
 * 覆盖真实书源实测出来的坑（每一个都对应过一个挂掉的源）：
 *   ① searchUrl 路径里的 {{key}} 被 absUrl 提前 percent-encode → 模板失配（开心文学）
 *   ② GBK 站点必须按站点编码发送关键字（书书小说：UTF-8 发过去返回空页）
 *   ③ `路径,{选项}` 的 JSON 选项写成多行时，不能按第一行截断（书书小说）
 *   ④ header 可以是 @js: 动态算出来的（聚合书库）
 *   ⑤ JS 沙箱要有 org.jsoup 与 cookie 对象（键盘小说 / 抖音小说）
 *
 *   node test/url-charset.mjs
 */

import http from 'node:http';

const pass = [];
const fail = [];
const check = (name, cond, extra) => {
  if (cond) pass.push(name);
  else fail.push(name + (extra === undefined ? '' : ' → ' + String(extra).slice(0, 300)));
};

const ROOT = new URL('..', import.meta.url).pathname;
const { searchSource } = await import(ROOT + 'src/engine.mjs');
const { evalJs } = await import(ROOT + 'src/jsbox.mjs');
const { encodeURIComponentInCharset, needsTranscode } = await import(ROOT + 'src/net/charset.mjs');

/* ---------------- 本地回声服务器：把收到的原始字节记下来 ---------------- */

const seen = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks);
    seen.push({
      method: req.method,
      rawUrl: req.url,
      headers: req.headers,
      bodyText: rawBody.toString('latin1'),
      bodyBuf: rawBody,
    });
    // 同时满足 HTML 规则与 JSONPath 规则：按路径返回不同内容
    if (/\/api\/search/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ rows: [{ serialName: '斗破苍穹', serialID: 12345 }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<ul class="list"><li class="it"><a href="/book/1">斗破苍穹</a><span class="au">天蚕土豆</span></li></ul>');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = 'http://127.0.0.1:' + server.address().port;

const baseSource = (over) => ({
  id: 1,
  name: '测试源',
  url: ORIGIN + '/',
  searchable: true,
  ruleSearch: { bookList: 'class.list@tag.li', name: 'a@text', author: '.au@text', bookUrl: 'a@href' },
  ...over,
});

/* ---------------- ① URL 路径里的模板 ---------------- */
{
  seen.length = 0;
  const r = await searchSource(baseSource({ searchUrl: '/search/{{key}}.html' }), '斗破苍穹', 1, { timeout: 8000 });
  check('① 路径模板 {{key}} 正常渲染（未被 %7B%7B 吃掉）',
    seen[0] && seen[0].rawUrl === '/search/' + encodeURIComponent('斗破苍穹') + '.html',
    seen[0] && seen[0].rawUrl);
  check('① 模板渲染后能解析出结果', r.items.length === 1 && r.items[0].name === '斗破苍穹', JSON.stringify(r.items));
}

/* ---------------- ② GBK 站点按站点编码发送关键字 ---------------- */
{
  seen.length = 0;
  const gbkKey = encodeURIComponentInCharset('斗破苍穹', 'gbk');
  const r = await searchSource(
    baseSource({ searchUrl: '/search?q={{key}},{"charset":"gbk"}' }),
    '斗破苍穹', 1, { timeout: 8000 },
  );
  const got = seen[0] && seen[0].rawUrl;
  check('② GBK 站点关键字按 GBK 编码（不是 UTF-8）', got === '/search?q=' + gbkKey, got + ' 期望 /search?q=' + gbkKey);
  // GBK 字节不能用 UTF-8 解，得按 GBK 解回来才能验证中文是否完好
  const back = (() => {
    try {
      const bytes = Buffer.from(got.split('q=')[1].split('%').filter(Boolean).map((h) => parseInt(h, 16)));
      return new TextDecoder('gbk').decode(bytes);
    } catch { return ''; }
  })();
  check('② GBK 编码解码回中文正确', back === '斗破苍穹', JSON.stringify(back));
  check('② 仍能解析出结果', r.items.length === 1, JSON.stringify(r.items));
  check('② charset 工具函数判定正确', needsTranscode('gbk') && needsTranscode('gb2312') && !needsTranscode('utf-8'));
}

/* ---------------- ③ 多行 JSON 选项不能被截断 ---------------- */
{
  seen.length = 0;
  const multi = '/search.php,{"method":"POST",\n "body":"searchkey={{key}}&type=all",\n "charset":"gbk"}';
  const r = await searchSource(baseSource({ searchUrl: multi }), '斗破苍穹', 1, { timeout: 8000 });
  const s0 = seen[0] || {};
  check('③ 多行选项被整体识别为一条地址', s0.rawUrl === '/search.php', s0.rawUrl);
  check('③ 选项里的 method=POST 生效', s0.method === 'POST', s0.method);
  check('③ 选项里的 body 生效且关键字按 GBK 编码',
    typeof s0.bodyText === 'string' && s0.bodyText.includes('searchkey=' + encodeURIComponentInCharset('斗破苍穹', 'gbk')),
    s0.bodyText);
  check('③ POST 搜索仍能解析出结果', r.items.length === 1, JSON.stringify(r.items));
}

/* ---------------- ③b 对象形式的 POST body（现代 JSON API 书源） ---------------- */
{
  seen.length = 0;
  const spec = '/api/search,' + JSON.stringify({
    method: 'POST',
    body: { Scene: 'chapter', Batch: [{ BookID: '{{baseUrl.match(/bookId=(\\d+)/)[1]}}', Seq: [7] }] },
  });
  await searchSource(baseSource({ searchUrl: spec, ruleSearch: { bookList: '$.rows[*]', name: '$.serialName', bookUrl: '$.serialID' } }),
    '斗破', 1, { timeout: 8000 });
  const s0 = seen[0] || {};
  const body = String(s0.bodyText || '');
  check('③b 对象 body 被序列化成 JSON 发出', body.startsWith('{') && body.includes('"Scene"'), body.slice(0, 120));
  check('③b 对象 body 里的 {{ }} 模板被渲染（{{baseUrl...}} 已求值）',
    !body.includes('{{'), body.slice(0, 200));
  check('③b Content-Type 为 JSON', /application\/json/i.test(String(s0.headers && s0.headers['content-type'])), s0.headers && s0.headers['content-type']);
}

/* ---------------- ④ header 支持 @js: 动态计算 ---------------- */
{
  seen.length = 0;
  await searchSource(baseSource({
    searchUrl: '/s?q={{key}}',
    header: '@js:\nJSON.stringify({ "Referer": baseUrl + "/", "X-Requested-With": "mark.via", "User-Agent": java.getWebViewUA() })',
  }), '斗破', 1, { timeout: 8000 });
  const h = (seen[0] && seen[0].headers) || {};
  check('④ @js: 计算的 Referer 生效（由 baseUrl 拼出）', String(h.referer || '').startsWith(ORIGIN), h.referer);
  check('④ @js: 计算的 X-Requested-With 生效', h['x-requested-with'] === 'mark.via', h['x-requested-with']);
  check('④ java.getWebViewUA() 有返回值', /Mozilla/.test(String(h['user-agent'] || '')), h['user-agent']);
}

/* ---------------- ⑤ JS 沙箱：org.jsoup 与 cookie 对象 ---------------- */
{
  const ctx = { baseUrl: ORIGIN + '/', vars: new Map(), errors: [] };
  check('⑤ org.jsoup 可解析并取属性',
    await evalJs(`org.jsoup.Jsoup.parse('<input name="s" value="v1">').select('input[name="s"]').attr('value')`, ctx) === 'v1');
  check('⑤ org.jsoup select().size() 正确',
    await evalJs(`org.jsoup.Jsoup.parse('<ul><li>1</li><li>2</li></ul>').select('li').size()`, ctx) === '2');
  check('⑤ org.jsoup eachText 正确',
    await evalJs(`org.jsoup.Jsoup.parse('<ul><li>甲</li><li>乙</li></ul>').select('li').eachText().join('')`, ctx) === '甲乙');

  const ctx2 = { baseUrl: ORIGIN + '/', vars: new Map(), errors: [], jar: { header: () => 'a=1; b=2', set: () => {} } };
  check('⑤ cookie 是对象（可 getCookie）', await evalJs('cookie.getCookie(baseUrl)', ctx2) === 'a=1; b=2');
  check('⑤ cookie 也能当字符串用（兼容老模板）', await evalJs('String(cookie)', ctx2) === 'a=1; b=2');
  check('⑤ cookie.removeCookie 可调用', await evalJs('cookie.removeCookie(baseUrl)', ctx2) === '');

  check('⑤ source.key 属性存在（legado 属性式写法）',
    await evalJs('source.key', { ...ctx, source: { url: 'http://x.test/' } }) === 'http://x.test/');
  check('⑤ <js> 语句块返回最后一行表达式',
    await evalJs('var a = 1;\nvar b = 2;\na + b;', ctx) === '3');
}

/* ---------------- 收尾 ---------------- */
server.close();
console.log('通过 ' + pass.length + ' 项，失败 ' + fail.length + ' 项');
for (const p of pass) console.log('  PASS ' + p);
if (fail.length) {
  console.log('失败清单：');
  for (const f of fail) console.log('  FAIL ' + f);
} else {
  console.log('全部通过 ✅');
}
process.exit(fail.length ? 1 : 0);
