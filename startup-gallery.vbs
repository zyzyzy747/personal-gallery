' Startup launcher - runs at Windows logon, completely hidden.
'
' Sequence (same order as the old .bat, but with no windows at all):
'   1. stop leftovers
'   2. build the index (incremental, 1-2 min) THEN start the server
'      -- serial, because a visitor must never read a half-written index
'   3. start the Cloudflare tunnel (it retries until 8777 answers,
'      so it is fine that the server is still building)
'
' Copy this file into:
'   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
' and remove the old PhotoGallery.bat from there.

Option Explicit

Dim sh, q, base, py, app, cf, cfg, cmd, log
Dim wmi, procs, p

Set sh = CreateObject("WScript.Shell")
q = Chr(34)
base = "D:\work\workbuddy\2026-10-25-19-09-03"
py = "%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"
app = base & "\app"
cf = base & "\tools\cloudflared.exe"
cfg = "%USERPROFILE%\.cloudflared\config.yml"

If Not CreateObject("Scripting.FileSystemObject").FileExists(py) Then
  WScript.Quit 1
End If
If Not CreateObject("Scripting.FileSystemObject").FileExists(cf) Then
  WScript.Quit 1
End If

' ---- stop leftovers from a previous session -----------------------------
On Error Resume Next
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='python.exe'")
For Each p In procs
  If Not IsNull(p.CommandLine) Then
    If InStr(LCase(p.CommandLine), "serve.py") > 0 Then p.Terminate()
  End If
Next
sh.Run "cmd /c taskkill /F /IM cloudflared.exe >nul 2>&1", 0, True
On Error GoTo 0

WScript.Sleep 1500

' ---- build THEN serve, hidden, serial -----------------------------------
cmd = "cmd /c " & q & q & py & q & " " & q & app & "\build.py" & q & _
      " > " & q & base & "\last-build.log" & q & " 2>&1 && " & _
      q & py & q & " -u " & q & app & "\serve.py" & q & _
      " 8777 > " & q & base & "\last-serve.log" & q & " 2>&1" & q
sh.Run cmd, 0, False

' ---- tunnel, hidden ------------------------------------------------------
WScript.Sleep 3000
sh.Run q & cf & q & " tunnel --config " & q & cfg & q & " run gallery", 0, False
