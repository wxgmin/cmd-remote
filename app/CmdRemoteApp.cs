// CmdRemoteApp v2 â€” desktop control app for cmd-remote.
// Native WinForms GUI: Home tab (status, start/stop, help) + embedded
// Control Panel tab (WebBrowser hosting /panel?token=...).
// Fixes the Unauthorized issue: the app owns the servers + token.
// Compiled with the .NET Framework csc (C# 5 compatible).
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Text;
using System.Windows.Forms;

namespace CmdRemoteApp
{
    public class MainForm : Form
    {
        // --- Theme (light-first, one blue accent) ---
        private static readonly Color Accent = Color.FromArgb(37, 99, 235);
        private static readonly Color Green = Color.FromArgb(22, 163, 74);
        private static readonly Color Red = Color.FromArgb(220, 38, 38);
        private static readonly Color Amber = Color.FromArgb(217, 119, 6);
        private static readonly Color LightBg = Color.FromArgb(250, 250, 250);
        private static readonly Color LightPanel = Color.White;
        private static readonly Color LightText = Color.FromArgb(17, 24, 39);
        private static readonly Color LightMuted = Color.FromArgb(107, 114, 128);
        private static readonly Color LightBorder = Color.FromArgb(229, 231, 235);
        private static readonly Color DarkBg = Color.FromArgb(15, 17, 21);
        private static readonly Color DarkPanel = Color.FromArgb(23, 26, 33);
        private static readonly Color DarkText = Color.FromArgb(230, 233, 239);
        private static readonly Color DarkMuted = Color.FromArgb(154, 163, 181);
        private static readonly Color DarkBorder = Color.FromArgb(38, 43, 54);

        private bool darkMode = false;

        // --- State ---
        private readonly string appDir;
        private string token = "";
        private Process serverProc;
        private Process ttyProc;
        private readonly Label statusLabel;
        private readonly Label detailLabel;
        private readonly Label urlLabel;
        private readonly Label helpLabel;
        private readonly Button startBtn;
        private readonly Button stopBtn;
        private readonly TabControl tabs;
        private readonly WebBrowser panelBrowser;
        private readonly System.Windows.Forms.Timer healthTimer;
        private readonly Button themeBtn;
        private readonly Button copyBtn;

