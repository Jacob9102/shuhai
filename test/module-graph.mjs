/** 独立核验前端模块图：import 目标是否存在、具名导入是否真的被导出 */
import fs from 'node:fs';
import path from 'node:path';

const WEB = 'web';
const jsDir = path.join(WEB, 'js');
const files = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'));
const problems = [];
const exportsMap = new Map();

for (const f of files) {
  const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(/\s+as\s+/).pop().trim();
      if (t) names.add(t);
    }
  }
  exportsMap.set(f, names);
}

let importCount = 0;
for (const f of files) {
  const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = m[1].trim();
    const spec = m[2];
    importCount++;
    if (!spec.startsWith('.')) { problems.push(f + ' 导入了非相对路径: ' + spec); continue; }
    const target = path.resolve(jsDir, spec);
    if (!fs.existsSync(target)) { problems.push(f + ' 导入的文件不存在: ' + spec); continue; }
    const tname = path.basename(target);
    if (!exportsMap.has(tname)) continue;
    const exp = exportsMap.get(tname);
    const braced = /\{([\s\S]*)\}/.exec(clause);
    if (braced) {
      for (const part of braced[1].split(',')) {
        const nm = part.trim().split(/\s+as\s+/)[0].trim();
        if (!nm) continue;
        if (!exp.has(nm)) problems.push(f + ' 从 ' + tname + ' 导入了不存在的具名导出: ' + nm);
      }
    } else if (!clause.startsWith('*')) {
      if (!exp.has('default')) problems.push(f + ' 默认导入了 ' + tname + '，但它没有 default 导出');
    }
  }
}

// index.html 引用检查
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
for (const m of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
  const p = path.join(WEB, m[1]);
  if (!fs.existsSync(p)) problems.push('index.html 引用了不存在的资源: ' + m[1]);
}
for (const m of html.matchAll(/<script[^>]*src="([^"]+)"/g)) {
  if (!m[1].startsWith('/js/')) problems.push('index.html 的 script 路径不是预期的 /js/*: ' + m[1]);
}

console.log('前端模块: ' + files.length + ' 个, import 语句: ' + importCount + ' 条');
console.log('index.html 引用资源: ' + [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(m => m[1]).join(', '));
if (problems.length) { console.log('❌ 发现问题 ' + problems.length + ' 个:'); for (const p of problems) console.log('   - ' + p); }
else console.log('✅ 模块图完整：所有 import 目标存在、具名导出匹配、index.html 引用有效');
