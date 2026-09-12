/**
 * 一键跑全部测试：单元 → 端到端 → 夹具联调
 *   node test/run-all.mjs      或   npm test
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SUITES = [
  ['解析器与选择器单元测试', 'test/unit-parser.mjs'],
  ['书源规则引擎单元测试', 'test/unit-rule.mjs'],
  ['前端模块图检查', 'test/module-graph.mjs'],
  ['端到端测试（自带模拟站点）', 'test/e2e.mjs'],
  ['夹具联调（第三方书源 + 模拟站点）', 'test/fixtures-e2e.mjs'],
  ['老库迁移与批量体检', 'test/legacy-migration.mjs'],
  ['URL/编码/JS 沙箱兼容性', 'test/url-charset.mjs'],
  ['搜索模式与结果聚合', 'test/search-modes.mjs'],
];

function run(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, file)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

let failed = 0;
for (const [title, file] of SUITES) {
  process.stdout.write('\n\x1b[1m▶ ' + title + '\x1b[0m\n');
  const { code, out } = await run(file);
  const lines = out.trim().split('\n');
  // 只打印关键行，避免输出过长
  const key = lines.filter((l) => /PASS|FAIL|通过|失败|全部通过|ALL GREEN|x |✗/.test(l));
  console.log('  ' + (key.length ? key.join('\n  ') : lines.slice(-8).join('\n  ')));
  if (code !== 0) failed++;
}

console.log('\n' + '='.repeat(46));
console.log(failed === 0 ? '✅ 全部测试套件通过' : '❌ 有 ' + failed + ' 个测试套件失败');
process.exit(failed ? 1 : 0);
