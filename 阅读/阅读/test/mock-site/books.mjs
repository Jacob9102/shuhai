/**
 * 离线 mock 书源站点的数据层。
 *
 * 设计原则：
 *  1. 零依赖、纯 Node 内置模块；
 *  2. 完全确定性——不使用 Math.random、不读时钟、不联网，
 *     同一本书同一章在任意时刻、任意机器上生成的内容完全一致；
 *  3. 中文内容全部为原创可读文本（非 lorem ipsum），用于端到端校验
 *     “搜索 -> 详情 -> 目录 -> 正文” 全链路。
 */

/** 每本书的章节总数（目录分页测试：每页 20 章，共 2 页） */
export const CHAPTERS_PER_BOOK = 30;
/** 目录页每页章节数 */
export const TOC_PAGE_SIZE = 20;
/** 搜索结果每页条数（8 本书 -> 首页 4 条，第二页 4 条） */
export const SEARCH_PAGE_SIZE = 4;
/** 正文页中故意混入的广告行，用于测试正文清洗规则 */
export const AD_LINES = [
  '本站域名 www.example.com 请记住',
  '手机用户请浏览 m.example.com',
  '笔趣阁 www.example.com 最新章节免费阅读',
];

export const BOOKS = [
  {
    id: 1001,
    name: '斗破苍穹',
    author: '天蚕土豆',
    kind: '玄幻',
    wordCount: '530万字',
    status: '连载中',
    intro: '这里是属于斗气的世界，没有花俏艳丽的魔法，有的仅仅是繁衍到巅峰的斗气。萧炎，一个曾经被视为废物的少年，在最绝望的时候遇见了药老，从此一路逆流而上，踏平强敌，终成斗帝。',
    hero: '萧炎',
    other: '药老',
    place: '乌坦城',
    skill: '斗气',
    item: '异火',
    sect: '云岚宗',
    firstChapter: '陨落的天才',
    lastChapter: '大结局',
  },
  {
    id: 1002,
    name: '凡人修仙传',
    author: '忘语',
    kind: '仙侠',
    wordCount: '748万字',
    status: '已完结',
    intro: '一个普通的山村小子，偶然之下进入了当地江湖小门派，成了一名记名弟子。他资质平庸，却凭着一股韧劲与一只神秘小瓶，一步一步走进修仙者的行列，最终笑傲三界。',
    hero: '韩立',
    other: '墨大夫',
    place: '七玄门',
    skill: '灵力',
    item: '小瓶',
    sect: '黄枫谷',
    firstChapter: '山村少年',
    lastChapter: '飞升仙界',
  },
  {
    id: 1003,
    name: '遮天',
    author: '辰东',
    kind: '玄幻',
    wordCount: '635万字',
    status: '已完结',
    intro: '冰冷与黑暗并存的宇宙深处，九具庞大的龙尸拉着一口青铜古棺，亘古长存。叶凡与同学聚会之后，被卷入一场跨越万古的修行之路，从此再也没有回头。',
    hero: '叶凡',
    other: '庞博',
    place: '泰山',
    skill: '源术',
    item: '青铜古棺',
    sect: '姜家',
    firstChapter: '九龙拉棺',
    lastChapter: '万古长存',
  },
  {
    id: 1004,
    name: '诡秘之主',
    author: '爱潜水的乌贼',
    kind: '奇幻',
    wordCount: '446万字',
    status: '已完结',
    intro: '蒸汽与机械的浪潮之中，谁能触及非凡？历史与黑暗的迷雾里，又是谁在低声耳语？克莱恩从诡秘的灰雾之上醒来，一步一步走向序列的尽头，也走向那个无人愿意提起的真相。',
    hero: '克莱恩',
    other: '老尼尔',
    place: '廷根市',
    skill: '灵性',
    item: '灰雾',
    sect: '值夜者',
    firstChapter: '灰雾之上',
    lastChapter: '愚者的黄昏',
  },
  {
    id: 1005,
    name: '盗墓笔记',
    author: '南派三叔',
    kind: '悬疑',
    wordCount: '143万字',
    status: '已完结',
    intro: '五十年前，一群长沙土夫子挖到一部战国帛书，残篇中记载了一座奇特的战国古墓的位置。五十年后，其中一个土夫子的孙子吴邪，在七星鲁王宫中撞见了此生最大的谜团。',
    hero: '吴邪',
    other: '张起灵',
    place: '鲁王宫',
    skill: '摸金手段',
    item: '青铜铃铛',
    sect: '九门',
    firstChapter: '七星鲁王宫',
    lastChapter: '终极的秘密',
  },
  {
    id: 1006,
    name: '庆余年',
    author: '猫腻',
    kind: '历史',
    wordCount: '380万字',
    status: '已完结',
    intro: '一个身患绝症的年轻人，重生在了一个完全不同的世界，成了庆国伯爵府里不受待见的私生子范闲。庙堂之高，江湖之远，他要在这两者之间，找到一条属于自己的活法。',
    hero: '范闲',
    other: '王启年',
    place: '澹州',
    skill: '真气',
    item: '黑箱子',
    sect: '鉴查院',
    firstChapter: '澹州少年',
    lastChapter: '归来仍是少年',
  },
  {
    id: 1007,
    name: '雪中悍刀行',
    author: '烽火戏诸侯',
    kind: '武侠',
    wordCount: '460万字',
    status: '已完结',
    intro: '北凉世子徐凤年，年少时纨绔荒唐，被父亲送进江湖里历练了三年。归来之后，他提刀北上，一步一步把自己走成了那座江湖里最难缠的对手，也走成了北凉的脊梁。',
    hero: '徐凤年',
    other: '老黄',
    place: '北凉',
    skill: '刀法',
    item: '绣冬刀',
    sect: '听潮阁',
    firstChapter: '纨绔世子',
    lastChapter: '刀落北凉',
  },
  {
    id: 1008,
    name: '全职高手',
    author: '蝴蝶蓝',
    kind: '游戏',
    wordCount: '530万字',
    status: '已完结',
    intro: '网游荣耀中被誉为教科书级别的顶尖高手叶修，因为种种原因遭到俱乐部的驱逐。离开职业圈的他寄身于一家小小的网吧，成了一个夜班网管，从零开始重新走上那条通往巅峰的路。',
    hero: '叶修',
    other: '苏沐橙',
    place: '兴欣网吧',
    skill: '操作',
    item: '千机伞',
    sect: '嘉世战队',
    firstChapter: '网吧网管',
    lastChapter: '巅峰之战',
  },
];

