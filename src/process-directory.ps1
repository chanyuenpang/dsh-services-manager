param([int]$TargetProcessId = 33860)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class RepairProcessDirectory {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr read);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsWow64Process(IntPtr h, out bool wow64);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int infoClass, byte[] info, int length, out int returned);
  static byte[] Read(IntPtr h, long address, int size) {
    byte[] b=new byte[size]; UIntPtr read;
    if(!ReadProcessMemory(h,new IntPtr(address),b,new UIntPtr((uint)size),out read) || read.ToUInt64()!=(ulong)size) throw new Win32Exception(Marshal.GetLastWin32Error());
    return b;
  }
  public static string Get(int pid) {
    if(IntPtr.Size!=8) throw new Exception("Requires x64 PowerShell");
    IntPtr h=OpenProcess(0x410,false,pid);
    if(h==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      bool wow; if(!IsWow64Process(h,out wow)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if(wow) throw new Exception("Refuse unverified WOW64 offsets");
      byte[] info=new byte[48]; int returned;
      int status=NtQueryInformationProcess(h,0,info,info.Length,out returned);
      if(status!=0) throw new Exception("NtQueryInformationProcess status "+status);
      long peb=BitConverter.ToInt64(info,8);
      long parameters=BitConverter.ToInt64(Read(h,peb+0x20,8),0);
      byte[] name=Read(h,parameters+0x38,16);
      int length=BitConverter.ToUInt16(name,0); long address=BitConverter.ToInt64(name,8);
      if(length<2 || length>32766 || length%2!=0) throw new Exception("Invalid directory string length");
      return System.Text.Encoding.Unicode.GetString(Read(h,address,length));
    } finally {CloseHandle(h);}
  }
}
'@
$before = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetProcessId"
$directory = [RepairProcessDirectory]::Get($TargetProcessId)
$after = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetProcessId"
if ($null -eq $before -or $null -eq $after -or $before.CreationDate -ne $after.CreationDate -or $before.CommandLine -cne $after.CommandLine) { throw 'Process identity changed during directory read' }
[pscustomobject]@{ pid = $TargetProcessId; commandLine = $after.CommandLine; cwd = $directory } | ConvertTo-Json -Compress
