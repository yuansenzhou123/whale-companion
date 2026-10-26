"""Transparent native Windows Live2D pet with the existing companion service."""
import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import queue
import sys
import threading
import time
import traceback
import webbrowser

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
DATA = ROOT/'data'
WIDTH, BODY_HEIGHT, HEADER = 400, 440, 160
HEIGHT = BODY_HEIGHT + HEADER
MOOD_LABELS = {'neutral':'平常', 'happy':'开心', 'surprised':'惊讶', 'sad':'难过', 'curious':'好奇', 'thinking':'思考', 'sleepy':'困困'}

def presentation(state, now_ms):
    if not state:
        return 'sleepy', '鲸鲸 · 陪你看', '鲸鲸就位～等你放视频啦', False
    scene = state.get('dateScene')
    if scene and not state.get('paused', state.get('status') == 'paused'):
        bubble = scene.get('bubble') or {}
        age = now_ms - (bubble.get('at') or 0)
        if bubble.get('text') and 0 <= age < 40000:
            return bubble.get('emotion', 'happy'), scene.get('label', '鲸鲸 · 陪你'), bubble['text'], age < 6500
        if scene.get('kind') == 'quiet':
            return 'sleepy', scene.get('label', '安静陪你'), '我在呢，你忙你的～', False
        if scene.get('phase') != 'closing' and state.get('status') != 'watching':
            return 'happy', scene.get('label', '鲸鲸 · 陪你'), '这一小会儿，分给你啦～', False
    status = state.get('status')
    title = (state.get('video') or {}).get('title') or '鲸鲸 · 陪你看'
    age = now_ms - (state.get('commentAt') or 0)
    recent = bool(state.get('comment')) and 0 <= age < 40000
    if recent:
        text = state['comment']
    elif status == 'watching':
        text = '唔，让我瞅瞅这一段…' if state.get('busy') else '我有在看哦，先不吵你～'
    elif status == 'paused':
        text = '歇一小会儿，右键就能叫醒我啦'
    elif status == 'waiting':
        text = '你按暂停，那我也偷偷懒～'
    else:
        text = '鲸鲸就位～等你放视频啦'
    return state.get('expression', 'sleepy'), title, text, recent and age < 6500

def launch_wechat_bridge(root=ROOT):
    import subprocess
    helper = Path(root)/'scripts/start-wechat-from-pet.ps1'
    if not helper.is_file() or not (Path(root)/'启动微信桥接.bat').is_file():
        raise FileNotFoundError('微信桥接启动文件缺失')
    powershell = Path(os.environ.get('SystemRoot', r'C:\Windows'))/'System32/WindowsPowerShell/v1.0/powershell.exe'
    log = Path(root)/'data/wechat-menu-launch.log'
    log.parent.mkdir(parents=True,exist_ok=True)
    with log.open('ab') as output:
        return subprocess.Popen([str(powershell),'-NoProfile','-ExecutionPolicy','Bypass','-File',str(helper)],cwd=str(root),stdin=subprocess.DEVNULL,stdout=output,stderr=output,creationflags=subprocess.CREATE_NO_WINDOW)


def request_wechat_bridge(root=ROOT):
    import subprocess
    helper=Path(root)/'scripts/start-wechat-from-pet.ps1'
    powershell=Path(os.environ.get('SystemRoot',r'C:\Windows'))/'System32/WindowsPowerShell/v1.0/powershell.exe'
    result=subprocess.run([str(powershell),'-NoProfile','-ExecutionPolicy','Bypass','-File',str(helper),'-CheckOnly'],cwd=str(root),stdin=subprocess.DEVNULL,capture_output=True,text=True,check=True,timeout=8,creationflags=subprocess.CREATE_NO_WINDOW)
    status=json.loads(result.stdout).get('status')
    if status=='alreadyRunning':
        try:
            state=json.loads((Path(root)/'data/wechat-bridge-status.json').read_text(encoding='utf-8'))
            if time.time()-state.get('heartbeatAt',0)<20:
                if state.get('stage')=='listening':return '微信桥接正在监听新消息～'
                if state.get('stage')=='waiting_for_wechat':return '微信客户端还没打开，我在等它～'
                if state.get('stage')=='reconnecting':return '正在重新连接微信，稍等一下下～'
                return '正在建立微信消息监听，稍等一下～'
        except (OSError,ValueError):pass
        return '桥接进程已打开，接收状态还未更新～'
    if status!='ready':
        raise ValueError('Unexpected bridge launcher status')
    launch_wechat_bridge(root)
    return '微信桥接正在启动，稍等一下下～'


