/**
 * 构建期运行时能力自检。
 *
 * 本项目高度依赖两项 Node 运行时能力：
 *   1. full-icu     —— 解码 GBK/GB18030/Big5 站点（中文小说站大量使用 GBK）
 *   2. node:sqlite  —— 内置数据库，用来避免任何第三方依赖
 *
 * 如果基础镜像缺少它们，宁可让 docker build 直接失败，
 * 也不要等到用户导入书源后才发现满屏乱码。
 *
 * 注意：这是 ESM 文件，不能用 require()，必须用 import。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const checks = [
  ['GBK 解码 (full-icu)', () => new TextDecoder('gbk').decode(Buffer.from([0xb6, 0xb7, 0xc6, 0xc6])) === '斗破'],
  ['GB18030 解码', () => new TextDecoder('gb18030').decode(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])) === '中文'],
  ['Big5 解码', () => new TextDecoder('big5').decode(Buffer.from([0xa7, 0x41])) === '你'],
  ['node:sqlite 内存库读写', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (a INTEGER)');
    db.prepare('INSERT INTO t VALUES (?)').run(42);
    const row = db.prepare('SELECT a FROM t').get();
    db.close();
    return row && row.a === 42;
  }],
  ['node:sqlite 文件库 + WAL + 中文', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shuhai-verify-'));
    try {
      const db = new DatabaseSync(path.join(dir, 'probe.db'));
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('CREATE TABLE t (a TEXT)');
      db.prepare('INSERT INTO t VALUES (?)').run('书海');
      const row = db.prepare('SELECT a FROM t').get();
      db.close();
      return row && row.a === '书海';
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }],
  ['fetch / AbortController', () => typeof fetch === 'function' && typeof AbortController === 'function'],
];

let failed = 0;
for (const [name, fn] of checks) {
  let ok = false;
  try { ok = Boolean(fn()); } catch (err) { ok = false; }
  console.log((ok ? '  OK  ' : '  NG  ') + name);
  if (!ok) failed++;
}

if (failed) {
  console.error('');
  console.error('基础镜像缺少 ' + failed + ' 项必需能力。');
  console.error('请把 Dockerfile 里的 FROM node:24-alpine 改成 FROM node:24-slim 后重新构建。');
  process.exit(1);
}
console.log('运行时能力自检通过（Node ' + process.version + ', ICU ' + process.versions.icu + '）');
