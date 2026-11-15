# When does each app's window first appear on screen? Launch → the first visible top-level window of its process (ms), median of N runs.
#   powershell -File desktop-rs/tests/bench-window.ps1 <electron K ROOM.exe> <rust kroom.exe> [runs]
param([string]$Electron, [string]$Rust, [int]$Runs = 5)
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class W {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L, T, R, B; }
  public static bool Visible(HashSet<uint> pids) {
    bool found = false;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); RECT r;
      if (pids.Contains(p) && IsWindowVisible(h) && GetWindowRect(h, out r) && (r.R - r.L) > 300 && (r.B - r.T) > 200) { found = true; return false; } return true; }, IntPtr.Zero);
    return found;
  }
}
"@
$prof = Join-Path $env:TEMP ("kroom-bench-win-" + [guid]::NewGuid())
function Once($exe, $argList) {
  $env:KROOM_NO_UPDATE = '1'
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = if ($argList) { Start-Process -FilePath $exe -ArgumentList $argList -PassThru } else { Start-Process -FilePath $exe -PassThru }
  $ms = -1
  while ($sw.ElapsedMilliseconds -lt 20000) {
    $pids = New-Object 'System.Collections.Generic.HashSet[uint32]'; [void]$pids.Add([uint32]$p.Id)
    if ([W]::Visible($pids)) { $ms = $sw.ElapsedMilliseconds; break }
    Start-Sleep -Milliseconds 5
  }
  Start-Sleep -Seconds 2
  taskkill /T /F /PID $p.Id 2>&1 | Out-Null
  Start-Sleep -Seconds 2
  return $ms
}
$e = @(); $r = @()
[void](Once $Electron "--user-data-dir=`"$prof`""); [void](Once $Rust $null)   # warm-up
for ($i = 0; $i -lt $Runs; $i++) { $e += Once $Electron "--user-data-dir=`"$prof`""; $r += Once $Rust $null }
function Med($a) { ($a | Sort-Object)[[int][math]::Floor($a.Count / 2)] }
"Electron: window visible after $(Med $e) ms   ($($e -join ' '))"
"Rust:     window visible after $(Med $r) ms   ($($r -join ' '))"
Remove-Item -Recurse -Force $prof -ErrorAction SilentlyContinue
