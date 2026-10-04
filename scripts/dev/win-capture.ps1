# Captures one window's own pixels via PrintWindow, so a covered window still screenshots.
# Selection is by process name: CJK arguments do not survive this console's codepage.
param(
  [string]$Process = 'electron',
  [string]$Out = (Join-Path ([System.IO.Path]::GetTempPath()) 'bonfire-window.png')
)
Add-Type -AssemblyName System.Drawing
$src = @"
using System;
using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
Add-Type $src

$pids = @{}
Get-Process -Name $Process -ErrorAction SilentlyContinue | ForEach-Object { $pids[[uint32]$_.Id] = $true }
if ($pids.Count -eq 0) { Write-Output "no process named $Process"; exit 1 }

$found = New-Object System.Collections.ArrayList
$cb = {
  param($h, $l)
  if ([Win]::IsWindowVisible($h)) {
    $pid2 = [uint32]0
    [Win]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
    if ($pids.ContainsKey($pid2)) {
      $r = New-Object Win+RECT
      [Win]::GetWindowRect($h, [ref]$r) | Out-Null
      $area = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
      if ($area -gt 40000) {
        $found.Add([pscustomobject]@{ H = $h; Area = $area; Rect = $r }) | Out-Null
      }
    }
  }
  return $true
}
[Win]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ($found.Count -eq 0) { Write-Output "no visible window for $Process"; exit 1 }
$best = $found | Sort-Object Area -Descending | Select-Object -First 1
$hwnd = $best.H
$rect = $best.Rect
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { Write-Output "degenerate size ${w}x${h}"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $gfx.GetHdc()
# PW_RENDERFULLCONTENT = 2: needed for Chromium-composited windows
$ok = [Win]::PrintWindow($hwnd, $hdc, 2)
$gfx.ReleaseHdc($hdc)
$bmp.Save($Out)
$gfx.Dispose()
$bmp.Dispose()
Write-Output "saved ${w}x${h} ok=$ok hwnd=$hwnd -> $Out"