        public MainForm()
        {
            appDir = Path.GetDirectoryName(Application.ExecutablePath) ?? ".";
            Text = "Cmd Remote";
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(760, 600);
            MinimumSize = new Size(680, 520);
            BackColor = LightBg;
            Font = new Font("Segoe UI", 10F);

            // ---- Header (dark, brand) ----
            var header = new Panel { Dock = DockStyle.Top, Height = 64, BackColor = DarkPanel };
            var logo = new Panel { Size = new Size(40, 40), Location = new Point(16, 12), BackColor = Accent };
            logo.Paint += (s, e) => DrawLogo(logo, e.Graphics);
            var title = new Label { Text = "Cmd Remote", ForeColor = Color.White, Font = new Font("Segoe UI", 14F, FontStyle.Bold), AutoSize = true, Location = new Point(68, 10) };
            var sub = new Label { Text = "Command Code from your phone", ForeColor = Color.FromArgb(200, 205, 215), Font = new Font("Segoe UI", 9F), AutoSize = true, Location = new Point(68, 36) };
            themeBtn = new Button { Text = "Dark", FlatStyle = FlatStyle.Flat, BackColor = DarkPanel, ForeColor = Color.White, Size = new Size(70, 28), Location = new Point(ClientSize.Width - 86, 18), Anchor = AnchorStyles.Top | AnchorStyles.Right, Cursor = Cursors.Hand };
            themeBtn.FlatAppearance.BorderColor = DarkBorder;
            themeBtn.Click += (s, e) => ToggleTheme();
            header.Controls.Add(logo); header.Controls.Add(title); header.Controls.Add(sub); header.Controls.Add(themeBtn);
            Controls.Add(header);

            // ---- Tabs ----
            tabs = new TabControl { Dock = DockStyle.Fill };
            tabs.Padding = new Point(18, 6);

            // Home tab
            var home = new TabPage("Home");
            var hp = new Panel { Dock = DockStyle.Fill, AutoScroll = true, Padding = new Padding(28) };

            statusLabel = new Label { Text = "Checkingâ€¦", Font = new Font("Segoe UI", 16F, FontStyle.Bold), AutoSize = false, Location = new Point(0, 8), Size = new Size(640, 30), ForeColor = LightText };
            detailLabel = new Label { Text = "", Font = new Font("Segoe UI", 11F), AutoSize = false, Location = new Point(0, 42), Size = new Size(640, 24), ForeColor = LightMuted };
            urlLabel = new Label { Text = "â€”", Font = new Font("Consolas", 10.5F), AutoSize = false, Location = new Point(0, 84), Size = new Size(640, 52), BorderStyle = BorderStyle.FixedSingle, BackColor = LightPanel, ForeColor = LightText, Padding = new Padding(10) };

            startBtn = MakeButton("Start servers", new Point(0, 158), Accent, Color.White);
            stopBtn = MakeButton("Stop servers", new Point(130, 158), Red, Color.White);
            var panelBtn = MakeButton("Control Panel tab", new Point(260, 158), Color.FromArgb(30, 41, 59), Color.White);
            copyBtn = MakeButton("Copy URL", new Point(0, 202), Color.FromArgb(229, 231, 235), LightText);
            var openBtn = MakeButton("Open in browser", new Point(110, 202), Color.FromArgb(229, 231, 235), LightText);

            helpLabel = new Label
            {
                Text = "How to connect from your phone\n\n" +
                       "1. Make sure the status above says Online â€” this app runs the servers for you.\n" +
                       "2. On your phone, open the Cmd Remote app (or the browser).\n" +
                       "3. In the Control Panel tab, scan the QR code with the phone app â€” it connects automatically.\n" +
                       "4. Away from home? Use the Tailscale button in the Control Panel to enable anywhere access.\n\n" +
                       "No QR? Type the server address and token from the Control Panel into the phone app manually.",
                Font = new Font("Segoe UI", 10.5F),
                AutoSize = false, Location = new Point(0, 260), Size = new Size(640, 220),
                ForeColor = LightMuted,
            };

            hp.Controls.Add(statusLabel);
            hp.Controls.Add(detailLabel);
            hp.Controls.Add(urlLabel);
            hp.Controls.Add(startBtn);
            hp.Controls.Add(stopBtn);
            hp.Controls.Add(panelBtn);
            hp.Controls.Add(copyBtn);
            hp.Controls.Add(openBtn);
            hp.Controls.Add(helpLabel);
            home.Controls.Add(hp);

            // Control Panel tab (embedded browser â€” native, no external window)
            var panelPage = new TabPage("Control Panel");
            panelBrowser = new WebBrowser { Dock = DockStyle.Fill, ScrollBarsEnabled = true, ScriptErrorsSuppressed = true };
            panelPage.Controls.Add(panelBrowser);

            tabs.TabPages.Add(home);
            tabs.TabPages.Add(panelPage);
            Controls.Add(tabs);

            startBtn.Click += (s, e) => StartServers();
            stopBtn.Click += (s, e) => StopServers();
            panelBtn.Click += (s, e) => tabs.SelectedIndex = 1;
            copyBtn.Click += (s, e) =>
            {
                if (!string.IsNullOrEmpty(urlLabel.Text) && urlLabel.Text != "â€”")
                {
                    Clipboard.SetText(urlLabel.Text);
                    copyBtn.Text = "Copied!";
                    var t = new System.Windows.Forms.Timer { Interval = 1200 };
                    t.Tick += (s2, e2) => { copyBtn.Text = "Copy URL"; t.Stop(); };
                    t.Start();
                }
            };
            openBtn.Click += (s, e) =>
            {
                if (!string.IsNullOrEmpty(urlLabel.Text) && urlLabel.Text != "â€”")
                    Process.Start(new ProcessStartInfo(urlLabel.Text) { UseShellExecute = true });
            };
            tabs.SelectedIndexChanged += (s, e) => { if (tabs.SelectedIndex == 1) LoadPanel(); };

            // Health timer
            healthTimer = new System.Windows.Forms.Timer { Interval = 3000 };
            healthTimer.Tick += (s, e) => UpdateStatus();
            healthTimer.Start();

            Shown += (s, e) => { EnsureToken(); SyncServers(); UpdateStatus(); };
            FormClosing += (s, e) => { healthTimer.Stop(); StopServers(false); };
            UpdateStatus();
        }

