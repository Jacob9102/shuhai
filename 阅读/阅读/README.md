# 书海 ShuHai

> 自托管的**全网小说搜索与阅读服务**。导入「阅读」(Legado) 书源，一个搜索框搜遍所有站点；自带阅读器，字体、背景、排版全部可调。
> **零第三方依赖**，Docker 一条命令部署。

<p>
<img alt="Node" src="https://img.shields.io/badge/Node-%E2%89%A522.5-339933"> 
<img alt="deps" src="https://img.shields.io/badge/dependencies-0-brightgreen">
<img alt="tests" src="https://img.shields.io/badge/tests-142%20passing-success">
</p>

---

## 目录

- [它能做什么](#它能做什么)
- [快速开始](#快速开始)
- [书源导入](#书源导入)
- [阅读器](#阅读器)
- [配置项](#配置项)
- [REST API](#rest-api)
- [架构与实现](#架构与实现)
- [测试](#测试)
- [已知限制](#已知限制)
- [安全须知](#安全须知)
- [常见问题](#常见问题)

---

## 它能做什么

| 你的需求 | 实现情况 |
|---|---|
| **按作者名 / 小说名搜索** | 并发请求所有已启用书源，支持「书名 / 作者 / 综合」三种模式、模糊匹配、跨源同名书聚合去重、相关度排序；搜索过程用 SSE **逐源流式返回**，哪个源慢、哪个源失败都看得见 |
| **导入阅读 APP 的书源** | 完整支持 阅读(Legado) 3.0 书源语法。支持 **粘贴 JSON / 网络订阅地址 / 本地 .json 文件** 三种导入方式，以及 append / merge / replace 三种冲突策略；可批量启用禁用、分组、导出回「阅读」APP |
| **管理一大堆失效书源** | 书源页支持**全选/跨页多选**、**批量体检**（SSE 实时进度，逐个标记可用/失效）、**一键清理失效源**；体检结果写入数据库并可按「可用 / 失效 / 未测试」筛选。**从未测试过的书源永远不会被自动删除** |
| **字体与背景设置** | 字体族（系统/宋体/黑体/楷体/仿宋…+自定义）、字号、字重、行高、字间距、段间距、首行缩进、对齐方式；背景色、文字色、背景图+不透明度、亮度遮罩、8 套主题预设 + 完全自定义 |
| **按页面大小自适应排版** | 列宽按视口自动收缩（`min(100%, 上限宽度)`）、字号可随视口缩放、`ResizeObserver` 实时重排、横竖屏自适应、320px 手机到 2560px 显示器都不溢出；移动端自动切换底部抽屉、桌面端右侧抽屉 |
| **常规阅读软件功能** | 书架分组、阅读进度断点续读、目录（分页目录自动跟进）、上一章/下一章、**换源**、全文缓存离线读、书签、批注笔记、章节搜索、五种翻页模式、点击/手势/键盘快捷键翻页、自动阅读、阅读计时、亮度调节、简繁转换、榜单分类发现 |

---

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
# 1. 准备数据目录（首次需要，否则 Docker 会以 root 创建）
mkdir -p data

# 2. 启动
docker compose up -d --build

# 3. 打开浏览器
#    http://<你的主机IP>:8080
```

首次进入后：

1. 打开左侧 **书源管理** → **导入书源**
2. 粘贴一份 legado 书源 JSON（或填订阅地址）
3. 回到 **搜索**，输入书名或作者名试试

> **换端口**：编辑 `.env`（从 `.env.example` 复制）里的 `SHUHAI_PUBLISH_PORT`，或直接改 compose 里的端口映射。
> **数据在哪**：全部在 `./data` 目录（一个 SQLite 文件），备份/迁移直接拷这个目录。

### 方式二：docker run

```bash
docker build -t shuhai:1.0.0 .

docker run -d --name shuhai \
  --restart unless-stopped \
  -p 8080:8080 \
  -v "$(pwd)/data:/data" \
  -e PUID=1000 -e PGID=1000 \
  -e TZ=Asia/Shanghai \
  shuhai:1.0.0
```

### 方式三：直接跑（本机已装 Node ≥ 22.5）

```bash
npm start              # 等价于 node src/server.mjs
# 打开 http://localhost:8080
```

不需要 `npm install` —— 项目零第三方依赖，只用 Node 标准库。

---

## 书源导入

### 支持的输入格式

```
1. 单个书源对象         { "bookSourceName": "...", "bookSourceUrl": "...", ... }
2. 书源数组            [ {...}, {...} ]
3. 订阅包裹格式         { "bookSources": [ {...}, {...} ] }
4. 夹带说明文字        "分享几本书源：[ {...} ] 快导入吧"    ← 会自动截取 JSON 片段
5. 网络订阅地址         https://example.com/sources.json
6. 本地 .json 文件     在导入面板里选择文件
```

### 冲突策略

| 策略 | 行为 |
|---|---|
| `append`（默认） | 以「名称 + 地址」为唯一键，已存在则**跳过** |
| `merge` | 已存在则**更新**为新的规则 |
| `replace` | **清空**现有书源后导入 |

### 书源语法支持

完整实现阅读 3.0 的规则语法：

| 语法 | 说明 |
|---|---|
| `class.x` `id.x` `tag.x` | 类名 / ID / 标签选择器 |
| `css:.a > .b` | 原生 CSS 选择器（支持 `>` `+` `~` 组合器与 `:eq()` `:first-child` `:not()` `:contains()` 等伪类） |
| `@` 链式步骤 | `class.book-list@tag.li@tag.a@href` |
| `text` `textNodes` `ownText` `html` `all` | 取值步骤 |
| `href` `src` `data-src` `content` … | 取属性，**自动补全为绝对地址** |
| `##正则##替换` | 正则替换；只写 `##正则` 表示删除匹配内容 |
| `[0]` `[-1]` `[0:5]` `[!0]` | 下标 / 负数下标 / 切片 / 排除 |
| `.0` `.-1` `!0` `td.-1:-2` `tr!0:-1` | 同上的**省略方括号**写法（真实书源里大量使用） |
| `!` `-` 前缀 | 排除 / 反转结果 |
| `\|\|` `&&` `%%` | 或 / 与 / 交叉合并 |
| `{{ JS 表达式 }}` | 内嵌 JS（含 `java.ajax` / `java.base64Decode` / `java.md5Encode` / `java.timeFormat` 等兼容实现） |
| `@js:` `<js>…</js>` | 该步骤由 JS 计算；`<js>` 块作为独立步骤，可用来预处理 HTML 后再选择 |
| `@get:{k}` `@put:{k:"规则"}` | 规则变量：`@put` 暂存（本步骤返回值不变），`@get` 取回 |
| `$` `$.data.list[*]` | **JSONPath**（现代 JSON 接口书源），支持通配、递归下降 `..`、过滤器 `[?(@.x=="y")]` |
| URL 选项 | `/search,{"method":"POST","body":"q={{key}}","charset":"gbk"}`（JSON 选项可跨行） |
| URL 动态计算 | `searchUrl` / `header` 可以是 `@js:` 或 `<js>`，运行时算出地址与请求头 |
| `org.jsoup` | JS 沙箱内可用 `org.jsoup.Jsoup.parse(html).select(...).attr(...)` |
| `cookie` | JS 里可 `cookie.getCookie/setCookie/removeCookie(url)`，也能当字符串用（`{{cookie}}`） |
| `source.*` | `source.key` / `source.name` / `source.getKey()` 等属性与方法均可 |

**自动处理**：GBK / GB2312 / GB18030 / Big5 编码嗅探（含无 charset 声明的站点）、**搜索关键字按站点编码发送**（GBK 站用 UTF-8 发关键字会一条都搜不到）、Cookie 会话保持、相对地址补全、URL 路径中的 `{{key}}` 模板、分页目录（`nextTocUrl`）、分页正文（`nextContentUrl`）、正文广告清洗、按站点限速。

### 书源排错

- 书源管理页每条都有 **测试** 按钮：显示耗时、命中条数、3 条样例、错误原因
- `GET /api/logs` 有最近 500 条运行日志
- `docker logs shuhai` 看服务端错误

### 搜索范围与结果展示

- **只显示书名/作者**：搜索结果默认「聚合去重」——同一本书只出现一条，
  卡片上只有封面、书名、作者和「N 个源」徽标；各书源的写法差异（`作者：天蚕土豆` /
  `天蚕土豆 著` / `《斗破苍穹》` / `斗破 苍穹`）都会被归一化后合并
- **换源由你决定**：多来源的书点「换源（N）」自己挑一个，不会被自动替换
- **书源范围筛选**：搜索栏旁边的「书源范围」可以勾选这次搜索用哪些书源
  （按分组展示，支持 全部启用 / 全选 / 清空 / 反选 / 仅体检可用 / 排除体检失效）。
  书源越多搜得越慢，只勾常用的几个能快很多
- **精确 / 模糊**：「匹配方式」选**精确**时只保留书名或作者与关键词完全一致的条目
  （搜「斗破苍穹」不会混进「斗破苍穹之秋雨」）；**模糊**是默认，按相关度排序

### 手机端适配

- 书源页在窄屏下改为纵向堆叠：勾选框 + 书名 + 操作按钮分行，**不会有横向滚动**
- 勾选框、开关、徽标按钮、滑块、输入框在移动端统一放大到适合手指点按的尺寸
- 底部导航、抽屉、弹窗在移动端自动切换为底部弹出式

### 坏记录自愈

- 书籍的目录地址若是无效值（早期书源规则 bug 可能写入 `["('/b/1.html', '', '')"]` 这类脏数据），
  打开时会**自动回源刷新一次**，修好后再读
- 目录拉取失败时会自动刷新书籍信息重试一次；仍失败则给出「刷新目录 / 重新搜索这本书 / 换源」的出口，
  而不是只丢一个 `HTTP 404 Not Found`

### 书源体检与批量清理

书源导入多了以后，最大的痛点是「哪些还能用」。书源管理页为此提供了一整套体检能力：

**1. 批量选择**

- 工具栏 **全选** 勾选当前已加载的一页；批量栏里的 **选中全部 N 个** 会把当前筛选条件下的书源全都选上（跨页，含未加载的页）
- 筛选条件（关键字 / 分组 / 启用状态 / 体检结果）与「全量体检」「清理失效」的范围完全一致，**所见即所测**

**2. 批量测试（体检）**

- 批量栏 **批量测试**：对选中的书源逐个真实搜一次，弹窗里用进度条 + 逐行结果实时显示（SSE 推送，`GET /api/sources/test-batch/stream`）
- 工具栏 **全量体检**：对整个筛选范围做同样的事
- 判定口径：用关键字（默认「斗破苍穹」）搜索，**命中 ≥1 条即「可用」，否则「失效」**，并记录耗时、命中条数、失败原因
- 结果写回数据库，列表上每条书源会显示 `可用 N 条 / 失效 / 未测试` 徽标，点徽标可看详情并当场重测
- 顶部实时统计：`共 N 个书源 · 可用 X · 失效 Y · 未测试 Z`

**3. 一键删除失效书源**

- 体检完成后，弹窗里直接给 **删除失效的 N 个** 按钮；确认后只删本次体检失败的
- 工具栏 **清理失效** 是全局入口，两种模式可选：
  - **直接删除已知失效的 N 个**：按上一次体检结果立刻清理，速度快
  - **先重新体检一遍，再删除失效的**：能发现「上次还活着、现在已经挂了」的源，耗时更长
- ⚠️ **安全边界**：只删除「体检过 **且** 失败」的书源（`last_test_at > 0 && last_test_ok = 0`）。
  **从未体检过的书源永远不会被删**，刚导入还没来得及测的源不会被误伤；筛选命中 0 个时一个都不删

等价命令行用法（适合挂定时任务）：

```bash
# 全量体检（同步返回结果）
curl -X POST http://localhost:8080/api/sources/test-batch -H 'Content-Type: application/json' \
  -d '{"keyword":"斗破苍穹","concurrency":6}'

# 只体检「已启用」的书源
curl -X POST http://localhost:8080/api/sources/test-batch -H 'Content-Type: application/json' \
  -d '{"enabled":"1"}'

# 一键清理：先重新体检再删失效
curl -X POST http://localhost:8080/api/sources/delete-invalid -H 'Content-Type: application/json' \
  -d '{"retest":true,"enabled":"1"}'
```

定时任务示例（每周一凌晨 4 点体检并清理已启用的失效源）：

```bash
0 4 * * 1 curl -s -X POST http://127.0.0.1:8080/api/sources/delete-invalid \
  -H 'Content-Type: application/json' -d '{"retest":true,"enabled":"1"}' >> /var/log/shuhai-health.log 2>&1
```

---

## 阅读器

### 字体与背景

- **主题**：默认白 / 羊皮纸 / 护眼绿 / 夜间灰 / 纯黑 OLED / 深蓝夜读 / 牛皮纸 / 淡蓝
- **自定义**：背景色、文字色、背景图 URL + 不透明度、亮度滑块
- **字体**：字体族（含自定义输入）、字号 12–40、字重 300–700、行高 1.2–3.0、字间距 0–5px

### 自适应排版

- `layoutMode: auto` —— 正文列宽 `min(100%, pageWidth)` 自动居中收缩
- `fontScaleWithWidth` —— 视口变小时字号按比例跟随
- 首行缩进、段间距、两端对齐/左对齐
- 窗口缩放、屏幕旋转、折叠屏展开都会实时重排并**保持阅读位置**

### 翻页与操作

| 模式 | 说明 |
|---|---|
| `scroll` | 上下滚动（连续阅读） |
| `slide` | 左右滑动翻页 |
| `cover` | 仿真覆盖翻页 |
| `none` | 无动画瞬切 |
| `vertical` | 上下翻页 |

- **点击翻页**：左 1/3 上一页 / 右 1/3 下一页 / 中间呼出菜单（可切换为「上下半屏」或关闭）
- **手势**：左右滑动、上下滑动翻页，与点击自动区分
- **快捷键**：`←` `→` 翻页 · `↑` `↓` 滚动/翻章 · `空格` 下一页 · `T` 目录 · `S` 设置 · `B` 书签 · `[` `]` 调字号 · `F` 全屏 · `Esc` 关闭面板 · `?` 帮助

### 其他

书架分组 · 阅读进度自动保存（翻章立即存 + 每 5 秒存 + 关页面 sendBeacon 兜底）· 目录（几千章分块渲染 + 标题搜索 + 正倒序）· 章节预加载 · **换源**（自动匹配同名书、保留进度百分比）· 整本离线缓存 · 书签 · 选中文字高亮/写笔记 · 简繁转换 · 自动阅读 · 阅读时长统计 · 榜单分类发现

---

## 配置项

全部通过环境变量配置（compose 里已带注释）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SHUHAI_PORT` | `8080` | 监听端口 |
| `SHUHAI_HOST` | `0.0.0.0` | 监听地址 |
| `SHUHAI_DB` | `/data/shuhai.db` | SQLite 数据库路径 |
| `PUID` / `PGID` | `1000` / `1000` | 数据目录属主，**NAS 部署必调**（`id -u` 查看自己的 uid） |
| `SHUHAI_SEARCH_CONCURRENCY` | `16` | 并发搜索的书源数，调大更快但更容易触发风控 |
| `SHUHAI_TIMEOUT` | `15000` | 单书源请求超时（毫秒） |
| `SHUHAI_HOST_INTERVAL_MS` | `120` | 同一站点最小请求间隔（毫秒），**降低被封风险** |
| `SHUHAI_MAX_TOC_PAGES` | `30` | 目录最大翻页数 |
| `SHUHAI_MAX_CONTENT_PAGES` | `6` | 单章正文最大翻页数 |
| `SHUHAI_JS_TIMEOUT` | `3000` | 书源内嵌 JS 执行超时（毫秒） |
| `SHUHAI_JS_MAX_AJAX` | `8` | 单次 JS 求值最多预取几个地址 |
| `SHUHAI_LOG_SIZE` | `500` | 内存日志条数 |

---

## REST API

完整契约见 **[docs/API.md](docs/API.md)**。所有接口以 `/api` 为前缀，统一返回 `{ok:true,data}` 或 `{ok:false,error:{code,message}}`。

```bash
# 健康检查
curl http://localhost:8080/api/health

# 导入书源
curl -X POST http://localhost:8080/api/sources/import \
  -H 'Content-Type: application/json' \
  -d '{"text":"[{\"bookSourceName\":\"示例\",\"bookSourceUrl\":\"https://example.com\",\"searchUrl\":\"/search?q={{key}}\"}]","mode":"append"}'

# 按书名搜索
curl 'http://localhost:8080/api/search?q=斗破苍穹&type=name'

# 按作者搜索
curl 'http://localhost:8080/api/search?q=天蚕土豆&type=author'

# 流式搜索（SSE）
curl -N 'http://localhost:8080/api/search/stream?q=斗破'
```

主要接口一览：

| 分组 | 接口 |
|---|---|
| 系统 | `/api/health` `/api/stats` `/api/logs` |
| 书源 | `/api/sources`(增删改查) `/import` `/import-url` `/export` `/test` `/preview` `/batch` `/groups` |
| 搜索 | `/api/search` `/api/search/stream` `/api/search/history` `/api/search/hot` `/api/sources/:id/search` |
| 书籍 | `/api/books/resolve` `/api/books/:id` `/chapters` `/content` `/cache` `/search` `/alternatives` `/change-source` |
| 书架 | `/api/shelf`(增删改查) |
| 进度 | `GET/PUT/POST /api/progress/:bookId`（POST 是给 `sendBeacon` 用的别名） |
| 书签 | `/api/bookmarks` `/api/notes` |
| 设置 | `/api/settings` `/api/settings/presets` |

---

## 架构与实现

```
src/
├── server.mjs        HTTP 服务、静态资源、SPA 回退、优雅退出
├── api.mjs           REST 路由（46 个接口）
├── db.mjs            SQLite（Node 内置 node:sqlite），WAL 模式
├── store.mjs         书籍/目录/正文缓存/书架/进度/书签 数据层
├── settings.mjs      阅读设置默认值与主题预设
├── source.mjs        书源归一化、导入导出、校验
├── engine.mjs        搜索 / 详情 / 目录 / 正文 / 换源 / 榜单（网络编排）
├── rule.mjs          ★ legado 规则引擎（@ ## {{}} %% && ||）
├── jsonpath.mjs      ★ JSONPath 子集
├── jsbox.mjs         ★ 书源 JS 沙箱 + java.* 兼容层
├── content.mjs       正文清洗（块级还原 + 广告过滤）
├── log.mjs           内存环形日志
├── html/
│   ├── parser.mjs    ★ 容错 HTML 解析器（零依赖）
│   └── selector.mjs  ★ CSS 选择器引擎（零依赖）
└── net/http.mjs      HTTP 客户端（编码嗅探 / Cookie 罐 / 限速 / 重试）

web/                  纯静态前端（原生 ES Module，无构建步骤）
├── index.html
├── css/style.css
└── js/  api · store · ui · main
      page-search · page-sources · page-shelf · page-book · page-settings
      reader · reader-settings · reader-pager

docs/API.md           冻结的接口契约
test/                 4 套测试 + 模拟站点 + 第三方书源夹具
```

### 几个值得一提的设计

**1. 零第三方依赖。** HTML 解析器、CSS 选择器引擎、JSONPath、SQLite 访问全部用 Node 标准库实现。带来的好处：镜像小、构建几秒、可完全离线构建、没有供应链风险、没有版本冲突。

**2. 同步 `java.ajax` 的「两遍求值」。** 阅读书源里的 JS 大量使用**同步**的 `java.ajax(url)`，而 Node 的网络请求是异步的。这里的做法是：第一遍用一个只记录 URL、返回空串的假 ajax 跑一遍表达式，收集所有要请求的地址；并发取回后放进缓存；第二遍用同步读缓存的真 ajax 再跑一遍。对绝大多数真实书源完全等价。

**3. Jsoup 兼容的选择器语义。** 规则的每一步在选择后代时会**包含元素自身**（与阅读 APP 行为一致），这保证了第三方书源的兼容性。

**4. 正文清洗的保守原则。** 广告行规则只匹配「明显是站点广告」的短行（长度 > 80 字符一律放行），宁可漏删也不误删正文。

---

## 测试

```bash
npm test                 # 全部 4 套，共 142 项断言
npm run test:unit        # 解析器/选择器 + 规则引擎（67 项）
npm run test:e2e         # 端到端，自带模拟站点（48 项）
npm run test:fixtures    # 第三方书源夹具联调（27 项）

npm run mock             # 单独启动模拟小说站（127.0.0.1:18080）
bash test/demo.sh        # 真机演示：起服务+模拟站点，导入书源并跑完整阅读链路
```

| 套件 | 覆盖内容 |
|---|---|
| `test/unit-parser.mjs` | HTML 解析容错、隐式闭合、实体解码、CSS 选择器、10k 节点性能 |
| `test/unit-rule.mjs` | 规则语法全量：步骤、下标、正则、JS、JSONPath、模板渲染 |
| `test/e2e.mjs` | 导入 → 搜索 → 榜单 → 落地 → 目录 → 正文 → 书架/进度/书签 → 缓存 → 换源 → 导出 → GBK → 错误处理 |
| `test/fixtures-e2e.mjs` | 用**独立编写**的第三方书源 JSON 驱动真实 HTTP 链路，交叉验证规则引擎 |

---

## 已知限制

诚实说明，避免踩坑：

1. **XPath 不支持。** 遇到 `@xpath:` 规则会降级为 CSS 选择器尝试，并在日志里告警。绝大多数 3.0 书源不使用 XPath。
2. **需要 WebView 的书源不支持。** 规则里 `webView:true` 或依赖 `loginCheckJs` 图形验证的源无法工作（服务端没有浏览器）。
3. **JS 沙箱不是安全边界。** 见下方[安全须知](#安全须知)。
4. **榜单覆盖有限。** `exploreUrl` 形态差异极大，只支持 JSON 数组与「标题::地址」两种格式；源不支持就返回空。
5. **简繁转换是字符级映射**，不是词组级（「头发」不会被误转，但个别词组可能不理想）。
6. **单用户设计。** 没有账号体系，API 无鉴权，**不要直接暴露到公网**。
7. **阅读进度不做多端实时同步**，但有服务端存储，多设备打开同一本书会读到同一进度。

---

## 安全须知

> ⚠️ **请只在可信内网部署，不要暴露到公网。**

原因：书源里的 `{{ }}` 与 `@js:` 表达式会在服务端执行 JavaScript。这是兼容阅读书源的必要代价（阅读 APP 同样如此）。本项目用 `node:vm` 新建上下文执行，沙箱内不存在 `process` / `require` / `global`，并带 3 秒执行超时；但 `vm` **不是**真正的安全边界。

实践建议：

- 只导入来源可信的书源（自己导出、知名社区分享），不要导入来路不明的 JSON
- 用 Docker 隔离运行（默认已经这么做了）
- 不要给它挂载敏感目录、不要给它过大的权限
- 如需公网访问，请放在反向代理 + 身份认证之后

---

## 常见问题

**Q：搜索很慢 / 有书源一直失败？**
每个源都有独立超时（默认 15 秒），慢的源不会阻塞其它源 —— 搜索页是流式返回的，先出来的先显示。可以在配置里调低 `SHUHAI_TIMEOUT`，并去「书源管理」把长期失败的源禁用掉。

**Q：提示「疑似被站点风控拦截」？**
说明对方站点在挡你的服务器 IP。可以调大 `SHUHAI_HOST_INTERVAL_MS`、调小 `SHUHAI_SEARCH_CONCURRENCY`；如果是 Cloudflare 盾，通常无解，换源即可。

**Q：容器起来了但数据库写入失败？**
数据目录属主不对。在宿主机执行 `chown -R 1000:1000 ./data`，或在 compose 里设置 `PUID`/`PGID` 为 `id -u`/`id -g` 的值。容器入口脚本会尝试自动修正，但某些 NAS 文件系统不允许。

**Q：怎么备份？**
拷贝 `./data` 目录即可（含数据库、书源、书架、进度、书签）。也可以用 `GET /api/sources/export` 单独导出书源。

**Q：能导入到手机上的「阅读」APP 吗？**
可以。书源管理页勾选后点「导出」，得到的就是标准 legado 格式 JSON。

**Q：怎么更新？**
```bash
git pull && docker compose up -d --build
```
数据在 `./data`，不会丢。

---

## License

MIT
