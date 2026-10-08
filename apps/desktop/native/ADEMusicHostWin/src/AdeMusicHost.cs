// ADE Music host for Windows.
//
// A hidden WebView2 window that runs MusicKit JS v3 on a tiny local page and is
// driven by ADE's main process over stdio:
//   stdin  = one JSON command per line. Forwarded to the page verbatim, except
//            the host's own commands: {"cmd":"quit"}, {"cmd":"show"}, {"cmd":"hide"}.
//   stdout = one JSON object per line: page events and command replies, plus the
//            host's own {"event":"hostReady"|"hostClosing"|"hostError"|"authWindow"}.
//   stderr = a human log. It never contains tokens: command lines are not logged,
//            and the page never logs them either.
//
// Built with the in-box .NET Framework csc.exe (C# 5), so no SDK is needed:
// see apps/desktop/scripts/build-music-host-win.mjs.
//
// Usage: ade-music-host.exe --udf <dir> --page <dir> [--host music.ade.local]
//                           [--parent-pid <pid>] [--show]
//
// Never pass --disable-component-update to WebView2: it removes the Widevine CDM
// and Apple Music then plays nothing but 30-second previews.
using System;
using System.Diagnostics;
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
    for (int i = 0; i < argv.Length; i++) {
      string a = argv[i];
      if (a == "--udf" && i + 1 < argv.Length) udf = argv[++i];
      else if (a == "--page" && i + 1 < argv.Length) page = argv[++i];
      else if (a == "--host" && i + 1 < argv.Length) vhost = argv[++i];
      else if (a == "--parent-pid" && i + 1 < argv.Length) int.TryParse(argv[++i], out parentPid);
      else if (a == "--show") show = true;
    }
    if (string.IsNullOrEmpty(udf)) {
      Emit("{\"event\":\"hostError\",\"code\":\"usage\",\"error\":\"--udf is required\"}");
      return 2;
    }
    page = Path.GetFullPath(page);

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
        var options = new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required");
        environment = await CoreWebView2Environment.CreateAsync(null, udf, options);
        await webView.EnsureCoreWebView2Async(environment);
        var core = webView.CoreWebView2;
        // Apple's sign-in page has a dark-mode contrast bug that makes its
        // buttons nearly invisible. The profile is shared with the popup, and the
        // player page has no UI, so light everywhere is free.
        core.Profile.PreferredColorScheme = CoreWebView2PreferredColorScheme.Light;
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
        Text = "Connect Apple Music",
        StartPosition = FormStartPosition.CenterScreen,
        ShowInTaskbar = true,
        TopMost = true,
        Width = 520,
        Height = 720,
      };
      if (features.HasSize) {
        form.ClientSize = new System.Drawing.Size((int)Math.Max(features.Width, 440), (int)Math.Max(features.Height, 620));
      }
      var popup = new WebView2 { Dock = DockStyle.Fill };
      form.Controls.Add(popup);
      form.Show();
      form.Activate();
      // TopMost only to land in front of ADE once; afterwards it behaves like any window.
      form.Shown += (a, b) => form.TopMost = false;
      await popup.EnsureCoreWebView2Async(environment);
      popup.CoreWebView2.Settings.AreDevToolsEnabled = false;
      popup.CoreWebView2.WindowCloseRequested += (a, b) => form.Close();
      popup.CoreWebView2.NewWindowRequested += OnNewWindowRequested;
      ev.NewWindow = popup.CoreWebView2;
      ev.Handled = true;
      Emit("{\"event\":\"authWindow\",\"state\":\"open\",\"n\":" + n + "}");
      form.FormClosed += (a, b) => Emit("{\"event\":\"authWindow\",\"state\":\"closed\",\"n\":" + n + "}");
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