def wrap_text(text, font, width, lines=3):
    result, line = [], ''
    for ch in str(text).replace('\n', ' '):
        if line and font.getlength(line + ch) > width:
            result.append(line)
            line = ''
        if len(result) == lines:
            result[-1] = result[-1][:-1] + '…'
            return result
        line += ch
    if line:
        result.append(line)
    return result

def apply_capture_policy(hwnd, allowed):
    api = ctypes.WinDLL('user32',use_last_error=True).SetWindowDisplayAffinity
    api.argtypes = [wintypes.HWND,wintypes.DWORD]
    api.restype = wintypes.BOOL
    if not api(hwnd,0 if allowed else 0x11):
        raise ctypes.WinError(ctypes.get_last_error())

class Backend:
    def __init__(self, endpoint):
        self.endpoint = endpoint.rstrip('/')
        self.state = None
        self.commands = queue.Queue()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def post(self, route, body):
        self.commands.put((route, body))

    def run(self):
        import requests
        http = requests.Session()
        http.trust_env = False
        token = ''
        while not self.stop.is_set():
            try:
                if not token:
                    response = http.get(self.endpoint+'/api/companion/bootstrap', timeout=3)
                    response.raise_for_status()
                    token = response.json()['token']
                headers = {'Authorization': 'Bearer '+token}
                while not self.commands.empty():
                    route, body = self.commands.get_nowait()
                    response = http.post(self.endpoint+'/api/companion/'+route, headers=headers, json=body, timeout=3)
                    if response.status_code == 403:
                        token = ''
                    response.raise_for_status()
                response = http.get(self.endpoint+'/api/companion/state', headers=headers, timeout=3)
                if response.status_code == 403:
                    token = ''
                response.raise_for_status()
                self.state = response.json()
            except Exception:
                # Never print request headers or the pairing token.
                if self.state:
                    self.state = {**self.state, 'status': 'disconnected', 'expression': 'sleepy', 'comment': ''}
            self.stop.wait(1.8)
        http.close()

class BitmapInfoHeader(ctypes.Structure):
    _fields_ = [('biSize',wintypes.DWORD), ('biWidth',wintypes.LONG), ('biHeight',wintypes.LONG), ('biPlanes',wintypes.WORD), ('biBitCount',wintypes.WORD), ('biCompression',wintypes.DWORD), ('biSizeImage',wintypes.DWORD), ('biXPelsPerMeter',wintypes.LONG), ('biYPelsPerMeter',wintypes.LONG), ('biClrUsed',wintypes.DWORD), ('biClrImportant',wintypes.DWORD)]

class BitmapInfo(ctypes.Structure):
    _fields_ = [('bmiHeader',BitmapInfoHeader), ('bmiColors',wintypes.DWORD*3)]

