using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class Theme {
    static readonly Dictionary<string, object> values;
    public static float Scale = 1;
    static Theme() {
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("theme.json"))
        using (var reader = new StreamReader(stream))
            values = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
    }
    public static int N(string name) { return Convert.ToInt32(values[name]); }
    public static int L(string name) { return Convert.ToInt32(((Dictionary<string, object>)values["layout"])[name]); }
    public static int Px(float value) { return (int)Math.Round(value * Scale); }
    public static Color C(string name) { return ColorTranslator.FromHtml((string)values[name]); }
    public static Font Font(int size, bool bold) { return new Font((string)values["font"], Px(size), bold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel); }
    public static Rectangle Box(int x, int y, int w, int h) { return new Rectangle(Px(x), Px(y), Px(w), Px(h)); }
    public static GraphicsPath Rounded(RectangleF box, float radius) {
        var path = new GraphicsPath();
        float d = Math.Min(radius * 2, Math.Min(box.Width, box.Height));
        if (d <= 0) { path.AddRectangle(box); return path; }
        path.AddArc(box.X, box.Y, d, d, 180, 90);
        path.AddArc(box.Right - d, box.Y, d, d, 270, 90);
        path.AddArc(box.Right - d, box.Bottom - d, d, d, 0, 90);
        path.AddArc(box.X, box.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }
    public static void Fill(Graphics g, RectangleF box, float radius, Color color) {
        using (var path = Rounded(box, radius)) using (var brush = new SolidBrush(color)) g.FillPath(brush, path);
    }
    public static void Text(Graphics g, string text, Rectangle box, int size, Color color, bool bold, StringAlignment align) {
        using (var font = Font(size, bold)) using (var brush = new SolidBrush(color))
        using (var format = new StringFormat { Alignment = align, LineAlignment = StringAlignment.Center, Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap })
            g.DrawString(text, font, brush, box, format);
    }
}

