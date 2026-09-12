/**
 * 搜索模式与结果聚合测试
 *
 * 覆盖用户实际反馈的两个问题：
 *   ① 「同一本书在列表里被列很多遍」——各书源作者字段写法不同（`天蚕土豆` /
 *      `作者：天蚕土豆` / `天蚕土豆 著` / 空），必须能合并成一条；
 *   ② 需要「精确搜索」——搜「斗破苍穹」时不要把「斗破苍穹之秋雨」也算进来。
 *
 *   node test/search-modes.mjs
 */

const ROOT = new URL('..', import.meta.url).pathname;
const { aggregateResults, isExactMatch, normalizeKeyword, cleanAuthor } = await import(ROOT + 'src/engine.mjs');

const pass = [];
const fail = [];
const check = (name, cond, extra) => {
  if (cond) pass.push(name);
  else fail.push(name + (extra === undefined ? '' : ' → ' + String(extra).slice(0, 300)));
};

/* ---------------- ① 聚合去重：同一本书的不同来源写法应合并 ---------------- */

const raw = [
  { name: '斗破苍穹', author: '天蚕土豆', sourceName: 'A' },
  { name: '《斗破苍穹》', author: '天蚕土豆', sourceName: 'B' },
  { name: '斗破苍穹', author: '作者：天蚕土豆', sourceName: 'C' },
  { name: '斗破 苍穹', author: '天蚕土豆 著', sourceName: 'D' },
  { name: '斗破苍穹', author: '', sourceName: 'E' },
  { name: '斗破苍穹', author: '天蚕土豆 漫画组', sourceName: 'F' },
  { name: '斗破苍穹之秋雨', author: '某甲', sourceName: 'G' },
  { name: '完美世界', author: '辰东', sourceName: 'H' },
  { name: '完美世界', author: '辰东', sourceName: 'I' },
];
const agg = aggregateResults(raw, { dedupe: true });
const exactName = (n) => agg.find((x) => x.name.replace(/[\s《》]/g, '') === n);
const dp = agg.find((x) => x.name.replace(/\s/g, '').includes('斗破苍穹') && !x.name.includes('之'));
check('① 九条原始结果聚合成三条', agg.length === 3, agg.map((x) => x.name).join(' | '));
check('① 六个「斗破苍穹」变体合并成一条', dp && dp.origins.length === 6, dp && dp.origins.length);
check('① 合并后保留全部来源', dp && ['A', 'B', 'C', 'D', 'E', 'F'].every((s) => dp.origins.some((o) => o.sourceName === s)),
  dp && dp.origins.map((o) => o.sourceName).join(','));
check('① 同名但不同书（斗破苍穹之秋雨）不会被误合并', !!exactName('斗破苍穹之秋雨') && exactName('斗破苍穹之秋雨').origins.length === 1);
check('① 代表条目取作者非空的那条（不留空作者）', dp && dp.author !== '', dp && JSON.stringify(dp.author));
check('① dedupe=0 时不做合并', aggregateResults(raw, { dedupe: false }).length === raw.length);

/* ---------------- 作者/书名清洗 ---------------- */

check('② 作者清洗：去掉「作者：」前缀', cleanAuthor('作者：天蚕土豆') === '天蚕土豆', cleanAuthor('作者：天蚕土豆'));
check('② 作者清洗：去掉尾部「著」', cleanAuthor('天蚕土豆 著') === '天蚕土豆', cleanAuthor('天蚕土豆 著'));
check('② 作者清洗：换行折叠', cleanAuthor('天蚕土豆\n漫画组') === '天蚕土豆 漫画组', cleanAuthor('天蚕土豆\n漫画组'));
check('② 关键字归一化：全角转半角+去标点', normalizeKeyword('《斗破  苍穹》！') === '斗破苍穹', normalizeKeyword('《斗破  苍穹》！'));

/* ---------------- ③ 精确搜索 ---------------- */

const items = [
  { name: '斗破苍穹', author: '天蚕土豆' },
  { name: '《斗破苍穹》', author: '天蚕土豆' },
  { name: '斗破 苍穹', author: '天蚕土豆' },
  { name: '斗破苍穹之秋雨', author: '某甲' },
  { name: '斗破苍穹大番外', author: '斗破苍穹漫画组' },
  { name: '完美世界', author: '辰东' },
];
const exact = (q, type) => items.filter((it) => isExactMatch(it, q, type));
check('③ 精确·书名：只保留完全同名（三种写法都算）', exact('斗破苍穹', 'name').length === 3,
  JSON.stringify(exact('斗破苍穹', 'name').map((x) => x.name)));
check('③ 精确·书名：番外/续作被排除',
  !exact('斗破苍穹', 'name').some((x) => /之|番外/.test(x.name)),
  JSON.stringify(exact('斗破苍穹', 'name').map((x) => x.name)));
check('③ 精确·作者：命中该作者的书', exact('天蚕土豆', 'author').length === 3, JSON.stringify(exact('天蚕土豆', 'author').map((x) => x.name)));
check('③ 精确·综合：书名或作者命中都算', exact('天蚕土豆', 'all').length === 3 && exact('斗破苍穹之秋雨', 'all').length === 1,
  JSON.stringify(exact('斗破苍穹之秋雨', 'all').map((x) => x.name)));
check('③ 精确：不相关的书一条都不留', exact('完美世界', 'name').length === 1);
check('③ 精确：空关键字不过滤', exact('', 'name').length === items.length);

console.log('通过 ' + pass.length + ' 项，失败 ' + fail.length + ' 项');
for (const p of pass) console.log('  PASS ' + p);
if (fail.length) {
  console.log('失败清单：');
  for (const f of fail) console.log('  FAIL ' + f);
} else {
  console.log('全部通过 ✅');
}
process.exit(fail.length ? 1 : 0);
