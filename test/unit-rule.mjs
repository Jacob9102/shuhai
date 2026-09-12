
import fs from 'node:fs';
import { makeContent, getString, getStringList, getElements, getItemCursors, renderTemplate, parseStep } from '../src/rule.mjs';

const html = fs.readFileSync(new URL('./_fixture.html', import.meta.url), 'utf8');

const ctx = { baseUrl: 'https://demo.test', pageUrl: 'https://demo.test/search?q=x', key: '斗破', page: 1, errors: [], vars: new Map() };
const content = makeContent(html);
const ok = [], bad = [];
const check = (n, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) ok.push(n); else { bad.push(n); console.log('  x ' + n + '\n      got  = ' + g + '\n      want = ' + w); }
};

const items = await getItemCursors('class.book-list@tag.li', content, ctx);
check('bookList -> 3 items', items.length, 3);

const first = items[0];
check('name', await getString('class.book-name@tag.a@text', first, ctx), '斗破苍穹');
check('author', await getString('class.author@text', first, ctx), '作者：天蚕土豆');
check('author strip prefix', await getString('class.author@text##作者：##', first, ctx), '天蚕土豆');
check('bookUrl abs', await getString('class.book-name@tag.a@href', first, ctx), 'https://demo.test/book/1001');
check('cover via data-src', await getString('class.cover@tag.img@data-src', first, ctx), 'https://demo.test/img/1001.jpg');
check('lastChapter', await getString('class.last-chapter@tag.a@text', first, ctx), '最新章节：大结局');
check('intro', await getString('class.intro@text', first, ctx), '这里是三十字以上的简介文本，讲述少年萧炎的成长故事。');
check('2nd item name', await getString('class.book-name@tag.a@text', items[1], ctx), '完美世界');
check('missing rule -> empty', await getString('class.nope@text', items[2], ctx), '');
check('|| fallback', await getString('class.nope@text||class.author@text', items[2], ctx), '作者：忘语');

check('[0]', await getString('class.book-name@tag.a@text[0]', content, ctx), '斗破苍穹');
check('[-1]', await getString('class.book-name@tag.a@text[-1]', content, ctx), '凡人修仙传');
check('string list len', (await getStringList('class.book-name@tag.a@text', content, ctx)).length, 3);
check('[0:2] len', (await getStringList('class.book-name@tag.a@text[0:2]', content, ctx)).length, 2);

check('##delete##', await getString('class.intro@text##^\\s+|\\s+$##', content, ctx), '这里是三十字以上的简介文本，讲述少年萧炎的成长故事。\n石昊的一生。');
check('##delete one##', await getString('class.intro@text##^\\s+|\\s+$##', items[0], ctx), '这里是三十字以上的简介文本，讲述少年萧炎的成长故事。');
check('##replace##', await getString('class.kind@text##分类：##类别-', items[0], ctx), '类别-玄幻');

check('html inner', (await getString('#content@html', content, ctx)).includes('<p>第一段正文。</p>'), true);
check('tag.* variant', await getString('tag.p@text[0]', first, ctx), '作者：天蚕土豆');
check('css: prefix', await getString('css:.book-item .book-name a@text', content, ctx), '斗破苍穹\n完美世界\n凡人修仙传');
check('children', (await getElements('class.book-list@children', content, ctx)).length, 3);

check('js arithmetic', await getString('{{1+1}}', content, ctx), '2');
check('js key', await getString('{{key}}', content, ctx), '斗破');
check('js method', await getString("{{'abc'.toUpperCase()}}", content, ctx), 'ABC');
check('js base64', await getString("{{java.base64Decode('546E5bm7')}}", content, ctx), '玄幻');
check('js md5', await getString("{{java.md5Encode('a')}}", content, ctx), '0cc175b9c0f1b6a831c399e269772661');

check('template key/page', await renderTemplate('https://x.test/s?q={{key}}&p={{page}}', ctx), 'https://x.test/s?q=斗破&p=1');
check('template js', await renderTemplate('https://x.test/{{java.md5Encode("a")}}', ctx), 'https://x.test/0cc175b9c0f1b6a831c399e269772661');

