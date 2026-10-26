"""B站本地客户端：自动跟随客户端窗口，无需框选，媒体会话提供真实标题/播放进度。"""
import base64
import ctypes
from ctypes import wintypes
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]

def matching_process(pid, expected):
    kernel = ctypes.windll.kernel32
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return False
    try:
        size = wintypes.DWORD(32768)
        name = ctypes.create_unicode_buffer(size.value)
        return bool(kernel.QueryFullProcessImageNameW(handle, 0, name, ctypes.byref(size))) and os.path.basename(name.value).casefold() == expected.casefold()
    finally:
        kernel.CloseHandle(handle)

def window_box(hwnd):
    """Recompute the exact client area each tick, including fullscreen and other monitors."""
    import win32gui
    left, top, right, bottom = win32gui.GetClientRect(hwnd)
    if right - left < 120 or bottom - top < 80:
        return None
    x1, y1 = win32gui.ClientToScreen(hwnd, (left, top))
    x2, y2 = win32gui.ClientToScreen(hwnd, (right, bottom))
    return (x1, y1, x2, y2)

def main():
    import requests
    import win32api
    import win32event
    import win32gui
    import win32process
    from PIL import ImageGrab, ImageChops, ImageStat
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass
    lock = socket.socket()
    try:
        lock.bind(('127.0.0.1', 47822))
    except OSError:
        return
    base = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8787').rstrip('/')
    parent = win32api.OpenProcess(0x100000, False, int(sys.argv[2])) if len(sys.argv) > 2 else None
    http = requests.Session()
    http.trust_env = False
    latest_media = {}
    powershell = str(Path(os.environ['WINDIR']) / 'System32/WindowsPowerShell/v1.0/powershell.exe')
    media = subprocess.Popen([powershell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(Path(__file__).with_name('media-session.ps1'))], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=0x08000000)
    def read_media():
        for raw in iter(media.stdout.readline, b''):
            try:
                row = json.loads(raw.decode('utf-8-sig'))
                latest_media.clear()
                latest_media.update(row)
            except Exception:
                pass
    threading.Thread(target=read_media, daemon=True).start()
    client_id = 'desktop-' + uuid.uuid4().hex
    fallback_id = uuid.uuid4().hex
    previous_image = None
    last_change = 0
    last_frame = 0
    observed_position = 0
    last_tick = time.time()
    token = ''
    previous_identity = ''
    try:
        while True:
            time.sleep(3)
            if parent and win32event.WaitForSingleObject(parent, 0) == 0:
                break
            try:
                if not token:
                    token = http.get(base + '/api/companion/bootstrap', timeout=3).json()['token']
                headers = {'Authorization': 'Bearer ' + token}
                response = http.get(base + '/api/companion/state', headers=headers, timeout=3)
                if response.status_code == 403:
                    token = ''
                    continue
                state = response.json()
                settings = state['settings']
                now = time.time()
                elapsed = min(5, max(0, now - last_tick))
                last_tick = now
                if not settings['enabled'] or (ROOT / 'data/PAUSED').exists():
                    previous_image = None
                    continue
                hwnd = win32gui.GetForegroundWindow()
                _, pid = win32process.GetWindowThreadProcessId(hwnd)
                if not hwnd or win32gui.IsIconic(hwnd) or not matching_process(pid, '哔哩哔哩.exe'):
                    previous_image = None
                    continue
                box = window_box(hwnd)
                if not box:
                    continue
                image = ImageGrab.grab(bbox=box, all_screens=True).convert('RGB')
                sample = image.resize((96, 54)).convert('L')
                changed = previous_image is None or ImageStat.Stat(ImageChops.difference(sample, previous_image)).mean[0] > 1.5
                previous_image = sample
                if changed:
                    last_change = now
                media_info = dict(latest_media)
                has_media = bool(media_info.get('ok')) and abs(now*1000 - media_info.get('timestamp', 0)) < 7000
                playing = bool(media_info.get('playing')) if has_media else now - last_change < 12
                if playing:
                    observed_position += elapsed
                title = str(media_info.get('title') or 'B站客户端当前片段')[:160]
                identity = hashlib.sha256((title + ':' + str(media_info.get('duration', 0))).encode()).hexdigest()[:24] if has_media and title != 'B站客户端当前片段' else fallback_id
                event = {'source': 'desktop', 'clientId': client_id, 'url': 'desktop://bilibili/' + identity, 'title': title, 'position': float(media_info.get('position', 0)) if has_media else observed_position, 'positionKind': 'media' if has_media else 'observed', 'playing': playing, 'paused': not playing, 'visible': True, 'ended': has_media and media_info.get('duration', 0) > 0 and media_info.get('position', 0) >= media_info['duration'] - 1}
                if identity != previous_identity:
                    last_frame = 0
                    previous_identity = identity
                if settings.get('framesEnabled', True) and (playing or state.get('needFrame')) and (state.get('needFrame') or now - last_frame >= settings['analysisIntervalSeconds']):
                    image.thumbnail((900, 600))
                    buf = io.BytesIO()
                    image.save(buf, format='JPEG', quality=78)
                    event['frame'] = 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')
                    last_frame = now
                result = http.post(base + '/api/companion/event', json=event, headers=headers, timeout=4)
                if result.status_code == 403:
                    token = ''
            except Exception as error:
                print('capture retry:', type(error).__name__, flush=True)
    finally:
        media.terminate()
        media.wait(timeout=5)
        if parent:
            parent.Close()
        lock.close()

if __name__ == '__main__':
    main()
