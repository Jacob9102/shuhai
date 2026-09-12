#!/usr/bin/env node
/**
 * 生成 test/mock-site/gbk-map.json —— 完整的 GBK(CP936) 双向映射表。
 *
 * 思路：Node 内置 ICU 的 TextDecoder 支持 gbk *解码*，但不支持编码。
 * 因此这里在构建期用 TextDecoder('gbk') 遍历全部合法 GBK 双字节序列，
 * 反查出每个汉字对应的字节，落盘为 JSON 映射表。
 * 运行期（server.mjs / gbk.mjs）只读 JSON，不再依赖 TextDecoder，零依赖、可离线。
 *
 * 用法： node test/mock-site/tools/gen-gbk-map.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, '..', 'gbk-map.json');

const dec = new TextDecoder('gbk', { fatal: false });
const map = {};
const aliases = {};
let scanned = 0;
let collisions = 0;

// GBK 单字节：0x00-0x7F 直通 ASCII
for (let b = 0x00; b <= 0x7f; b++) {
  map[String.fromCharCode(b)] = b.toString(16).toUpperCase().padStart(2, '0');
}
// 0x80 在 CP936 中通常映射为欧元符号
try {
  const euro = dec.decode(new Uint8Array([0x80]));
  if (euro && euro !== '\uFFFD' && !(euro in map)) map[euro] = '80';
} catch { /* 该运行时无 gbk 解码器时忽略 */ }

// GBK 双字节：首字节 0x81-0xFE，尾字节 0x40-0xFE 且排除 0x7F
for (let lead = 0x81; lead <= 0xfe; lead++) {
  for (let trail = 0x40; trail <= 0xfe; trail++) {
    if (trail === 0x7f) continue;
    const ch = dec.decode(new Uint8Array([lead, trail]));
    if (!ch || ch.length !== 1 || ch === '\uFFFD') continue;
    scanned++;
    const hex = lead.toString(16).toUpperCase().padStart(2, '0') +
                trail.toString(16).toUpperCase().padStart(2, '0');
    if (ch in map) { collisions++; aliases[hex] = ch; continue; }
    map[ch] = hex;
  }
}

const payload = {
  _comment: 'GBK(CP936) 字符到双字节十六进制编码表；由 tools/gen-gbk-map.mjs 通过 TextDecoder(gbk) 全量扫描生成，供 mock 站点做 GBK 编解码使用。aliases 为同一字符的第二个合法码位（解码时需要）。',
  encoding: 'GBK',
  generatedBy: 'test/mock-site/tools/gen-gbk-map.mjs',
  entries: Object.keys(map).length,
  aliasCount: Object.keys(aliases).length,
  map,
  aliases,
};

writeFileSync(outFile, JSON.stringify(payload), 'utf8');
console.log('scanned pairs:', scanned, 'collisions:', collisions, 'entries:', payload.entries);
console.log('aliases:', JSON.stringify(aliases));
console.log('written:', outFile);
