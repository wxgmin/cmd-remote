// CmdRemoteApp v3 - desktop app for cmd-remote.
// Clean WinForms UI: big QR code on the Home screen, auto-managed servers,
// embedded Control Panel tab. ASCII-only source (no special chars).
// Compiled with the .NET Framework csc.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace CmdRemoteApp
{
    public class MainForm : Form
    {
        // Keep the PC awake so the phone can always reach it.
        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern uint SetThreadExecutionState(uint esFlags);
        private const uint ES_CONTINUOUS = 0x80000000;
        private const uint ES_SYSTEM_REQUIRED = 0x00000001;
        private const uint ES_DISPLAY_REQUIRED = 0x00000002;

        private static readonly Color Accent = Color.FromArgb(37, 99, 235);
        private static readonly Color Green = Color.FromArgb(22, 163, 74);
        private static readonly Color Red = Color.FromArgb(220, 38, 38);
        private static readonly Color Amber = Color.FromArgb(217, 119, 6);
        private static readonly Color Bg = Color.FromArgb(250, 250, 250);
        private static readonly Color Panel = Color.White;
        private static readonly Color Fg = Color.FromArgb(17, 24, 39);
        private static readonly Color Muted = Color.FromArgb(107, 114, 128);
        private static readonly Color HeaderBg = Color.FromArgb(23, 26, 33);

        private readonly string appDir;
        private string token = "";
        private Process serverProc;
        private Process ttyProc;
        private readonly Label statusLabel;
        private readonly Label detailLabel;
        private readonly PictureBox qrBox;
        private readonly Label phoneUrlLabel;
        private readonly TabControl tabs;
        private readonly WebBrowser panelBrowser;
        private readonly System.Windows.Forms.Timer healthTimer;
        private readonly NotifyIcon trayIcon;
        private bool starting = false;
        private bool exiting = false;

        public MainForm()
        {
            appDir = Path.GetDirectoryName(Application.ExecutablePath) ?? ".";
            Text = "Cmd Remote";
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(720, 640);
            MinimumSize = new Size(680, 560);
            BackColor = Bg;
            Font = new Font("Segoe UI", 10F);

            // Keep the PC awake while this app runs (phone must always reach it).
            SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED);

            // System tray: minimize to tray, restore on double-click, Exit menu.
            trayIcon = new NotifyIcon
            {
                Icon = System.Drawing.SystemIcons.Application,
                Text = "Cmd Remote - always online",
                Visible = true,
            };
            var trayMenu = new ContextMenuStrip();
            trayMenu.Items.Add("Open Cmd Remote", null, (s, e) => RestoreFromTray());
            trayMenu.Items.Add("Check status now", null, (s, e) => SyncServers());
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add("Exit", null, (s, e) => { exiting = true; trayIcon.Visible = false; Application.Exit(); });
            trayIcon.ContextMenuStrip = trayMenu;
            trayIcon.DoubleClick += (s, e) => RestoreFromTray();
            Resize += (s, e) => { if (WindowState == FormWindowState.Minimized) HideToTray(); };
            FormClosing += (s, e) =>
            {
                if (!exiting && e.CloseReason == CloseReason.UserClosing)
                {
                    // Closing the window just hides to tray — keep serving.
                    e.Cancel = true;
                    HideToTray();
                    return;
                }
                healthTimer.Stop();
                SetThreadExecutionState(ES_CONTINUOUS);
            };

            // Auto-start with Windows so it's always available after reboot.
            EnsureAutostart();

            // Header
            var header = new Panel { Dock = DockStyle.Top, Height = 62, BackColor = HeaderBg };
            var logo = new Panel { Size = new Size(38, 38), Location = new Point(16, 12), BackColor = Accent };
            logo.Paint += (s, e) => DrawLogo(logo, e.Graphics);
            var title = new Label { Text = "Cmd Remote", ForeColor = Color.White, Font = new Font("Segoe UI", 14F, FontStyle.Bold), AutoSize = true, Location = new Point(64, 10) };
            var sub = new Label { Text = "Command Code from your phone", ForeColor = Color.FromArgb(200, 205, 215), Font = new Font("Segoe UI", 9F), AutoSize = true, Location = new Point(64, 36) };
            header.Controls.Add(logo); header.Controls.Add(title); header.Controls.Add(sub);
            Controls.Add(header);

            // Tabs
            tabs = new TabControl { Dock = DockStyle.Fill };
            tabs.Padding = new Point(16, 5);

            // ---- Home tab ----
            var home = new TabPage("Home");
            home.BackColor = Bg;
            var hp = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, Padding = new Padding(28, 20, 28, 20) };
            hp.RowCount = 6;
            hp.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));   // status
            hp.RowStyles.Add(new RowStyle(SizeType.Absolute, 26));   // detail
            hp.RowStyles.Add(new RowStyle(SizeType.Percent, 100));   // QR (grows with window)
            hp.RowStyles.Add(new RowStyle(SizeType.Absolute, 64));   // url
            hp.RowStyles.Add(new RowStyle(SizeType.Absolute, 14));   // spacer
            hp.RowStyles.Add(new RowStyle(SizeType.Absolute, 120));  // help

            statusLabel = new Label { Text = "Starting...", Font = new Font("Segoe UI", 15F, FontStyle.Bold), ForeColor = Fg, AutoSize = false, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft };
            detailLabel = new Label { Text = "", Font = new Font("Segoe UI", 10.5F), ForeColor = Muted, AutoSize = false, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true };

            qrBox = new PictureBox { Dock = DockStyle.Fill, SizeMode = PictureBoxSizeMode.Zoom, BackColor = Panel, BorderStyle = BorderStyle.FixedSingle };
            qrBox.Paint += (s, e) =>
            {
                if (qrBox.Image == null)
                {
                    var c = qrBox.ClientRectangle;
                    e.Graphics.DrawString("Loading QR code...", new Font("Segoe UI", 12F), new SolidBrush(Muted), c, new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center });
                }
            };

            phoneUrlLabel = new Label { Text = "Loading...", Font = new Font("Consolas", 10F), ForeColor = Fg, AutoSize = false, Dock = DockStyle.Fill, BorderStyle = BorderStyle.FixedSingle, BackColor = Panel, Padding = new Padding(10), TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true };

            var helpLabel = new Label
            {
                Text = "How to connect from your phone\n" +
                       "1. Keep this app running - it stays in the tray.\n" +
                       "2. On your phone, open the Cmd Remote app.\n" +
                       "3. Scan the QR code above. The app connects automatically.\n" +
                       "4. Away from home? Open the Control Panel tab and use the Tailscale button.",
                Font = new Font("Segoe UI", 10.5F),
                ForeColor = Muted,
                AutoSize = false, Dock = DockStyle.Fill,
            };

            hp.Controls.Add(statusLabel, 0, 0);
            hp.Controls.Add(detailLabel, 0, 1);
            hp.Controls.Add(qrBox, 0, 2);
            hp.Controls.Add(phoneUrlLabel, 0, 3);
            hp.Controls.Add(helpLabel, 0, 5);
            home.Controls.Add(hp);

            // ---- Control Panel tab ----
            var panelPage = new TabPage("Control Panel");
            panelPage.BackColor = Bg;
            panelBrowser = new WebBrowser { Dock = DockStyle.Fill, ScrollBarsEnabled = true, ScriptErrorsSuppressed = true };
            panelPage.Controls.Add(panelBrowser);

            tabs.TabPages.Add(home);
            tabs.TabPages.Add(panelPage);
            Controls.Add(tabs);

            tabs.SelectedIndexChanged += (s, e) => { if (tabs.SelectedIndex == 1) LoadPanel(); };

            // Auto-manage servers in the background (watchdog).
            healthTimer = new System.Windows.Forms.Timer { Interval = 4000 };
            healthTimer.Tick += (s, e) => { if (!starting && !exiting) SyncServers(); };
            healthTimer.Start();

            Shown += (s, e) => { EnsureToken(); EnsureTailscale(); SyncServers(); RefreshQr(); };
        }

        private void RestoreFromTray()
        {
            Show();
            WindowState = FormWindowState.Normal;
            BringToFront();
            Activate();
        }
        private void HideToTray()
        {
            Hide();
            if (trayIcon != null) trayIcon.ShowBalloonTip(1500, "Cmd Remote still running", "Servers stay online. Double-click the tray icon to open.", ToolTipIcon.Info);
        }

        // Register in the Startup registry so it launches at login.
        private void EnsureAutostart()
        {
            try
            {
                using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                {
                    if (key != null)
                        key.SetValue("CmdRemote", "\"" + Application.ExecutablePath + "\"");
                }
            }
            catch { }
        }

        // Bring the tailnet up if Tailscale is installed but down.
        private void EnsureTailscale()
        {
            try
            {
                var ts = @"C:\Program Files\Tailscale\tailscale.exe";
                if (!File.Exists(ts)) return;
                using (var p = Process.Start(new ProcessStartInfo(ts, "status") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true }))
                {
                    if (p != null && p.StandardOutput.ReadToEnd().Contains("stopped"))
                    {
                        Process.Start(new ProcessStartInfo(ts, "up") { UseShellExecute = false, CreateNoWindow = true });
                    }
                }
            }
            catch { }
        }

        private void DrawLogo(Panel p, Graphics g)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var pen = new Pen(Color.White, 4f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
            g.DrawLine(pen, 10, 13, 24, 19);
            g.DrawLine(pen, 24, 19, 10, 25);
            g.DrawLine(pen, 13, 28, 25, 28);
            pen.Dispose();
        }

        // ---- Token ----
        private string EnvPath { get { return Path.Combine(appDir, ".env"); } }

        private void EnsureToken()
        {
            try
            {
                if (token.Length == 0)
                {
                    if (File.Exists(EnvPath))
                    {
                        foreach (var line in File.ReadAllLines(EnvPath))
                        {
                            var parts = line.Split('=');
                            if (parts.Length == 2 && parts[0].Trim() == "CMD_REMOTE_TOKEN") { token = parts[1].Trim(); break; }
                        }
                    }
                    if (token.Length == 0)
                    {
                        token = Guid.NewGuid().ToString("N").Substring(0, 32);
                        try { File.WriteAllText(EnvPath, "# cmd-remote configuration\r\nCMD_REMOTE_TOKEN=" + token + "\r\n"); } catch { }
                    }
                }
                // Keep any dev repo .env in sync so a manually-started
                // `node server.js` from the repo uses the SAME token.
                SyncRepoEnv();
            }
            catch { }
        }

        // If a cmd-remote checkout exists near the app (or in common dev
        // locations), align its .env token with ours so both setups agree.
        // Only overwrite when the repo token is missing or the weak default
        // "change-me" — never clobber a token the user set by hand.
        private void SyncRepoEnv()
        {
            try
            {
                string[] candidates = {
                    Path.Combine(appDir, "..", "..", "cmd-remote", ".env"),          // C:\Users\Waiz\cmd-remote\.env
                    Path.Combine(appDir, "cmd-remote", ".env"),
                };
                foreach (var p in candidates)
                {
                    var full = Path.GetFullPath(p);
                    if (!File.Exists(full)) continue;
                    string[] lines;
                    try { lines = File.ReadAllLines(full); } catch { continue; }
                    string repoToken = "";
                    foreach (var line in lines)
                    {
                        if (line.StartsWith("CMD_REMOTE_TOKEN=", StringComparison.OrdinalIgnoreCase))
                        {
                            repoToken = line.Substring("CMD_REMOTE_TOKEN=".Length).Trim();
                            break;
                        }
                    }
                    // Only sync if missing, empty, or the known weak default.
                    if (repoToken.Length == 0 || repoToken == "change-me" || repoToken == "<token>")
                    {
                        bool wrote = false;
                        for (int i = 0; i < lines.Length; i++)
                        {
                            if (lines[i].StartsWith("CMD_REMOTE_TOKEN=", StringComparison.OrdinalIgnoreCase))
                            {
                                lines[i] = "CMD_REMOTE_TOKEN=" + token;
                                wrote = true;
                                break;
                            }
                        }
                        if (!wrote)
                        {
                            var list = new System.Collections.Generic.List<string>(lines);
                            list.Add("CMD_REMOTE_TOKEN=" + token);
                            lines = list.ToArray();
                        }
                        try { File.WriteAllLines(full, lines); } catch { }
                    }
                }
            }
            catch { }
        }

        // ---- Health ----
        private bool IsUp(int port)
        {
            try
            {
                using (var c = new System.Net.Sockets.TcpClient())
                {
                    var ar = c.BeginConnect("127.0.0.1", port, null, null);
                    return ar.AsyncWaitHandle.WaitOne(600) && c.Connected;
                }
            }
            catch { return false; }
        }

        private bool ServerAcceptsToken()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://localhost:8787/api/status");
                req.Headers["Authorization"] = "Bearer " + token;
                req.Timeout = 2000;
                using (var resp = (HttpWebResponse)req.GetResponse())
                    return resp.StatusCode == HttpStatusCode.OK;
            }
            catch { return false; }
        }

        private void SyncServers()
        {
            EnsureToken();
            bool chat = IsUp(8787), tty = IsUp(8788);
            if (chat && tty)
            {
                if (ServerAcceptsToken())
                {
                    SetStatus("Online", "Your phone can connect now. Scan the QR.", Green);
                    RefreshQr();
                    return;
                }
                // Servers are up but reject our token — likely started by
                // something else with a different .env. Restart them to match.
                SetStatus("Fixing connection...", "Restarting the servers to match this app.", Amber);
                KillNodeServers();
                System.Threading.Thread.Sleep(600);
            }
            else if (chat != tty)
            {
                // One server died — restart only the missing one.
                SetStatus("Restoring...", "One server stopped. Bringing it back.", Amber);
                KillNodeServers(); // restart both for consistency (shared token/env)
                System.Threading.Thread.Sleep(600);
            }
            StartServers();
        }

        private void StartServers()
        {
            starting = true;
            try
            {
                SetStatus("Starting...", "Please wait a moment.", Amber);
                var node = Path.Combine(appDir, "node.exe");
                if (!File.Exists(node)) node = "node";
                // Run the servers from the user's home so the agent works on
                // real user files (NOT the AppData install dir). WORK_DIR can
                // be overridden with an env var in .env if desired.
                var workDir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                try
                {
                    var envPath = Path.Combine(appDir, ".env");
                    if (File.Exists(envPath))
                    {
                        foreach (var line in File.ReadAllLines(envPath))
                        {
                            if (line.StartsWith("WORK_DIR=", StringComparison.OrdinalIgnoreCase))
                            {
                                var v = line.Substring("WORK_DIR=".Length).Trim().Trim('"');
                                if (v.Length > 0 && Directory.Exists(v)) workDir = v;
                                break;
                            }
                        }
                        // Persist WORK_DIR in the app's .env so the servers
                        // (and the Files page) always use the same root even
                        // when launched from the install dir.
                        var envLines = new System.Collections.Generic.List<string>(File.ReadAllLines(envPath));
                        bool hasWorkDir = false;
                        for (int i = 0; i < envLines.Count; i++)
                        {
                            if (envLines[i].StartsWith("WORK_DIR=", StringComparison.OrdinalIgnoreCase))
                            {
                                envLines[i] = "WORK_DIR=" + workDir;
                                hasWorkDir = true;
                                break;
                            }
                        }
                        if (!hasWorkDir) envLines.Add("WORK_DIR=" + workDir);
                        File.WriteAllLines(envPath, envLines.ToArray());
                    }
                }
                catch { }
                if (!IsUp(8787))
                    serverProc = Process.Start(new ProcessStartInfo(node, "\"" + Path.Combine(appDir, "server.js") + "\"") { WorkingDirectory = workDir, UseShellExecute = false, CreateNoWindow = true });
                if (!IsUp(8788))
                    ttyProc = Process.Start(new ProcessStartInfo(node, "\"" + Path.Combine(appDir, "tty-server.mjs") + "\"") { WorkingDirectory = workDir, UseShellExecute = false, CreateNoWindow = true });
                for (int i = 0; i < 10; i++)
                {
                    System.Threading.Thread.Sleep(400);
                    if (IsUp(8787) && IsUp(8788)) break;
                }
                if (IsUp(8787) && IsUp(8788) && ServerAcceptsToken())
                {
                    SetStatus("Online", "Your phone can connect now. Scan the QR.", Green);
                    RefreshQr();
                }
                else
                {
                    SetStatus("Almost there", "Servers are starting. Trying again in a few seconds...", Amber);
                }
            }
            catch (Exception ex)
            {
                SetStatus("Could not start", ex.Message, Red);
            }
            finally { starting = false; }
        }

        private void KillNodeServers()
        {
            try
            {
                // wmic is removed on Windows 11 24H2+; use Get-CimInstance.
                using (var cmd = new Process())
                {
                    cmd.StartInfo.FileName = "powershell.exe";
                    cmd.StartInfo.Arguments = "-NoProfile -Command \"Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' | Where-Object { $_.CommandLine -match 'server\\.js|tty-server\\.mjs' } | ForEach-Object { $_.ProcessId }\"";
                    cmd.StartInfo.UseShellExecute = false;
                    cmd.StartInfo.CreateNoWindow = true;
                    cmd.StartInfo.RedirectStandardOutput = true;
                    cmd.Start();
                    var output = cmd.StandardOutput.ReadToEnd();
                    cmd.WaitForExit(2000);
                    foreach (var line in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                    {
                        int pid;
                        if (int.TryParse(line.Trim(), out pid))
                        {
                            try { Process.GetProcessById(pid).Kill(); } catch { }
                        }
                    }
                }
            }
            catch { }
        }

        private void SetStatus(string main, string detail, Color color)
        {
            if (InvokeRequired) { BeginInvoke((Action)(() => SetStatus(main, detail, color))); return; }
            statusLabel.Text = main;
            statusLabel.ForeColor = color;
            detailLabel.Text = detail;
        }

        // ---- QR ----
        // The server nests the chosen connection under "best": 
        //   { best: { host, payload: { browserUrl, qrBrowser, ... } }, tailscaleIP, lan, ... }
        private void RefreshQr()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://localhost:8787/api/panel?mode=auto");
                req.Headers["Authorization"] = "Bearer " + token;
                req.Timeout = 4000;
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(resp.GetResponseStream()))
                {
                    var json = sr.ReadToEnd();
                    // The payload for the "best" host contains the QR + URL.
                    var payloadStart = json.IndexOf("\"payload\":");
                    var payloadChunk = payloadStart >= 0 ? json.Substring(payloadStart) : json;
                    var qr = FindJsonString(payloadChunk, "qrBrowser");
                    if (qr != null && qr.StartsWith("data:image/png;base64,"))
                    {
                        try
                        {
                            var img = Base64ToImage(qr.Substring("data:image/png;base64,".Length));
                            if (img != null)
                            {
                                qrBox.Image = img;
                                qrBox.Invalidate();
                            }
                        }
                        catch { }
                    }
                    var url = FindJsonString(payloadChunk, "browserUrl");
                    if (url == null) url = FindJsonString(json, "browserUrl"); // fallback
                    if (url != null) phoneUrlLabel.Text = url;
                }
            }
            catch { }
        }

        // Minimal JSON string extractor (no JSON parser dependency):
        // finds "key":"value" (with possible escaped chars) starting after key.
        private static string FindJsonString(string json, string key)
        {
            var needle = "\"" + key + "\":\"";
            var i = json.IndexOf(needle);
            if (i < 0) return null;
            var start = i + needle.Length;
            var sb = new StringBuilder();
            for (int k = start; k < json.Length; k++)
            {
                var ch = json[k];
                if (ch == '\\' && k + 1 < json.Length) { sb.Append(json[k + 1]); k++; continue; }
                if (ch == '"') break;
                sb.Append(ch);
            }
            return sb.ToString();
        }

        private static Image Base64ToImage(string b64)
        {
            var bytes = Convert.FromBase64String(b64);
            using (var ms = new MemoryStream(bytes))
            {
                return Image.FromStream(ms);
            }
        }

        private void LoadPanel()
        {
            EnsureToken();
            panelBrowser.Navigate("http://localhost:8787/panel/embed?token=" + Uri.EscapeDataString(token));
        }
    }

    public static class Program
    {
        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }
}
