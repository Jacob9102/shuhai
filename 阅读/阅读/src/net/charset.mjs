/**
 * 非 UTF-8 站点的「请求侧」编码。
 *
 * 为什么需要：很多中文小说站是 GBK/GB2312/Big5，搜索关键字必须按站点编码发送——
 * 用 UTF-8 发过去，站点查不到任何结果（表现为「搜索成功但 0 条结果」）。
 * 例如 书书小说：searchkey 用 UTF-8 编码返回 2868B 空页，用 GBK 编码返回真正的结果页。
 *
 * 实现：Node 的 TextDecoder 支持 gbk/gb18030/big5 解码（镜像里已装 full-icu 并有自检），
 * 但 TextEncoder 只有 UTF-8。所以这里**在运行时用解码器反向生成编码表**：
 * 遍历双字节区间，能解码成单个字符的组合就是合法码位，反过来即 char → bytes。
 * 好处：零依赖、不需要额外的映射表文件，首次构建约几毫秒，之后缓存复用。
 */

const tableCache = new Map();

/** 生效编码名：gb2312 按 gbk 处理（gb2312 是 gbk 的子集） */
function normalizeCharset(charset) {
  const cs = String(charset || '').trim().toLowerCase().replace(/[_\s]/g, '-');
  if (!cs) return '';
  if (cs === 'gb2312' || cs === 'gb-2312' || cs === 'gbk' || cs === 'cp936' || cs === 'ms936') return 'gbk';
  if (cs === 'gb18030') return 'gb18030';
  if (cs === 'big5' || cs === 'big-5' || cs === 'cp950') return 'big5';
  return cs;
}

/** 是否是需要做请求侧转码的编码（UTF-8 系不需要） */
export function needsTranscode(charset) {
  const cs = normalizeCharset(charset);
  return !!cs && !cs.startsWith('utf') && cs !== 'unicode' && cs !== 'iso-8859-1' && cs !== 'ascii';
}

function tableFor(charset) {
  if (tableCache.has(charset)) return tableCache.get(charset);
  const map = new Map();
  let decoder = null;
  try { decoder = new TextDecoder(charset, { fatal: true }); } catch { /* 运行时不支持该编码 */ }
  if (decoder) {
    for (let hi = 0x81; hi <= 0xfe; hi++) {
      for (let lo = 0x40; lo <= 0xfe; lo++) {
        if (lo === 0x7f) continue;
        const bytes = Buffer.from([hi, lo]);
        try {
          const ch = decoder.decode(bytes);
          if (ch && ch.length === 1 && ch !== '\uFFFD' && !map.has(ch)) map.set(ch, bytes);
        } catch { /* 非法码位：跳过 */ }
      }
    }
  }
  tableCache.set(charset, map);
  return map;
}

/** 把字符串编码成目标编码的字节 */
export function encodeBytes(text, charset) {
  const cs = normalizeCharset(charset);
  const table = needsTranscode(cs) ? tableFor(cs) : null;
  if (!table || !table.size) return Buffer.from(String(text ?? ''), 'utf8');
  const parts = [];
  for (const ch of String(text ?? '')) {
    const hit = table.get(ch);
    if (hit) parts.push(hit);
    else if (ch.charCodeAt(0) < 0x80) parts.push(Buffer.from(ch, 'ascii'));
    else parts.push(Buffer.from(ch, 'utf8')); // 字表里没有的字符只能退回 UTF-8
  }
  return Buffer.concat(parts);
}

const UNRESERVED = /[A-Za-z0-9\-_.!~*'()]/;

/** 按目标编码做 percent-encoding（用于把关键字塞进 URL / 表单） */
export function encodeURIComponentInCharset(text, charset) {
  const cs = normalizeCharset(charset);
  if (!needsTranscode(cs)) return encodeURIComponent(String(text ?? ''));
  const buf = encodeBytes(text, cs);
  let out = '';
  for (const b of buf) {
    const ch = String.fromCharCode(b);
    out += UNRESERVED.test(ch) ? ch : '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}