/** 中间章节标题池（第 2 ~ 29 章从中确定性抽取） */
const TITLE_POOL = [
  '风起', '夜行', '旧约', '故人', '入局', '试炼', '破境', '立威', '暗涌', '重逢',
  '旧伤', '雨夜', '抉择', '交锋', '孤城', '寻踪', '交易', '杀机', '迷雾', '断念',
  '试刀', '旧宅', '残卷', '旁观者', '不速之客', '一诺千金', '各怀心思', '山雨欲来',
  '胜负未分', '真实身份', '不欢而散', '临阵换将', '险中求胜', '旧账新算', '步步紧逼',
  '一线生机', '静水流深', '局中之局', '无功而返', '尘埃落定', '潜流', '转身',
  '试探', '收网', '余波', '灯下黑', '各归其位',
];

/** 确定性伪随机：mulberry32，种子固定 -> 结果可复现 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/** 确定性洗牌（Fisher-Yates + 固定种子） */
function shuffle(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/** 每本书一份固定的标题排列：第 2 ~ 29 章各取一个，互不重复 */
const TITLE_PERMUTATIONS = {};
function titleFor(book, n) {
  if (n === 1) return book.firstChapter;
  if (n === CHAPTERS_PER_BOOK) return book.lastChapter;
  if (!TITLE_PERMUTATIONS[book.id]) {
    TITLE_PERMUTATIONS[book.id] = shuffle(mulberry32(book.id * 2654435761), TITLE_POOL);
  }
  const perm = TITLE_PERMUTATIONS[book.id];
  return perm[(n - 2) % perm.length];
}

/** 章节标题全文，例如 “第1章 陨落的天才” */
export function chapterTitle(book, n) {
  return '第' + n + '章 ' + titleFor(book, n);
}

/** 书籍最新章节标题（＝最后一章标题） */
export function lastChapterTitle(book) {
  return chapterTitle(book, CHAPTERS_PER_BOOK);
}

// ---------------------------------------------------------------------------
// 正文语料：分门别类的原创中文句子模板。
// 占位符：{hero} 主角 / {other} 同伴 / {place} 地点 / {skill} 功法 / {item} 关键道具 / {sect} 势力
// ---------------------------------------------------------------------------
const SENT = {
  env: [
    '夜色像化不开的浓墨，沉甸甸地压了下来，连风里都带着一股潮湿的凉意。',
    '天边最后一缕余晖沉入山脊，远处的灯火一盏接着一盏地亮了起来。',
    '清晨的雾气还没有散尽，石板路上湿漉漉的，踩上去发出轻微的声响。',
    '乌云在头顶翻涌，闷雷一声接着一声，仿佛有什么东西正在云层之上苏醒。',
    '风穿过长长的巷道，卷起几片枯叶，打着旋儿落在{hero}的脚边。',
    '{place}的午后安静得有些反常，连平日里聒噪的雀鸟都不见了踪影。',
    '月色如水，洒在青灰色的屋脊上，勾勒出一道道冷硬的轮廓。',
    '雨下了整整一夜，屋檐下积起一道细细的水帘，滴答声敲得人心烦。',
    '山谷深处传来隐约的轰鸣，脚下的地面随之轻轻震颤。',
    '灯火在风里晃了晃，把两个人的影子拉得又细又长。',
    '空气忽然变得粘稠起来，仿佛连呼吸都要费上几分力气。',
    '远处的钟声响了三下，惊起一片栖在檐下的宿鸟。',
    '天光初亮，街道上已经有了零星的行人，挑着担子匆匆而过。',
    '四野寂静无声，只有溪水从石缝间流过，发出细碎而清冷的响动。',
  ],
  act: [
    '{hero}缓缓吐出一口浊气，掌心那缕{skill}悄然收敛，重新归于平静。',
    '他抬手抹去额角的汗珠，指节因为用力而微微发白。',
    '脚步在门前停住，他伸手推开那扇沉重的木门，门轴发出一声悠长的呻吟。',
    '{hero}将{item}小心翼翼地收进怀里，动作轻得像是在护着一件易碎的瓷器。',
    '一记闷响过后，屋梁上的灰尘簌簌落下，在地上砸出一个小小的圆圈。',
    '他闭上眼，试着让{skill}沿着经脉缓缓流转，一周天下来，四肢百骸都暖了起来。',
    '刀锋擦着衣角掠过，撕开一道口子，凉风立刻灌了进来。',
    '两人对视一眼，几乎是同时向两侧跃开，只留下原地一圈扩散的尘雾。',
    '{hero}伸手按住{other}的肩膀，示意他不要出声。',
    '他一步一步地往前走，每一步都踩得极稳，仿佛脚下就是万丈深渊。',
    '指尖触到{item}的刹那，一股寒意顺着皮肤直窜而上。',
    '他弯下腰，仔细辨认着地上那道已经模糊的痕迹。',
    '呼吸渐渐平稳下来，{hero}重新站起身，拍了拍衣角的尘土。',
    '一道幽光自{item}上浮现，映亮了他半张沉静的脸。',
    '他把最后一口干粮咽下，就着冰冷的溪水漱了漱口。',
    '抬手、出招、收势，三个动作一气呵成，快得几乎看不清残影。',
  ],
  talk: [
    '“你真的想清楚了？”{other}压低了声音，“这一去，未必有归途。”',
    '“再等等，”{hero}说，“时机还没有到。”',
    '“{sect}的人，从来不会把话说第二遍。”对方冷冷地丢下这一句，转身便走。',
    '“我只是想知道真相，”{hero}迎上他的目光，“哪怕代价很大。”',
    '“记住，{skill}再强，也要看用的人是谁。”{other}的语气里带着几分告诫。',
    '“天亮之前，我们必须离开{place}。”',
    '“此事与你无关。”{hero}摇了摇头，“你留在原地，等我回来。”',
    '“东西已经到手了。”黑暗中有人低声回了一句。',
    '“你笑什么？”{other}被他看得有些不自在。',
    '“走吧，”{hero}淡淡道，“留在这里，只会多添几条不必要的麻烦。”',
  ],
  mind: [
    '他知道，从踏出这一步起，就再没有回头的余地。',
    '许多念头在脑海里翻涌，最后却只剩下一个：活下去。',
    '越是临近，心里反而越是平静，静得像一潭没有风的水。',
    '有些事一旦想通了，压在胸口的石头也就落了地。',
    '他忽然明白，{other}刚才那句话里藏着别的意思。',
    '这种感觉很熟悉，像极了多年前那个同样阴冷的夜晚。',
    '他没有回头，因为回头也改变不了什么。',
    '若是换了从前，他大概早就冲上去了；可现在他学会了等。',
    '所谓机缘，从来都只留给还站着的人。',
    '那股不安挥之不去，像一根细刺扎在心底。',
    '他反复推演着每一种可能，最后还是把最坏的那一种也算在了里面。',
    '直到这一刻他才发觉，自己已经在不知不觉间走了这么远。',
  ],
  turn: [
    '就在这时，异变陡生。',
    '然而下一刻，所有人都愣在了原地。',
    '变故来得毫无征兆，连{other}都没能反应过来。',
    '可他很快发现，事情远没有看上去那么简单。',
    '一道刺目的白光骤然炸开，将四周照得雪亮。',
    '沉闷的破裂声毫无预兆地响起，像是什么东西碎掉了。',
    '也就在这一瞬间，他察觉到了一丝极淡的杀意。',
    '局面在转瞬之间彻底颠倒了过来。',
    '原本紧闭的石门，竟自己缓缓裂开了一道缝隙。',
    '远处忽然传来一声长啸，由远及近，快得惊人。',
  ],
  end: [
    '他知道，真正的麻烦，现在才刚刚开始。',
    '而这一切的答案，或许就藏在{place}的深处。',
    '这一夜，注定无人能够安睡。',
    '他握紧了手中的{item}，向前迈出了最后一步。',
    '风又起，吹散了最后一点余温。',
    '“我们走。”他说。',
    '至于后面会发生什么，他已经不再去想。',
    '那道身影终于消失在夜色尽头，再没有回头。',
  ],
};

const MIX = ['act', 'talk', 'mind', 'act', 'mind', 'act'];

function fill(tpl, book) {
  return tpl
    .replace(/{hero}/g, book.hero)
    .replace(/{other}/g, book.other)
    .replace(/{place}/g, book.place)
    .replace(/{skill}/g, book.skill)
    .replace(/{item}/g, book.item)
    .replace(/{sect}/g, book.sect);
}

const PARAGRAPHS_PER_CHAPTER = 14;

/**
 * 生成某一章的段落数组。返回 [{ type:'text'|'ad', text }]。
 * 第 3、7、10 段之后插入广告行（正文清洗规则的靶子）。
 */
export function chapterParagraphs(book, n) {
  const rng = mulberry32(book.id * 100003 + n * 7919);
  const out = [];
  const adAt = { 2: 0, 6: 1, 9: 2 };
  // 同一章内避免整句重复，保证读起来不像复读机
  const used = {};
  function pickFresh(pool) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const s = pick(rng, pool);
      if (!used[s]) { used[s] = 1; return s; }
    }
    return pick(rng, pool);
  }
  for (let i = 0; i < PARAGRAPHS_PER_CHAPTER; i++) {
    const parts = [];
    parts.push(fill(pickFresh(i % 4 === 3 ? SENT.turn : SENT.env), book));
    const body = 3 + Math.floor(rng() * 2);
    for (let k = 0; k < body; k++) parts.push(fill(pickFresh(SENT[MIX[Math.floor(rng() * MIX.length)]]), book));
    if (i === PARAGRAPHS_PER_CHAPTER - 1) parts.push(fill(pickFresh(SENT.end), book));
    out.push({ type: 'text', text: parts.join('') });
    if (i in adAt) out.push({ type: 'ad', text: AD_LINES[adAt[i]] });
  }
  return out;
}

