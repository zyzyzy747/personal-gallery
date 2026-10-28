' Silent launcher for the photo gallery.
'
' Why this exists: serve.py and cloudflared are both console programs, so
' starting them normally always leaves a window somewhere - visible, or
' minimized in the taskbar. WScript.Shell.Run with window style 0 starts
' them completely hidden: no window, no taskbar button, nothing on screen.
'
' Output still goes to log files, so nothing is lost:
'   last-serve.log   server
'   tools\service.log  tunnel
'
' Double-click this file to start. Use stop-gallery.vbs to stop.

Option Explicit

Dim sh, q, base, py, app, cf, cfg, cmd
Dim wmi, procs, p

Set sh = CreateObject("WScript.Shell")
q = Chr(34)
base = "D:\work\workbuddy\2026-10-25-19-09-03"
py = "C:\Users\Administrator\.workbuddy\binaries\python\versions\3.13.12\python.exe"
app = base & "\app"
cf = base & "\tools\cloudflared.exe"
cfg = "C:\Users\Administrator\.cloudflared\config.yml"

If Not CreateObject("Scripting.FileSystemObject").FileExists(py) Then
  MsgBox "Python not found:" & vbCrLf & py, 16, "Gallery"
  WScript.Quit 1
End If

' ---- 1. stop any old server (python.exe running serve.py) ----------------
On Error Resume Next
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='python.exe'")
For Each p In procs
  If Not IsNull(p.CommandLine) Then
    If InStr(LCase(p.CommandLine), "serve.py") > 0 Then p.Terminate()
  End If
Next

' ---- 2. stop any old tunnel ---------------------------------------------
sh.Run "cmd /c taskkill /F /IM cloudflared.exe >nul 2>&1", 0, True
On Error GoTo 0

WScript.Sleep 1500

' ---- 3. start server, hidden -------------------------------------------
' cmd /c ""python.exe" "serve.py" 8777 > "log" 2>&1"
' The doubled quote after /c is required when the first token is quoted.
' -u = unbuffered: without it, print() output sits in a 4KB buffer and
' last-serve.log stays EMPTY for as long as the server runs.
cmd = "cmd /c " & q & q & py & q & " -u " & q & app & "\serve.py" & q & _
      " 8777 > " & q & base & "\last-serve.log" & q & " 2>&1" & q
sh.Run cmd, 0, False

' ---- 4. start tunnel, hidden -------------------------------------------
WScript.Sleep 2000
sh.Run q & cf & q & " tunnel --config " & q & cfg & q & " run gallery", 0, False

' ---- 5. tell the user, then disappear ----------------------------------
MsgBox "Gallery started." & vbCrLf & vbCrLf & _
       "No window will appear - that is normal." & vbCrLf & _
       "Open: http://127.0.0.1:8777/index.html" & vbCrLf & vbCrLf & _
       "Logs: last-serve.log  |  tools\service.log", 64, "Gallery"
