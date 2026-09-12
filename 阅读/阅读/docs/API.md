# 书海 ShuHai · API 契约 v1（冻结）

所有接口以 \`/api\` 为前缀，请求/响应均为 \`application/json; charset=utf-8\`。
统一响应包装：

\`\`\`json
{ "ok": true, "data": <any> }
{ "ok": false, "error": { "code": "BAD_REQUEST", "message": "人类可读信息" } }
\`\`\`

错误码：\`BAD_REQUEST\` \`NOT_FOUND\` \`UPSTREAM_ERROR\` \`UPSTREAM_NOT_FOUND\` \`TIMEOUT\` \`RULE_ERROR\` \`CONFLICT\` \`CHAPTER_OUT_OF_RANGE\` \`BOOK_RECORD_BROKEN\` \`INTERNAL\`
HTTP 状态码与语义对应（400/404/409/500/502/504）。
> **\`NOT_FOUND\` 与 \`UPSTREAM_NOT_FOUND\` 的区别（重要）**：
> \`NOT_FOUND\`(404) 表示**本服务**没有这个资源（书源 / 书籍 / 书签不存在）。
> \`UPSTREAM_NOT_FOUND\`(502) 表示**书源站点**返回了 404，即那一页已失效 —— 不是本服务的接口问题。
> 早先版本把两者混用，书源站点挂了却提示 \`HTTP 404 Not Found\`，看起来像本服务出错。
> \`CHAPTER_OUT_OF_RANGE\`(409) 表示目录已变化、请求的章节序号越界，刷新目录即可恢复。

时间戳一律为 Unix 毫秒（number）。分页参数 \`page\` 从 1 开始，\`limit\` 默认 20，上限 200。

---

## 1. 系统

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | \`/api/health\` | \`{ok:true,data:{status:"ok",version,uptime,sourceCount,bookCount}}\` |
| GET | \`/api/stats\` | \`{sourceTotal,sourceEnabled,bookTotal,chapterCached,readSeconds,bookmarkTotal}\` |

## 2. 书源 Source

Source 对象（对前端）：

\`\`\`ts
{
  id: number
  name: string            // bookSourceName
  url: string             // bookSourceUrl 站点根地址
  group: string           // bookSourceGroup，可含多个以 , 或 ; 分隔
  type: number            // 0 文本 1 音频 2 图片 3 文件
  enabled: boolean
  weight: number          // 越大搜索时越靠前
  sortOrder: number
  comment: string
  lastUpdateTime: number
  respondTime: number     // 最近一次响应耗时 ms（0 = 未测）
  lastTestAt: number      // 最近一次体检时间；0 = 从未体检
  lastTestOk: boolean     // 最近一次体检是否通过
  lastTestCount: number   // 最近一次体检命中的条数
  lastTestError: string   // 最近一次体检的失败原因
  testStatus: 'ok' | 'fail' | 'untested'  // 体检结论（由上面四个字段推导）
  searchable: boolean     // 是否配置了 searchUrl
  ruleStats: { hasSearch:boolean, hasBookInfo:boolean, hasToc:boolean, hasContent:boolean }
  createdAt: number
  updatedAt: number
}
\`\`\`

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| GET | \`/api/sources\` | \`?q=\` 关键字 \`&group=\` \`&enabled=1\|0\` \`&status=ok\|fail\|untested\` \`&page=\` \`&limit=\` | \`{items:Source[], total, groups:string[], page, limit, testStats:{total,ok,fail,untested}}\` |
| GET | \`/api/sources/:id\` | | \`{source:Source, raw:object}\`  raw 为原始书源 JSON |
| POST | \`/api/sources\` | body: 原始书源 JSON | 新建，返回 \`{source, raw}\`；同名同 url 冲突返回 409 CONFLICT |
| PUT | \`/api/sources/:id\` | body: 原始书源 JSON（部分字段即可） | 更新 |
| PATCH | \`/api/sources/:id\` | \`{enabled?,weight?,group?,sortOrder?}\` | 局部更新 |
| DELETE | \`/api/sources/:id\` | | \`{deleted:number}\` |
| POST | \`/api/sources/delete\` | \`{ids:number[]}\` | 批量删除 |
| POST | \`/api/sources/batch\` | \`{ids:number[], patch:{enabled?,weight?,group?}}\` | 批量改 |
| POST | \`/api/sources/import\` | \`{text?:string, url?:string, mode:"merge"\|"replace"\|"append", group?:string, enabled?:boolean}\` | 见下 |
| POST | \`/api/sources/import-url\` | \`{url, mode?, group?}\` | 从网络地址导入（支持订阅链接） |
| GET | \`/api/sources/export\` | \`?ids=1,2,3\` 省略=全部 \`&enabledOnly=1\` | 返回 legado 兼容 JSON 数组（\`Content-Disposition: attachment\` 也提供 \`?download=1\`） |
| POST | \`/api/sources/test\` | \`{id, keyword?}\` | 真实搜索一次，返回 \`{ok,elapsed,count,samples,error?,log}\`，结果同时写入该源的体检字段 |
| POST | \`/api/sources/preview\` | \`{raw:object, keyword?}\` | 未保存前测试 |
| POST | \`/api/sources/test-batch\` | \`{ids?:number[], keyword?, q?, group?, enabled?, status?, concurrency?}\` | **批量体检**（同步返回全部结果） |
| GET | \`/api/sources/test-batch/stream\` | 同上（query 形式） | **批量体检 SSE**：\`start\` → \`result\`×N → \`done\` |
| POST | \`/api/sources/delete-invalid\` | \`{ids?, retest?:boolean, keyword?, q?, group?, enabled?, status?, concurrency?}\` | **一键删除失效书源** |
| GET | \`/api/sources/groups\` | | \`string[]\` |

**体检（test-batch）语义**：对范围内每个书源用 \`keyword\`（默认「斗破苍穹」）真实搜索一次，
命中 ≥1 条即 \`ok\`，结果写入 \`last_test_*\`。范围优先级：\`ids\` > 筛选条件（\`q/group/enabled/status\`）> 全部。
\`concurrency\` 默认 6、上限 16。返回 \`{total, ok, fail, took, results:[{id,name,ok,count,elapsed,error,samples}], stats}\`。

**SSE 事件**：
- \`event: start\` → \`{total, keyword, concurrency}\`
- \`event: result\` → \`{id,name,ok,count,elapsed,error,done,total}\`（逐个推送，可做进度条）
- \`event: done\` → \`{total, ok, fail, took, stats}\`

**delete-invalid 语义**：只删除 \`last_test_at > 0 && last_test_ok = 0\` 的书源——
**从未体检过的书源永远不会被删除**（避免误删刚导入还没测的源）。
\`retest: true\` 时先按同一范围批量体检再删。删除范围与体检范围严格一致，筛选命中 0 个时一个都不删。
返回 \`{tested, deleted, ids:number[], items:[{id,name,error}], scope:number, stats}\`。

**import 语义**：\`text\` 可为单对象、数组、\`{"bookSources":[...]}\`、或包含 JSON 的任意文本（会自动截取首个 \`[\`/\`{\` 到末个 \`]\`/\`}\`）。
\`mode\`：\`append\`（默认，全部新增）、\`merge\`（以 name+url 为键，存在则更新）、\`replace\`（清空后导入）。
返回 \`{added, updated, skipped, failed:[{name,error}], total}\`。

## 3. 搜索 Search

SearchResult 对象：

\`\`\`ts
{
  key: string             // sourceId + "|" + bookUrl 的稳定标识
  sourceId: number
  sourceName: string
  name: string
  author: string
  kind: string
  intro: string
  coverUrl: string
  bookUrl: string
  wordCount: string
  lastChapter: string
  score: number           // 相关度 0-100
}
\`\`\`

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| GET | \`/api/search\` | \`q\`(必填) \`type=name\|author\|all\`(默认 all) \`match=fuzzy\|exact\`(默认 fuzzy) \`sources=1,2\` \`groups=\` \`limit=60\` \`timeout=15000\` \`dedupe=1\` | 并发抓取全部启用书源，聚合去重排序。返回 \`{items, total, took, match, sources:[{id,name,ok,count,elapsed,error}]}\` |
| GET | \`/api/search/stream\` | 同上 | **SSE**。事件：\`event: source\` data=\`{sourceId,sourceName,ok,count,elapsed,error,items:SearchResult[]}\`；结束 \`event: done\` data=\`{total,took}\`；心跳 \`:ping\`。客户端用 \`EventSource\`。 |
| GET | \`/api/sources/:id/search\` | \`q\` \`page=1\` | 单源搜索，返回 \`{items, page, hasMore}\` |
| GET | \`/api/search/history\` | \`?limit=20\` | \`[{id,keyword,type,createdAt}]\` |
| DELETE | \`/api/search/history\` | | 清空 |
| GET | \`/api/search/hot\` | `sources=6` `groups=3` `limit=20` `timeout=12000` | 榜单/分类发现。解析各书源的 `exploreUrl`（支持 JSON 数组与 `标题::地址` 两种写法）逐组抓取，返回 `[{sourceId,sourceName,title,items:SearchResult[],ok,error}]`。单个源失败只跳过它，全部失败返回 `[]`。字段规则优先用 `ruleExplore`，缺失时回退 `ruleSearch` |

**match 搜索模式**：
- `fuzzy`（默认）：包含关键词的都算，按相关度打分排序（`scoreMatch`）。
- `exact`：只保留**书名或作者与关键词完全一致**的条目。比对前会做归一化——
  全角转半角、去掉空格与《》【】（）等标点、忽略大小写。
  例：搜「斗破苍穹」时不会把「斗破苍穹之秋雨」算进来；`《斗破 苍穹》` 与 `斗破苍穹` 视为同一本。

## 4. 书籍 Book / 目录 / 正文

Book 对象：

\`\`\`ts
{
  id: number
  sourceId: number
  sourceName: string
  bookUrl: string
  name: string
  author: string
  cover: string
  intro: string
  kind: string
  lastChapter: string
  wordCount: string
  status: string
  tocUrl: string
  chapterCount: number
  createdAt: number
  updatedAt: number
  inShelf: boolean
}
\`\`\`

Chapter 对象：\`{ index:number, title:string, url:string, isVolume:boolean, cached:boolean }\`

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| POST | \`/api/books/resolve\` | \`{sourceId, bookUrl, name?, author?}\` | 由搜索结果落地成 Book（去重：sourceId+bookUrl 唯一） |
| GET | \`/api/books/:id\` | \`?refresh=1\` | Book（refresh 时回源刷新详情） |
| GET | \`/api/books/:id/chapters\` | \`?refresh=1\` | \`{items:Chapter[], total, fromCache:boolean}\` |
| GET | \`/api/books/:id/content\` | \`?index=0\` 或 \`?url=\` \`&refresh=1\` | \`{index,title,content,nextIndex,prevIndex,cached,fromCache}\`，content 为已清洗的纯文本（段落以 \n 分隔） |
| POST | \`/api/books/:id/cache\` | \`{from:number,to:number,concurrency?}\` | 后台预下载，返回 \`{jobId,queued}\` |
| GET | \`/api/books/:id/cache\` | | \`{cached:number,total:number,queued:number,running:boolean}\` |
| GET | \`/api/books/:id/search\` | \`?q=\` | 全书章节标题搜索 \`[{index,title}]\` |
| GET | \`/api/books/:id/alternatives/stream\` | 同左 | **推荐**。SSE 流式换源：每搜完一个书源立即推送，首个候选通常 1~2 秒到达，而不是等全部源跑完。事件体 {type:cached|source|done|error}；source 带 items[] 与 progress{responded,total,succeeded,failed}；done 带 {total,searched,succeeded,failed,failures[],took} |
| GET | \`/api/books/:id/alternatives\` | \`?maxSources=40\` \`&timeout=7000\` \`&limit=40\` \`&refresh=1\` | 换源候选：\`{items:SearchResult[], total, searched, fromCache}\`。只挑最可能出结果的 N 个源（先排除体检失败的），单源超时 7s、并发 14，结果缓存 3 分钟；\`refresh=1\` 强制重查 |
| POST | \`/api/books/:id/change-source\` | \`{sourceId, bookUrl, keepProgress=1}\` | 换源，保留进度百分比，返回新 Book |
| DELETE | \`/api/books/:id\` | | 删除书籍及其缓存 |

## 5. 书架 Shelf / 进度 / 书签 / 笔记

| 方法 | 路径 | 参数 | 说明 |
|---|---|---|---|
| GET | \`/api/shelf\` | | \`{items:(Book & {shelf:{group,sortOrder,addedAt}, progress:{chapterIndex,chapterTitle,percent,updatedAt}})[], groups:string[]}\` |
| POST | \`/api/shelf\` | \`{bookId}\` 或 \`{sourceId,bookUrl,name,author}\` | 加入书架 |
| DELETE | \`/api/shelf/:bookId\` | | 移出书架（保留进度） |
| PATCH | \`/api/shelf/:bookId\` | \`{group?, sortOrder?}\` | 移动分组/排序 |
| GET | \`/api/progress/:bookId\` | | \`{chapterIndex,chapterTitle,chapterPos,percent,updatedAt,readSeconds}\` |
| PUT | \`/api/progress/:bookId\` | \`{chapterIndex,chapterTitle?,chapterPos?,percent?,addSeconds?}\` | 保存进度（节流调用，前端 5s 一次或翻章时） |
| POST | `/api/progress/:bookId` | 同上 | **PUT 的等价别名**。浏览器 `navigator.sendBeacon` 只能发 POST，页面卸载时的进度兜底上报走的正是这个入口 |
| GET | \`/api/bookmarks\` | \`?bookId=\` | \`[{id,bookId,chapterIndex,chapterTitle,pos,text,note,createdAt}]\` |
| POST | \`/api/bookmarks\` | \`{bookId,chapterIndex,chapterTitle,pos,text,note?}\` | |
| DELETE | \`/api/bookmarks/:id\` | | |
| GET | \`/api/notes\` | \`?bookId=\` | 同 bookmarks（note 非空） |

## 6. 设置 Settings

服务端保存全局默认阅读设置（多设备同步）。前端优先级：**本地 localStorage > 服务端 settings**。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | \`/api/settings\` | 返回完整设置对象（含默认值合并） |
| PUT | \`/api/settings\` | 深合并保存，返回合并后对象 |
| GET | \`/api/settings/presets\` | 主题预设列表（见下） |

设置对象（**前端 localStorage key 同名**，便于同步）：

\`\`\`ts
{
  theme: "light"|"sepia"|"green"|"dark"|"black"|"night"|"custom"
  // 背景
  bgColor: string          // #rrggbb
  bgImage: string          // url 或 ""；设置后叠加 bgColor 与遮罩
  bgOpacity: number        // 0-100 背景图不透明度
  textColor: string
  // 字体
  fontFamily: string       // CSS font-family 值
  fontSize: number         // px, 12-40
  fontWeight: number       // 300-700
  lineHeight: number       // 1.2-3.0
  letterSpacing: number    // px, 0-5
  paragraphSpacing: number // em, 0-3（段间距）
  textIndent: number       // em, 0-4（首行缩进）
  textAlign: "left"|"justify"
  // 排版/自适应
  layoutMode: "auto"|"fixed"      // auto=按视口自适应列宽
  pageWidth: number               // px, 320-1600 最大正文列宽（auto 时为上限）
  pagePadding: number             // px, 0-80 左右内边距
  fontScaleWithWidth: boolean     // 视口变小时按比例微调字号
  // 翻页
  pageMode: "scroll"|"slide"|"cover"|"none"|"vertical"
  // scroll 滚动 / slide 左右滑动 / cover 仿真覆盖 / none 无动画 / vertical 上下翻页
  animateDuration: number         // ms, 0-600
  clickArea: "none"|"left-right"|"all"  // 点击翻页区域
  // 其他
  autoRead: { enabled:boolean, speed:number }   // speed px/s
  keepScreenOn: boolean
  showProgress: boolean
  showClock: boolean
  showBattery: boolean
  fullscreen: boolean
  brightness: number        // 20-100，用 CSS filter 模拟
  simplify: boolean         // 简繁转换（前端实现）
  fontSizeShortcut: boolean
  hideStatusBar: boolean
  pageAnim: string
}
\`\`\`

\`/api/settings/presets\` 返回：

\`\`\`json
[
 {"id":"light","name":"默认白","patch":{"theme":"light","bgColor":"#ffffff","textColor":"#2c2c2c"}},
 {"id":"sepia","name":"羊皮纸","patch":{"theme":"sepia","bgColor":"#f5ecd9","textColor":"#4a3f35"}},
 {"id":"green","name":"护眼绿","patch":{"theme":"green","bgColor":"#cce8cf","textColor":"#26352a"}},
 {"id":"dark","name":"夜间灰","patch":{"theme":"dark","bgColor":"#1f1f1f","textColor":"#b8b8b8"}},
 {"id":"black","name":"纯黑 OLED","patch":{"theme":"black","bgColor":"#000000","textColor":"#8f8f8f"}},
 {"id":"night","name":"深蓝夜读","patch":{"theme":"night","bgColor":"#12202b","textColor":"#9fb3c8"}}
]
\`\`\`

## 7. 事件日志（可选）

GET \`/api/logs?limit=200\` → \`[{ts,level,msg,ctx}]\` 内存环形日志，用于书源排错。

---

## 前端路由（hash 路由，无后端依赖）

- \`#/search\`  搜索页（默认）
- \`#/shelf\`   书架
- \`#/book/:id\` 书籍详情（简介/目录/换源/加入书架）
- \`#/read/:id?chapter=N\` 阅读器
- \`#/sources\` 书源管理
- \`#/settings\` 全局设置
