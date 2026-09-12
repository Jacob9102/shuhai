/**
 * 书海 · 桌面版启动器
 *
 * 干的事很简单：把自带的 Node 运行时拉起来跑 app/src/server.mjs，
 * 等 /api/health 通了以后打开默认浏览器，右下角留一个托盘图标。
 *
 * 设计上的几个取舍：
 *  - 默认只监听 127.0.0.1，避免 Windows 防火墙弹窗；要手机/局域网访问就把 config.ini 的 host 改成 0.0.0.0
 *  - 数据全部落在程序目录的 data/ 下，整个文件夹复制走就能带走书源、书架和阅读进度
 *  - 编译目标 .NET Framework 4.x / WinForms，Windows 10、11 自带，无需额外运行库
 */

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace ShuHaiDesktop
{
    internal static class Program
    {
        private const string AppTitle = "书海";
        private const string MutexName = "ShuHaiDesktop_SingleInstance_v1";
        private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string RunValueName = "ShuHai";

        private static string rootDir;
        private static string appDir;
        private static string dataDir;
        private static string logsDir;
        private static string logPath;
        private static string configPath;
        private static string portFilePath;
        private static string nodePath;

        private static int cfgPort = 8080;
        private static string cfgHost = "127.0.0.1";
        private static bool cfgOpenBrowser = true;
        private static bool cfgAppWindow = true;   // false = 用默认浏览器开标签页
        private static bool cfgCloseToTray;        // true = 关掉窗口后继续挂在托盘
        private static int activePort;

        private static Process nodeProc;
        private static Process shellProc;          // 独立窗口所属的浏览器进程
        private static System.Windows.Forms.Timer windowWatch;
        private static bool sawAppWindow;          // 见过窗口没有（Edge 冷启动可能要几秒）
        private static int windowMissCount;        // 连续多少次没看见窗口
        private static DateTime windowGraceUntil = DateTime.MinValue;
        private static NotifyIcon tray;
        private static Mutex instanceLock;
        private static ApplicationContext appCtx;
        private static bool shuttingDown;

        private static readonly object logLock = new object();
        private static readonly List<string> recentLog = new List<string>();

        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            rootDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            appDir = Path.Combine(rootDir, "app");
            dataDir = Path.Combine(rootDir, "data");
            logsDir = Path.Combine(dataDir, "logs");
            logPath = Path.Combine(logsDir, "server.log");
            configPath = Path.Combine(rootDir, "config.ini");
            portFilePath = Path.Combine(dataDir, "running.port");
            nodePath = Path.Combine(rootDir, "runtime", "node.exe");

            try
            {
                Directory.CreateDirectory(dataDir);
                Directory.CreateDirectory(logsDir);
            }
            catch { }

            bool isFirstInstance;
            instanceLock = new Mutex(true, MutexName, out isFirstInstance);
            if (!isFirstInstance)
            {
                // 已经有一个实例在跑了：直接把浏览器指过去，不再起第二个服务
                int known = ReadPortFile();
                if (known > 0 && IsShuHai(known))
                {
                    OpenUrl(known);
                }
                else
                {
                    MessageBox.Show(
                        "书海已经在运行了。\n\n如果浏览器没打开，请双击右下角托盘里的书海图标。",
                        AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                return;
            }

            if (!File.Exists(nodePath))
            {
                Fail("运行环境不完整：找不到 " + nodePath + "\n\n请把整个「书海」文件夹一起复制，不要只拷 exe。");
                return;
            }
            if (!File.Exists(Path.Combine(appDir, "src", "server.mjs")))
            {
                Fail("运行环境不完整：找不到 " + Path.Combine(appDir, "src", "server.mjs") + "\n\n请把整个「书海」文件夹一起复制，不要只拷 exe。");
                return;
            }

            LoadConfig();
            TruncateLog();

            // 端口上已经跑着一个书海（例如用调试模式批处理启动的）→ 直接开浏览器
            if (IsShuHai(cfgPort))
            {
                if (cfgOpenBrowser) OpenFrontend(cfgPort);
                return;
            }

            int port = PickPort(cfgPort);
            if (port <= 0)
            {
                Fail("端口 " + cfgPort + " 到 " + (cfgPort + 50) + " 都被别的程序占用了。\n\n" +
                     "请关闭占用端口的程序，或编辑 config.ini 里的 port 换一个端口。");
                return;
            }

            if (!StartServer(port)) return;

            activePort = port;
            WritePortFile(port);
            CreateTray();
            if (cfgOpenBrowser) OpenFrontend(port);

            appCtx = new ApplicationContext();
            Application.Run(appCtx);

            Shutdown();
        }

        // ---------------------------------------------------------------- 配置

        private static void LoadConfig()
        {
            if (!File.Exists(configPath)) return;
            string[] lines;
            try { lines = File.ReadAllLines(configPath); }
            catch { return; }

            foreach (string raw in lines)
            {
                string line = raw.Trim();
                if (line.Length == 0 || line.StartsWith("#") || line.StartsWith(";")) continue;
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                string key = line.Substring(0, eq).Trim().ToLowerInvariant();
                string val = line.Substring(eq + 1).Trim();
                if (val.Length == 0) continue;

                if (key == "port")
                {
                    int p;
                    if (int.TryParse(val, out p) && p > 0 && p < 65536) cfgPort = p;
                }
                else if (key == "host")
                {
                    cfgHost = val;
                }
                else if (key == "open_browser")
                {
                    cfgOpenBrowser = !(val == "0" || val.Equals("false", StringComparison.OrdinalIgnoreCase) || val.Equals("no", StringComparison.OrdinalIgnoreCase));
                }
                else if (key == "window")
                {
                    cfgAppWindow = !val.Equals("browser", StringComparison.OrdinalIgnoreCase);
                }
                else if (key == "close_action")
                {
                    cfgCloseToTray = (val == "tray" || val.Equals("keep", StringComparison.OrdinalIgnoreCase));
                }
            }
        }

        // ------------------------------------------------------------ 端口工具

        private static int PickPort(int start)
        {
            for (int p = start; p <= start + 50 && p < 65536; p++)
            {
                if (IsPortFree(p)) return p;
            }
            return 0;
        }

        private static bool IsPortFree(int port)
        {
            TcpListener listener = null;
            try
            {
                listener = new TcpListener(IPAddress.Loopback, port);
                listener.Start();
                return true;
            }
            catch
            {
                return false;
            }
            finally
            {
                if (listener != null)
                {
                    try { listener.Stop(); } catch { }
                }
            }
        }

        /** 该端口上跑的是不是书海（用 /api/health 的返回体认亲） */
        private static bool IsShuHai(int port)
        {
            string body = HttpGet("http://127.0.0.1:" + port + "/api/health", 1500);
            return body != null && body.IndexOf("sourceCount", StringComparison.Ordinal) >= 0;
        }

        private static string HttpGet(string url, int timeoutMs)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "GET";
                req.Proxy = null;                        // 本机地址，绕开系统代理
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                using (StreamReader sr = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                {
                    return sr.ReadToEnd();
                }
            }
            catch
            {
                return null;
            }
        }

        private static int ReadPortFile()
        {
            try
            {
                if (!File.Exists(portFilePath)) return 0;
                int p;
                if (int.TryParse(File.ReadAllText(portFilePath).Trim(), out p)) return p;
            }
            catch { }
            return 0;
        }

        private static void WritePortFile(int port)
        {
            try { File.WriteAllText(portFilePath, port.ToString()); } catch { }
        }

        // -------------------------------------------------------------- 服务

        private static bool StartServer(int port)
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = nodePath;
            // node:sqlite 在 22.x 上会打一行实验性警告，这里关掉，日志干净点
            psi.Arguments = "--disable-warning=ExperimentalWarning src/server.mjs";
            psi.WorkingDirectory = appDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;

            try
            {
                psi.EnvironmentVariables["SHUHAI_HOST"] = cfgHost;
                psi.EnvironmentVariables["SHUHAI_PORT"] = port.ToString();
                psi.EnvironmentVariables["SHUHAI_DB"] = Path.Combine(dataDir, "shuhai.db");
                psi.EnvironmentVariables["NODE_ENV"] = "production";
                if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("TZ")))
                    psi.EnvironmentVariables["TZ"] = "Asia/Shanghai";
            }
            catch { }

            AppendLog("=== 启动书海 v" + ReadAppVersion() + " ===");
            AppendLog("运行时: " + nodePath);
            AppendLog("端口: " + cfgHost + ":" + port);
            AppendLog("数据库: " + Path.Combine(dataDir, "shuhai.db"));

            try
            {
                nodeProc = new Process();
                nodeProc.StartInfo = psi;
                nodeProc.EnableRaisingEvents = true;
                nodeProc.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (e.Data != null) AppendLog(e.Data);
                };
                nodeProc.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (e.Data != null) AppendLog(e.Data);
                };
                nodeProc.Exited += delegate { OnServerExited(); };
                nodeProc.Start();
                nodeProc.BeginOutputReadLine();
                nodeProc.BeginErrorReadLine();
            }
            catch (Exception ex)
            {
                Fail("启动失败：" + ex.Message + "\n\n日志：" + logPath);
                return false;
            }

            // 等它就绪（首次启动要建表 / 迁移数据，给到 40 秒）
            for (int i = 0; i < 80; i++)
            {
                if (IsShuHai(port)) return true;
                try { if (nodeProc.HasExited) break; }
                catch { }
                Thread.Sleep(500);
            }

            string tail = TailLog(12);
            Fail("书海服务没能启动。\n\n日志尾部：\n" + (tail.Length == 0 ? "(空)" : tail) + "\n\n完整日志：" + logPath);
            return false;
        }

        private static void OnServerExited()
        {
            if (shuttingDown) return;
            try
            {
                ThreadPool.QueueUserWorkItem(delegate
                {
                    if (shuttingDown) return;
                    MessageBox.Show(
                        "书海服务意外退出了。\n\n日志尾部：\n" + TailLog(10) + "\n\n完整日志：" + logPath,
                        AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    ExitApp();
                });
            }
            catch { }
        }

        private static void Shutdown()
        {
            shuttingDown = true;

            try { if (windowWatch != null) windowWatch.Stop(); }
            catch { }

            // 先好好关掉独立窗口（发 WM_CLOSE，别硬杀，免得留下崩溃恢复提示），再停服务
            try
            {
                if (shellProc != null && !shellProc.HasExited)
                {
                    CloseAppWindow();
                    if (!shellProc.WaitForExit(3000)) shellProc.Kill();
                }
            }
            catch { }

            try
            {
                if (nodeProc != null && !nodeProc.HasExited)
                {
                    nodeProc.Kill();
                    nodeProc.WaitForExit(4000);
                }
            }
            catch { }
            try { if (File.Exists(portFilePath)) File.Delete(portFilePath); } catch { }
            try
            {
                if (tray != null)
                {
                    tray.Visible = false;
                    tray.Dispose();
                    tray = null;
                }
            }
            catch { }
            try { if (instanceLock != null) instanceLock.ReleaseMutex(); } catch { }
        }

        private static void ExitApp()
        {
            shuttingDown = true;
            try { if (appCtx != null) appCtx.ExitThread(); } catch { }
        }

        // -------------------------------------------------------------- 托盘

        private static void CreateTray()
        {
            ContextMenuStrip menu = new ContextMenuStrip();

            ToolStripMenuItem head = new ToolStripMenuItem(AppTitle + " 正在运行 · 端口 " + activePort);
            head.Enabled = false;
            menu.Items.Add(head);
            menu.Items.Add(new ToolStripSeparator());

            ToolStripMenuItem open = new ToolStripMenuItem("打开书海", null, delegate { OpenFrontend(activePort); });
            open.Font = new Font(open.Font, FontStyle.Bold);
            menu.Items.Add(open);
            menu.Items.Add(new ToolStripMenuItem("在浏览器中打开", null, delegate { OpenUrl(activePort); }));
            menu.Items.Add(new ToolStripMenuItem("打开数据文件夹", null, delegate { OpenPath(dataDir); }));
            menu.Items.Add(new ToolStripMenuItem("查看运行日志", null, delegate { OpenPath(logPath); }));
            menu.Items.Add(new ToolStripMenuItem("修改配置(config.ini)", null, delegate { OpenPath(configPath); }));
            menu.Items.Add(new ToolStripMenuItem("查看使用说明", null, delegate { OpenPath(Path.Combine(rootDir, "使用说明.txt")); }));
            menu.Items.Add(new ToolStripSeparator());

            menu.Items.Add(new ToolStripMenuItem("创建桌面快捷方式", null, delegate { CreateDesktopShortcut(); }));

            ToolStripMenuItem autoStart = new ToolStripMenuItem("开机自动启动");
            autoStart.Checked = IsAutoStartEnabled();
            autoStart.Click += delegate
            {
                bool want = !IsAutoStartEnabled();
                SetAutoStart(want);
                autoStart.Checked = IsAutoStartEnabled();
            };
            menu.Items.Add(autoStart);

            menu.Items.Add(new ToolStripMenuItem("退出书海", null, delegate { ExitApp(); }));

            tray = new NotifyIcon();
            tray.Icon = LoadAppIcon();
            tray.Text = Clip(AppTitle + " · 端口 " + activePort, 63);
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { OpenFrontend(activePort); };
            tray.Visible = true;
            tray.BalloonTipTitle = AppTitle + " 已启动";
            tray.BalloonTipText = "浏览器里已经开始阅读；关闭本窗口不会退出，退出请右键托盘图标。";
            try { tray.ShowBalloonTip(5000); } catch { }
        }

        private static Icon LoadAppIcon()
        {
            try
            {
                Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("shuhai.ico");
                if (s != null)
                {
                    using (s) { return new Icon(s, SystemInformation.SmallIconSize); }
                }
            }
            catch { }
            try { return Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch { }
            return SystemIcons.Application;
        }

        private static bool IsAutoStartEnabled()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKeyPath, false))
                {
                    if (k == null) return false;
                    string v = k.GetValue(RunValueName) as string;
                    return !string.IsNullOrEmpty(v);
                }
            }
            catch { return false; }
        }

        private static void SetAutoStart(bool on)
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RunKeyPath))
                {
                    if (k == null) return;
                    if (on) k.SetValue(RunValueName, "\"" + Application.ExecutablePath + "\"");
                    else k.DeleteValue(RunValueName, false);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("设置开机启动失败：" + ex.Message, AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        /** 用 WScript.Shell 建快捷方式，省得为了一个 .lnk 去 P/Invoke IShellLink */
        private static void CreateDesktopShortcut()
        {
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType == null) throw new Exception("系统缺少 WScript.Shell");

                object shell = Activator.CreateInstance(shellType);
                string linkPath = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppTitle + ".lnk");

                object shortcut = shellType.InvokeMember(
                    "CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { linkPath });
                Type sc = shortcut.GetType();
                sc.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { Application.ExecutablePath });
                sc.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { rootDir });
                sc.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { Application.ExecutablePath + ",0" });
                sc.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "书海 · 全网小说搜索与阅读" });
                sc.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);

                MessageBox.Show("桌面快捷方式已创建：\n" + linkPath, AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show("创建快捷方式失败：" + ex.Message, AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        // ------------------------------------------------------------ 杂项工具

        /** 按配置决定用独立窗口还是浏览器标签页 */
        private static void OpenFrontend(int port)
        {
            if (!cfgAppWindow)
            {
                OpenUrl(port);
                return;
            }
            if (OpenAppWindow(port)) return;
            AppendLog("没找到 Edge/Chrome，退回用默认浏览器打开");
            OpenUrl(port);
        }

        /**
         * 用 Edge/Chrome 的 --app 模式开一个没有标签页、没有地址栏的独立窗口。
         * 用程序自带的 profile 目录，与用户日常浏览器的登录状态、书签完全隔离。
         */
        private static bool OpenAppWindow(int port)
        {
            // 已经开着就把它叫到前面来，不再开第二个
            if (FocusAppWindow()) return true;

            string browser = FindBrowser();
            if (browser == null) return false;

            string profile = Path.Combine(dataDir, "browser-profile");
            bool firstRun = !Directory.Exists(profile);

            StringBuilder args = new StringBuilder();
            args.Append("--app=http://127.0.0.1:").Append(port).Append("/ ");
            args.Append("--user-data-dir=\"").Append(profile).Append("\" ");
            args.Append("--no-first-run --no-default-browser-check --hide-crash-restore-bubble ");
            args.Append("--disk-cache-size=134217728 ");
            if (firstRun) args.Append("--window-size=1280,880 ");

            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(browser, args.ToString());
                psi.UseShellExecute = false;
                psi.WorkingDirectory = rootDir;
                shellProc = Process.Start(psi);
                shellProc.EnableRaisingEvents = true;
                shellProc.Exited += delegate { OnShellProcessExited(); };
                sawAppWindow = false;
                windowMissCount = 0;
                windowGraceUntil = DateTime.Now.AddSeconds(45);   // 冷启动宽限
                StartWindowWatch();
                AppendLog("独立窗口: " + browser + " (pid " + shellProc.Id + ")");
                return true;
            }
            catch (Exception ex)
            {
                AppendLog("打开独立窗口失败: " + ex.Message);
                return false;
            }
        }

        /** 找浏览器内核：Edge 优先（Windows 一定有），其次 Chrome，最后查注册表 */
        private static string FindBrowser()
        {
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pfx86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string lad = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

            List<string> candidates = new List<string>();
            string[] rel = new string[]
            {
                @"Microsoft\Edge\Application\msedge.exe",
                @"Google\Chrome\Application\chrome.exe",
            };
            foreach (string r in rel)
            {
                if (!string.IsNullOrEmpty(pfx86)) candidates.Add(Path.Combine(pfx86, r));
                if (!string.IsNullOrEmpty(pf)) candidates.Add(Path.Combine(pf, r));
                if (!string.IsNullOrEmpty(lad)) candidates.Add(Path.Combine(lad, r));
            }
            foreach (string c in candidates)
            {
                try { if (File.Exists(c)) return c; }
                catch { }
            }

            string[] exes = new string[] { "msedge.exe", "chrome.exe" };
            RegistryKey[] roots = new RegistryKey[] { Registry.CurrentUser, Registry.LocalMachine };
            foreach (RegistryKey root in roots)
            {
                foreach (string exe in exes)
                {
                    try
                    {
                        using (RegistryKey k = root.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + exe, false))
                        {
                            if (k == null) continue;
                            string v = k.GetValue(null) as string;
                            if (!string.IsNullOrEmpty(v) && File.Exists(v)) return v;
                        }
                    }
                    catch { }
                }
            }
            return null;
        }

        /**
         * 找书海的独立窗口。
         *
         * 这里认窗口不认进程：Edge 会把 --app 窗口交给别的进程，盯着自己启动的那个 pid
         * 会在窗口还开着的时候误判成已关闭。窗口标题由页面决定，index.html 和 reader.js
         * 里每一处都带「书海」，所以按标题认亲最稳。
         */
        private static IntPtr FindAppWindow(out int windowPid)
        {
            IntPtr found = IntPtr.Zero;
            int foundPid = 0;
            StringBuilder title = new StringBuilder(256);

            EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                if (!IsWindowVisible(hWnd)) return true;

                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                if (pid == 0) return true;

                title.Length = 0;
                GetWindowText(hWnd, title, title.Capacity);
                if (title.Length == 0) return true;
                if (title.ToString().IndexOf("书海", StringComparison.Ordinal) < 0) return true;
                if (!IsBrowserProcess((int)pid)) return true;

                found = hWnd;
                foundPid = (int)pid;
                return false;
            }, IntPtr.Zero);

            windowPid = foundPid;
            return found;
        }

        /** 只认浏览器进程，免得把标题里带「书海」的记事本之类误当成书海窗口 */
        private static bool IsBrowserProcess(int pid)
        {
            try
            {
                string name = Process.GetProcessById(pid).ProcessName;
                return name.Equals("msedge", StringComparison.OrdinalIgnoreCase)
                    || name.Equals("chrome", StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
        }

        private static void StartWindowWatch()
        {
            if (windowWatch != null) { windowWatch.Start(); return; }
            windowWatch = new System.Windows.Forms.Timer();
            windowWatch.Interval = 2000;
            windowWatch.Tick += delegate { WatchAppWindow(); };
            windowWatch.Start();
        }

        /** 每 2 秒看一眼窗口还在不在；连续两次没看见才算关了，避免被瞬时抖动骗到 */
        private static void WatchAppWindow()
        {
            if (shuttingDown) return;

            int pid;
            if (FindAppWindow(out pid) != IntPtr.Zero)
            {
                sawAppWindow = true;
                windowMissCount = 0;
                return;
            }

            if (!sawAppWindow)
            {
                // 还没见过窗口：冷启动可能慢，只要进程还活着就继续等
                if (DateTime.Now < windowGraceUntil) return;
                if (shellProc != null && !shellProc.HasExited) return;
                AppendLog("没等到书海窗口");
                if (!cfgCloseToTray) ExitApp();
                return;
            }

            windowMissCount++;
            if (windowMissCount >= 2)
            {
                windowMissCount = 0;
                AppendLog("独立窗口已关闭");
                if (!cfgCloseToTray) ExitApp();
            }
        }

        private static bool FocusAppWindow()
        {
            try
            {
                int pid;
                IntPtr h = FindAppWindow(out pid);
                if (h == IntPtr.Zero) return false;
                ShowWindow(h, SW_RESTORE);
                SetForegroundWindow(h);
                return true;
            }
            catch { return false; }
        }

        private static void CloseAppWindow()
        {
            try
            {
                int pid;
                IntPtr h = FindAppWindow(out pid);
                if (h != IntPtr.Zero) PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            }
            catch { }
        }

        /**
         * 自己启动的那个浏览器进程退出了。这不等于窗口关了（Edge 会做进程交接），
         * 所以这里只记日志，关窗判定统一交给 WatchAppWindow。
         */
        private static void OnShellProcessExited()
        {
            if (shuttingDown) return;
            AppendLog("浏览器主进程退出（窗口可能还在，等轮询确认）");
        }

        private static void OpenUrl(int port)
        {
            OpenPath("http://127.0.0.1:" + port + "/");
        }

        private static void OpenPath(string target)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(target);
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show("打不开 " + target + "\n\n" + ex.Message, AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private static void Fail(string message)
        {
            MessageBox.Show(message, AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        private static string Clip(string text, int max)
        {
            return text.Length <= max ? text : text.Substring(0, max);
        }

        private static void AppendLog(string line)
        {
            string stamped = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line;
            lock (logLock)
            {
                recentLog.Add(stamped);
                if (recentLog.Count > 400) recentLog.RemoveAt(0);
                try
                {
                    File.AppendAllText(logPath, stamped + Environment.NewLine, new UTF8Encoding(false));
                }
                catch { }
            }
        }

        private static string TailLog(int lines)
        {
            lock (logLock)
            {
                int start = recentLog.Count - lines;
                if (start < 0) start = 0;
                StringBuilder sb = new StringBuilder();
                for (int i = start; i < recentLog.Count; i++)
                {
                    sb.AppendLine(recentLog[i]);
                }
                return sb.ToString().TrimEnd();
            }
        }

        private static void TruncateLog()
        {
            try
            {
                FileInfo fi = new FileInfo(logPath);
                if (fi.Exists && fi.Length > 2 * 1024 * 1024) fi.Delete();
            }
            catch { }
        }

        /** 版本号以 app/package.json 为准，打日志时不用手写 */
        private static string ReadAppVersion()
        {
            try
            {
                string pkg = Path.Combine(appDir, "package.json");
                if (!File.Exists(pkg)) return "?";
                System.Text.RegularExpressions.Match m =
                    System.Text.RegularExpressions.Regex.Match(File.ReadAllText(pkg), "\"version\"\\s*:\\s*\"([^\"]+)\"");
                if (m.Success) return m.Groups[1].Value;
            }
            catch { }
            return "?";
        }

        // -------------------------------------------------- Win32（只为独立窗口服务）

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        private const int SW_RESTORE = 9;
        private const uint WM_CLOSE = 0x0010;

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int cmdShow);
        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    }
}
