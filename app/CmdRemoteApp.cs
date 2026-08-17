// CmdRemoteApp — desktop control app for cmd-remote.
// A single-file WinForms GUI: start/stop servers, open the control panel,
// copy the phone URL, show status. Compiled with the .NET Framework csc.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Windows.Forms;

namespace CmdRemoteApp
{
    public class MainForm : Form
    {
        private readonly string appDir;
        private readonly string token;
        private Process serverProc;
        private Process ttyProc;
        private readonly Label statusLabel;
        private readonly Button startBtn;
        private readonly Button stopBtn;
        private readonly Label urlLabel;
        private readonly System.Windows.Forms.Timer healthTimer;

        public MainForm()
        {
            appDir = Path.GetDirectoryName(Application.ExecutablePath);
            token = ReadToken();
            Text = "Cmd Remote";
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(460, 380);
            MinimumSize = new Size(420, 340);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            BackColor = Color.FromArgb(11, 13, 18);
            Font = new Font("Segoe UI", 10F);

            // Header with logo tile
            var header = new Panel { Dock = DockStyle.Top, Height = 72, BackColor = Color.FromArgb(19, 22, 29) };
            var logo = new Panel { Size = new Size(44, 44), Location = new Point(18, 14), BackColor = Color.FromArgb(139, 92, 246) };
            logo.Paint += (s, e) => {
                using (var g = logo.CreateGraphics())
                using (var br = new SolidBrush(Color.White))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    var pen = new Pen(Color.White, 4.5f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
                    g.DrawLine(pen, 12, 16, 28, 22);
                    g.DrawLine(pen, 28, 22, 12, 28);
                    g.DrawLine(pen, 16, 32, 28, 32);
                    pen.Dispose();
                }
            };
            var title = new Label { Text = "Cmd Remote", ForeColor = Color.White, Font = new Font("Segoe UI", 15F, FontStyle.Bold), AutoSize = true, Location = new Point(74, 14) };
            var sub = new Label { Text = "Command Code from your phone", ForeColor = Color.FromArgb(154, 163, 181), Font = new Font("Segoe UI", 9F), AutoSize = true, Location = new Point(74, 42) };
            header.Controls.Add(logo); header.Controls.Add(title); header.Controls.Add(sub);
            Controls.Add(header);

            // Status
            var statusText = new Label { Text = "Server status:", ForeColor = Color.FromArgb(154, 163, 181), AutoSize = true, Location = new Point(24, 92) };
            statusLabel = new Label { Text = "Unknown", ForeColor = Color.FromArgb(245, 158, 11), AutoSize = true, Location = new Point(120, 92), Font = new Font("Segoe UI", 10F, FontStyle.Bold) };
            Controls.Add(statusText); Controls.Add(statusLabel);

            // URL box
            var urlCaption = new Label { Text = "Phone URL (scan the QR in the Control Panel):", ForeColor = Color.FromArgb(154, 163, 181), AutoSize = true, Location = new Point(24, 128) };
            urlLabel = new Label { Text = "—", ForeColor = Color.White, AutoSize = false, Size = new Size(412, 54), Location = new Point(24, 152), BorderStyle = BorderStyle.FixedSingle, BackColor = Color.FromArgb(24, 27, 34), Padding = new Padding(8) };
            Controls.Add(urlCaption); Controls.Add(urlLabel);

            // Buttons
            startBtn = MakeButton("Start servers", new Point(24, 222), Color.FromArgb(139, 92, 246));
            stopBtn = MakeButton("Stop servers", new Point(168, 222), Color.FromArgb(255, 107, 129));
            var panelBtn = MakeButton("Open Control Panel", new Point(312, 222), Color.FromArgb(6, 182, 212));
            var copyBtn = MakeButton("Copy URL", new Point(24, 266), Color.FromArgb(40, 44, 54));
            var openUrlBtn = MakeButton("Open on this PC", new Point(120, 266), Color.FromArgb(40, 44, 54));
            Controls.Add(startBtn); Controls.Add(stopBtn); Controls.Add(panelBtn);
            Controls.Add(copyBtn); Controls.Add(openUrlBtn);

            startBtn.Click += (s, e) => StartServers();
            stopBtn.Click += (s, e) => StopServers();
            panelBtn.Click += (s, e) => OpenPanel();
            copyBtn.Click += (s, e) => {
                if (!string.IsNullOrEmpty(urlLabel.Text) && urlLabel.Text != "—")
                {
                    Clipboard.SetText(urlLabel.Text);
                    copyBtn.Text = "Copied!";
                    var t = new System.Windows.Forms.Timer { Interval = 1200 };
                    t.Tick += (s2, e2) => { copyBtn.Text = "Copy URL"; t.Stop(); };
                    t.Start();
                }
            };
            openUrlBtn.Click += (s, e) => {
                if (!string.IsNullOrEmpty(urlLabel.Text) && urlLabel.Text != "—")
                    Process.Start(new ProcessStartInfo(urlLabel.Text) { UseShellExecute = true });
            };

            // Health timer
            healthTimer = new System.Windows.Forms.Timer { Interval = 3000 };
            healthTimer.Tick += (s, e) => UpdateStatus();
            healthTimer.Start();

            Shown += (s, e) => { StartServers(); UpdateStatus(); };
            FormClosing += (s, e) => { healthTimer.Stop(); StopServers(); };
            UpdateStatus();
        }