class LayeredBitmap:
    def __init__(self, width, height):
        import win32gui
        self.gui = win32gui
        self.width, self.height = width, height
        self.screen = win32gui.GetDC(0)
        self.dc = win32gui.CreateCompatibleDC(self.screen)
        info = BitmapInfo()
        info.bmiHeader = BitmapInfoHeader(ctypes.sizeof(BitmapInfoHeader), width, -height, 1, 32, 0, width*height*4, 0, 0, 0, 0)
        self.bits = ctypes.c_void_p()
        create = ctypes.windll.gdi32.CreateDIBSection
        create.argtypes = [wintypes.HDC, ctypes.POINTER(BitmapInfo), wintypes.UINT, ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD]
        create.restype = wintypes.HBITMAP
        self.bitmap = create(self.dc, ctypes.byref(info), 0, ctypes.byref(self.bits), None, 0)
        if not self.bitmap:
            raise ctypes.WinError()
        self.original = win32gui.SelectObject(self.dc, self.bitmap)

    def present(self, hwnd, image):
        import numpy as np
        rgba = np.asarray(image).copy()
        rgba[:,:,:3] = ((rgba[:,:,:3].astype(np.uint16)*rgba[:,:,3:4]+127)//255).astype(np.uint8)
        pixels = rgba[:,:,[2,1,0,3]].tobytes()
        ctypes.memmove(self.bits, pixels, len(pixels))
        x, y, _, _ = self.gui.GetWindowRect(hwnd)
        self.gui.UpdateLayeredWindow(hwnd, self.screen, (x,y), (self.width,self.height), self.dc, (0,0), 0, (0,0,255,1), 2)

    def close(self):
        self.gui.SelectObject(self.dc, self.original)
        self.gui.DeleteObject(self.bitmap)
        self.gui.DeleteDC(self.dc)
        self.gui.ReleaseDC(0, self.screen)

class Pet:
    def __init__(self, endpoint):
        import win32api, win32con, win32gui
        from speech_bubble import BubblePainter
        from live2d_renderer import Live2DRenderer
        self.gui, self.con, self.api = win32gui, win32con, win32api
        self.renderer = Live2DRenderer(width=WIDTH, height=BODY_HEIGHT, preferences=DATA/'live2d-controls.json')
        self.controls = self.renderer.controls
        self.last_frame_at = time.monotonic()
        self.backend = Backend(endpoint)
        self.endpoint = endpoint
        self.running, self.visible = True, True
        self.drag = None
        self.override = None
        self.touch_until = 0
        self.bubble_painter = BubblePainter(WIDTH,HEADER)
        self.bitmap = LayeredBitmap(WIDTH, HEIGHT)
        self.tray_message = win32con.WM_USER + 24
        wc = win32gui.WNDCLASS()
        wc.style = win32con.CS_DBLCLKS
        wc.lpfnWndProc = self.wndproc
        wc.hInstance = win32api.GetModuleHandle(None)
        wc.lpszClassName = 'WhaleGirlNativeLive2D'
        wc.hCursor = win32gui.LoadCursor(0, win32con.IDC_ARROW)
        win32gui.RegisterClass(wc)
        work = win32api.GetMonitorInfo(win32api.MonitorFromPoint((0,0), win32con.MONITOR_DEFAULTTOPRIMARY))['Work']
        x, y = work[2]-WIDTH-24, work[3]-HEIGHT-20
        try:
            position = json.loads((DATA/'live2d-window.json').read_text())
            sx, sy = int(position['x']), int(position['y'])
            sy += int(position.get('height',548))-HEIGHT
            if win32api.MonitorFromPoint((sx+WIDTH//2,sy+HEIGHT//2), win32con.MONITOR_DEFAULTTONULL):
                x, y = sx, sy
        except Exception:
            pass
        style = win32con.WS_EX_LAYERED | win32con.WS_EX_TOOLWINDOW | win32con.WS_EX_TOPMOST | 0x08000000
        self.hwnd = win32gui.CreateWindowEx(style, wc.lpszClassName, '鲸鲸陪看桌宠', win32con.WS_POPUP, x, y, WIDTH, HEIGHT, 0, 0, wc.hInstance, None)
        apply_capture_policy(self.hwnd,self.controls.allow_capture)
        self.icon = win32gui.LoadIcon(0, win32con.IDI_APPLICATION)
        win32gui.Shell_NotifyIcon(win32gui.NIM_ADD, (self.hwnd,1,win32gui.NIF_ICON|win32gui.NIF_MESSAGE|win32gui.NIF_TIP,self.tray_message,self.icon,'鲸鲸 · Live2D陪看'))
        self.render()
        self.reveal()

    def save_position(self):
        x, y, _, _ = self.gui.GetWindowRect(self.hwnd)
        (DATA/'live2d-window.json').write_text(json.dumps({'x':x,'y':y,'height':HEIGHT}), encoding='utf-8')

    def wndproc(self, hwnd, message, wparam, lparam):
        c, g = self.con, self.gui
        from pet_instance import REVEAL_MESSAGE
        if message == REVEAL_MESSAGE:
            self.reveal()
            return 0
        if message == c.WM_SHOWWINDOW:
            self.visible = bool(wparam)
        if message == c.WM_MOUSEACTIVATE:
            return 3  # MA_NOACTIVATE: keep the video player focused.
        if message == c.WM_LBUTTONDOWN:
            self.drag = (self.api.GetCursorPos(), g.GetWindowRect(hwnd))
            g.SetCapture(hwnd)
            return 0
        if message == c.WM_MOUSEMOVE and self.drag:
            (ox,oy), (x,y,_,_) = self.drag
            cx, cy = self.api.GetCursorPos()
            g.SetWindowPos(hwnd, 0, x+cx-ox, y+cy-oy, 0,0,c.SWP_NOSIZE|c.SWP_NOZORDER|c.SWP_NOACTIVATE)
            return 0
        if message == c.WM_LBUTTONUP:
            if self.drag:
                self.drag = None
                g.ReleaseCapture()
                self.save_position()
            return 0
        if message == c.WM_LBUTTONDBLCLK:
            self.touch_until = time.time()+6
            self.override = ('happy',self.touch_until)
            return 0
        if message == c.WM_RBUTTONUP or (message == self.tray_message and lparam == c.WM_RBUTTONUP):
            self.menu()
            return 0
        if message == self.tray_message and lparam == c.WM_LBUTTONDBLCLK:
            self.show_hide()
            return 0
        if message == c.WM_CLOSE:
            g.DestroyWindow(hwnd)
            return 0
        if message == c.WM_DESTROY:
            self.running = False
            g.PostQuitMessage(0)
            return 0
        return g.DefWindowProc(hwnd,message,wparam,lparam)

    def reveal(self):
        from pet_instance import visible_position
        self.visible = True
        monitor = self.api.MonitorFromWindow(self.hwnd,self.con.MONITOR_DEFAULTTONEAREST)
        work = self.api.GetMonitorInfo(monitor)['Work']
        x,y = visible_position(self.gui.GetWindowRect(self.hwnd),work)
        self.gui.SetWindowPos(self.hwnd,self.con.HWND_TOPMOST,x,y,0,0,self.con.SWP_NOSIZE|self.con.SWP_NOACTIVATE)
        self.gui.ShowWindow(self.hwnd,self.con.SW_SHOWNOACTIVATE)
        self.save_position()

    def show_hide(self):
        self.visible = not self.visible
        self.gui.ShowWindow(self.hwnd, self.con.SW_SHOWNOACTIVATE if self.visible else self.con.SW_HIDE)

    def menu(self):
        g, c = self.gui, self.con
        settings = (self.backend.state or {}).get('settings',{})
        menu = g.CreatePopupMenu()
        g.AppendMenu(menu,c.MF_STRING,1,'暂停陪看' if settings.get('enabled') else '继续陪看')
        g.AppendMenu(menu,c.MF_STRING,2,'说说这段')
        g.AppendMenu(menu,c.MF_STRING | (c.MF_CHECKED if settings.get('automaticComments',True) else 0),3,'自动评论')
        g.AppendMenu(menu,c.MF_STRING | (c.MF_CHECKED if self.controls.allow_capture else 0),7,'允许截图')
        from pet_controls import menu_groups
        visual_commands = {}
        command_id = 1000
        for title,rows in menu_groups(self.renderer.catalog,self.controls):
            submenu = g.CreatePopupMenu()
            for kind,value,label,checked in rows:
                flags = c.MF_STRING | (c.MF_CHECKED if checked else 0)
                g.AppendMenu(submenu,flags,command_id,label)
                visual_commands[command_id] = (kind,value)
                command_id += 1
            g.AppendMenu(menu,c.MF_POPUP,submenu,title)
        g.AppendMenu(menu,c.MF_SEPARATOR,0,'')
        g.AppendMenu(menu,c.MF_STRING,9,'启动微信桥接')
        g.AppendMenu(menu,c.MF_STRING,10,'人设设置')
        g.AppendMenu(menu,c.MF_STRING,11,'视频分享白名单')
        g.AppendMenu(menu,c.MF_STRING,8,'相处与约会')
        g.AppendMenu(menu,c.MF_STRING,4,'陪看设置')
        g.AppendMenu(menu,c.MF_STRING,5,'隐藏桌宠' if self.visible else '显示桌宠')
        g.AppendMenu(menu,c.MF_STRING,6,'退出桌宠')
        previous = g.GetForegroundWindow()
        try:
            x,y = self.api.GetCursorPos()
            # Native popup needs a foreground owner to dismiss on outside clicks.
            try: g.SetForegroundWindow(self.hwnd)
            except Exception: pass
            selected = g.TrackPopupMenu(menu,c.TPM_RETURNCMD|c.TPM_RIGHTBUTTON,x,y,0,self.hwnd,None)
            g.PostMessage(self.hwnd,c.WM_NULL,0,0)
            if selected == 1:
                self.backend.post('settings',{'enabled':not settings.get('enabled',False)})
            elif selected == 2:
                self.backend.post('comment',{})
            elif selected == 3:
                self.backend.post('settings',{'automaticComments':not settings.get('automaticComments',True)})
            elif selected == 7:
                self.set_capture_allowed(not self.controls.allow_capture)
            elif selected == 9:
                self.request_bridge_start()
            elif selected == 11:
                webbrowser.open(self.endpoint+'/debug#cfg_share')
            elif selected == 10:
                webbrowser.open(self.endpoint+'/persona')
            elif selected == 8:
                webbrowser.open(self.endpoint+'/relationship')
            elif selected == 4:
                webbrowser.open(self.endpoint+'/companion')
            elif selected == 5:
                self.show_hide()
            elif selected == 6:
                g.PostMessage(self.hwnd,c.WM_CLOSE,0,0)
            elif selected in visual_commands:
                self.visual_command(*visual_commands[selected])
        finally:
            g.DestroyMenu(menu)
            if previous != self.hwnd and g.IsWindow(previous) and g.GetForegroundWindow() == self.hwnd:
                try: g.SetForegroundWindow(previous)
                except Exception: pass

    def request_bridge_start(self):
        self.menu_notice=('我看看微信桥接有没有打开～',time.time()+10)
        def work():
            try:
                text=request_wechat_bridge()
            except Exception:
                text='桥接启动检查失败了，看看 data/wechat-menu-launch.log 呀'
            self.menu_notice=(text,time.time()+8)
        threading.Thread(target=work,daemon=True).start()

    def set_capture_allowed(self, allowed):
        apply_capture_policy(self.hwnd,allowed)
        self.controls.set_allow_capture(allowed)

    def visual_command(self, kind, value):
        if kind == 'face':
            self.controls.set_face(value)
        elif kind == 'toggle':
            self.controls.toggle(value)
        elif kind == 'reset':
            self.controls.reset(value)
        elif kind == 'motion':
            self.renderer.play_motion(value)
        elif kind == 'gesture':
            self.renderer.play_gesture(value)
        elif kind == 'stop':
            self.renderer.stop_action()

    def bubble(self,title,text,mood='neutral'):
        return self.bubble_painter.render(title,text,mood)

    def render(self):
        from PIL import Image
        now = time.time()
        mood,title,text,talking = presentation(self.backend.state,now*1000)
        if self.override and now < self.override[1]:
            mood = self.override[0]
        if now < self.touch_until:
            text,talking = '诶，摸到我啦～',False
        notice=getattr(self,'menu_notice',None)
        if notice and now<notice[1]:
            text,talking=notice[0],False
        x,y,_,_ = self.gui.GetWindowRect(self.hwnd)
        cx,cy = self.api.GetCursorPos()
        gaze = (max(0,min(WIDTH,cx-x)),max(0,min(BODY_HEIGHT,cy-y-HEADER)))
        from live2d_renderer import EMOTION_EXPRESSIONS
        dt = max(.001,min(.2,time.monotonic()-self.last_frame_at))
        self.last_frame_at = time.monotonic()
        transient = EMOTION_EXPRESSIONS.get(mood) if self.override and now < self.override[1] else None
        body = self.renderer.frame(mood,gaze,talking,dt=dt,expression_override=transient)
        frame = Image.new('RGBA',(WIDTH,HEIGHT))
        frame.alpha_composite(body,(0,HEADER))
        frame.alpha_composite(self.bubble(title,text,mood),(0,24))
        self.bitmap.present(self.hwnd,frame)
        return mood

    def run(self):
        frames,last_report = 0,time.monotonic()
        try:
            while self.running:
                started = time.monotonic()
                self.gui.PumpWaitingMessages()
                if not self.running:
                    break
                if self.visible:
                    mood = self.render()
                    frames += 1
                if time.monotonic()-last_report >= 5:
                    elapsed = time.monotonic()-last_report
                    report = {'pid':os.getpid(),'renderer':'live2d-py','model':'live2D/DS鼠控版.zip','loaded':True,'emotion':self.renderer.emotion,'expressions':len(self.renderer.available_expressions),'motions':len(self.renderer.catalog.motions),'enabledOptions':sorted(self.controls.enabled),'manualFace':self.controls.manual_face,'action':self.renderer.action['id'] if self.renderer.action else None,'visible':self.visible,'instanceProtocol':1,'allowCapture':self.controls.allow_capture,'bubbleStyle':'soft-rounded','fps':round(frames/elapsed,1),'time':time.time()}
                    tmp = DATA/'live2d-pet-status.json.tmp'
                    tmp.write_text(json.dumps(report,ensure_ascii=False),encoding='utf-8')
                    tmp.replace(DATA/'live2d-pet-status.json')
                    frames,last_report = 0,time.monotonic()
                time.sleep(max(.001,(.05 if self.visible else .2)-(time.monotonic()-started)))
        finally:
            self.backend.stop.set()
            self.gui.Shell_NotifyIcon(self.gui.NIM_DELETE,(self.hwnd,1))
            self.bitmap.close()
            self.renderer.close()
            if self.gui.IsWindow(self.hwnd):
                self.gui.DestroyWindow(self.hwnd)

def main():
    import win32api, win32event, winerror
    parser = argparse.ArgumentParser()
    parser.add_argument('--endpoint',default='http://127.0.0.1:8787')
    parser.add_argument('--preview')
    parser.add_argument('--expression',default='happy')
    args = parser.parse_args()
    try: ctypes.windll.user32.SetProcessDPIAware()
    except Exception: pass
    if args.preview:
        from live2d_renderer import preview
        preview(args.preview,args.expression)
        return
    from pet_instance import mutex_name, reveal_existing
    mutex = win32event.CreateMutex(None,False,mutex_name())
    if win32api.GetLastError() == winerror.ERROR_ALREADY_EXISTS:
        mutex.Close()
        reveal_existing()
        return
    try:
        Pet(args.endpoint).run()
    finally:
        mutex.Close()

if __name__ == '__main__':
    try:
        main()
    except Exception:
        DATA.mkdir(exist_ok=True)
        details = traceback.format_exc()
        (DATA/'live2d-pet-error.log').write_text(details,encoding='utf-8')
        print(details,flush=True)
        raise SystemExit(1)
