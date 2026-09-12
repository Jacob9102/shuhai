
import { parseHtml, textOf, attrOf, innerHtml, outerHtml } from '../src/html/parser.mjs';
import { selectAll, selectFirst } from '../src/html/selector.mjs';

const html = `<!DOCTYPE html><html><head><meta charset="gbk"><title>测试</title>
<style>body{color:red}</style></head><body>
<div class="book-list">
  <div class="book-item"><a class="cover" href="/book/1001"><img src="/img/1001.jpg" alt="封面"></a>
    <h3 class="book-name"><a href="/book/1001">斗破苍穹 &amp; 番外</a></h3>
    <p class="author">作者：天蚕土豆</p>
    <p class="last-chapter"><a href="/book/1001/chapter/999">最新章节：大结局</a></p></div>
  <div class="book-item"><a class="cover" href="/book/1002"><img src="/img/1002.jpg"></a>
    <h3 class="book-name"><a href="/book/1002">完美世界</a></h3>
    <p class="author">作者：辰东</p></div>
  <div class="book-item"><a class="cover" href="/book/1003"><img src="/img/1003.jpg"></a>
    <h3 class="book-name"><a href="/book/1003">凡人修仙传</a></h3>
    <p class="author">作者：忘语</p></div>
</div>
<div id="content"><p>第一段&nbsp;正文</p><p>第二段<br>换行</p><script>var a=1<2;</script></div>
<ul class="toc"><li><a href="/c/1">第1章 起点</a></li><li><a href="/c/2">第2章 出发</a></li><li><a href="/c/3">第3章 终点</a></li></ul>
<p>未闭合段落
<div>后面的div</div>
</body></html>`;

const doc = parseHtml(html);
const ok = [];
const bad = [];
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) ok.push(name); else bad.push(name + ' | got=' + g + ' want=' + w);
};

check('bookList count', selectAll(doc, '.book-list').length, 1);
check('book-item count', selectAll(doc, '.book-item').length, 3);
check('descendant .book-item .book-name a', selectAll(doc, '.book-item .book-name a').length, 3);
check('child combinator', selectAll(doc, '.book-list > .book-item').length, 3);
check('name text', textOf(selectFirst(doc, '.book-item .book-name')), '斗破苍穹 & 番外');
check('name from 2nd item', textOf(selectAll(doc, '.book-name')[1]), '完美世界');
check('author text', textOf(selectAll(doc, '.author')[0]), '作者：天蚕土豆');
check('cover href', attrOf(selectFirst(doc, '.book-item .cover'), 'href'), '/book/1001');
check('img src chained', attrOf(selectFirst(doc, '.book-item .cover img'), 'src'), '/img/1001.jpg');
check('last-chapter a href', attrOf(selectFirst(doc, '.last-chapter a'), 'href'), '/book/1001/chapter/999');
check('toc li count', selectAll(doc, '.toc li').length, 3);
check('toc li a text', textOf(selectAll(doc, '.toc li a')[1]), '第2章 出发');
check('nth-child(2)', textOf(selectFirst(doc, '.book-item:nth-child(2) .book-name')), '完美世界');
check('attr ^= selector', selectAll(doc, 'img[src^="/img/100"]').length, 3);
check('id selector', innerHtml(selectFirst(doc, '#content')).includes('第一段'), true);
check('script stripped from text', textOf(selectFirst(doc, '#content')).includes('var a'), false);
check('nbsp decoded', textOf(selectFirst(doc,'#content')).startsWith('第一段 正文'), true);
check(':not()', selectAll(doc, '.book-item:not(:first-child)').length, 2);
check(':contains', selectAll(doc, 'p:contains(辰东)').length, 1);
check('unclosed p then div', selectAll(doc, 'p + div').length >= 1, true);
check('title raw text', textOf(selectFirst(doc, 'title')), '测试');
check('outerHtml img void', outerHtml(selectFirst(doc, 'img')), '<img src="/img/1001.jpg" alt="封面">');
check('group selector', selectAll(doc, '.author, .last-chapter').length, 4);
check('missing attr -> empty', attrOf(selectFirst(doc, 'img'), 'nope'), '');

console.log('PASS ' + ok.length);
if (bad.length) { console.log('FAIL ' + bad.length); bad.forEach(b => console.log('  ✗ ' + b)); }
else console.log('ALL GREEN');

// 性能：10000 个 li 的目录页
const big = '<div class="chapter-list"><ul>' + Array.from({length:10000},(_,i)=>`<li><a href="/c/${i}">第${i}章 标题</a></li>`).join('') + '</ul></div>';
const t0 = Date.now();
const bigDoc = parseHtml(big);
const t1 = Date.now();
const lis = selectAll(bigDoc, '.chapter-list li a');
const t2 = Date.now();
console.log('perf: parse=' + (t1-t0) + 'ms select=' + (t2-t1) + 'ms nodes=' + lis.length + ' last=' + textOf(lis[9999]));
