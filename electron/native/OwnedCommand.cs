// Compiled at build/test time, never from a chat turn. Windows 10+ Job-list
// process creation establishes ownership atomically before repository code runs.
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ErisOwnedCommand {
 [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long a,b; public uint flags; public UIntPtr c,d; public uint e; public UIntPtr f; public uint g,h; }
 [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit basic; public Io io; public UIntPtr a,b,c,d; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup { public uint cb; public string a,b,c; public uint d,e,f,g,h,i,j,flags; public short k,l; public IntPtr m,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup basic; public IntPtr attributes; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attr,string name);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref ExtendedLimit info,uint size);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref StartupEx start,out ProcessInfo info);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
 static Exception Failure(string action) { return new Exception(action+": "+Marshal.GetLastWin32Error()); }
 public static int Main() {
   IntPtr job=IntPtr.Zero,list=IntPtr.Zero,jobs=IntPtr.Zero;
   bool initialized=false;
   ProcessInfo child=new ProcessInfo();
   try {
     job=CreateJobObject(IntPtr.Zero,null);
     if(job==IntPtr.Zero) throw Failure("Create owned command Job Object");
     ExtendedLimit limits=new ExtendedLimit(); limits.basic.flags=0x2000;
     if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimit)))) throw Failure("Configure kill-on-close Job Object");
     IntPtr size=IntPtr.Zero;
     InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
     if(size==IntPtr.Zero) throw Failure("Size process attribute list");
     list=Marshal.AllocHGlobal(size);
     if(!InitializeProcThreadAttributeList(list,1,0,ref size)) throw Failure("Initialize process attribute list");
     initialized=true;
     jobs=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobs,job);
     if(!UpdateProcThreadAttribute(list,0,new IntPtr(0x2000D),jobs,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero)) throw Failure("Configure atomic Job assignment; unrestricted execution refused");
     string command=Environment.GetEnvironmentVariable("ERIS_OWNED_COMMAND");
     Environment.SetEnvironmentVariable("ERIS_OWNED_COMMAND",null);
     if(String.IsNullOrEmpty(command)) throw new Exception("Missing owned command");
     string shell=System.IO.Path.Combine(Environment.GetEnvironmentVariable("SystemRoot"),"System32","cmd.exe");
     StartupEx start=new StartupEx();start.basic.cb=(uint)Marshal.SizeOf(typeof(StartupEx));start.basic.flags=0x100;start.attributes=list;
     start.basic.input=GetStdHandle(-10);start.basic.output=GetStdHandle(-11);start.basic.error=GetStdHandle(-12);
     var line=new StringBuilder("\""+shell+"\" /d /s /c \""+command+"\"");
     if(!CreateProcess(shell,line,IntPtr.Zero,IntPtr.Zero,true,0x08080000,IntPtr.Zero,Environment.CurrentDirectory,ref start,out child)) throw Failure("Create command inside owned Job; unrestricted execution refused");
     if(WaitForSingleObject(child.process,0xffffffff)!=0) throw Failure("Wait for owned command");
     uint code;if(!GetExitCodeProcess(child.process,out code)) throw Failure("Read command exit status");
     return unchecked((int)code);
   } catch(Exception error) { Console.Error.WriteLine(error.Message);return 1;
   } finally {
     // The non-inheritable Job handle is held only by this helper. Any exit,
     // including forced termination, kills all still-running descendants.
     if(job!=IntPtr.Zero) CloseHandle(job);
     if(child.process!=IntPtr.Zero) CloseHandle(child.process);
     if(child.thread!=IntPtr.Zero) CloseHandle(child.thread);
     if(initialized) DeleteProcThreadAttributeList(list);
     if(list!=IntPtr.Zero) Marshal.FreeHGlobal(list);
     if(jobs!=IntPtr.Zero) Marshal.FreeHGlobal(jobs);
   }
 }
}
