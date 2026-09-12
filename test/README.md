# 书源端到端测试夹具（离线 mock 书源站 + legado 书源）

本目录提供一套**完全离线、零依赖、可复现**的端到端测试夹具，用于验证后端「阅读(Legado) 3.0 书源规则引擎」的
**搜索 → 书籍详情 → 目录(含分页) → 正文(含广告清洗)** 全链路，以及 UTF-8 / GBK / POST / 异常 四类场景。

- 只依赖 Node 内置模块（`node:http` / `node:fs`），**不需要 npm install**；
- **不访问任何外网**：图片由内置 base64 的 1x1 JPEG 提供，页面无任何外链 CSS/JS/图片；
- **完全确定性**：不使用 `Math.random`、不读时钟，同一本书同一章每次生成的内容完全一致。

---

## 1. 目录结构

| 文件 | 说明 |
|---|---|
| `mock-site/server.mjs` | 零依赖 Node HTTP 服务器，默认监听 `127.0.0.1:18080`（`MOCK_PORT` 可覆盖） |
| `mock-site/books.mjs` | 8 本中文小说数据 + 确定性正文章节生成器（每章 ≥1200 汉字） |
| `mock-site/gbk.mjs` | GBK 编解码器（编码 / 解码 / 百分号编码），查表实现，运行期不依赖 ICU |
| `mock-site/gbk-map.json` | 全量 GBK(CP936) 映射表（24067 条），由脚本离线生成 |
| `mock-site/tools/gen-gbk-map.mjs` | 生成 `gbk-map.json` 的构建脚本（仅在需要重建编码表时运行） |
| `fixtures/sources.json` | **数组形式**的 legado 书源，5 个 |
| `fixtures/legado-subscription.json` | **订阅形式** `{"bookSources":[UTF8源, GBK源]}`，用于测试订阅导入 |

## 2. 启动与停止

```bash
# 前台启动（默认 127.0.0.1:18080）
node test/mock-site/server.mjs

# 换端口
MOCK_PORT=18081 node test/mock-site/server.mjs

# 后台启动 / 关闭
node test/mock-site/server.mjs &
kill %1
```

启动后可访问 `GET http://127.0.0.1:18080/__routes` 查看全部路由的自描述清单。

## 3. 路由表

| 方法 | 路径 | 说明 | 默认编码 |
|---|---|---|---|
| GET | `/` | 首页，热门书籍链接列表（`.hot-list > .hot-item > .hot-name`） | UTF-8 |
| GET | `/search?q=&page=1` | 搜索结果页（HTML，结构见下） | **GBK** |
| POST | `/search` | 同 GET，参数取表单 body（`application/x-www-form-urlencoded` 或 JSON） | **GBK** |
| GET | `/gbk-search?q=&page=1` | 强制 GBK 的搜索结果页（与 `/search` 同实现） | **GBK** |
| GET | `/book/:id` | 详情页：`h1.book-title` / `span.author` / `img.book-cover` / `.kind` / `.word-count` / `.status` / `#intro` / `a.toc` | UTF-8 |
| GET | `/book/:id/chapters?page=1` | 目录页，30 章，每页 20 章；`a.next` 为下一页链接（末页为无 href 的 `span.next.disabled`） | UTF-8 |
| GET | `/book/:id/chapter/:n` | 正文页：`#content` 内 17 个 `<p>`，其中 3 个是广告行 | UTF-8 |
| GET | `/book/:id/chapter/:n/next` | 长章节（`n % 5 === 0`）的续页；非长章节返回**空 `#content`** | UTF-8 |
| GET | `/img/:id.jpg` | 1x1 合法 JPEG（内嵌 base64，`Content-Type: image/jpeg`） | — |
| GET | `/slow?ms=3000` | 故意延迟（默认 3000ms，上限 60000ms），测试超时 | UTF-8 |
| GET | `/broken` | 固定返回 **HTTP 500** | UTF-8 |
| GET | `/__routes` | 路由清单（JSON） | — |
| — | 其它 | 404 页面（如 `/book/9999`） | UTF-8 |

未特殊说明的路由都支持 `?charset=utf8` / `?charset=gbk` 覆盖编码，也支持 `gb2312` / `gb18030` 别名。

### 搜索结果页结构（规则靶点）

