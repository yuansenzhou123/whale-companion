"""Stop a known version's own processes using exact executable and script paths."""
import argparse,ctypes,json,os,pathlib,time
import psutil

def canonical(path):return os.path.normcase(os.path.abspath(path))
def matches_script(process,root,relative):
    expected=canonical(root/relative)
    for arg in process.cmdline()[1:]:
        if pathlib.PureWindowsPath(arg).name.lower()!=pathlib.PureWindowsPath(relative).name.lower():continue
        actual=canonical(pathlib.Path(arg) if os.path.isabs(arg) else pathlib.Path(process.cwd())/arg)
        if actual==expected:return True
    return False
def selected(root,server_only=False):
    node=canonical(root/'runtime/node.exe');python=canonical(root/'runtime/python/python.exe');found=[]
    python_scripts=['examples/wechatauto_bridge.py','companion/desktop/live2d_pet.py','companion/desktop/capture_client.py','tools/hotkey_daemon.py']
    shell_scripts=['scripts/run-companion-window.ps1','scripts/start-wechat-from-pet.ps1','companion/desktop/media-session.ps1']
    for p in psutil.process_iter():
        try:
            if p.pid==os.getpid():continue
            exe=canonical(p.exe())
            if exe==node and matches_script(p,root,'server.js'):found.append(p)
            elif not server_only and exe==python and any(matches_script(p,root,s) for s in python_scripts):found.append(p)
            elif not server_only and pathlib.PureWindowsPath(exe).name.lower() in ('powershell.exe','pwsh.exe') and any(matches_script(p,root,s) for s in shell_scripts):found.append(p)
        except (OSError,psutil.Error):pass
    return found
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--check-only',action='store_true');parser.add_argument('--server-only',action='store_true');args=parser.parse_args()
    root=pathlib.Path(args.root).resolve()
    if root.name!='whale-girl-3.0-full' or root.parent.name not in ('whale-girl-3.0-full - 2','whale-girl-3.0-full - 3'):raise SystemExit('Refusing unrecognized project path')
    if not (root/'server.js').is_file():raise SystemExit('Project missing')
    targets=selected(root,args.server_only)
    if args.check_only:print(json.dumps({'checkOnly':True,'matchedProcesses':len(targets)}));return
    if not args.server_only:(root/'data/PAUSED').write_text('Version switched',encoding='utf-8')
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.OpenProcess.argtypes=[ctypes.c_uint,ctypes.c_int,ctypes.c_uint];kernel.OpenProcess.restype=ctypes.c_void_p
    kernel.TerminateProcess.argtypes=[ctypes.c_void_p,ctypes.c_uint];kernel.CloseHandle.argtypes=[ctypes.c_void_p]
    for p in targets:
        # Recheck identity immediately before termination to guard against PID reuse.
        try:
            if not any(q.pid==p.pid and q.create_time()==p.create_time() for q in selected(root,args.server_only)):continue
            handle=kernel.OpenProcess(1,False,p.pid)
            if not handle:raise ctypes.WinError(ctypes.get_last_error())
            try:
                if not kernel.TerminateProcess(handle,0):raise ctypes.WinError(ctypes.get_last_error())
            finally:kernel.CloseHandle(handle)
        except psutil.NoSuchProcess:pass
    psutil.wait_procs(targets,timeout=8)
    remaining=selected(root,args.server_only)
    print(json.dumps({'stopped':len(targets),'remaining':len(remaining)}))
    if remaining:raise SystemExit(1)
if __name__=='__main__':main()