        private void DrawLogo(Panel p, Graphics g)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var pen = new Pen(Color.White, 4f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
            g.DrawLine(pen, 11, 14, 25, 20);
            g.DrawLine(pen, 25, 20, 11, 26);
            g.DrawLine(pen, 14, 29, 26, 29);
            pen.Dispose();
        }

        private Button MakeButton(string text, Point loc, Color back, Color fore)
        {
            var b = new Button
            {
                Text = text, Location = loc, Size = new Size(120, 32),
                FlatStyle = FlatStyle.Flat, BackColor = back, ForeColor = fore,
                Font = new Font("Segoe UI", 9.5F, FontStyle.Bold), Cursor = Cursors.Hand,
            };
            b.FlatAppearance.BorderSize = 0;
            return b;
        }

        // ---- Token ownership (fixes Unauthorized) ----
        private string EnvPath { get { return Path.Combine(appDir, ".env"); } }

        private string ReadToken()
        {
            try
            {
                if (File.Exists(EnvPath))
                {
                    foreach (var line in File.ReadAllLines(EnvPath))
                    {
                        var parts = line.Split('=');
                        if (parts.Length == 2 && parts[0].Trim() == "CMD_REMOTE_TOKEN") return parts[1].Trim();
                    }
                }
            }
            catch { }
            return "";
        }

        private void EnsureToken()
        {
            if (token.Length > 0) return;
            token = ReadToken();
            if (token.Length == 0)
            {
                token = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N").Substring(0, 8);
                try
                {
                    var lines = new StringBuilder();
                    lines.AppendLine("# cmd-remote configuration");
                    lines.AppendLine("CMD_REMOTE_TOKEN=" + token);
                    File.WriteAllText(EnvPath, lines.ToString());
                }
                catch { }
            }
        }

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