```html
<div class="book-list">
  <div class="book-item">
    <a class="cover" href="/book/1001"><img src="/img/1001.jpg" alt="封面"></a>
    <h3 class="book-name"><a href="/book/1001">斗破苍穹</a></h3>
    <p class="author">作者：天蚕土豆</p>
    <p class="kind">分类：玄幻</p>
    <p class="word-count">字数：530万字</p>
    <p class="intro">这里是属于斗气的世界……</p>
    <p class="last-chapter"><a href="/book/1001/chapter/30">最新章节：第30章 大结局</a></p>
  </div>
</div>
<div class="pager"><a class="prev" …>上一页</a><span class="page-now">第 1 / 2 页</span><a class="next" href="/search?q=…&page=2">下一页</a></div>
```

> 注：规范样例里的 `/book/1001/chapter/999` 为示意，本 mock 每本只有 30 章，因此最新章节链接指向真实的第 30 章。

### 正文页广告行（正文清洗靶点）

```html
<div id="content">
  <p>……正文段落……</p>
  <p>本站域名 www.example.com 请记住</p>
  <p>手机用户请浏览 m.example.com</p>
  <p class="ad">笔趣阁 www.example.com 最新章节免费阅读</p>
  ……
</div>
```

## 4. 数据与分页

| 书号 | 书名 | 作者 | 分类 | 字数 | 状态 |
|---|---|---|---|---|---|
| 1001 | 斗破苍穹 | 天蚕土豆 | 玄幻 | 530万字 | 连载中 |
| 1002 | 凡人修仙传 | 忘语 | 仙侠 | 748万字 | 已完结 |
| 1003 | 遮天 | 辰东 | 玄幻 | 635万字 | 已完结 |
| 1004 | 诡秘之主 | 爱潜水的乌贼 | 奇幻 | 446万字 | 已完结 |
| 1005 | 盗墓笔记 | 南派三叔 | 悬疑 | 143万字 | 已完结 |
| 1006 | 庆余年 | 猫腻 | 历史 | 380万字 | 已完结 |
| 1007 | 雪中悍刀行 | 烽火戏诸侯 | 武侠 | 460万字 | 已完结 |
| 1008 | 全职高手 | 蝴蝶蓝 | 游戏 | 530万字 | 已完结 |

- **搜索分页**：每页 4 条，共 8 本 → 共 2 页；`q` 为空返回全部。
- **模糊匹配**：`q` 同时匹配**书名**与**作者**的子串，如 `q=天` → 斗破苍穹(作者含“天蚕土豆”)、遮天；`q=忘语` → 凡人修仙传。
- **目录分页**：每本 30 章，每页 20 章 → 第 1 页 20 条、第 2 页 10 条。
- **正文**：每章 14 个正文段 + 3 条广告，**≥1200 汉字**（实测约 1400–1700 字）；每 5 章为“长章节”，拆成两页。

## 5. 编码规则（GBK 是重点考察项）

1. `/search` 与 `/gbk-search` **默认输出真正的 GBK 字节**（`Content-Type: text/html; charset=gbk`），
   页面里所有中文（书名/作者/简介/分页）都是 GBK 双字节，**不是 UTF-8**。
2. 其它页面默认 UTF-8；任意 HTML 路由都可用 `?charset=gbk|utf8` 覆盖。
3. **链接继承编码**：页面内链接会把“当前生效编码”向后传递。因此
   - UTF-8 源：`/search?…&charset=utf8` → 详情/目录/正文链接保持**干净**（`/book/1001`、`/book/1001/chapters`、`/book/1001/chapter/1`）；
   - GBK 源：`/gbk-search?…` → 详情/目录/正文链接自动带 `?charset=gbk`，保证整条数据流都是 GBK。
4. **关键字编码**：GBK 页面按 GBK 解码 `q`，即要求引擎用 GBK 对 `{{key}}` 做百分号编码（真实 GBK 站点的做法）。
   例如 `斗` → `%B6%B7`、`忘语` → `%CD%FC%D3%EF`。
   若关键字被按 UTF-8 提交，mock 会**回退匹配**并在结果页打印 `<p class="warn">编码容错…</p>`，便于立刻发现编码不一致。
5. 结果页始终打印一行调试信息（`p.encoding-note`）：页面编码 / 收到的查询串 / 解码后的关键字。

手工验证 GBK（需要 iconv）：

