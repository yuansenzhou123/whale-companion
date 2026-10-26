using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace WhaleCompanion {
  public sealed class PetWindow : Form {
    string endpoint, token = "", emotion = "sleepy", bubble = "打开 B站客户端就好，我会自己跟上来～", title = "鲸鲸 · 陪你看";
    bool enabled = false, automaticComments = true, preview = false;
    int polling = 0, tick = 0;
    DateTime touchUntil = DateTime.MinValue;
    System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    System.Windows.Forms.Timer animation = new System.Windows.Forms.Timer();
    ToolStripMenuItem toggleItem, automaticItem;
    NotifyIcon tray;
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);
    public PetWindow(string url, bool renderOnly) {
      endpoint = url.TrimEnd('/'); preview = renderOnly;
      Text = "鲸鲸陪看桌宠"; FormBorderStyle = FormBorderStyle.None; ClientSize = new Size(356, 352);
      BackColor = Color.Magenta; TransparencyKey = Color.Magenta; TopMost = true; ShowInTaskbar = false; DoubleBuffered = true;
      StartPosition = FormStartPosition.Manual; Location = new Point(Screen.PrimaryScreen.WorkingArea.Right - Width - 24, Screen.PrimaryScreen.WorkingArea.Bottom - Height - 20);
      Font = new Font("Microsoft YaHei UI", 9);
      timer.Interval = 1800; timer.Tick += delegate {Poll();};
      animation.Interval = 120; animation.Tick += delegate {tick++; Invalidate();};
      MouseDown += delegate(object sender, MouseEventArgs e) {if (e.Button == MouseButtons.Left) {ReleaseCapture(); SendMessage(Handle, 0xA1, 2, 0);}};
      MouseDoubleClick += delegate {touchUntil = DateTime.Now.AddSeconds(6); bubble = "诶，摸到我啦～"; Invalidate();};
      if (!preview) {
        var menu = new ContextMenuStrip();
        toggleItem = new ToolStripMenuItem("暂停陪看", null, delegate {Post("settings", "{\"enabled\":" + (!enabled ? "true" : "false") + "}");});
        menu.Items.Add(toggleItem);
        menu.Items.Add("说说这段", null, delegate {Post("comment", "{}");});
        automaticItem = new ToolStripMenuItem("自动评论", null, delegate {Post("settings", "{\"automaticComments\":" + (!automaticComments ? "true" : "false") + "}");});
        menu.Items.Add(automaticItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("陪看设置", null, delegate {System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(endpoint + "/companion") {UseShellExecute = true});});
        menu.Items.Add("显示 / 隐藏", null, delegate {if (Visible) Hide(); else Show();});
        menu.Items.Add("退出桌宠", null, delegate {Close();});
        menu.Opening += delegate {toggleItem.Text = enabled ? "暂停陪看" : "继续陪看"; automaticItem.Checked = automaticComments;};
        ContextMenuStrip = menu;
        tray = new NotifyIcon {Icon = SystemIcons.Information, Text = "鲸鲸陪看", Visible = true, ContextMenuStrip = menu};
        tray.DoubleClick += delegate {Show();};
        timer.Start(); animation.Start(); Shown += delegate {Poll();};
      }
    }
    [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
    protected override void OnHandleCreated(EventArgs e) {base.OnHandleCreated(e); SetWindowDisplayAffinity(Handle, 0x11);}
    protected override bool ShowWithoutActivation {get {return true;}}
    protected override CreateParams CreateParams {get {var value = base.CreateParams; value.ExStyle |= 0x08000000; return value;}}
    protected override void WndProc(ref Message message) {
      if (message.Msg == 0x21) {message.Result = new IntPtr(3); return;}
      base.WndProc(ref message);
    }
    static Dictionary<string, object> Obj(object value) {return value as Dictionary<string, object> ?? new Dictionary<string, object>();}
    static object Get(Dictionary<string, object> row, string key) {object value; return row.TryGetValue(key, out value) ? value : null;}
    static string Str(Dictionary<string, object> row, string key) {return Convert.ToString(Get(row, key)) ?? "";}
    Dictionary<string, object> Request(string route, string body) {
      var request = (HttpWebRequest)WebRequest.Create(endpoint + "/api/companion/" + route);
      request.Proxy = null; request.Timeout = 2000; request.ReadWriteTimeout = 2000; request.Method = body == null ? "GET" : "POST";
      if (token.Length > 0) request.Headers["Authorization"] = "Bearer " + token;
      if (body != null) {
        var bytes = Encoding.UTF8.GetBytes(body); request.ContentType = "application/json"; request.ContentLength = bytes.Length;
        using (var stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
      }
      using (var response = request.GetResponse()) using (var reader = new System.IO.StreamReader(response.GetResponseStream(), Encoding.UTF8)) return Obj(new JavaScriptSerializer().DeserializeObject(reader.ReadToEnd()));
    }
    void Dispatch(Action action) {
      try {if (!IsDisposed && IsHandleCreated) BeginInvoke((Action)delegate {if (!IsDisposed) action();});}
      catch (InvalidOperationException) {}
    }
    void Poll() {
      if (Interlocked.Exchange(ref polling, 1) != 0 || IsDisposed) return;
      ThreadPool.QueueUserWorkItem(delegate {
        try {
          if (token.Length == 0) token = Str(Request("bootstrap", null), "token");
          var state = Request("state", null);
          Dispatch(delegate {ApplyState(state);});
        } catch {
          token = "";
          Dispatch(delegate {title = "等待鲸鲸服务"; if (DateTime.Now > touchUntil) bubble = "连接断开啦，打开鲸鲸服务后我会自己连回来。"; emotion = "sleepy"; Invalidate();});
        } finally {Interlocked.Exchange(ref polling, 0);}
      });
    }
    void Post(string route, string body) {
      ThreadPool.QueueUserWorkItem(delegate {
        try {if (token.Length == 0) token = Str(Request("bootstrap", null), "token"); Request(route, body); Poll();}
        catch {Dispatch(delegate {bubble = "还没接到视频呢，把 B站客户端切到前台播放吧。"; Invalidate();});}
      });
    }
    void ApplyState(Dictionary<string, object> state) {
      var options = Obj(Get(state, "settings")); enabled = Convert.ToBoolean(Get(options, "enabled") ?? false); automaticComments = Convert.ToBoolean(Get(options, "automaticComments") ?? true);
      emotion = Str(state, "expression");
      var video = Obj(Get(state, "video")); string status = Str(state, "status");
      title = video.Count > 0 ? Str(video, "title") : "鲸鲸 · 等你选一段视频";
      if (DateTime.Now > touchUntil) {
        double commentAt; Double.TryParse(Str(state, "commentAt"), out commentAt);
        double age = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - commentAt;
        if (Str(state, "comment").Length > 0 && age < 40000) bubble = Str(state, "comment");
        else if (status == "watching") bubble = Convert.ToBoolean(Get(state, "busy") ?? false) ? "唔……让我看看这一段。" : "在认真看呢，有意思的地方我再说～";
        else if (status == "paused") bubble = "先歇会儿，想继续就右键点“继续陪看”呀。";
        else if (status == "waiting") bubble = "暂停啦？那我也伸个懒腰。";
        else bubble = "打开 B站客户端就好，我会自己跟上来～";
      }
      Invalidate();
    }
    static void Ellipse(Graphics g, Color color, float x, float y, float w, float h) {using (var b = new SolidBrush(color)) g.FillEllipse(b, x, y, w, h);}
    static void Polygon(Graphics g, Color color, params PointF[] points) {using (var b = new SolidBrush(color)) g.FillPolygon(b, points);}
    void Render(Graphics g) {
      g.SmoothingMode = SmoothingMode.AntiAlias; g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
      Color blue = Color.FromArgb(65, 112, 185), dark = Color.FromArgb(36, 65, 114), light = Color.FromArgb(143, 204, 238), skin = Color.FromArgb(255, 231, 216);
      using (var path = new GraphicsPath()) {
        path.AddArc(12, 4, 22, 22, 180, 90); path.AddArc(322, 4, 22, 22, 270, 90); path.AddArc(322, 91, 22, 22, 0, 90); path.AddArc(12, 91, 22, 22, 90, 90); path.CloseFigure();
        using (var brush = new SolidBrush(Color.FromArgb(247, 252, 255))) g.FillPath(brush, path);
        using (var pen = new Pen(Color.FromArgb(158, 198, 221), 1.5f)) g.DrawPath(pen, path);
      }
      using (var f = new Font("Microsoft YaHei UI", 8)) using (var brush = new SolidBrush(Color.FromArgb(64, 108, 143))) g.DrawString(title, f, brush, new RectangleF(25, 14, 305, 19), new StringFormat {Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap});
      using (var f = new Font("Microsoft YaHei UI", 10)) using (var brush = new SolidBrush(dark)) g.DrawString(bubble, f, brush, new RectangleF(25, 38, 305, 65));
      Polygon(g, Color.FromArgb(247, 252, 255), new PointF(180, 111), new PointF(194, 124), new PointF(202, 111));
      float sway = (float)Math.Sin(tick / 5.0) * 4;
      using (var pen = new Pen(blue, 22)) g.DrawBezier(pen, 230, 309, 300, 333, 312 + sway, 276, 298 + sway, 264);
      Polygon(g, light, new PointF(297 + sway, 271), new PointF(271 + sway, 239), new PointF(302 + sway, 247), new PointF(320 + sway, 231), new PointF(326 + sway, 265));
      Ellipse(g, blue, 112, 145, 147, 175); Ellipse(g, light, 122, 203, 25, 111); Ellipse(g, light, 232, 202, 23, 112);
      Polygon(g, dark, new PointF(157, 267), new PointF(214, 267), new PointF(239, 332), new PointF(132, 332));
      Polygon(g, Color.White, new PointF(168, 279), new PointF(203, 279), new PointF(218, 329), new PointF(151, 329));
      Ellipse(g, dark, 149, 331, 29, 13); Ellipse(g, dark, 194, 331, 29, 13);
      Ellipse(g, skin, 137, 164, 101, 101); Ellipse(g, blue, 131, 143, 111, 45);
      Polygon(g, blue, new PointF(132, 165), new PointF(139, 214), new PointF(155, 177), new PointF(175, 192), new PointF(182, 174), new PointF(206, 193), new PointF(213, 175), new PointF(237, 209), new PointF(245, 161));
      Polygon(g, light, new PointF(129, 169), new PointF(101, 143), new PointF(113, 183), new PointF(133, 187));
      Polygon(g, light, new PointF(240, 167), new PointF(270, 143), new PointF(257, 184), new PointF(240, 188));
      using (var pen = new Pen(light, 4)) g.DrawBezier(pen, 184, 148, 169, 112, 211, 126, 194, 142);
      string mood = DateTime.Now < touchUntil ? "happy" : emotion;
      bool blink = tick % 45 >= 42 || mood == "sleepy";
      using (var pen = new Pen(dark, 3)) {
        for (int i = 0; i < 2; i++) {int x = 154 + i * 48;
          if (blink) g.DrawLine(pen, x, 214, x + 18, 215);
          else if (mood == "happy") g.DrawArc(pen, x, 205, 19, 17, 190, 160);
          else {Ellipse(g, Color.White, x - 2, 201, 24, 29); Ellipse(g, dark, x + 3, 204, 14, mood == "surprised" ? 23 : 20); Ellipse(g, Color.White, x + 6, 207, 5, 6);}
        }
        if (mood == "surprised") g.DrawEllipse(pen, 182, 237, 12, 15);
        else if (mood == "sad") g.DrawArc(pen, 181, 241, 15, 11, 190, 160);
        else if (mood == "happy") g.DrawArc(pen, 179, 231, 19, 16, 0, 180);
        else if (mood == "curious" || mood == "thinking") g.DrawLine(pen, 182, 242, 194, 240);
        else g.DrawArc(pen, 180, 235, 17, 10, 0, 180);
      }
      Ellipse(g, Color.FromArgb(244, 173, 179), 141, 231, 16, 7); Ellipse(g, Color.FromArgb(244, 173, 179), 220, 231, 16, 7);
      if (mood == "sad") Ellipse(g, light, 222, 224, 7, 15);
      Ellipse(g, skin, 132, mood == "surprised" ? 252 : 285, 20, 17); Ellipse(g, skin, 219, mood == "surprised" ? 252 : 285, 20, 17);
      if (mood == "thinking") using (var f = new Font("Microsoft YaHei UI", 14)) using (var b = new SolidBrush(dark)) g.DrawString("…", f, b, 266, 189);
      if (mood == "surprised") using (var f = new Font("Microsoft YaHei UI", 18, FontStyle.Bold)) using (var b = new SolidBrush(blue)) g.DrawString("!", f, b, 266, 177);
    }
    protected override void OnPaint(PaintEventArgs e) {base.OnPaint(e); Render(e.Graphics);}
    protected override void OnFormClosed(FormClosedEventArgs e) {timer.Stop(); animation.Stop(); if (tray != null) tray.Dispose(); base.OnFormClosed(e);}
    public static void Run(string endpoint) {
      bool created; using (var mutex = new Mutex(true, "Local\\WhaleGirlWatchPet", out created)) {
        if (!created) return; Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new PetWindow(endpoint, false));
      }
    }
    public static void Preview(string file, string mood) {using (var form = new PetWindow("http://127.0.0.1:8787", true)) {form.emotion = mood; form.title = "鲸鲸 · 陪你看这一段"; form.bubble = "这只猫偷吃还装无辜……我宣布它是同伙。"; using (var bitmap = new Bitmap(356, 352)) {using (var g = Graphics.FromImage(bitmap)) {form.BackColor = Color.FromArgb(224, 238, 248); form.TransparencyKey = Color.Empty; form.DrawToBitmap(bitmap, new Rectangle(0, 0, 356, 352));} bitmap.Save(file, System.Drawing.Imaging.ImageFormat.Png);}}}
  }
}