/** 章节被拆成两页的长章节（用于测试“下一页”正文合并）：每 5 章一个 */
export function isLongChapter(n) {
  return n % 5 === 0;
}

/**
 * 取正文分页片段。part = 1 为第一页，2 为“下一页”。
 * 非长章节的 part=2 返回空数组（页面渲染为“本章已完结”占位）。
 */
export function chapterPart(book, n, part) {
  const all = chapterParagraphs(book, n);
  if (!isLongChapter(n)) return part === 1 ? all : [];
  const cut = Math.ceil(all.length / 2);
  return part === 1 ? all.slice(0, cut) : all.slice(cut);
}

/** 正文纯汉字/字符数统计（自检用） */
export function chapterTextLength(book, n) {
  return chapterParagraphs(book, n)
    .filter(function (p) { return p.type === 'text'; })
    .map(function (p) { return p.text; })
    .join('')
    .length;
}

/** 按关键字模糊匹配书名或作者（大小写不敏感，去首尾空白） */
export function searchBooks(keyword) {
  const q = String(keyword == null ? '' : keyword).trim().toLowerCase();
  if (!q) return BOOKS.slice();
  return BOOKS.filter(function (b) {
    return b.name.toLowerCase().indexOf(q) >= 0 || b.author.toLowerCase().indexOf(q) >= 0;
  });
}

export function findBook(id) {
  const n = Number(id);
  for (let i = 0; i < BOOKS.length; i++) if (BOOKS[i].id === n) return BOOKS[i];
  return null;
}
