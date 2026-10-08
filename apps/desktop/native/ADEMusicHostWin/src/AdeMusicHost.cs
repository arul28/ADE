// ADE Music host for Windows.
//
// A hidden WebView2 window that runs MusicKit JS v3 on a tiny local page and is
// driven by ADE's main process over stdio:
//   stdin  = one JSON command per line. Forwarded to the page verbatim, except
//            the host's own commands: {"cmd":"quit"}, {"cmd":"show"}, {"cmd":"hide"},
//            {"cmd":"showAuth"} (bring the sign-in window to the front) and
//            {"cmd":"closeAuth"} (close it, which cancels the sign-in).
//   stdout = one JSON object per line: page events and command replies, plus the
//            host's own {"event":"hostReady"|"hostClosing"|"hostError"|"authWindow"}.
//   stderr = a human log. It never contains tokens: command lines are not logged,
//            and the page never logs them either.
//
// Built with the in-box .NET Framework csc.exe (C# 5), so no SDK is needed:
// see apps/desktop/scripts/build-music-host-win.mjs.
//
// Usage: ade-music-host.exe --udf <dir> --page <dir> [--host music.ade.local]
//                           [--parent-pid <pid>] [--show] [--gpu] [--muted]
//
// Never pass --disable-component-update to WebView2: it removes the Widevine CDM
// and Apple Music then plays nothing but 30-second previews.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Program {
  static readonly Stopwatch Clock = Stopwatch.StartNew();
  static readonly object OutLock = new object();
  static Form mainForm;
  static CoreWebView2Environment environment;
  static int popupCount;
  static string virtualHost = "music.ade.local";
  static string pageDir;
  static readonly List<Form> authForms = new List<Form>();

  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool FlashWindowEx(ref FLASHWINFO info);
  [StructLayout(LayoutKind.Sequential)]
  struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
  const int SW_SHOW = 5;
  const int SW_RESTORE = 9;

  // Show a window and bring it in front of ADE. ADE starts this host with
  // windowsHide, so the process's STARTUPINFO says SW_HIDE and Windows applies
  // that to the first ShowWindow(SW_SHOWNORMAL) the process makes: a plain
  // Form.Show() of the sign-in window was silently turned into "hidden". An
  // explicit SW_SHOW is never overridden. A background process may not take the
  // foreground, so borrow the foreground thread's input for the call, and
  // flash the taskbar button if Windows still refuses.
  static void Present(Form form) {
    IntPtr h = form.Handle;
    ShowWindow(h, IsIconic(h) ? SW_RESTORE : SW_SHOW);
    IntPtr fg = GetForegroundWindow();
    uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, IntPtr.Zero);
    uint me = GetCurrentThreadId();
    bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
    try {
      BringWindowToTop(h);
      form.TopMost = true;
      form.TopMost = false;
      bool ok = SetForegroundWindow(h);
      if (!ok) {
        var info = new FLASHWINFO { hwnd = h, dwFlags = 3 | 12, uCount = 3, dwTimeout = 0 };
        info.cbSize = (uint)Marshal.SizeOf(info);
        FlashWindowEx(ref info);
      }
      Log("present ok=" + ok + " attached=" + attached);
    } finally {
      if (attached) AttachThreadInput(me, fgThread, false);
    }
  }

  static void Log(string message) {
    lock (OutLock) {
      Console.Error.WriteLine("[" + Clock.ElapsedMilliseconds.ToString().PadLeft(7) + "ms] " + message);
      Console.Error.Flush();
    }
  }

  static void Emit(string json) {
    lock (OutLock) {
      Console.Out.WriteLine(json);
      Console.Out.Flush();
    }
  }

  static string Quote(string s) {
    if (s == null) return "null";
    return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "") + "\"";
  }

  [STAThread]
  static int Main(string[] argv) {
    string baseDir = AppDomain.CurrentDomain.BaseDirectory;
    string udf = null;
    string page = Path.Combine(baseDir, "page");
    string vhost = "music.ade.local";
    int parentPid = 0;
    bool show = false;
    bool gpu = false;
    bool muted = false;
    for (int i = 0; i < argv.Length; i++) {
      string a = argv[i];
      if (a == "--udf" && i + 1 < argv.Length) udf = argv[++i];
      else if (a == "--page" && i + 1 < argv.Length) page = argv[++i];
      else if (a == "--host" && i + 1 < argv.Length) vhost = argv[++i];
      else if (a == "--parent-pid" && i + 1 < argv.Length) int.TryParse(argv[++i], out parentPid);
      else if (a == "--show") show = true;
      else if (a == "--gpu") gpu = true;
      else if (a == "--muted") muted = true;
    }
    if (string.IsNullOrEmpty(udf)) {
      Emit("{\"event\":\"hostError\",\"code\":\"usage\",\"error\":\"--udf is required\"}");
      return 2;
    }
    page = Path.GetFullPath(page);
    pageDir = page;
    virtualHost = vhost;

    string runtime;
    try {
      runtime = CoreWebView2Environment.GetAvailableBrowserVersionString();
    } catch (Exception) {
      runtime = null;
    }
    if (string.IsNullOrEmpty(runtime)) {
      Emit("{\"event\":\"hostError\",\"code\":\"webview2_missing\",\"error\":\"The Microsoft Edge WebView2 Runtime is not installed.\"}");
      return 3;
    }
    Log("start runtime=" + runtime + " pid=" + Process.GetCurrentProcess().Id);

    Application.EnableVisualStyles();
    mainForm = new Form {
      Text = "ADE Music",
      Width = 960,
      Height = 640,
      ShowInTaskbar = show,
      StartPosition = FormStartPosition.Manual,
      Location = show ? new System.Drawing.Point(80, 80) : new System.Drawing.Point(-32000, -32000),
    };
    if (!show) mainForm.Opacity = 0;
    var webView = new WebView2 { Dock = DockStyle.Fill };
    mainForm.Controls.Add(webView);

    if (parentPid > 0) WatchParent(parentPid);

    mainForm.Load += async (s, e) => {
      try {
        // Autoplay without a gesture: every play comes from ADE's own UI, never this page.
        // A hidden audio player needs no GPU, one renderer and no extensions.
        // Measured while playing: 248 MB private across the process tree with
        // the defaults, 141 MB with these flags. --gpu keeps the GPU process.
        string flags = "--autoplay-policy=no-user-gesture-required --renderer-process-limit=1 --disable-extensions"
          + " --disable-features=msSmartScreenProtection,msWebOOUI,msPdfOOUI,SpareRendererForSitePerProcess";
        if (!gpu) flags += " --disable-gpu";
        var options = new CoreWebView2EnvironmentOptions(flags);
        environment = await CoreWebView2Environment.CreateAsync(null, udf, options);
        await webView.EnsureCoreWebView2Async(environment);
        var core = webView.CoreWebView2;
        // Apple's sign-in page has a dark-mode contrast bug that makes its
        // buttons nearly invisible. The profile is shared with the popup, and the
        // player page has no UI, so light everywhere is free.
        core.Profile.PreferredColorScheme = CoreWebView2PreferredColorScheme.Light;
        // Test instances play silently (--muted); playback still runs.
        if (muted) core.IsMuted = true;
        core.Settings.AreDevToolsEnabled = show;
        core.Settings.AreDefaultContextMenusEnabled = show;
        core.Settings.IsStatusBarEnabled = false;
        core.WebMessageReceived += (o, ev) => {
          string message;
          try { message = ev.TryGetWebMessageAsString(); } catch (Exception) { return; }
          if (message != null && message.StartsWith("{")) Emit(message);
        };
        core.NavigationCompleted += (o, ev) => Log("navigation ok=" + ev.IsSuccess + " status=" + ev.WebErrorStatus);
        core.ProcessFailed += (o, ev) => {
          Log("process failed " + ev.ProcessFailedKind);
          Emit("{\"event\":\"hostError\",\"code\":\"process_failed\",\"error\":" + Quote(ev.ProcessFailedKind.ToString()) + "}");
        };
        core.NewWindowRequested += OnNewWindowRequested;
        core.SetVirtualHostNameToFolderMapping(vhost, page, CoreWebView2HostResourceAccessKind.Allow);
        Emit("{\"event\":\"hostReady\",\"hostPid\":" + Process.GetCurrentProcess().Id
          + ",\"browserPid\":" + core.BrowserProcessId
          + ",\"runtime\":" + Quote(runtime)
          + ",\"origin\":" + Quote("https://" + vhost) + "}");
        core.Navigate("https://" + vhost + "/index.html");
        var reader = new Thread(() => StdinLoop(core)) { IsBackground = true, Name = "stdin" };
        reader.Start();
      } catch (Exception ex) {
        Log("startup failed " + ex);
        Emit("{\"event\":\"hostError\",\"code\":\"startup_failed\",\"error\":" + Quote(ex.Message) + "}");
        mainForm.Close();
      }
    };
    mainForm.FormClosed += (s, e) => Emit("{\"event\":\"hostClosing\"}");
    Application.Run(mainForm);
    Log("exit");
    return 0;
  }

  // MusicKit's authorize() opens Apple's sign-in in a popup and waits for it to
  // post back to window.opener. The popup must be a real WebView2 that shares
  // this environment, handed back through NewWindow, or the opener link breaks.
  static async void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs ev) {
    var deferral = ev.GetDeferral();
    try {
      int n = ++popupCount;
      var features = ev.WindowFeatures;
      var form = new Form {
        Text = "Connect Apple Music - ADE",
        StartPosition = FormStartPosition.CenterScreen,
        ShowInTaskbar = true,
        Width = 520,
        Height = 720,
      };
      try {
        form.Icon = System.Drawing.Icon.ExtractAssociatedIcon(Process.GetCurrentProcess().MainModule.FileName);
      } catch (Exception) { }
      if (features.HasSize) {
        form.ClientSize = new System.Drawing.Size((int)Math.Max(features.Width, 440), (int)Math.Max(features.Height, 620));
      }
      var popup = new WebView2 { Dock = DockStyle.Fill };
      form.Controls.Add(popup);
      authForms.Add(form);
      form.FormClosed += (a, b) => {
        authForms.Remove(form);
        Emit("{\"event\":\"authWindow\",\"state\":\"closed\",\"n\":" + n + "}");
      };
      form.Show();
      Present(form);
      await popup.EnsureCoreWebView2Async(environment);
      popup.CoreWebView2.Settings.AreDevToolsEnabled = false;
      // Apple's consent page loads ADE's icon from the player page's origin.
      try { popup.CoreWebView2.SetVirtualHostNameToFolderMapping(virtualHost, pageDir, CoreWebView2HostResourceAccessKind.Allow); } catch (Exception) { }
      popup.CoreWebView2.WindowCloseRequested += (a, b) => form.Close();
      popup.CoreWebView2.NewWindowRequested += OnNewWindowRequested;
      ev.NewWindow = popup.CoreWebView2;
      ev.Handled = true;
      Emit("{\"event\":\"authWindow\",\"state\":\"open\",\"n\":" + n + "}");
    } catch (Exception ex) {
      Log("popup failed " + ex.Message);
      Emit("{\"event\":\"hostError\",\"code\":\"popup_failed\",\"error\":" + Quote(ex.Message) + "}");
    } finally {
      deferral.Complete();
    }
  }

  static void StdinLoop(CoreWebView2 core) {
    string line;
    try {
      while ((line = Console.In.ReadLine()) != null) {
        line = line.Trim();
        if (line.Length == 0) continue;
        if (line == "{\"cmd\":\"quit\"}") break;
        if (line == "{\"cmd\":\"showAuth\"}" || line == "{\"cmd\":\"closeAuth\"}") {
          bool close = line.Contains("close");
          mainForm.BeginInvoke((Action)(() => {
            foreach (var f in authForms.ToArray()) {
              if (f.IsDisposed) continue;
              if (close) f.Close(); else Present(f);
            }
          }));
          continue;
        }
        if (line == "{\"cmd\":\"show\"}" || line == "{\"cmd\":\"hide\"}") {
          bool visible = line.Contains("show");
          mainForm.BeginInvoke((Action)(() => {
            mainForm.Opacity = visible ? 1 : 0;
            mainForm.ShowInTaskbar = visible;
            mainForm.Location = visible ? new System.Drawing.Point(80, 80) : new System.Drawing.Point(-32000, -32000);
          }));
          continue;
        }
        string command = line;
        mainForm.BeginInvoke((Action)(() => {
          try { core.PostWebMessageAsString(command); } catch (Exception ex) { Log("post failed " + ex.Message); }
        }));
      }
    } catch (Exception ex) {
      Log("stdin failed " + ex.Message);
    }
    // EOF or quit: ADE is done with us (or gone). Close cleanly so the
    // WebView2 browser process tree exits with this process.
    try { mainForm.BeginInvoke((Action)(() => mainForm.Close())); } catch (Exception) { Environment.Exit(0); }
  }

  // A crashed ADE closes our stdin, which ends StdinLoop. This covers the case
  // where the pipe handle leaks to another process and stays open.
  static void WatchParent(int pid) {
    Process parent;
    try { parent = Process.GetProcessById(pid); } catch (Exception) { return; }
    var t = new Thread(() => {
      try { parent.WaitForExit(); } catch (Exception) { return; }
      Log("parent exited");
      try { mainForm.BeginInvoke((Action)(() => mainForm.Close())); } catch (Exception) { }
      Thread.Sleep(5000);
      Environment.Exit(0);
    }) { IsBackground = true, Name = "parent-watch" };
    t.Start();
  }
}