const jsonSrc = makeContent(JSON.stringify({ code:0, data:{ list:[
  {name:'斗破苍穹', author:'天蚕土豆', url:'/read/1', words:5300000},
  {name:'完美世界', author:'辰东', url:'/read/2', words:6000000}
]}}));
const jitems = await getItemCursors('$.data.list[*]', jsonSrc, ctx);
check('json list len', jitems.length, 2);
check('json name', await getString('$.name', jitems[0], ctx), '斗破苍穹');
check('json author', await getString('$.author', jitems[1], ctx), '辰东');
check('json regex strip', await getString('$.name##苍穹##苍', jitems[0], ctx), '斗破苍');
check('json deep', await getString('$.data.list[0].name', jsonSrc, ctx), '斗破苍穹');
check('json filter', await getString('$.data.list[?(@.author=="辰东")].name', jsonSrc, ctx), '完美世界');
check('json wildcard', await getString('$.data.list[*].name', jsonSrc, ctx), '["斗破苍穹","完美世界"]');

// --- legado 兼容语法（真实书源实测出来的缺口，逐条回归）---
const compatHtml = makeContent(`<div class="list">
  <a href="/b/1.html">第一本</a><a href="/b/2.html">第二本</a><a href="/b/3.html">第三本</a>
  <p class="author">作者A</p><p class="author">作者B</p><p class="author">作者C</p>
  <table><tr class="head"><td>表头</td></tr><tr class="row"><td>甲</td><td>乙</td><td>丙</td><td>丁</td></tr></table>
</div>`);

// ① 不带方括号的下标 / 排除 / 切片
check('裸下标 a.0', await getString('.list@a.0@href', compatHtml, ctx), 'https://demo.test/b/1.html');
check('裸负下标 a.-1', await getString('.list@a.-1@href', compatHtml, ctx), 'https://demo.test/b/3.html');
check('裸下标配标签+类 p.author.2', await getString('p.author.2@text', compatHtml, ctx), '作者C');
check('裸排除 tr!0', await getString('table@tr!0@tag.td.0@text', compatHtml, ctx), '甲');
check('裸负区间 td.-1:-2', await getString('table@tr.row@td.-1:-2@text', compatHtml, ctx), '丙\n丁');
// !A:B 的实测语义是「排除这两个下标」（书书小说 tr!0:-1 去掉表头表尾、奇塔小说 tag.ul!0:1 去掉最新章节块）
const exclHtml = makeContent('<table><tr><td>表头</td></tr><tr><td>甲</td></tr><tr><td>乙</td></tr><tr><td>表尾</td></tr></table>');
check('裸排除两个下标 tr!0:-1', await getString('table@tr!0:-1@tag.td@text', exclHtml, ctx), '甲\n乙');
check('裸倒数 td.-3', await getString('table@tr.row@td.-3@text', compatHtml, ctx), '乙');
check('原有方括号形式不受影响', await getString('.list@a[0]@text', compatHtml, ctx), '第一本');

// URL 属性补全必须发生在正则「之后」：@href##正则 的正则要作用在原始属性值上。
// 若提前补成绝对地址，`.*` 这类贪婪正则会连域名前缀一起吃掉（奇塔小说目录只剩 1 章就是这个原因）。
const hrefHtml = makeContent('<div class="l"><a href="/b/123.html">x</a></div>');
check('@href##正则 作用在原始属性值上', await getString('class.l@tag.a@href##^/b/##', hrefHtml, ctx), 'https://demo.test/123.html');
check('未加正则时 href 仍补成绝对地址', await getString('class.l@tag.a@href', hrefHtml, ctx), 'https://demo.test/b/123.html');

// ② <js>…</js> 内联步骤（真实 bookList 写法：先剥注释再选节点）
const jsPreHtml = makeContent(`<!-- 广告 --><ul id="book_list"><li class="b"><a href="/x/1">书名一</a></li><li class="b"><a href="/x/2">书名二</a></li></ul>`);
const jsPreItems = await getItemCursors('<js>\nString(result).replace(/<!--|-->/g, "");\n</js>\n#book_list li', jsPreHtml, ctx);
check('<js> 内联步骤做预处理后选中 2 个节点', jsPreItems.length, 2);
check('<js> 之后的子规则可继续用', await getString('a@text', jsPreItems[0], ctx), '书名一');

