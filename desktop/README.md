# 书海 · Windows 桌面版打包

把「书海」这个零依赖的 Node 服务打包成一个**绿色免安装的 Windows 软件**：整个文件夹拷到任何一台 Windows 10/11 电脑，双击 `书海.exe` 就能用，目标机器**不需要安装 Node**。

## 目录内容

| 文件 | 说明 |
|---|---|
| `build.ps1` | 打包脚本：组装运行时、编译启动器、生成配置和说明 |
| `ShuHaiLauncher.cs` | 托盘启动器源码（C# / WinForms，编译目标 .NET Framework 4.x） |
| `make-icon.ps1` | 用 System.Drawing 现画多尺寸 `.ico`，不依赖任何设计素材 |
| `重新打包.bat` | 双击即重新打包 |
| `app-preview.png` | 图标预览 |

## 用法

```powershell
# 默认：源码取仓库根目录（本目录的上一级），产物写到 <仓库根>\dist\书海
powershell -ExecutionPolicy Bypass -File build.ps1

# 连现有书源数据一起打包（默认不带，保护你的书源和阅读记录）
powershell -ExecutionPolicy Bypass -File build.ps1 -WithData

# 自定义路径
powershell -ExecutionPolicy Bypass -File build.ps1 -SourceDir D:\shuhai -OutDir D:\out\书海
```

前置条件：Windows 10/11；本机装有 Node ≥ 22.5（脚本会把 `node.exe` 复制进包里）。用到的 C# 编译器是 Windows 自带的 `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，无需额外安装。

重复执行是安全的：只重建 `app/` 和 `runtime/`，**`data/` 和 `config.ini` 永远保留**，`config.ini` 里新增的配置项会自动补写进去。

## 产物结构

```
书海/
  书海.exe          启动器：托盘图标、拉起服务、打开独立窗口
  调试模式.bat      带命令行窗口启动，排错用
  config.ini        端口、监听地址、窗口形式等
  使用说明.txt      给最终用户看的说明
  app/              服务与网页（src + web + package.json）
  runtime/node.exe  内置 Node 运行时
  data/             SQLite 数据库 + 日志 + 浏览器配置，全部就地保存
```

## 启动器的行为

- **独立窗口**：用系统自带的 Edge（或 Chrome）以 `--app=` 应用模式打开，没有标签页和地址栏，任务栏上是单独一个图标；用程序自带的 `data/browser-profile` 配置目录，与用户日常浏览器完全隔离。找不到 Chromium 内核浏览器时退回默认浏览器开标签页，功能不变。
- **单实例**：重复双击只会把已有窗口叫到前面，不会起第二个服务。
- **关窗即退**：关掉窗口，服务和托盘一起退出（`config.ini` 里 `close_action=tray` 可改成留在托盘后台）。
- 托盘右键：打开书海 / 在浏览器中打开 / 打开数据文件夹 / 查看运行日志 / 修改配置 / 查看使用说明 / 创建桌面快捷方式 / 开机自动启动 / 退出。
- 端口被占用时自动往后找空闲端口；默认只监听 `127.0.0.1`，不触发防火墙弹窗。

## 一个实现上的坑

判断「用户是不是把窗口关了」不能盯进程：Edge 会在窗口打开约 40 秒后把自己那个进程退出、把窗口交接给别的进程，照着进程判活会把还在用的软件误杀。

所以启动器**认窗口不认进程**：每 2 秒枚举一次顶层窗口，按「标题含『书海』且属于 Edge/Chrome 进程」认亲（页面里每一处 `document.title` 都带「书海」），连续两次看不到才判定关闭。