// One painted control owns its visual, focus, pointer and keyboard states.
sealed class ActionButton : Control {
    public bool Primary, Selected, Scope;
    public string Detail = "";
    bool hover, pressed;
    public ActionButton() {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.Selectable, true);
        SetStyle(ControlStyles.StandardClick | ControlStyles.StandardDoubleClick, false);
        TabStop = true;
        AccessibleRole = AccessibleRole.PushButton;
        Cursor = Cursors.Hand;
    }
    protected override bool IsInputKey(Keys keyData) {
        Keys key = keyData & Keys.KeyCode;
        return key == Keys.Space || key == Keys.Enter || base.IsInputKey(keyData);
    }
    protected override AccessibleObject CreateAccessibilityInstance() { return new ButtonAccessibility(this); }
    sealed class ButtonAccessibility : ControlAccessibleObject {
        readonly ActionButton button;
        public ButtonAccessibility(ActionButton owner) : base(owner) { button = owner; }
        public override AccessibleRole Role { get { return button.Scope ? AccessibleRole.RadioButton : AccessibleRole.PushButton; } }
        public override string DefaultAction { get { return button.Scope ? "选择" : "按下"; } }
        public override AccessibleStates State { get { return base.State | (button.Selected ? AccessibleStates.Checked : AccessibleStates.None); } }
        public override void DoDefaultAction() {
            if (button.Enabled && button.Visible) button.BeginInvoke(new MethodInvoker(delegate { button.OnClick(EventArgs.Empty); }));
        }
    }
    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; pressed = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { if (e.Button == MouseButtons.Left && Enabled) { pressed = true; Capture = true; Focus(); Invalidate(); } base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) {
        bool commit = pressed && Enabled && e.Button == MouseButtons.Left && ClientRectangle.Contains(e.Location);
        pressed = false; Capture = false; Invalidate(); base.OnMouseUp(e);
        if (commit) OnClick(EventArgs.Empty);
    }
    protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
    protected override void OnLostFocus(EventArgs e) { pressed = false; Invalidate(); base.OnLostFocus(e); }
    protected override void OnKeyDown(KeyEventArgs e) {
        if (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter) { pressed = true; Invalidate(); e.Handled = true; }
        base.OnKeyDown(e);
    }
    protected override void OnKeyUp(KeyEventArgs e) {
        if ((e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter) && pressed) {
            pressed = false; Invalidate(); OnClick(EventArgs.Empty); e.Handled = true;
        }
        base.OnKeyUp(e);
    }
    protected override void OnPaint(PaintEventArgs e) {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
        g.Clear(BackColor);
        var box = new RectangleF(1, 1, Width - 3, Height - 3);
        Color bg = Theme.C(Primary ? (hover || pressed ? "accentHover" : "accent") : Selected ? "accentSoft" : hover || pressed ? "soft" : "surface");
        if (!Enabled) bg = Theme.C("soft");
        Theme.Fill(g, box, Theme.Px(Theme.N("controlRadius")), bg);
        using (var path = Theme.Rounded(box, Theme.Px(Theme.N("controlRadius"))))
        using (var pen = new Pen(Theme.C(Selected || Focused ? "accent" : "border"), Theme.Px(Focused ? 2 : 1)))
            if (!Primary || Focused) g.DrawPath(pen, path);
        Color fg = Theme.C(!Enabled ? "secondary" : Primary ? "surface" : "text");
        int inset = Theme.Px(18), shift = pressed ? Theme.Px(1) : 0;
        if (Scope) {
            Theme.Text(g, Text, new Rectangle(inset, Theme.Px(8) + shift, Width - inset * 3, Theme.Px(25)), Theme.N("fontSize"), fg, true, StringAlignment.Near);
            Theme.Text(g, Detail, new Rectangle(inset, Theme.Px(34) + shift, Width - inset * 2, Theme.Px(22)), Theme.N("smallSize"), Theme.C("secondary"), false, StringAlignment.Near);
            var mark = new Rectangle(Width - Theme.Px(37), Theme.Px(15), Theme.Px(18), Theme.Px(18));
            using (var pen = new Pen(Theme.C(Selected ? "accent" : "border"), Theme.Px(1))) g.DrawEllipse(pen, mark);
            if (Selected) {
                using (var brush = new SolidBrush(Theme.C("accent"))) g.FillEllipse(brush, mark);
                using (var pen = new Pen(Theme.C("surface"), Theme.Px(1.6f))) {
                    g.DrawLines(pen, new[] { new Point(mark.X + Theme.Px(4), mark.Y + Theme.Px(9)), new Point(mark.X + Theme.Px(8), mark.Y + Theme.Px(12)), new Point(mark.X + Theme.Px(14), mark.Y + Theme.Px(6)) });
                }
            }
        } else Theme.Text(g, Text, new Rectangle(0, shift, Width, Height), Theme.N("fontSize"), fg, true, StringAlignment.Center);
    }
}