        private Button MakeButton(string text, Point loc, Color color)
        {
            var b = new Button
            {
                Text = text,
                Location = loc,
                Size = new Size(140, 34),
                FlatStyle = FlatStyle.Flat,
                BackColor = color,
                ForeColor = Color.White,
                Font = new Font("Segoe UI", 9.5F, FontStyle.Bold),
                Cursor = Cursors.Hand,
            };
            b.FlatAppearance.BorderSize = 0;
            return b;
        }

        private string ReadToken()
        {
            try
            {
                var env = Path.Combine(appDir, ".env");
                if (File.Exists(env))
                {
                    foreach (var line in File.ReadAllLines(env))
                    {
                        var parts = line.Split('=');
                        if (parts.Length == 2 && parts[0].Trim() == "CMD_REMOTE_TOKEN")
                            return parts[1].Trim();
                    }
                }
            }
            catch { }
            return "";
        }

        private bool IsUp(int port)
        {
            try
            {
                using (var c = new System.Net.Sockets.TcpClient())
                {
                    var ar = c.BeginConnect("127.0.0.1", port, null, null);
                    return ar.AsyncWaitHandle.WaitOne(800) && c.Connected;
                }
            }
            catch { return false; }
        }

        private void UpdateStatus()
        {
            bool chat = IsUp(8787), tty = IsUp(8788);
            if (chat && tty) { statusLabel.Text = "Online — both servers up"; statusLabel.ForeColor = Color.FromArgb(52, 211, 153); }
            else if (chat || tty) { statusLabel.Text = "Partial (chat " + (chat ? "up" : "down") + " · tty " + (tty ? "up" : "down") + ")"; statusLabel.ForeColor = Color.FromArgb(245, 158, 11); }
            else { statusLabel.Text = "Offline"; statusLabel.ForeColor = Color.FromArgb(255, 107, 129); }
        }

        private void StartServers()
        {
            if (IsUp(8787) && IsUp(8788)) { UpdateStatus(); return; }
            var node = Path.Combine(appDir, "node.exe");
            if (!File.Exists(node)) node = "node";
            try
            {
                if (!IsUp(8787))
                    serverProc = Process.Start(new ProcessStartInfo(node, "server.js") { WorkingDirectory = appDir, UseShellExecute = false, CreateNoWindow = true });
                if (!IsUp(8788))
                    ttyProc = Process.Start(new ProcessStartInfo(node, "tty-server.mjs") { WorkingDirectory = appDir, UseShellExecute = false, CreateNoWindow = true });
                System.Threading.Thread.Sleep(1500);
                UpdateStatus();
            }
            catch (Exception ex)
            {
                statusLabel.Text = "Error: " + ex.Message;
                statusLabel.ForeColor = Color.FromArgb(255, 107, 129);
            }
        }

        private void StopServers()
        {
            foreach (var p in new[] { serverProc, ttyProc })
            {
                try { if (p != null && !p.HasExited) p.Kill(); } catch { }
            }
            serverProc = null; ttyProc = null;
            UpdateStatus();
        }

        private void OpenPanel()
        {
            var url = "http://localhost:8787/panel" + (token.Length > 0 ? "?token=" + token : "");
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
            catch { }
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            // Compute the phone URL (tailnet IP or LAN) and show it.
            try
            {
                using (var wc = new WebClient())
                {
                    var json = wc.DownloadString("http://localhost:8787/api/panel?mode=auto");
                    // Minimal parse: grab "browserUrl" from best payload.
                    var i = json.IndexOf("\"browserUrl\":\"");
                    if (i >= 0)
                    {
                        var start = i + "\"browserUrl\":\"".Length;
                        var end = json.IndexOf("\"", start);
                        if (end > start) urlLabel.Text = json.Substring(start, end - start);
                    }
                }
            }
            catch { urlLabel.Text = "http://localhost:8788/?token=" + token; }
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
