# 书海 ShuHai

> 自托管的**全网小说搜索与阅读服务**。导入「阅读」(Legado) 书源，一个搜索框搜遍所有站点；自带阅读器，字体、背景、排版全部可调。
> **零第三方依赖**，只用 Node 标准库；可以 Docker 一条命令部署，也可以打包成 Windows 桌面软件。

本仓库同时存放服务本体和 Windows 桌面版的打包工具。

## 仓库结构

| 路径 | 说明 |
|---|---|
| [`阅读/阅读/`](阅读/阅读) | **服务本体**：Node 服务、网页前端、书源引擎、测试与 Docker 部署文件 |
| [`desktop/`](desktop) | **Windows 桌面版打包**：C# 托盘启动器 + 打包脚本，把整个服务做成一键运行的软件 |

> 服务本体的完整文档（书源语法、REST API、架构说明、常见问题）在 [`阅读/阅读/README.md`](阅读/阅读/README.md)。

## 快速开始

### 方式一：Docker Compose（推荐，适合 NAS / 服务器）

```bash
cd 阅读/阅读
mkdir -p data
docker compose up -d --build
# 打开 http://<你的主机IP>:8080
```

### 方式二：本机直接跑（已装 Node ≥ 22.5）

```bash
cd 阅读/阅读
npm start          # 等价于 node src/server.mjs
# 打开 http://localhost:8080
```

不需要 `npm install`——项目只用 Node 标准库，没有 `node_modules`。

### 方式三：Windows 桌面版（做成独立窗口的软件）

```powershell
cd desktop
powershell -ExecutionPolicy Bypass -File build.ps1
```

脚本会把服务、内置 Node 运行时、图标和托盘启动器组装进 `dist/书海/`，拷到任何一台 Windows 10/11 电脑双击 `书海.exe` 即可运行，目标机器**无需安装 Node**。细节见 [`desktop/README.md`](desktop/README.md)。

## 首次使用

1. 打开 **书源管理** → **导入书源**
2. 粘贴一份阅读（Legado）书源 JSON，或填网络订阅地址、选本地 `.json` 文件
3. 回到 **搜索**，输入书名或作者名

## 数据与隐私

这个仓库**不含任何书源、书架或阅读记录**：

- 所有运行数据都在各目录的 `data/` 下（一个 SQLite 库），已被 `.gitignore` 排除
- `.env` 之类的本机配置同样不入库，仓库里只保留 `.env.example`
- 测试用的书源都是 `test/fixtures/` 里指向本地 mock 站点的假数据，`npm test` 全程离线

所以 clone 下来是一个干净的、可以直接跑的空白实例，书源需要你自己导入。

## 测试

```bash
cd 阅读/阅读
npm test           # 解析器 / 规则引擎 / 端到端 / 字符集 / 模块图 全套
npm run mock       # 单独起离线 mock 站点，配合 test/fixtures 里的书源调试
```

## 许可

MIT