// ③ @put / @get 变量步骤（书书小说的真实写法：name 存 href，bookUrl 取回）
const putCtx = { baseUrl: 'https://demo.test', pageUrl: 'https://demo.test', key: 'k', page: 1, errors: [], vars: new Map() };
const putHtml = makeContent('<li class="it"><a href="/read_123.html">斗破苍穹</a></li>');
const putItem = (await getItemCursors('class.it', putHtml, putCtx))[0];
check('@put 不改变本步骤结果', await getString('a.0@text@put:{u:"a.0@href"}', putItem, putCtx), '斗破苍穹');
check('@get 取回 @put 存的变量', await getString('@get:{u}', putItem, putCtx), 'https://demo.test/read_123.html');
check('@get 变量不存在时返回空', await getString('@get:{nope}', putItem, putCtx), '');

// ④ <js> 块是语句（没有 return）时，取最后一行表达式的值
const jsStmtCtx = { baseUrl: 'https://demo.test', pageUrl: 'https://demo.test', errors: [], vars: new Map() };
check('<js> 语句块返回最后一行表达式',
  await getString('<js>\nvar s = result;\ns.replace(/\\s+/g, "");\n</js>', makeContent('<b> a b </b>'), jsStmtCtx), '<b>ab</b>');

// --- 字面量 / 模板步骤（现代 JSON API 书源的核心写法，QQ浏览器源实测）---
{
  const ctxL = { baseUrl: 'https://x.test/', pageUrl: 'https://x.test/', key: '斗破', page: 1, errors: [], vars: new Map() };
  const jsonCur = (await getItemCursors('$.booklist[*]', makeContent(JSON.stringify({ booklist: [{ bid: 59212932, serialID: 7 }] })), ctxL))[0];
  check('多行规则：JSONPath → <js> → 裸 URL 模板',
    await getString('$.bid\n<js>1100000000 + parseInt(result)</js>\nhttps://api.test/intro?bookid={{result}}', jsonCur, ctxL),
    'https://api.test/intro?bookid=1159212932');
  check('{{$.x}} 绑定当前 JSON 对象',
    await getString('{{$.serialID}}', jsonCur, ctxL), '7');
  check('URL+JSON 选项不会被误判成 CSS 选择器',
    await getString('https://api.test/x,{\n  "method": "POST",\n  "body": {"a": [1]}\n}', jsonCur, ctxL),
    'https://api.test/x,{\n  "method": "POST",\n  "body": {"a": [1]}\n}');
  check('相对地址+选项同样识别为字面量',
    parseStep('/be-api/x,{"method":"POST"}').kind, 'literal');
  check('带模板的选择器仍是选择器（没被字面量规则吃掉）',
    parseStep('#box-{{key}}').kind, 'selector');
}

// --- js 步骤的尾部下标（真实书源里的高频写法）---
// 回归用例：@onclick@js:result.match(...)[1] 曾经把 match() 返回的整个数组 JSON 化，
// 于是 bookUrl 变成 '["(...)","/b/229093.html"]'，后续目录请求必然 404。
const jsHtml = makeContent(`<ul class="l"><li class="i" onclick="openBook('/b/229093.html', '', '')">灵破苍穹</li></ul>`);
const jsItems = await getItemCursors('class.l@tag.li', jsHtml, ctx);
check('@onclick@js + [1] 取捕获组',
  await getString(String.raw`@onclick@js:result.match(/\('(.*?)', '', ''\)/)[1]`, jsItems[0], ctx),
  '/b/229093.html');
check('@js 数组 + [0]', await getString('@js:["a","b"][0]', content, ctx), 'a');
check('@js 数组 + [-1]', await getString('@js:["a","b"][-1]', content, ctx), 'b');
check('@js 数组无下标 -> JSON（不回归）', await getString('@js:["a","b"]', content, ctx), '["a","b"]');
check('@js 表达式', await getString('@js:1+1', content, ctx), '2');

check('step class', parseStep('class.book-list').selector, '.book-list');
check('step class multi', parseStep('class.a b').selector, '.a.b');
check('step id', parseStep('id.content').selector, '#content');
check('step tag', parseStep('tag.li').selector, 'li');
check('step index', parseStep('tag.li[0]').index, '0');
check('step attr', parseStep('href').attr, 'href');
check('step text', parseStep('text').attr, 'text');

console.log('PASS ' + ok.length + ' / ' + (ok.length + bad.length));
console.log(bad.length ? 'FAILED: ' + [...new Set(bad)].join(', ') : 'ALL GREEN');
