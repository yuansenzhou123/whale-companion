"""Find only WeChat's own windows or native dialogs linked by a real owner chain."""
def belongs_to_wechat(hwnd,pid,main_hwnd,main_pid,owner_of,pid_of,root_of):
    if pid==main_pid:return True
    if not hwnd:return False
    seen=set();current=hwnd
    for _ in range(12):
        if not current or current in seen:return False
        seen.add(current)
        if current!=hwnd and ((main_hwnd and (current==main_hwnd or root_of(current)==main_hwnd)) or pid_of(current)==main_pid):return True
        current=owner_of(current)
    return False

def related_roots(main):
    import uiautomation as automation
    import win32gui,win32process,win32con
    main_pid=main.ProcessId;main_hwnd=getattr(main,'NativeWindowHandle',0);parent=main
    for _ in range(6):
        if main_hwnd:break
        try:parent=parent.GetParentControl();main_hwnd=getattr(parent,'NativeWindowHandle',0)
        except Exception:break
    if main_hwnd:main_hwnd=win32gui.GetAncestor(main_hwnd,win32con.GA_ROOT)
    result=[]
    for window in automation.GetRootControl().GetChildren():
        try:
            hwnd=getattr(window,'NativeWindowHandle',0);pid=window.ProcessId
            if belongs_to_wechat(hwnd,pid,main_hwnd,main_pid,
                owner_of=lambda value:win32gui.GetWindow(value,win32con.GW_OWNER),
                pid_of=lambda value:win32process.GetWindowThreadProcessId(value)[1],
                root_of=lambda value:win32gui.GetAncestor(value,win32con.GA_ROOT)):result.append(window)
        except Exception:continue
    return result