sealed class Installer : Form {
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int value, int size);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, out bool value, uint flags);
    readonly string payload, version, build;
    readonly ActionButton mine = new ActionButton(), everyone = new ActionButton(), primary = new ActionButton(), secondary = new ActionButton(), reset = new ActionButton();
    readonly ActionButton close = new ActionButton();
    readonly TextBox path = new TextBox();
    readonly Timer frames = new Timer();
    readonly Stopwatch clock = new Stopwatch();
    readonly Dictionary<Control, Rectangle> logicalBounds = new Dictionary<Control, Rectangle>();
    readonly bool motion, removing;
    readonly string removalDirectory;
    bool allUsers, running, finished;
    string error = "";
    public int Result = 2;

    public Installer(string engine, string appVersion, string buildId, string uninstallDirectory, bool machineScope) {
        payload = engine; version = appVersion; build = buildId;
        removing = uninstallDirectory.Length > 0; removalDirectory = uninstallDirectory;
        bool animations;
        motion = SystemParametersInfo(0x1042, 0, out animations, 0) && animations;
        using (var g = CreateGraphics()) Theme.Scale = g.DpiX / 96f;
        AutoScaleMode = AutoScaleMode.None;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(Theme.Px(Theme.N("width")), Theme.Px(Theme.N("height")));
        BackColor = Theme.C("background");
        Text = removing ? "卸载 Eve" : "安装 Eve";
        DoubleBuffered = true;
        try { Icon = Icon.ExtractAssociatedIcon(payload); } catch { }
        int x = Theme.L("contentX"), right = Theme.L("contentRight"), y = Theme.L("scopeY"), w = Theme.L("scopeWidth"), h = Theme.L("scopeHeight");
        SetupButton(mine, "仅为我", Theme.Box(x, y, w, h), delegate { SetScope(false); });
        SetupButton(everyone, "所有用户", Theme.Box(x + w + Theme.L("scopeGap"), y, w, h), delegate { SetScope(true); });
        mine.Scope = everyone.Scope = true;
        mine.Detail = "当前账户"; everyone.Detail = "这台电脑上的所有账户";
        path.BorderStyle = BorderStyle.None;
        path.BackColor = Theme.C("soft"); path.ForeColor = Theme.C("text");
        path.Font = Theme.Font(Theme.N("smallSize"), false);
        path.Bounds = Theme.Box(x + 14, Theme.L("pathY") + 12, Theme.L("pathWidth") - 28, Theme.L("pathHeight") - 20);
        path.AccessibleName = "安装位置";
        path.TextChanged += delegate { error = ""; Invalidate(); };
        path.KeyDown += async delegate(object sender, KeyEventArgs e) {
            if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; await InstallAsync(); }
        };
        Controls.Add(path);
        SetupButton(reset, "重置", Theme.Box(x + Theme.L("pathWidth") + Theme.L("buttonGap"), Theme.L("pathY"), right - x - Theme.L("pathWidth") - Theme.L("buttonGap"), Theme.L("pathHeight")), delegate { SetScope(allUsers); });
        SetupButton(primary, removing ? "卸载" : "安装", Theme.Box(right - Theme.L("buttonWidth"), Theme.L("footerY"), Theme.L("buttonWidth"), Theme.L("buttonHeight")), async delegate { if (finished) { if (removing) Close(); else OpenApp(); } else await InstallAsync(); });
        primary.Primary = true;
        SetupButton(secondary, "取消", Theme.Box(right - Theme.L("buttonWidth") * 2 - Theme.L("buttonGap"), Theme.L("footerY"), Theme.L("buttonWidth"), Theme.L("buttonHeight")), delegate { Close(); });
        SetupButton(close, "×", Theme.Box(Theme.N("width") - Theme.L("margin") - 28, Theme.L("headerY") - 2, 28, 28), delegate { Close(); });
        close.BackColor = Theme.C("background");
        close.AccessibleName = removing ? "关闭卸载程序" : "关闭安装程序";
        var minimize = new ActionButton();
        SetupButton(minimize, "−", Theme.Box(Theme.N("width") - Theme.L("margin") - 66, Theme.L("headerY") - 2, 28, 28), delegate { WindowState = FormWindowState.Minimized; });
        minimize.BackColor = Theme.C("background");
        minimize.AccessibleName = "最小化";
        foreach (Control control in Controls) logicalBounds[control] = new Rectangle(
            (int)Math.Round(control.Left / Theme.Scale), (int)Math.Round(control.Top / Theme.Scale),
            (int)Math.Round(control.Width / Theme.Scale), (int)Math.Round(control.Height / Theme.Scale));
        SetScope(false);
        if (removing) {
            allUsers = machineScope; path.Text = removalDirectory;
            mine.Visible = everyone.Visible = path.Visible = reset.Visible = false;
        }
        Shown += delegate { primary.Focus(); };
        FormClosing += delegate(object sender, FormClosingEventArgs e) { if (running) e.Cancel = true; };
        MouseDown += delegate(object sender, MouseEventArgs e) {
            if (e.Button == MouseButtons.Left && e.Y < Theme.Px(Theme.L("cardY"))) { ReleaseCapture(); SendMessage(Handle, 0xA1, (IntPtr)2, IntPtr.Zero); }
        };
        frames.Interval = Theme.N(motion ? "frameMs" : "statusIntervalMs");
        frames.Tick += delegate { if (running) Invalidate(Theme.Box(x, Theme.L("progressY") - 8, right - x, Theme.L("statusY") - Theme.L("progressY") + 56)); };
    }

    protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        try { int corner = 2; DwmSetWindowAttribute(Handle, 33, ref corner, sizeof(int)); } catch { }
    }
    protected override void WndProc(ref Message message) {
        base.WndProc(ref message);
        if (message.Msg == 0x02E0 && logicalBounds != null) {
            Theme.Scale = (message.WParam.ToInt32() & 0xffff) / 96f;
            ClientSize = new Size(Theme.Px(Theme.N("width")), Theme.Px(Theme.N("height")));
            foreach (var item in logicalBounds) item.Key.Bounds = Theme.Box(item.Value.X, item.Value.Y, item.Value.Width, item.Value.Height);
            path.Font.Dispose(); path.Font = Theme.Font(Theme.N("smallSize"), false);
            Invalidate(true);
        }
    }
    void SetupButton(ActionButton button, string text, Rectangle bounds, EventHandler action) {
        button.Text = text; button.AccessibleName = text; button.Bounds = bounds;
        button.BackColor = Theme.C("surface");
        button.Click += action;
        Controls.Add(button);
    }
    string DefaultPath(bool machine) {
        return Path.Combine(Environment.GetFolderPath(machine ? Environment.SpecialFolder.ProgramFiles : Environment.SpecialFolder.LocalApplicationData), machine ? "Eve" : "Programs\\Eve");
    }
    void SetScope(bool machine) {
        allUsers = machine;
        mine.Selected = !machine; everyone.Selected = machine;
        mine.Invalidate(); everyone.Invalidate();
        path.Text = DefaultPath(machine);
    }
    string ValidPath() {
        string value = Environment.ExpandEnvironmentVariables(path.Text.Trim().Trim('"'));
        if (String.IsNullOrWhiteSpace(value) || !Path.IsPathRooted(value) || value.StartsWith("\\\\") || value.IndexOf('"') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
            throw new ArgumentException("请输入本机上的完整安装路径");
        foreach (var part in value.Split('\\', '/')) if (part == "..") throw new ArgumentException("安装路径不能包含上级目录");
        value = Path.GetFullPath(value).TrimEnd('\\');
        if (value.Length > Theme.N("maxPathLength") || value == Path.GetPathRoot(value).TrimEnd('\\')) throw new ArgumentException("请选择具体文件夹，并缩短路径");
        string system = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        if (value.Equals(system, StringComparison.OrdinalIgnoreCase) || value.StartsWith(system + "\\", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("请选择系统目录以外的位置");
        if (allUsers) {
            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles).TrimEnd('\\') + "\\";
            if (!value.StartsWith(programFiles, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("所有用户安装请选择 Program Files 内的文件夹");
        }
        return value;
    }
    async Task InstallAsync() {
        if (running || finished) return;
        string destination;
        try {
            destination = ValidPath();
            if (removing && !File.Exists(Path.Combine(destination, "Eve.exe"))) throw new IOException("未找到 Eve，请检查安装位置");
        } catch (Exception e) {
            error = e.Message; path.AccessibleDescription = error;
            AccessibilityNotifyClients(AccessibleEvents.SystemAlert, -1);
            Invalidate(); path.Focus(); return;
        }
        error = ""; running = true;
        close.Enabled = false;
        mine.Visible = everyone.Visible = path.Visible = reset.Visible = false;
        primary.Visible = secondary.Visible = false;
        clock.Restart(); frames.Start(); Invalidate();
        try {
            string arguments = "/S " + (allUsers ? "/allusers " : "/currentuser ") + (removing ? "_?=" : "/D=") + destination;
            var start = new ProcessStartInfo(payload, arguments) {
                UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(payload), WindowStyle = ProcessWindowStyle.Hidden
            };
            if (allUsers) start.Verb = "runas";
            using (var engine = Process.Start(start)) {
                if (engine == null) throw new IOException(removing ? "卸载未能启动，请重试" : "安装程序未能启动");
                await Task.Run(delegate { engine.WaitForExit(); });
                if (engine.ExitCode != 0) throw new IOException((removing ? "卸载" : "安装") + "未完成（代码 " + engine.ExitCode + "）");
            }
            if (removing) {
                if (File.Exists(Path.Combine(destination, "Eve.exe")) || Directory.Exists(Path.Combine(destination, "resources")))
                    throw new IOException("仍有应用文件占用，请关闭 Eve 后重试");
                finished = true; Result = 0;
                primary.Text = "完成"; secondary.Visible = false;
                return;
            }
            string info = Path.Combine(destination, "resources", "app", "dist", "build-info.json");
            if (!File.Exists(Path.Combine(destination, "Eve.exe")) || !File.Exists(info)) throw new IOException("应用文件不完整，请重试");
            var identity = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(info));
            if (!identity.ContainsKey("buildId") || (string)identity["buildId"] != build) throw new IOException("安装版本核验失败，请重试");
            finished = true; Result = 0; path.Text = destination;
            primary.Text = "打开 Eve"; secondary.Text = "完成";
        } catch (Win32Exception e) { error = e.NativeErrorCode == 1223 ? "已取消" : (removing ? "卸载未能启动，请重试" : "安装程序未能启动，请重试"); }
          catch (Exception e) { error = e.Message; }
        finally {
            running = false; clock.Stop(); frames.Stop();
            close.Enabled = true;
            primary.Visible = true; secondary.Visible = !(removing && finished);
            mine.Visible = everyone.Visible = path.Visible = reset.Visible = !finished && !removing;
            primary.Focus(); Invalidate();
        }
    }
    void OpenApp() {
        try { Process.Start(new ProcessStartInfo(Path.Combine(path.Text, "Eve.exe")) { UseShellExecute = true, WorkingDirectory = path.Text }); Close(); }
        catch { error = "未能打开 Eve，请从开始菜单重试"; Invalidate(); }
    }

    protected override void OnPaint(PaintEventArgs e) {
        base.OnPaint(e);
        var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
        int x = Theme.L("contentX"), right = Theme.L("contentRight"), textWidth = right - x;
        Theme.Fill(g, Theme.Box(Theme.L("margin"), Theme.L("cardY") + 3, Theme.N("width") - Theme.L("margin") * 2, Theme.L("cardHeight")), Theme.Px(Theme.N("radius")), Theme.C("soft"));
        Theme.Fill(g, Theme.Box(Theme.L("margin"), Theme.L("cardY"), Theme.N("width") - Theme.L("margin") * 2, Theme.L("cardHeight")), Theme.Px(Theme.N("radius")), Theme.C("surface"));
        Theme.Fill(g, Theme.Box(Theme.L("margin"), Theme.L("headerY"), 28, 28), Theme.Px(8), Theme.C("text"));
        Theme.Text(g, "E", Theme.Box(Theme.L("margin"), Theme.L("headerY"), 28, 28), 20, Theme.C("surface"), true, StringAlignment.Center);
        Theme.Text(g, "Eve", Theme.Box(Theme.L("margin") + 40, Theme.L("headerY"), 80, 28), 18, Theme.C("text"), true, StringAlignment.Near);
        string title = removing ? (finished ? "卸载完成" : running ? "正在卸载 Eve" : "卸载 Eve") : (finished ? "安装完成" : running ? "正在安装 Eve" : "安装 Eve");
        string subtitle = removing ? (finished ? "项目与设置已保留" : running ? "正在移除应用文件" : "移除应用，保留项目与设置") : (finished ? "Eve 已就绪" : running ? "正在写入应用文件" : "选择安装范围与位置");
        Theme.Text(g, title, Theme.Box(x, Theme.L("titleY"), textWidth, 42), Theme.N("titleSize"), Theme.C("text"), true, StringAlignment.Near);
        Theme.Text(g, subtitle, Theme.Box(x, Theme.L("subtitleY"), textWidth, 26), Theme.N("fontSize"), Theme.C("secondary"), false, StringAlignment.Near);
        if (running) {
            Rectangle track = Theme.Box(x, Theme.L("progressY"), textWidth, Theme.L("progressHeight"));
            Theme.Fill(g, track, track.Height / 2f, Theme.C("soft"));
            if (motion) {
                double phase = (clock.Elapsed.TotalMilliseconds % Theme.N("progressCycleMs")) / Theme.N("progressCycleMs");
                int segment = track.Width / 3;
                var fill = new RectangleF(track.Left + (float)((track.Width + segment) * phase) - segment, track.Top, segment, track.Height);
                using (var clip = Theme.Rounded(track, track.Height / 2f)) {
                    var state = g.Save(); g.SetClip(clip);
                    using (var brush = new LinearGradientBrush(fill, Theme.C("accent"), Theme.C("accent"), 0f))
                    using (var segmentPath = Theme.Rounded(fill, track.Height / 2f)) {
                        brush.InterpolationColors = new ColorBlend {
                            Colors = new[] { Color.FromArgb(0, Theme.C("accent")), Color.FromArgb(100, Theme.C("accent")), Theme.C("accent"), Color.FromArgb(0, Theme.C("accent")) },
                            Positions = new[] { 0f, 0.35f, 0.75f, 1f }
                        };
                        g.FillPath(brush, segmentPath);
                    }
                    g.Restore(state);
                }
            } else Theme.Fill(g, new Rectangle(track.X, track.Y, track.Width / 2, track.Height), track.Height / 2f, Theme.C("accent"));
            Theme.Text(g, "已用时 " + clock.Elapsed.ToString(@"mm\:ss"), Theme.Box(x, Theme.L("statusY"), textWidth, 26), Theme.N("smallSize"), Theme.C("secondary"), false, StringAlignment.Near);
        } else if (removing) {
            Theme.Fill(g, Theme.Box(x, Theme.L("scopeY"), textWidth, Theme.L("scopeHeight") * 2), Theme.Px(Theme.N("controlRadius")), Theme.C("soft"));
            Theme.Text(g, "保留的资料", Theme.Box(x + 18, Theme.L("scopeY") + 20, textWidth - 36, 24), Theme.N("smallSize"), Theme.C("secondary"), false, StringAlignment.Near);
            Theme.Text(g, "科研项目与数据", Theme.Box(x + 18, Theme.L("scopeY") + 50, textWidth - 36, 24), Theme.N("fontSize"), Theme.C("text"), false, StringAlignment.Near);
            Theme.Text(g, "会话、技能、记忆与设置", Theme.Box(x + 18, Theme.L("scopeY") + 82, textWidth - 36, 24), Theme.N("fontSize"), Theme.C("text"), false, StringAlignment.Near);
        } else if (finished) {
            Theme.Fill(g, Theme.Box(x, Theme.L("scopeY"), textWidth, Theme.L("scopeHeight") * 2), Theme.Px(Theme.N("controlRadius")), Theme.C("soft"));
            Theme.Text(g, "安装位置", Theme.Box(x + 18, Theme.L("scopeY") + 24, textWidth - 36, 24), Theme.N("smallSize"), Theme.C("secondary"), false, StringAlignment.Near);
            Theme.Text(g, path.Text, Theme.Box(x + 18, Theme.L("scopeY") + 58, textWidth - 36, 28), Theme.N("smallSize"), Theme.C("text"), false, StringAlignment.Near);
        } else {
            Theme.Text(g, "安装位置", Theme.Box(x, Theme.L("pathLabelY"), textWidth, 22), Theme.N("smallSize"), Theme.C("secondary"), false, StringAlignment.Near);
            Theme.Fill(g, Theme.Box(x, Theme.L("pathY"), Theme.L("pathWidth"), Theme.L("pathHeight")), Theme.Px(Theme.N("controlRadius")), Theme.C("soft"));
        }
        if (error.Length > 0) Theme.Text(g, error, Theme.Box(x, Theme.L("errorY"), textWidth, 22), Theme.N("smallSize"), Theme.C("danger"), false, StringAlignment.Near);
        Theme.Text(g, "Eve " + version, Theme.Box(Theme.L("margin"), Theme.L("versionY"), textWidth, 22), Theme.N("smallSize"), Theme.C("secondary"), false, StringAlignment.Near);
    }
    protected override void Dispose(bool disposing) { if (disposing) frames.Dispose(); base.Dispose(disposing); }
}

static class Program {
    [STAThread] static int Main(string[] args) {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        string payload = "", version = "", build = "", uninstallDirectory = "", scope = "current";
        for (int i = 0; i + 1 < args.Length; i += 2) {
            if (args[i] == "--payload") payload = args[i + 1];
            if (args[i] == "--version") version = args[i + 1];
            if (args[i] == "--build") build = args[i + 1];
            if (args[i] == "--uninstall") uninstallDirectory = args[i + 1];
            if (args[i] == "--scope") scope = args[i + 1];
        }
        if (!File.Exists(payload) || version.Length == 0 || (build.Length == 0 && uninstallDirectory.Length == 0)) return 1;
        using (var app = new Installer(payload, version, build, uninstallDirectory, scope == "all")) { Application.Run(app); return app.Result; }
    }
}
