set -e
cd "$(dirname "$0")/.." 2>/dev/null || true
W=$(mktemp -d)
node test/mock-site/server.mjs >"$W/mock.log" 2>&1 &
MOCK=$!
SHUHAI_PORT=18990 SHUHAI_DB="$W/demo.db" SHUHAI_HOST=127.0.0.1 node src/server.mjs >"$W/srv.log" 2>&1 &
SRV=$!
trap 'kill $MOCK $SRV 2>/dev/null || true; rm -rf "$W"' EXIT
sleep 2

B=http://127.0.0.1:18990
echo "### 1. 健康检查"
curl -s $B/api/health | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s).data;console.log('  ',j.status,'| Node',j.node,'| 书源',j.sourceCount)})"

echo "### 2. 导入标准 legado 书源（test/fixtures/sources.json）"
node -e "
const fs=require('fs');
const t=fs.readFileSync('test/fixtures/sources.json','utf8');
fetch('http://127.0.0.1:18990/api/sources/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t,mode:'append'})})
 .then(r=>r.json()).then(j=>console.log('  ',JSON.stringify(j.data)));
"
sleep 0.5

echo "### 3. 按【书名】搜索"
curl -s "$B/api/search?q=$(node -e "process.stdout.write(encodeURIComponent('斗破'))")" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s).data;
console.log('   命中',d.total,'条，耗时',d.took,'ms');
for(const i of d.items.slice(0,3)) console.log('   -',i.name,'/',i.author,'/',i.kind,'| 来源:',i.sourceName,'| 匹配度',Math.round(i.score));
console.log('   书源状态:',d.sources.map(x=>x.name+'='+(x.ok?x.count+'条':('失败:'+x.error))).join(' | '));})"

echo "### 4. 按【作者名】搜索"
curl -s "$B/api/search?q=$(node -e "process.stdout.write(encodeURIComponent('忘语'))")&type=author" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s).data;
console.log('   命中',d.total,'条 ->',d.items.slice(0,3).map(i=>i.name+'('+i.author+')').join(', '));})"

echo "### 5. 榜单/分类发现"
curl -s "$B/api/search/hot" | head -c 220; echo

echo "### 6. 完整阅读链路（落地 -> 目录 -> 正文）"
node -e "
(async()=>{
const B='http://127.0.0.1:18990';
const j=async(p,o)=>(await (await fetch(B+p,o)).json());
const list=await j('/api/sources?limit=10');
const src=list.data.items.find(s=>s.enabled&&s.name.includes('UTF8'));
const s=await j('/api/sources/'+src.id+'/search?q='+encodeURIComponent('斗破'));
const hit=s.data.items[0];
console.log('   搜索命中:',hit.name,'-',hit.author);
const b=await j('/api/books/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceId:src.id,bookUrl:hit.bookUrl})});
console.log('   书籍落地: id='+b.data.id,'|',b.data.name,'| 简介',(b.data.intro||'').length+'字');
const c=await j('/api/books/'+b.data.id+'/chapters');
console.log('   目录抓取:',c.data.total,'章','(来自缓存:'+c.data.fromCache+', 翻页数:'+(c.data.pages||1)+')');
const ct=await j('/api/books/'+b.data.id+'/content?index=0');
const txt=ct.data.content;
console.log('   正文抓取:',txt.length,'字符,',txt.split('\n').length,'段 | 广告残留:',/请记住|天才一秒|www\./i.test(txt)?'有':'无');
console.log('   正文开头:',JSON.stringify(txt.slice(0,50)));
const prog=await j('/api/progress/'+b.data.id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chapterIndex:2,percent:7,addSeconds:60})});
console.log('   进度保存(POST/sendBeacon 路径):',JSON.stringify(prog.data));
const st=await j('/api/stats');
console.log('   统计:',JSON.stringify(st.data));
})();
"
echo "$W" > /dev/null
