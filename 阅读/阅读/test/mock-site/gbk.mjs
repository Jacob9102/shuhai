/**
 * GBK(CP936) 编解码器 —— 只依赖同目录下的 gbk-map.json，不需要任何 npm 依赖。
 *
 * Node 的 TextEncoder 只支持 UTF-8，Buffer 也不支持 gbk，因此这里在“构建期”
 * 用 TextDecoder('gbk') 反查生成了一张完整的 字符 <-> 双字节 映射表
 * （tools/gen-gbk-map.mjs），运行期查表即可：纯离线、零依赖、可复现。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const table = JSON.parse(readFileSync(join(here, 'gbk-map.json'), 'utf8'));
const MAP = table.map;
const ALIASES = table.aliases || {};
const FALLBACK = 0x3f; // '?'

/** 反向表：双字节十六进制 -> 字符（含 aliases，保证解码完整） */
const REVERSE = (function () {
  const r = new Map();
  const keys = Object.keys(MAP);
  for (let i = 0; i < keys.length; i++) {
    const hex = MAP[keys[i]];
    if (hex.length === 4 && !r.has(hex)) r.set(hex, keys[i]);
  }
  const akeys = Object.keys(ALIASES);
  for (let i = 0; i < akeys.length; i++) {
    if (!r.has(akeys[i])) r.set(akeys[i], ALIASES[akeys[i]]);
  }
  return r;
})();

function hex2(n) {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

/** 该字符串能否被 GBK 完整表示 */
export function canEncodeGBK(str) {
  for (const ch of String(str)) if (MAP[ch] === undefined) return false;
  return true;
}

/** 返回无法用 GBK 表示的字符列表（去重），用于自检 */
export function unmappableChars(str) {
  const bad = new Set();
  for (const ch of String(str)) if (MAP[ch] === undefined) bad.add(ch);
  return Array.from(bad);
}

/**
 * 把字符串编码为 GBK 字节。
 * 映射表中不存在的字符（如 emoji、部分生僻字）替换为 '?'，保证永不抛异常。
 */
export function gbkEncode(str) {
  const s = String(str);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const hex = MAP[s[i]];
    if (hex === undefined) { out.push(FALLBACK); continue; }
    if (hex.length === 2) { out.push(parseInt(hex, 16)); continue; }
    out.push(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2), 16));
  }
  return Buffer.from(out);
}

/** 把 GBK 字节解码为字符串；无法识别的字节输出 U+FFFD */
export function gbkDecode(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let out = '';
  for (let i = 0; i < b.length; i++) {
    const byte = b[i];
    if (byte < 0x80) { out += String.fromCharCode(byte); continue; }
    if (byte >= 0x81 && byte <= 0xfe && i + 1 < b.length) {
      const ch = REVERSE.get(hex2(byte) + hex2(b[i + 1]));
      if (ch !== undefined) { out += ch; i++; continue; }
    }
    out += '\uFFFD';
  }
  return out;
}

/** 按 GBK 规则做 URL 百分号编码（真实 GBK 源站就是用它来传关键字的） */
export function percentEncodeGBK(str) {
  const buf = gbkEncode(str);
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    const ch = String.fromCharCode(c);
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
    else out += '%' + hex2(c);
  }
  return out;
}

export const GBK_TABLE_SIZE = Object.keys(MAP).length;
export default { gbkEncode, gbkDecode, canEncodeGBK, unmappableChars, percentEncodeGBK, GBK_TABLE_SIZE };
