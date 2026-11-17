# "A heavy program in front": ONE process that owns a maximised foreground window and keeps every core busy (as a game does), for the
# background voice tests (bg-voice.mjs LOADS=fg / fghigh). Windows treats the foreground window's process differently from other busy programs.
#   powershell -File fg-hog.ps1 -Threads 12 -Priority Normal|AboveNormal|High -Seconds 30
param([int]$Threads = [Environment]::ProcessorCount, [string]$Priority = 'Normal', [int]$Seconds = 30, [long]$Affinity = 0)
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System; using System.Threading; using System.Windows.Forms; using System.Diagnostics; using System.Runtime.InteropServices;
public static class Hog {
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  public static void Run(int threads, string prio, int seconds, long affinity) {
    if (affinity != 0) Process.GetCurrentProcess().ProcessorAffinity = (IntPtr)affinity;
    Process.GetCurrentProcess().PriorityClass = (ProcessPriorityClass)Enum.Parse(typeof(ProcessPriorityClass), prio);
    for (int i = 0; i < threads; i++) { var t = new Thread(() => { double x = 0; for (;;) x += Math.Sqrt(x + 1); }); t.IsBackground = true; t.Start(); }
    var f = new Form { Text = "KROOM-FG-HOG", WindowState = FormWindowState.Maximized, BackColor = System.Drawing.Color.Black };
    var timer = new System.Windows.Forms.Timer { Interval = 1000 }; int n = 0;
    timer.Tick += (s, e) => { if (n == 0) SetForegroundWindow(f.Handle); if (++n >= seconds) f.Close(); }; timer.Start();
    f.Shown += (s, e) => { f.Activate(); SetForegroundWindow(f.Handle); };
    Application.Run(f);
  }
}
'@
[Hog]::Run($Threads, $Priority, $Seconds, $Affinity)
