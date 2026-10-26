"""Find this project's real pet window and reveal it; never trust a stale PID file."""
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import time

ROOT=Path(__file__).resolve().parents[2]
REVEAL_MESSAGE=0x8000+87

def mutex_name(root=ROOT):
    identity=os.path.normcase(str(Path(root).resolve())).encode('utf-8')
    return 'Local\\WhaleGirlWatchPet-'+hashlib.sha256(identity).hexdigest()[:12]

def process_image(pid):
    kernel=ctypes.windll.kernel32
    kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD]
    kernel.OpenProcess.restype=wintypes.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes=[wintypes.HANDLE,wintypes.DWORD,wintypes.LPWSTR,ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes=[wintypes.HANDLE]
    handle=kernel.OpenProcess(0x1000,False,pid)
    if not handle:return ''
    try:
        size=wintypes.DWORD(32768)
        value=ctypes.create_unicode_buffer(size.value)
        if kernel.QueryFullProcessImageNameW(handle,0,value,ctypes.byref(size)):
            return value.value
        return ''
    finally:kernel.CloseHandle(handle)

def find_instances(root=ROOT):
    import win32gui,win32process
    expected=os.path.normcase(str((Path(root)/'runtime/python/python.exe').resolve()))
    found=[]
    def inspect(hwnd,_):
        try:
            if win32gui.GetClassName(hwnd)!='WhaleGirlNativeLive2D':return
            pid=win32process.GetWindowThreadProcessId(hwnd)[1]
            image=process_image(pid)
            if image and os.path.normcase(str(Path(image).resolve()))==expected:
                found.append((hwnd,pid))
        except Exception:pass
    win32gui.EnumWindows(inspect,None)
    return found

def visible_position(rect,work):
    x,y,right,bottom=rect
    width,height=right-x,bottom-y
    left,top,end,base=work
    return (min(max(x,left+8),max(left+8,end-width-8)),min(max(y,top+8),max(top+8,base-height-8)))

def reveal_existing(root=ROOT):
    import win32api,win32con,win32gui
    windows=find_instances(root)
    if not windows:return {'found':False}
    hwnd,pid=windows[0]
    win32gui.PostMessage(hwnd,REVEAL_MESSAGE,0,0)
    deadline=time.monotonic()+.8
    while time.monotonic()<deadline and not win32gui.IsWindowVisible(hwnd):time.sleep(.04)
    # Previous versions know the tray double-click event, but not REVEAL_MESSAGE.
    if not win32gui.IsWindowVisible(hwnd):
        win32gui.PostMessage(hwnd,win32con.WM_USER+24,1,win32con.WM_LBUTTONDBLCLK)
        deadline=time.monotonic()+1.5
        while time.monotonic()<deadline and not win32gui.IsWindowVisible(hwnd):time.sleep(.04)
    if not win32gui.IsWindowVisible(hwnd):
        raise RuntimeError('桌宠窗口暂时没有响应，请查看 data/live2d-pet.stderr.log。')
    monitor=win32api.MonitorFromWindow(hwnd,win32con.MONITOR_DEFAULTTONEAREST)
    work=win32api.GetMonitorInfo(monitor)['Work']
    x,y=visible_position(win32gui.GetWindowRect(hwnd),work)
    win32gui.SetWindowPos(hwnd,win32con.HWND_TOPMOST,x,y,0,0,win32con.SWP_NOSIZE|win32con.SWP_NOACTIVATE)
    return {'found':True,'pid':pid,'visible':True}

if __name__=='__main__':
    try:ctypes.windll.user32.SetProcessDPIAware()
    except Exception:pass
    print(json.dumps(reveal_existing(),ensure_ascii=True))
