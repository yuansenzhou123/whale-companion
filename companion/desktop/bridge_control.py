"""Project-scoped bridge lifecycle; never terminate WeChat or other project copies."""
import ctypes
import json
import os
from pathlib import Path
import time
import psutil


def canonical(value):
    return os.path.normcase(os.path.abspath(str(value)))


class BridgeController:
    def __init__(self,root):
        self.root=Path(root).resolve()
        self.marker=self.root/'data/WECHAT_STOPPED'

    def role(self,process):
        name=process.name().lower()
        if name in ('python.exe','pythonw.exe'):
            scripts={'examples/wechatauto_bridge.py':'bridge'}
        elif name in ('powershell.exe','pwsh.exe'):
            scripts={'scripts/start-wechat-from-pet.ps1':'guard'}
        elif name=='cmd.exe':
            scripts={'启动微信桥接.bat':'guard','scripts/bridge_loop.bat':'guard'}
        else:return None
        for arg in process.cmdline()[1:]:
            # Only a complete script argument is trusted; no substring matching.
            arg=arg.strip('"')
            for relative,role in scripts.items():
                if Path(arg).name.lower()!=Path(relative).name.lower():continue
                candidate=Path(arg) if os.path.isabs(arg) else Path(process.cwd())/arg
                if canonical(candidate)==canonical(self.root/relative):return role
        return None

    def processes(self):
        result=[]
        for process in psutil.process_iter():
            try:
                if process.pid==os.getpid():continue
                role=self.role(process)
                if role:result.append((process,role,process.create_time()))
            except (OSError,psutil.Error):continue
        return result

    def status(self):
        found=self.processes()
        return {'running':bool(found),'bridgeCount':sum(role=='bridge' for _,role,_ in found),
                'guardCount':sum(role=='guard' for _,role,_ in found),'stopped':self.marker.exists()}

    def terminate(self,process,created):
        # Recheck the live PID, creation time and script before termination.
        current=psutil.Process(process.pid)
        if current.create_time()!=created or not self.role(current):return
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.OpenProcess.argtypes=[ctypes.c_uint,ctypes.c_int,ctypes.c_uint]
        kernel.OpenProcess.restype=ctypes.c_void_p
        kernel.TerminateProcess.argtypes=[ctypes.c_void_p,ctypes.c_uint]
        kernel.CloseHandle.argtypes=[ctypes.c_void_p]
        handle=kernel.OpenProcess(1,False,current.pid)
        if not handle:raise ctypes.WinError(ctypes.get_last_error())
        try:
            # Exit zero also tells an older batch launcher not to recover/retry.
            if not kernel.TerminateProcess(handle,0):raise ctypes.WinError(ctypes.get_last_error())
        finally:kernel.CloseHandle(handle)

    def stop(self):
        self.marker.parent.mkdir(parents=True,exist_ok=True)
        self.marker.write_text('Stopped from desktop pet\n',encoding='utf-8')
        deadline=time.monotonic()+8
        empty=0
        while time.monotonic()<deadline:
            found=self.processes()
            if not found:
                empty+=1
                if empty>=2:break
            else:
                empty=0
                # Stop recovery launchers before their bridge child.
                for process,role,created in sorted(found,key=lambda row:row[1]=='bridge'):
                    try:self.terminate(process,created)
                    except psutil.NoSuchProcess:pass
            time.sleep(.15)
        if self.processes():raise RuntimeError('bridge_process_still_running')
        # An earlier requested launch must not remove the newer stop marker.
        self.marker.write_text('Stopped from desktop pet\n',encoding='utf-8')
        file=self.root/'data/wechat-bridge-status.json'
        try:state=json.loads(file.read_text(encoding='utf-8'))
        except (OSError,ValueError):state={}
        state.update(stage='stopped',stoppedAt=time.time(),heartbeatAt=time.time())
        temp=file.with_suffix('.json.tmp');temp.write_text(json.dumps(state,ensure_ascii=False),encoding='utf-8');temp.replace(file)
        return {'status':'stopped','running':False}
