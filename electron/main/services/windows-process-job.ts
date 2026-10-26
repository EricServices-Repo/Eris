/** A Windows Job Object owns the suspended command before any repository code runs.
 * Closing the wrapper (including forced termination) closes its only Job handle.
 */
export const WINDOWS_PROCESS_JOB = String.raw`
$ErrorActionPreference = 'Stop'
if ($env:ERIS_OWNED_TRACE -eq '1') { [Console]::Error.WriteLine('Eris job: compiling launcher') }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ErisOwnedCommand {
 [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long a,b; public uint flags; public UIntPtr c,d; public uint e; public UIntPtr f; public uint g,h; }
 [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit basic; public Io io; public UIntPtr a,b,c,d; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup { public uint cb; public string a,b,c; public uint d,e,f,g,h,i,j,flags; public short k,l; public IntPtr m,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attr,string name);
 [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job,int type,ref ExtendedLimit info,uint size);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,System.Text.StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup start,out ProcessInfo info);
 [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
 static void Trace(string message) { if(Environment.GetEnvironmentVariable("ERIS_OWNED_TRACE")=="1") Console.Error.WriteLine("Eris job: "+message); }
 public static int Run() {
   Trace("creating job");
   IntPtr job=CreateJobObject(IntPtr.Zero,null);
   ProcessInfo child=new ProcessInfo();
   if(job==IntPtr.Zero) throw new Exception("Could not create owned command Job Object");
   try {
     ExtendedLimit limits=new ExtendedLimit(); limits.basic.flags=0x2000;
     if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimit)))) throw new Exception("Could not configure kill-on-close Job Object");
     Trace("job configured");
     string command=Environment.GetEnvironmentVariable("ERIS_OWNED_COMMAND");
     Environment.SetEnvironmentVariable("ERIS_OWNED_COMMAND",null);
     string shell=System.IO.Path.Combine(Environment.GetEnvironmentVariable("SystemRoot"),"System32","cmd.exe");
     Startup start=new Startup(); start.cb=(uint)Marshal.SizeOf(typeof(Startup)); start.flags=0x100;
     start.input=GetStdHandle(-10);start.output=GetStdHandle(-11);start.error=GetStdHandle(-12);
     var line=new System.Text.StringBuilder("\""+shell+"\" /d /s /c \""+command+"\"");
     if(!CreateProcess(shell,line,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,Environment.CurrentDirectory,ref start,out child)) throw new Exception("Could not create suspended command: "+Marshal.GetLastWin32Error());
     Trace("suspended child created");
     if(!AssignProcessToJobObject(job,child.process)) throw new Exception("Could not assign command to Job Object; unrestricted execution refused");
     Trace("child assigned");
     if(ResumeThread(child.thread)==0xffffffff) throw new Exception("Could not resume owned command");
     Trace("child resumed");
     WaitForSingleObject(child.process,0xffffffff);
     Trace("child exited");
     uint code;if(!GetExitCodeProcess(child.process,out code)) throw new Exception("Could not read command exit status");
     return unchecked((int)code);
   } finally {
     if(child.process!=IntPtr.Zero) { TerminateProcess(child.process,1); CloseHandle(child.process); }
     if(child.thread!=IntPtr.Zero) CloseHandle(child.thread);
     CloseHandle(job);
   }
 }
}
'@
if ($env:ERIS_OWNED_TRACE -eq '1') { [Console]::Error.WriteLine('Eris job: compiled launcher') }
try { exit ([ErisOwnedCommand]::Run()) } catch { [Console]::Error.WriteLine($_); exit 1 }
`
