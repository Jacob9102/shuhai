/**
 * 正文清洗 —— 把抓回来的 HTML 变成可直接排版的纯文本。
 *
 * 真实小说站的正文页噪声很多：站名广告、导航条、二维码提示、
 * "天才一秒记住本站"、隐藏的 js 变量、分页残留等。
 * 这里做「块级结构 → 段落」的还原，再按行过滤广告。
 */

import { parseHtml } from './html/parser.mjs';

/** 会强制换行的块级标签 */
const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'section',
  'article', 'blockquote', 'pre', 'dd', 'dt', 'figure', 'figcaption', 'header',
  'footer', 'hr', 'table', 'ul', 'ol', 'center', 'form',
]);

/** 完全跳过的标签 */
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'iframe', 'svg', 'button', 'select', 'textarea', 'ins']);

/**
 * 广告行特征。只匹配「明显是站点广告」的短行，避免误伤正文。
 * 宁可漏删也不能删正文 —— 这是清洗的核心原则。
 */
const AD_LINE_PATTERNS = [
  /^(?:天才一秒记住|一秒记住|请记住本站|记住本站|本站域名|本书首发|首发地址|最新网址|永久网址|手机用户请|手机版请|手机阅读请|请浏览|本章未完|点击下一页|继续阅读)/,
  /(?:请记住本站|记住本书首发域名|一秒记住本站|天才一秒记住|最新章节请|无弹窗全文阅读|手机用户请浏览|手机版阅读网址|本章未完，请点击|内容未完，请点击)/,
  /^(?:上一章|下一章|上一页|下一页|返回目录|返回书页|目\s*录|章节目录|加入书签|推荐本书|投推荐票|求收藏|求推荐票|求月票|求打赏|笔趣阁|全文阅读|手机阅读)[\s:：,，、]*$/,
  /^(?:www\.|m\.|wap\.)[\w-]+\.(?:com|cn|net|org|cc|me|top|xyz|info|la|tv)/i,
  /^(?:https?:\/\/|ftp:\/\/)\S+$/i,
  /(?:www\.[\w-]+\.(?:com|cn|net|org|cc|top|xyz|info))/i,
  /^(?:小说|本书|更多精校|更多章节|免费阅读|全集下载|txt下载|电子书下载)/,
  /(?:记住我们的网址|收藏本站|把本站加入收藏|按Ctrl\+D)/,
  /^(?:第[一二三四五六七八九十百千\d]+[章节卷])?\s*[（(【\[]?(?:求票|求订阅|加更|公告)[）)】\]]?$/,
  /^[\s\-—=*~·。#>_+]{3,}$/,
  /^&nbsp;?$/,
];

/** 是否疑似广告/导航行 */
export function isAdLine(line, extraRegexes = []) {
  const s = String(line).trim();
  if (!s) return true;
  // 太长的行不可能是广告条，直接放行（保护正文）
  if (s.length > 80) return false;
  for (const re of extraRegexes) {
    if (re.test(s)) return true;
  }
  for (const re of AD_LINE_PATTERNS) {
    if (re.test(s)) return true;
  }
  return false;
}

/**
 * 从 DOM 提取段落。用显式栈遍历，遇块级标签换行。
 */
function collectLines(root) {
  const lines = [];
  let buf = '';

  const flush = () => {
    const t = buf.replace(/[\t\r\n\f\v]+/g, ' ').replace(/ {2,}/g, ' ').trim();
    if (t) lines.push(t);
    buf = '';
  };

  const walk = (node) => {
    for (const c of node.children || []) {
      if (c.type === 'text') { buf += c.data; continue; }
      if (c.type !== 'element') continue;
      if (SKIP_TAGS.has(c.tag)) continue;

      const isBlock = BLOCK_TAGS.has(c.tag);
      if (isBlock) flush();
      if (c.tag === 'br') { flush(); continue; }

      walk(c);

      // 块级元素内部可能没有文本子节点（如 <img>），需要处理 alt
      if (c.tag === 'img' && !c.children?.length) {
        const alt = c.attrs?.alt;
        if (alt && alt.length > 1) buf += alt;
      }
      if (isBlock) flush();
    }
  };

  walk(root);
  flush();
  return lines;
}

/**
 * 把正文 HTML 转成清洗后的纯文本。
 * @param {string} html 原始 HTML 片段
 * @param {object} [opts]
 * @param {string} [opts.replaceRegex] 书源自带的 replaceRegex，形如 "##正则##替换"
 * @param {string[]} [opts.titleAliases] 需要剔除的首行（通常是章节标题重复）
 * @param {boolean} [opts.keepEmptyLines] 是否保留空行
 */
export function cleanContent(html, opts = {}) {
  let text = String(html ?? '');
  if (!text) return '';

  // 书源自带的替换规则先行（很多源用它去广告）
  const extra = [];
  if (opts.replaceRegex) {
    for (const rule of String(opts.replaceRegex).split(/\r?\n/)) {
      if (!rule.trim()) continue;
      const m = /^([\s\S]*?)##([\s\S]*?)(?:##([\s\S]*))?$/.exec(rule);
      if (!m) continue;
      const [, pattern, replacement] = m;
      if (!pattern) continue;
      try {
        // 形如 <br\s*/?>##\n  这种"标签替换成换行"的常见写法
        text = text.replace(new RegExp(pattern, 'gi'), replacement ?? '');
      } catch {
        // 无效正则，退化成字面量替换
        text = text.split(pattern).join(replacement ?? '');
      }
    }
  }

  // 纯文本输入（有些书源直接返回 text）不需要解析
  const looksHtml = /<[a-zA-Z!/][^>]*>/.test(text);
  let lines;
  if (looksHtml) {
    const doc = parseHtml(text);
    lines = collectLines(doc);
  } else {
    lines = text
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((l) => l.replace(/[\t\f\v]+/g, ' ').replace(/ {2,}/g, ' ').trim())
      .filter(Boolean);
  }

  const extraRes = [];
  if (opts.adPatterns) for (const p of opts.adPatterns) {
    try { extraRes.push(new RegExp(p)); } catch { /* 忽略 */ }
  }

  const aliases = (opts.titleAliases || []).filter(Boolean).map((t) => String(t).trim());

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // 去掉行首缩进用的全角/半角空白（缩进由前端排版负责）
    line = line.replace(/^[\s\u3000]+/, '').replace(/[\s\u3000]+$/, '');
    if (!line) continue;

    // 首行/次行与章节标题重复 → 去掉
    if (out.length <= 1 && aliases.some((a) => a && (line === a || line.replace(/[\s　]/g, '') === a.replace(/[\s　]/g, '')))) {
      continue;
    }
    if (isAdLine(line, extraRes)) continue;
    out.push(line);
  }

  let result = out.join('\n');
  // 收敛多余空行
  result = result.replace(/\n{3,}/g, '\n\n').trim();
  return result;
}

/** 粗略估算字数（中文按字符，英文按词） */
export function countWords(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const words = (s.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ').match(/[A-Za-z0-9]+/g) || []).length;
  return cjk + words;
}

/** 把正文切成更小的抓取单元，避免单章过长 */
export function splitLongText(text, maxLen = 20000) {
  const s = String(text || '');
  if (s.length <= maxLen) return [s];
  const parts = [];
  let cur = '';
  for (const para of s.split('\n')) {
    if (cur.length + para.length + 1 > maxLen && cur) { parts.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + para;
  }
  if (cur) parts.push(cur);
  return parts;
}