```bash
# 用 GBK 百分号编码提交关键字，再用 iconv 解码响应
curl -s 'http://127.0.0.1:18080/search?q=%B6%B7&page=1' | iconv -f gbk -t utf8 | grep -E 'search-summary|book-name'
# 响应头应为 Content-Type: text/html; charset=gbk
curl -sI 'http://127.0.0.1:18080/search?q=%B6%B7&page=1' | grep -i content-type
```

## 6. 书源清单（test/fixtures/sources.json）

| 源名 | 权重 | 默认启用 | 验证点 |
|---|---|---|---|
| 本地测试源-UTF8 | 100 | ✅ | 主链路：GET 搜索 + UTF-8 + 目录分页 + 正文清洗 + 长章节 `nextContentUrl` |
| 本地测试源-GBK | 90 | ✅ | GBK 字节输出、GBK 关键字编码、全程 GBK 数据流（`charset` / `bookSourceCharset`） |
| 本地测试源-POST | 80 | ✅ | URL 后缀 JSON `url,{"method":"POST","body":"…"}`、body 中 `{{key}}`/`{{page}}` 替换、表单编码 |
| 本地测试源-坏规则 | 10 | ✅ | 非法正则 / 不存在的选择器 / `@js` 抛错 / tocUrl 404：单源失败不崩溃、可读错误 |
| 本地测试源-坏站点500 | 5 | ❌（手动启用） | 源站 5xx 降级；把 searchUrl 换成 `/slow?ms=3000` 可测超时 |

导入方式（对应 `docs/API.md`）：

```bash
# 数组形式
curl -s -X POST localhost:3000/api/sources/import -H 'content-type: application/json' \
  -d '{"text":"'"$(cat test/fixtures/sources.json)"'","mode":"append"}'
# 订阅形式 {"bookSources":[…]}（导入器应自动识别包裹对象）
curl -s -X POST localhost:3000/api/sources/import -H 'content-type: application/json' \
  -d '{"text":"'"$(cat test/fixtures/legado-subscription.json)"'","mode":"merge"}'
```

`legado-subscription.json` 是 `sources.json` 前两个源的包裹版，重新生成：

```bash
node -e "const a=require('./test/fixtures/sources.json');require('fs').writeFileSync('test/fixtures/legado-subscription.json',JSON.stringify({bookSources:a.slice(0,2)},null,2)+'\n')"
```

## 7. 端到端期望结果（请求 → 期望）

### 7.1 原始 HTTP 层

| 请求 | 期望 |
|---|---|
| `GET /` | 200，`charset=utf-8`，含 8 个 `.hot-item` 链接 |
| `GET /search?q=%E6%96%97&page=1&charset=utf8` | 200，UTF-8，1 条结果（斗破苍穹），链接为 `/book/1001` |
| `GET /search?q=%B6%B7&page=1` | 200，**GBK 字节**，1 条结果，链接为 `/book/1001?charset=gbk` |
| `GET /search?q=&page=2&charset=utf8` | 200，4 条结果，`第 2 / 2 页` |
| `POST /search`（body `q=天&page=1`） | 200，与 GET 等价，2 条结果（斗破苍穹、遮天） |
| `GET /book/1001` | 200，`.book-title`=斗破苍穹、`.author`=天蚕土豆、`.status`=连载中、`#intro` 83 字、`a.toc`=`/book/1001/chapters` |
| `GET /book/1001/chapters?page=1` | 200，`.chapter-list li` 20 条，`a.next`=`…/chapters?page=2` |
| `GET /book/1001/chapters?page=2` | 200，10 条，末条“第30章 大结局”，`class="next disabled"` 且**无 href**（nextTocUrl 应为空） |
| `GET /book/1001/chapter/1` | 200，`#content` 内 17 个 `<p>`（14 正文 + 3 广告），正文 ≥1200 汉字 |
| `GET /book/1001/chapter/5` | 200，含 `<a id="next" href="/book/1001/chapter/5/next">` |
| `GET /book/1001/chapter/5/next` | 200，续页正文（约 700+ 汉字） |
| `GET /book/1001/chapter/1/next` | 200，`#content` **为空**（不报错） |
| `GET /img/1001.jpg` | 200，`image/jpeg`，160 字节，`FFD8FFE0…FFD9`，SOF0=1x1 |
| `GET /slow?ms=3000` | 200，耗时 ≥3s |
| `GET /broken` | **500** |
| `GET /book/9999` / `GET /nope` | 404 |

