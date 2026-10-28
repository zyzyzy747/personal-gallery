' Stop the photo gallery (server + tunnel), silently.
'
' Double-click to stop everything. A confirmation pops up when done,
' because with no windows there is otherwise nothing to look at.

Option Explicit

Dim sh, wmi, procs, p, killed
Set sh = CreateObject("WScript.Shell")
killed = 0

On Error Resume Next

' ---- server: python.exe whose command line contains serve.py -------------
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='python.exe'")
For Each p In procs
  If Not IsNull(p.CommandLine) Then
    If InStr(LCase(p.CommandLine), "serve.py") > 0 Then
      p.Terminate()
      killed = killed + 1
    End If
  End If
Next

' ---- tunnel --------------------------------------------------------------
Dim rc
rc = sh.Run("cmd /c taskkill /F /IM cloudflared.exe >nul 2>&1", 0, True)
If rc = 0 Then killed = killed + 1

On Error GoTo 0

If killed = 0 Then
  MsgBox "Nothing was running.", 64, "Gallery"
Else
  MsgBox "Gallery stopped." & vbCrLf & vbCrLf & _
         "Local site and phone access are both off now." & vbCrLf & _
         "Run start-gallery.vbs to bring it back.", 64, "Gallery"
End If