        // True if servers are up AND accept our token; false on 401.
        private bool StatusWithToken()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://localhost:8787/api/status");
                req.Headers["Authorization"] = "Bearer " + token;
                req.Timeout = 2000;
                using (var resp = (HttpWebResponse)req.GetResponse())
                    return resp.StatusCode == HttpStatusCode.OK;
            }
            catch (WebException ex)
            {
                var resp = ex.Response as HttpWebResponse;
                if (resp != null && resp.StatusCode == HttpStatusCode.Unauthorized) return false;
                return true; // connection refused etc â€” the timer will surface it
            }
            catch { return true; }
        }

        // Kill node processes running our server scripts (started elsewhere with a different token).
        private void KillNodeServers()
        {
            try
            {
                foreach (var p in Process.GetProcessesByName("node"))
                {
                    try
                    {
                        using (var cmd = new Process())
                        {
                            cmd.StartInfo.FileName = "cmd.exe";
                            cmd.StartInfo.Arguments = "/c wmic process where \"ProcessId=" + p.Id + "\" get CommandLine /value";
                            cmd.StartInfo.UseShellExecute = false;
                            cmd.StartInfo.CreateNoWindow = true;
                            cmd.StartInfo.RedirectStandardOutput = true;
                            cmd.Start();
                            var cl = cmd.StandardOutput.ReadToEnd();
                            cmd.WaitForExit(3000);
                            if (cl.Contains("server.js") || cl.Contains("tty-server.mjs")) p.Kill();
                        }
                    }
                    catch { }
                }
            }
            catch { }
        }

        private void SyncServers()
        {
            bool chatUp = IsUp(8787), ttyUp = IsUp(8788);
            if (chatUp && ttyUp)
            {
                if (StatusWithToken())
                {
                    detailLabel.Text = "Servers are online and using this app's token.";
                    detailLabel.ForeColor = Green;
                    return;
                }
                detailLabel.Text = "Servers are running with a different token â€” restarting them to match this appâ€¦";
                detailLabel.ForeColor = Amber;
                KillNodeServers();
                System.Threading.Thread.Sleep(800);
            }
            StartServers();
        }

        private void StartServers()
        {
            EnsureToken();
            if (IsUp(8787) && IsUp(8788) && StatusWithToken()) { UpdateStatus(); return; }
            var node = Path.Combine(appDir, "node.exe");
            if (!File.Exists(node)) node = "node";
            try
            {
                if (!IsUp(8787))
                    serverProc = Process.Start(new ProcessStartInfo(node, "server.js") { WorkingDirectory = appDir, UseShellExecute = false, CreateNoWindow = true });
                if (!IsUp(8788))
                    ttyProc = Process.Start(new ProcessStartInfo(node, "tty-server.mjs") { WorkingDirectory = appDir, UseShellExecute = false, CreateNoWindow = true });
                System.Threading.Thread.Sleep(1800);
                UpdateStatus();
            }
            catch (Exception ex)
            {
                detailLabel.Text = "Could not start servers: " + ex.Message;
                detailLabel.ForeColor = Red;
            }
        }

        private void StopServers(bool update = true)
        {
            foreach (var p in new[] { serverProc, ttyProc })
            {
                try { if (p != null && !p.HasExited) p.Kill(); } catch { }
            }
            serverProc = null; ttyProc = null;
            if (update) UpdateStatus();
        }

        private void UpdateStatus()
        {
            bool chat = IsUp(8787), tty = IsUp(8788);
            bool auth = chat && tty && StatusWithToken();
            if (chat && tty && auth)
            {
                statusLabel.Text = "Online. Ready to connect from your phone";
                statusLabel.ForeColor = Green;
                detailLabel.Text = "Servers are running with this app's token.";
                detailLabel.ForeColor = Green;
            }
            else if (chat || tty)
            {
                statusLabel.Text = "Partial (chat " + (chat ? "up" : "down") + " / tty " + (tty ? "up" : "down") + ")";
                statusLabel.ForeColor = Amber;
                detailLabel.Text = auth ? "" : "Token mismatch detected. Servers will be restarted.";
                detailLabel.ForeColor = Amber;
            }
            else
            {
                statusLabel.Text = "Offline. Servers not running";
                statusLabel.ForeColor = Red;
                detailLabel.Text = "Click \"Start servers\" to begin.";
                detailLabel.ForeColor = LightMuted;
            }
            RefreshPhoneUrl();
        }

        // The phone URL: use the server's best host (Tailscale or LAN), never localhost.
        private void RefreshPhoneUrl()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://localhost:8787/api/panel?mode=auto");
                req.Headers["Authorization"] = "Bearer " + token;
                req.Timeout = 2500;
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(resp.GetResponseStream()))
                {
                    var json = sr.ReadToEnd();
                    var i = json.IndexOf("\"browserUrl\":\"");
                    if (i >= 0)
                    {
                        var start = i + "\"browserUrl\":\"".Length;
                        var end = json.IndexOf("\"", start);
                        if (end > start)
                        {
                            urlLabel.Text = json.Substring(start, end - start);
                            return;
                        }
                    }
                }
            }
            catch { }
            urlLabel.Text = "http://localhost:8788/?token=" + token;
        }

        private void LoadPanel()
        {
            EnsureToken();
            // Server-rendered embed page: works in the IE-based WebBrowser control.
            var url = "http://localhost:8787/panel/embed?token=" + Uri.EscapeDataString(token);
            panelBrowser.Navigate(url);
        }

        private void ToggleTheme()
        {
            darkMode = !darkMode;
            var bg = darkMode ? DarkBg : LightBg;
            var panel = darkMode ? DarkPanel : LightPanel;
            var text = darkMode ? DarkText : LightText;
            var muted = darkMode ? DarkMuted : LightMuted;
            var border = darkMode ? DarkBorder : LightBorder;

            BackColor = bg;
            tabs.BackColor = bg;
            foreach (TabPage tp in tabs.TabPages) tp.BackColor = panel;
            statusLabel.ForeColor = text;
            detailLabel.ForeColor = muted;
            urlLabel.BackColor = panel; urlLabel.ForeColor = text;
            urlLabel.BorderStyle = BorderStyle.FixedSingle;
            helpLabel.ForeColor = muted;
            copyBtn.BackColor = panel; copyBtn.ForeColor = text;
            themeBtn.Text = darkMode ? "Light" : "Dark";
            themeBtn.BackColor = panel;
            themeBtn.ForeColor = text;
            themeBtn.FlatAppearance.BorderColor = border;
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