### 7.2 规则引擎层（用 UTF8 源）

| 阶段 | 规则 | 期望值 |
|---|---|---|
| 搜索 | `ruleSearch.bookList` | `q=斗` → 1 条；`q=` (空) → 4 条/页、共 2 页 |
| 搜索 | `name` | `斗破苍穹` |
| 搜索 | `author` | `天蚕土豆`（`##作者：##` 已去前缀） |
| 搜索 | `kind` / `wordCount` | `玄幻` / `530万字` |
| 搜索 | `lastChapter` | `第30章 大结局` |
| 搜索 | `coverUrl` | `/img/1001.jpg`（应解析为绝对地址 `http://127.0.0.1:18080/img/1001.jpg`） |
| 搜索 | `bookUrl` | `/book/1001`（相对地址应相对源站解析） |
| 详情 | `name/author/kind/wordCount/status` | 斗破苍穹 / 天蚕土豆 / 玄幻 / 530万字 / 连载中 |
| 详情 | `intro` | 83 字简介（不是空、不是 HTML 片段） |
| 详情 | `tocUrl` | `/book/1001/chapters` |
| 目录 | `chapterList` | 第 1 页 20 条 / 第 2 页 10 条，合计 30 |
| 目录 | `chapterName` / `chapterUrl` | `第1章 陨落的天才` / `/book/1001/chapter/1` |
| 目录 | `nextTocUrl` | 第 1 页 → `?page=2`；第 2 页 → **空**（不循环） |
| 正文 | `content` | 清洗后 **0 个广告行**（`example.com` 不出现），14 段，≥1200 汉字 |
| 正文 | `nextContentUrl` | 第 1/2/3/4 章为空；第 5 章 → `/book/1001/chapter/5/next` |
| GBK 源 | 搜索 | 响应按 GBK 解码后书名正确；关键字用 GBK 编码时结果页**无** `p.warn` |
| 坏规则源 | 搜索 | 返回 0 条且**不抛异常**；`/api/search` 汇总仍返回其它源的结果 |
| 坏站点源 | 搜索 | 500 → 该源单条 error，其它源不受影响，接口不 500 |

### 7.3 API 层（对应 docs/API.md）

| 请求 | 期望 |
|---|---|
| `POST /api/sources/import`（`sources.json`，mode=append） | `added=5, failed=[]` |
| `POST /api/sources/import`（`legado-subscription.json`，mode=merge） | 识别 `{"bookSources":[…​]}` 包裹，`updated=2` |
| `GET /api/sources` | 列出 5 个源，GBK 源 raw 中保留 `charset: "gbk"` |
| `POST /api/sources/test`（UTF8 源, keyword=斗） | `ok=true, count=1`，samples[0].name=斗破苍穹 |
| `GET /api/search?q=斗` | 聚合返回斗破苍穹（多源去重后 1 条） |
| `POST /api/books/resolve` → `GET /api/books/:id/chapters` | 30 章 |
| `GET /api/books/:id/content?index=0` | `content` 中**无** `example.com` 广告行，段落以 `\n` 分隔 |

## 8. 已知边界与未验证项

- **`###` 链式多替换未纳入夹具**：所有源的 `content` 都用最保守的单条替换
  `id.content@html##<p[^>]*>(?:本站域名|手机用户请浏览|笔趣阁)[^<]*</p>##`。
  若引擎支持 legado 的 `###` 多替换语法，可另行手工验证（本夹具未覆盖，属兼容性待确认项）。
- **`charset` 在 GBK 源里同时写在顶层（`charset`/`bookSourceCharset`）和搜索 URL 后缀 JSON 中**，
  以兼顾不同实现取值位置。若引擎忽略 URL 后缀 JSON，关键字会以 UTF-8 提交，此时 mock 会走容错分支并打印 `p.warn`（结果仍正确，但说明实现未处理 charset）。
- mock 的分页页码容错：`page` 缺失/非法/≤0 一律按第 1 页处理。
- `/slow` 只延迟固定时长，不做断连/半包等网络异常模拟。
- 图片是 1x1 JPEG（仅验证下载与 `Content-Type`，不验证真实封面内容）。
- `gbk-map.json` 由 `node test/mock-site/tools/gen-gbk-map.mjs` 生成；重建需要 Node 带 ICU 的 `TextDecoder('gbk')`，
  但**运行 mock 站点时不需要**（只读 JSON）。
