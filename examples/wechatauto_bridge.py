#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
鲸鲸 · 微信 4.x 桥接（不注入、不修改微信）

原理：
  - 读消息：解密微信 4.x 本地 SQLite 数据库（只读，需要微信处于登录状态）
  - 发消息：驱动微信窗口（UI 自动化 + 剪贴板），相当于有人替你打字发送

前置：
  1. WeChat 4.x 已登录（建议用小号）
  2. 已装依赖：pip install wechatauto-replica requests
  3. 鲸鲸服务已启动（双击 启动鲸鱼娘.bat）
  4. config.json 里 gateway.wechat.enabled = true（脚本会读 token）

用法：
  python examples/wechatauto_bridge.py

注意：
  - 发送消息会抢微信窗口焦点，这是 4.x 自动化的正常表现。
  - 微信必须保持登录；退出登录后数据库密钥会失效。
  - 自动化不是微信官方接口，仍有账号风险，只用小号 + 测试群。
"""

import json
import random
import urllib.parse
import os
# 关掉 wechatauto 的「拟人节流」（默认 natural：120 秒内 6 次写就冷却 30~75 秒）
os.environ.setdefault("WECHATAUTO_RHYTHM", "off")
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
import sys
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "config.json")
LOG_FILE = os.path.join(ROOT, "data", "wechat-bridge-4x.log")
RECEIVE_HEALTH = None

# 只回复这些会话（留空 = 全部会话都交给鲸鲸判断）
# 例如 ["文件传输助手", "深海鱼塘"]
ONLY_CHATS = []

# 距离启动多久之前的消息不处理（秒）
SKIP_OLDER_THAN = 10
DIGEST_MINUTES = 30
MASTER_WXID = ''
# 超过这么多秒的旧消息直接不回，避免“回上一条”
STALE_AFTER = float(os.environ.get("WHALE_STALE_AFTER", "4"))
try:
    _cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config.json")
    with open(_cfg_path, "r", encoding="utf-8-sig") as _f:
        _cfg = json.load(_f)
    _stale = (_cfg.get("wechat") or {}).get("staleAfterSec")
    if isinstance(_stale, (int, float)) and _stale > 0:
        STALE_AFTER = float(_stale)
    _wechat = _cfg.get("wechat") or {}
    GAME_TOKENS = [str(x).lower() for x in (_wechat.get("gameWhitelist") or []) if str(x).strip()]
    AWAY_NOTICE = bool(_wechat.get("awayNotice", True))
    RETURN_NOTICE = bool(_wechat.get("returnNotice", True))
    QUEUED_MAX_AGE = float(_wechat.get("queuedMaxAgeSec", 300))
    QUEUED_MAX_CHATS = int(_wechat.get("queuedMaxChats", 2))
    QUOTE_REPLY = bool(_wechat.get("quoteReply", True))
    LOW_BATTERY_PCT = float(_wechat.get("lowBatteryPercent", 5))
    GOODNIGHT_TEXT = str(_wechat.get("goodnightText", "晚安，电量快没了，我先睡啦，明天见～"))
    _share = _cfg.get("share") or {}
    SHARE_ENABLED = bool(_share.get("enabled", True))
    SHARE_EVERY = float(_share.get("everyMinutes", 120))
    _digest = _wechat.get("digestMinutes", 30)
    DIGEST_MINUTES = float(_digest) if isinstance(_digest, (int, float)) else 30.0
    MASTER_WXID = (((_cfg.get("persona") or {}).get("master") or {}).get("wxids") or [''])[0]
except Exception:
    pass

START_TS = time.time()

# 系统 / 公众号通知：只用来记录，不接话（否则会跟「微信团队」吵起来）
SYSTEM_SENDER_NAMES = {
    "微信团队", "微信支付", "服务通知", "订阅号消息", "文件传输助手",
    "微信运动", "微信公众平台", "腾讯客服", "微信安全中心", "微信广告",
}
try:
    SYSTEM_SENDER_NAMES |= {str(x).strip() for x in (_wechat.get("ignoreSenders") or []) if str(x).strip()}
except Exception:
    pass
_SYSTEM_TEXT_RE = __import__("re").compile(r"<a\s+href=|weixin://|&lt;a\s+href=", __import__("re").I)
# 同一会话同一句话的重复回复保护（秒）与每分钟回复上限
DUP_REPLY_WINDOW = 45
MAX_REPLIES_PER_MIN = 8
# 单实例锁端口：被占用就说明已经有桥接在跑，直接退出
BRIDGE_LOCK_PORT = 47821

# —— 语音识别（语音消息 → 文字）——
# 默认用阿里云百炼的 qwen3-asr-flash；Key 依次取 voice.apiKey → data/settings.json → deepseek.apiKey
VOICE_ENABLED = True
VOICE_BASE_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
VOICE_MODEL = "qwen3-asr-flash"
VOICE_API_KEY = ""
VOICE_TIMEOUT = 90
VOICE_MAX_SECONDS = 120
VOICE_SAMPLE_RATE = 16000
try:
    _voice_cfg = (_cfg.get("voice") or {})
    VOICE_ENABLED = bool(_voice_cfg.get("enabled", True))
    VOICE_BASE_URL = str(_voice_cfg.get("baseUrl") or VOICE_BASE_URL)
    VOICE_MODEL = str(_voice_cfg.get("model") or VOICE_MODEL)
    VOICE_API_KEY = str(_voice_cfg.get("apiKey") or "")
    VOICE_TIMEOUT = float(_voice_cfg.get("timeoutMs", 90000)) / 1000.0
    VOICE_MAX_SECONDS = float(_voice_cfg.get("maxSeconds", 120))
    if not VOICE_API_KEY:
        try:
            _settings_path = os.path.join(ROOT, "data", "settings.json")
            with open(_settings_path, "r", encoding="utf-8-sig") as _sf:
                _st = json.load(_sf)
            VOICE_API_KEY = str(_st.get("apiKey") or "")
        except Exception:
            VOICE_API_KEY = ""
except Exception:
    pass


def asr_transcribe(wav_bytes, api_key, model, base_url, timeout=90):
    """把 wav 字节交给语音识别接口，返回文字；失败抛异常或返回空串。"""
    import base64
    import urllib.request

    if not api_key:
        raise RuntimeError("没有可用的语音识别 Key")
    payload = {
        "model": model,
        "input": {
            "messages": [{
                "role": "user",
                "content": [{"audio": "data:audio/wav;base64," + base64.b64encode(wav_bytes).decode()}],
            }]
        },
    }
    req = urllib.request.Request(
        base_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8", "replace"))
    try:
        text = data["output"]["choices"][0]["message"]["content"][0]["text"]
    except Exception:
        text = ""
    return str(text or "").strip()


def clean_transcript(text):
    """去掉只剩标点的转写结果。"""
    t = str(text or "").strip()
    t = t.strip("，,。.！!？?…~～、 ")
    return t if len(t) >= 1 else ""

_recent_dup = {}
_reply_stamps = {}
_guard_lock = threading.Lock()


def is_system_notice(username, nickname, content):
    """系统号 / 通知类消息：带 weixin:// 链接、HTML 链接、或已知系统号名字。"""
    if _SYSTEM_TEXT_RE.search(str(content or "")):
        return True
    name = str(nickname or "").strip()
    if name in SYSTEM_SENDER_NAMES:
        return True
    uid = str(username or "")
    if uid.startswith("gh_"):
        return True
    return False


def duplicate_guard(chat_username, sender, content):
    """同一人 45 秒内重复同一句 → 不再回（微信重投/通知刷屏）。"""
    now = time.time()
    key = (str(chat_username or ""), str(sender or ""), str(content or "").strip())
    with _guard_lock:
        last = _recent_dup.get(key, 0)
        _recent_dup[key] = now
        if len(_recent_dup) > 500:
            for k, v in list(_recent_dup.items()):
                if now - v > 600:
                    _recent_dup.pop(k, None)
        return now - last < DUP_REPLY_WINDOW


def rate_guard(chat_username):
    """同一会话一分钟内已经回了 MAX_REPLIES_PER_MIN 条 → 先停下，避免越聊越乱。"""
    now = time.time()
    key = str(chat_username or "")
    with _guard_lock:
        stamps = [t for t in _reply_stamps.get(key, []) if now - t < 60]
        if len(stamps) >= MAX_REPLIES_PER_MIN:
            _reply_stamps[key] = stamps
            return False
        stamps.append(now)
        _reply_stamps[key] = stamps
    return True


BOOT_LOG = os.path.join(ROOT, "data", "bridge-boot.log")


def boot(msg):
    """启动诊断：只写文件，不依赖控制台（控制台被选中时 print 会卡住）"""
    try:
        os.makedirs(os.path.dirname(BOOT_LOG), exist_ok=True)
        with open(BOOT_LOG, "a", encoding="utf-8") as f:
            f.write("%s [pid %s] %s\n" % (time.strftime("%H:%M:%S"), os.getpid(), msg))
    except Exception:
        pass


boot("脚本开始执行")


def log(*args):
    if RECEIVE_HEALTH is not None:
        RECEIVE_HEALTH.observe(*args)
    line = time.strftime("[%H:%M:%S] ") + " ".join(str(a) for a in args)
    # 先写文件，再打印：这样即使控制台卡住，日志也不会丢
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    try:
        print(line, flush=True)
    except Exception:
        pass


_win_problem_ts = {}


def log_window_problem(where, err):
    """窗口操作失败两分钟内只报一次。

    挪不动/置顶不了窗口不该让整条发送失败（UIA 还能把字打进去），
    更不该让看门狗以为“发送卡住”把桥接反复重启——那会一直弹「拒绝访问」。
    """
    now = time.time()
    if now - _win_problem_ts.get(where, 0) < 120:
        return
    _win_problem_ts[where] = now
    log(where + "：", repr(err))


def read_config():
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8-sig") as f:
                cfg = json.load(f)
        except Exception as e:
            log("读取 config.json 失败：", e)
    return cfg


def build_bot_url(cfg):
    port = (cfg.get("server") or {}).get("port", 8787)
    return os.environ.get("WHALE_BOT_URL", "http://127.0.0.1:%s/webhook/wechat" % port)


def configure_crash_log(log_dir, report):
    """记录当前线程的致命异常；周期全线程转储仅在显式诊断时启用。"""
    import faulthandler
    crash_file = open(os.path.join(log_dir, "bridge-hang.log"), "a", encoding="utf-8")
    try:
        faulthandler.enable(file=crash_file, all_threads=False)
        if os.environ.get("WHALE_TRACE_HANGS", "").strip() == "1":
            faulthandler.dump_traceback_later(40, repeat=True, file=crash_file)
            report("已开启周期全线程转储（仅诊断模式，40s）")
        else:
            report("已开启崩溃记录；周期全线程转储已关闭")
        return crash_file
    except Exception:
        faulthandler.cancel_dump_traceback_later()
        faulthandler.disable()
        crash_file.close()
        raise


def main():
    if os.path.exists(os.path.join(ROOT,"data","WECHAT_STOPPED")):
        boot("微信桥接已由桌宠关闭")
        return 0
    boot("进入 main()")
    # 微信的 Qt accessibility 只在「纯英文路径」下能热激活成功；路径里带中文时，
    # UIA 认不出主窗（ensure_window 超时 37s），之后每次发送都退到 OCR 并报
    # error(5, 'SetWindowPos', '拒绝访问')，日志刷屏、消息发不出去。
    if any(ord(ch) > 127 for ch in ROOT):
        log("[!] 路径里有中文/非英文字符：", ROOT)
        log("    微信 UI 自动化在这种路径下会失败（发送一直报「拒绝访问」）。")
        log("    请把整个文件夹移到纯英文路径再启动，例如 D:\\whale-girl-3.0")
    # 单实例锁：多个桥接连同一份微信数据库会导致同一条消息被回好几遍
    _lock_sock = None
    try:
        import socket as _socket
        _lock_sock = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
        _lock_sock.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 0)
        _lock_sock.bind(("127.0.0.1", BRIDGE_LOCK_PORT))
        _lock_sock.listen(1)
        boot("单实例锁已获取（端口 %d）" % BRIDGE_LOCK_PORT)
    except OSError as e:
        log("已经有一个桥接在跑了（端口 %d 被占用），本进程退出：%r" % (BRIDGE_LOCK_PORT, e))
        try:
            if _lock_sock:
                _lock_sock.close()
        except Exception:
            pass
        return 0
    except Exception:
        _lock_sock = None
    try:
        try:
            # 持有句柄直到 main 退出，避免故障处理器写入已关闭文件。
            _hang_file = configure_crash_log(os.path.join(ROOT, "data"), boot)
        except Exception as diagnostic_error:
            boot("崩溃记录初始化失败：%r" % diagnostic_error)

        boot("开始 import requests")
        import requests

        boot("开始 import wechatauto（可能较慢，10~20 秒）")
        from wechatauto import MediaDownloader, WeChatDB, WeChatGUI
        from wechatauto.db import Listener

        # 小版本兼容补丁：本机微信上 UIA 控件树其实已经物化，但顶层窗口类名不是
        # mmui::MainWindow，wechatauto 自带的判断会把它当成「没物化」，于是每次
        # 发送都跳过 UIA、掉进会卡死在截屏里的 OCR 兜底。补丁见 uia_compat.py。
        # 包里自带的 Python 开了 safe_path（sys.flags.safe_path=True，sys.path[0]
        # 是 python312.zip 而不是脚本目录），所以同目录的 uia_compat 直接 import 会
        # ModuleNotFoundError。这里显式把 examples 目录塞进 sys.path；再不行就按
        # 文件路径加载（双保险）。
        _here = os.path.dirname(os.path.abspath(__file__))
        if _here not in sys.path:
            sys.path.insert(0, _here)
        from share_policy import load_policy, choose_target, send_if_allowed
        # 打开每一步的耗时日志（uia step xxx -> X.XXs），下次卡住能直接看出停在哪步
        os.environ.setdefault("WHALE_STEPLOG", "1")
        boot("应用 uia_compat 补丁")
        try:
            import uia_compat
            boot("uia_compat.apply() = %r" % (uia_compat.apply(),))
        except Exception as _compat_err:
            try:
                import importlib.util as _ilu
                _spec = _ilu.spec_from_file_location(
                    "uia_compat", os.path.join(_here, "uia_compat.py"))
                _mod = _ilu.module_from_spec(_spec)
                sys.modules["uia_compat"] = _mod
                _spec.loader.exec_module(_mod)
                _mod.apply()
                boot("uia_compat 已按文件路径加载并生效")
            except Exception:                # noqa: BLE001
                boot("uia_compat 未生效: %r" % (_compat_err,))

        boot("import 完成")
    except Exception as e:
        boot("导入失败: %r" % (e,))
        log("缺少依赖或导入失败：", e)
        log("请先运行：\"%LOCALAPPDATA%\\Programs\\Python\\Python312\\python.exe\" -m pip install wechatauto-replica requests")
        return 1

    cfg = read_config()
    gw = (cfg.get("gateway") or {}).get("wechat") or {}
    token = gw.get("inboundToken", "")
    bot_url = build_bot_url(cfg)
    aliases = ((cfg.get("persona") or {}).get("aliases") or []) + [
        ((cfg.get("persona") or {}).get("name") or "鲸鲸")
    ]

    log("连接微信 4.x 数据库（只读）…")
    # token 一定要读到：读不到就是「她不理人」最隐蔽的原因（服务端会直接 401）
    if token:
        log("webhook token：已读取（%s…）" % token[:6])
    else:
        log("⚠️ webhook token 是空的！检查 config.json 的 gateway.wechat.inboundToken（文件要能正常解析）")
    db = WeChatDB()
    from bridge_health import ReceiveHealth
    from bridge_media import acquire_image, prepare_image, request_vision, same_message, valid_media_control, valid_description, aligned_media_rect
    global RECEIVE_HEALTH
    RECEIVE_HEALTH=ReceiveHealth(os.path.join(ROOT,"data","wechat-bridge-status.json"),db.wxid,report=log)
    RECEIVE_HEALTH.start()
    _media_box = {"downloader": None}

    def _get_media():
        """按需创建媒体下载器；图片和表情识别共用一个实例。"""
        if _media_box["downloader"] is None:
            save_dir = os.path.join(ROOT, "data", "media-cache")
            os.makedirs(save_dir, exist_ok=True)
            _media_box["downloader"] = MediaDownloader(db, save_dir=save_dir)
        return _media_box["downloader"]

    me = db.wxid
    try:
        info = db.get_self_info() or {}
        log("当前登录账号：", info.get("nick_name") or info.get("remark") or me)
    except Exception:
        log("当前登录账号 wxid：", me)
    log("数据库目录：", db.db_dir)

    sessions = {}
    try:
        for s in db.get_sessions(limit=800):
            sessions[s["username"]] = s
    except Exception as e:
        log("读取会话列表失败：", e)

    name_cache = {}

    def display_name(username):
        if username in name_cache:
            return name_cache[username]
        name = ""
        try:
            if username.endswith("@chatroom"):
                name = db.group_id_to_name(username) or ""
                if not name:
                    s = sessions.get(username) or {}
                    name = s.get("last_sender") or ""
            else:
                name = db.get_nickname(username) or ""
        except Exception:
            name = ""
        name = name or username
        name_cache[username] = name
        return name

    alias_cache = {}
    # 上次把这个会话切到哪一行名字（微信里没命名的群，行名是成员名）
    open_cache = {}

    def aliases_for(username, shown=""):
        """会话列表里那一行可能叫什么（微信里没命名的群，显示的是成员名）。

        实测：群 45063658812@chatroom 在数据库里 nick_name 是空的，会话列表里显示
        「宇火之于、云白『世一区』」—— 按群名/open_chat 都匹配不上，所以这里把
        「成员名用、连起来」也当候选名。
        """
        key = (username or "", shown or "")
        if key in alias_cache:
            return alias_cache[key]
        out = []
        if shown and shown != username and not str(shown).endswith("@chatroom"):
            out.append(shown)
        if username and str(username).endswith("@chatroom"):
            try:
                nm = db.group_id_to_name(username) or ""
            except Exception:
                nm = ""
            if nm and nm != username:
                out.append(nm)
            try:
                nicks = []
                for m in (db.get_group_members(username) or []):
                    if m.get("username") == me:
                        continue
                    n = (m.get("remark") or "").strip() or (m.get("nick_name") or "").strip()
                    if n:
                        nicks.append(n)
                if nicks:
                    out.append("、".join(nicks))
            except Exception:
                pass
        if not out:
            out.append(shown or username)
        out = [x for x in dict.fromkeys(out) if x]
        alias_cache[key] = out
        return out

    def chat_latest_seq(username):
        try:
            rows = db.get_messages(username, limit=1)
            return rows[0].get("sort_seq") or 0 if rows else 0
        except Exception:
            return 0

    gui = None
    gui_lock = threading.Lock()
    send_lock = threading.Lock()
    dead_chats = set()
    fail_streak = {}
    self_wxid = db.wxid
    pending_replies = {}
    SEND_STATE = {"active": False, "start": 0.0}
    pending_lock = threading.Lock()
    AWAY = {"on": False}
    NOTIFIED = []

    def away_active():
        """主人在微信里发了「我去玩了」→ 写 data/away.json，这里据此静默排队。"""
        try:
            p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "away.json")
            with open(p, "r", encoding="utf-8") as f:
                d = json.load(f)
            return float(d.get("until") or 0) > time.time()
        except Exception:
            return False

    def game_running():
        if not GAME_TOKENS:
            return False
        try:
            import psutil
            for p in psutil.process_iter(["name"]):
                n = (p.info.get("name") or "").lower()
                if any(t in n for t in GAME_TOKENS):
                    return True
        except Exception:
            pass
        return False

    def foreground_is_fullscreen():
        """前台是不是全屏程序（比如游戏）——这时别抢焦点，先把回复排着。"""
        try:
            import win32gui, win32api, win32process, psutil
            h = win32gui.GetForegroundWindow()
            if not h:
                return False
            _, pid = win32process.GetWindowThreadProcessId(h)
            name = psutil.Process(pid).name().lower()
            if name.startswith("weixin"):
                return False
            r = win32gui.GetWindowRect(h)
            sw, sh = win32api.GetSystemMetrics(0), win32api.GetSystemMetrics(1)
            return r[0] <= 0 and r[1] <= 0 and r[2] >= sw - 2 and r[3] >= sh - 2
        except Exception:
            return False

    def group_is_alive(chat_username):
        """被踢出群后，群会话还在，但发不出去；先查成员列表。"""
        if not str(chat_username).endswith("@chatroom"):
            return True
        try:
            members = db.get_group_members(chat_username) or []
            ids = {str(m.get("wxid") or m.get("username")) for m in members}
            return self_wxid in ids
        except Exception:
            return True

    # ---------- 微信窗口置顶（关键：别的窗口挡在微信上面会导致打字落空） ----------
    def find_weixin_hwnd():
        try:
            import win32gui
            import win32con
            import win32process
            import psutil
        except Exception:
            return 0
        found = []
        # 微信（4.x / Qt）会额外建一个「托盘图标隐藏消息窗」：它算可见窗口，
        # 而且 GetWindowRect 出来的面积常常比主窗还大（实测 1320x900 > 主窗 896x776）。
        # 以前按「面积最大」挑，就会挑中它 —— 对它 SetWindowPos 直接 error(5) 拒绝访问，
        # 于是每次发送都失败、走 OCR 兜底、再被看门狗重启，一直循环报「拒绝访问」。
        BAD_CLASS = ("trayicon", "messagewindow", "msctf", "sopy", "sogou", "hintwnd", "default ime", "notifyicon")

        def cb(h, _):
            try:
                title = win32gui.GetWindowText(h) or ""
                _, pid = win32process.GetWindowThreadProcessId(h)
                if pid <= 0:
                    return
                cls = win32gui.GetClassName(h) or ""
                low = cls.lower()
                if any(bad in low for bad in BAD_CLASS):
                    return
                rect = win32gui.GetWindowRect(h)
                area = max(0, rect[2] - rect[0]) * max(0, rect[3] - rect[1])
                if win32gui.IsIconic(h):
                    # 最小化后 GetWindowRect 是 (-16000,-16000,…) 的退化矩形，
                    # 换算成「还原后」的尺寸再判大小
                    try:
                        rc = win32gui.GetWindowPlacement(h)[4]
                        area = max(0, rc[2] - rc[0]) * max(0, rc[3] - rc[1]) or area
                    except Exception:
                        pass
                # 不再要求 IsWindowVisible：微信缩在托盘里时主窗 visible=0，以前这里
                # 直接 return，于是整条「置顶 + 调窗口」都被跳过。主窗至少 300x250，
                # 托盘提示窗（260x85）和辅助窗（173x196）顺手被排除。
                if area < 300 * 250 and title.strip() != "微信":
                    return
                try:
                    name = psutil.Process(pid).name().lower()
                except Exception:
                    return
                if not name.startswith("weixin"):
                    return
                if "发送" in title or "助手" in title:
                    return
                try:
                    style = win32gui.GetWindowLong(h, win32con.GWL_STYLE)
                    has_min_box = bool(style & win32con.WS_MINIMIZEBOX)
                except Exception:
                    has_min_box = False
                is_main_title = title.strip() == "微信"
                looks_main_class = ("qwindowicon" in low) or ("mmui::mainwindow" in low)
                # 真主窗的三条特征都各加一个大权重，面积只在同类里起作用，
                # 这样托盘消息窗再“大”也排不到前面
                score = area
                if is_main_title:
                    score += 10 ** 9
                if looks_main_class:
                    score += 10 ** 8
                if has_min_box:
                    score += 10 ** 7
                found.append((score, 1 if is_main_title else 0, h))
            except Exception:
                pass

        try:
            win32gui.EnumWindows(cb, None)
        except Exception:
            return 0
        if not found:
            return 0
        found.sort(reverse=True)
        return found[0][2]

    def normalize_window(hwnd):
        """微信窗口太小 / 超出屏幕 / 被挪走都会让 UI 自动化点空，统一调成稳定尺寸。"""
        try:
            import win32gui
            import win32con
            import win32api
            sw, sh = win32api.GetSystemMetrics(0), win32api.GetSystemMetrics(1)
            rect = win32gui.GetWindowRect(hwnd)
            x, y, w, h = rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]
            tw, th = min(1320, sw - 160), min(900, sh - 160)
            need = w < 1080 or h < 760 or w > sw - 80 or h > sh - 80 or x < -20 or y < -20 or x + w > sw + 20 or y + h > sh + 20
            if need:
                win32gui.SetWindowPos(hwnd, win32con.HWND_TOP, 40, 20, tw, th, win32con.SWP_SHOWWINDOW)
                log("微信窗口调整：%dx%d @(%d,%d) → %dx%d（保证自动发送稳定）" % (w, h, x, y, tw, th))
                time.sleep(0.8)
        except Exception as e:
            log_window_problem("调整微信窗口失败（继续发送）", e)

    def with_window_on_top(fn, require_foreground=False):
        """发送前拉起微信；朋友圈必须核实成功后才查找编辑控件。"""
        if game_running():
            return {"outcome":"draft","error":"当前游戏运行中，未拉起微信"} if require_foreground else False
        hwnd = find_weixin_hwnd()
        if require_foreground and not hwnd:
            log("朋友圈前台检查失败：未找到微信主窗口，未尝试打开发表入口")
            return {"outcome":"draft","error":"未找到微信主窗口，未尝试打开发表入口"}
        was_topmost = False
        touched = False
        SEND_STATE["active"] = True
        SEND_STATE["start"] = time.time()
        SEND_STATE["timeout"] = 90 if require_foreground else 40
        try:
            import win32gui
            import win32con
            if hwnd:
                try:
                    if not win32gui.IsWindowVisible(hwnd):
                        # 微信在托盘里时主窗是隐藏的，先把窗口拉出来再打字
                        win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
                        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                        log("微信在托盘里，已把主窗口拉出来再发送")
                        time.sleep(0.4)
                except Exception as e:
                    log("拉出微信窗口失败：", repr(e))
                normalize_window(hwnd)
                try:
                    fg = win32gui.GetForegroundWindow()
                except Exception:
                    fg = 0
                if fg != hwnd:
                    touched = True
                    force_foreground(hwnd)
                    ex = win32gui.GetWindowLong(hwnd, win32con.GWL_EXSTYLE)
                    was_topmost = bool(ex & win32con.WS_EX_TOPMOST)
                    # 置顶失败不该让整条发送失败（比如挑到了不能定位的窗口），
                    # 顶多是“可能被别的窗口挡住”，打字还有 UIA 兜着
                    try:
                        win32gui.SetWindowPos(
                            hwnd, win32con.HWND_TOPMOST, 0, 0, 0, 0,
                            win32con.SWP_NOMOVE | win32con.SWP_NOSIZE,
                        )
                    except Exception as e:
                        log_window_problem("窗口置顶失败（继续发送）", e)
                    win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                    time.sleep(0.2)
            if require_foreground:
                try:
                    foreground = win32gui.GetForegroundWindow()
                    verified = (foreground == hwnd or bool(foreground) and win32gui.GetAncestor(foreground, 2) == win32gui.GetAncestor(hwnd, 2))
                    verified = verified and win32gui.IsWindowVisible(hwnd) and not win32gui.IsIconic(hwnd)
                except Exception:
                    verified = False
                if not verified:
                    log("朋友圈前台检查失败：未能把微信恢复并切到前台，未检查发表控件")
                    return {"outcome":"draft","error":"未能把微信恢复并切到前台，尚未检查发表入口"}
                log("朋友圈前台检查通过，开始识别发表入口")
            return fn()
        finally:
            SEND_STATE["active"] = False
            SEND_STATE["timeout"] = 40
            try:
                if touched and hwnd and not was_topmost:
                    import win32gui
                    import win32con
                    win32gui.SetWindowPos(
                        hwnd, win32con.HWND_NOTOPMOST, 0, 0, 0, 0,
                        win32con.SWP_NOMOVE | win32con.SWP_NOSIZE,
                    )
            except Exception:
                pass

    def force_foreground(hwnd):
        """把微信强制拉到前台（SetForegroundWindow 单用会被系统拒绝）。"""
        try:
            import ctypes
            user32 = ctypes.windll.user32
            if user32.GetForegroundWindow() == hwnd:
                return True
            fg = user32.GetForegroundWindow()
            tid_fg = user32.GetWindowThreadProcessId(fg, None)
            tid = user32.GetWindowThreadProcessId(hwnd, None)
            try:
                user32.AttachThreadInput(tid_fg, tid, True)
                user32.ShowWindow(hwnd, 9)  # SW_RESTORE
                user32.SetForegroundWindow(hwnd)
                user32.BringWindowToTop(hwnd)
            finally:
                try:
                    user32.AttachThreadInput(tid_fg, tid, False)
                except Exception:
                    pass
            time.sleep(0.15)
            return user32.GetForegroundWindow() == hwnd
        except Exception:
            return False

    UIA_CACHE = {"u": None}

    def _input_value(u):
        """尽量读出输入框当前文字；读不到返回空串。"""
        try:
            e = u._chat_input()
            if e is None:
                return ''
            for name in ('get_value', 'value'):
                try:
                    v = getattr(e, name)
                    v = v() if callable(v) else v
                    if v is not None:
                        return str(v)
                except Exception:
                    pass
            try:
                return str(e.iface_value.Value)
            except Exception:
                pass
        except Exception:
            pass
        return ''

    def press_enter(with_ctrl=False):
        """用底层按键补发 Enter（UIA 的 SendKeys 有时不触发发送）。"""
        try:
            import win32api
            import win32con
            hwnd = find_weixin_hwnd()
            if hwnd:
                force_foreground(hwnd)
            time.sleep(0.10)
            if with_ctrl:
                win32api.keybd_event(0x11, 0, 0, 0)
            win32api.keybd_event(0x0D, 0, 0, 0)
            win32api.keybd_event(0x0D, 0, win32con.KEYEVENTF_KEYUP, 0)
            if with_ctrl:
                win32api.keybd_event(0x11, 0, win32con.KEYEVENTF_KEYUP, 0)
            time.sleep(0.25)
            return True
        except Exception as e:
            log("手动回车失败：", repr(e))
            return False

    def uia_send(text, who, username=""):
        """优先用 UIA 发送：不依赖 OCR 找发送按钮，成功后返回 True。"""
        u = UIA_CACHE["u"]
        if u is None:
            try:
                with gui_lock:
                    u = gui._get_uia() if gui is not None else None
                UIA_CACHE["u"] = u
            except Exception:
                u = None
        if u is None:
            return False
        keys = aliases_for(username, who) if username else [who]
        try:
            cur = None
            try:
                cur = u.current_chat()
            except Exception:
                pass
            hit_cur = (cur == who) or any(cur == k for k in keys if k)
            if not hit_cur and username:
                hit_cur = bool(cur) and open_cache.get(username) == cur
            if not hit_cur:
                if not u.open_chat(keys):
                    try:
                        u.back_to_chat_tab()
                    except Exception:
                        pass
                    if not u.open_chat(keys):
                        return False
                if username:
                    try:
                        open_cache[username] = u.current_chat() or ""
                        log("UIA 已切到会话：", open_cache[username])
                    except Exception:
                        pass
            t_open = time.time()
            sent_ok = False
            try:
                sent_ok = bool(u.send_text(text))
            except Exception:
                sent_ok = False
            if not sent_ok:
                try:
                    u.back_to_chat_tab()
                    sent_ok = bool(u.send_text(text))
                except Exception:
                    sent_ok = False
            log("UIA 发送耗时 %.1fs（打开会话+输入）" % (time.time() - t_open))
            if sent_ok:
                # 多按几次：Enter 两次 + Ctrl+Enter 两次（兼容“按 Ctrl+Enter 发送”的设置）
                press_enter(False)
                press_enter(False)
                press_enter(True)
                press_enter(True)
                return True
        except Exception as e:
            log("UIA 发送异常：", repr(e))
        return False

    def send_text(text, chat_display_name, chat_username="", force=False, quote_text=None, queue_if_busy=True):
        nonlocal gui
        if chat_username and chat_username in dead_chats:
            log("跳过已失效的会话：", chat_display_name)
            return False
        if chat_username and not group_is_alive(chat_username):
            dead_chats.add(chat_username)
            log("群里已经没有我了（被移出？），以后跳过：", chat_display_name)
            return False
        if not force and (AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen()):
            if not queue_if_busy:
                return False
            with pending_lock:
                pending_replies[chat_username or chat_display_name] = (text, chat_display_name, chat_username, time.time())
            log("你在游戏/全屏程序里，回复先排队，等你退出再发：", chat_display_name)
            return True
        with send_lock:
            if not force and (AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen()):
                if not queue_if_busy:
                    return False
                with pending_lock:
                    pending_replies[chat_username or chat_display_name] = (text, chat_display_name, chat_username, time.time())
                log("游戏/全屏中，先排队：", chat_display_name)
                return True
            with gui_lock:
                if gui is None:
                    log("初始化微信窗口驱动…（会抢一下焦点，约 5~10 秒）")
                    gui = WeChatGUI()
            # ⓪ 引用回复（引用对方那条消息）——比普通发送慢，失败自动回退
            if quote_text and QUOTE_REPLY:
                try:
                    if with_window_on_top(lambda: gui.quote_msg(text, who=chat_display_name, target_text=quote_text, verify=False)):
                        log("引用回复成功 →", chat_display_name)
                        return True
                except Exception as e:
                    log("引用回复失败，回退普通发送：", repr(e))
            # ① 首选 UIA：稳定、快，不依赖 OCR 找发送按钮
            t_start = time.time()
            uia_available = False
            try:
                uia_available = gui._get_uia() is not None
            except Exception:
                uia_available = False
            for attempt in (1, 2):
                t_att = time.time()
                try:
                    if with_window_on_top(lambda: uia_send(text, chat_display_name, chat_username)):
                        fail_streak.pop(chat_username, None)
                        log("发送成功（%.1fs）→ %s" % (time.time() - t_start, chat_display_name))
                        return True
                    log("UIA 发送未成功（第 %d 次，%.1fs），准备重试" % (attempt, time.time() - t_att))
                except Exception as e:
                    log("UIA 发送异常（第 %d 次，%.1fs）：%r" % (attempt, time.time() - t_att, e))
                time.sleep(0.5)
            if uia_available:
                # UIA 可用但没发出去：直接放弃，别走 75 秒的 OCR 兜底拖死后面消息
                log("UIA 发不出去，跳过 OCR 兜底：", chat_display_name)
            else:
                log("UIA 不可用，走 OCR 兜底")
            # ② 兜底：仅当 UIA 不可用时才走 OCR。
            #    注意：OCR 这条路在这台机器上会卡死在 PIL.ImageGrab.grab 截屏里
            #    （data/bridge-hang.log 有栈），以前直接拖到 40 秒看门狗把整个桥接
            #    os._exit(2) 重启；这里给它 25 秒，超时就放弃这一条。
            if not uia_available:
                try:
                    with gui_lock:
                        try:
                            gui = WeChatGUI()
                        except Exception as e:
                            log("重建窗口驱动失败：", repr(e))
                    _box = {}

                    def _ocr_send():
                        try:
                            _box["r"] = with_window_on_top(
                                lambda: gui.send_msg(text, chat_display_name, True))
                        except Exception as _e:      # noqa: BLE001
                            _box["e"] = _e

                    _th = threading.Thread(target=_ocr_send, daemon=True)
                    _th.start()
                    _th.join(25)
                    if _th.is_alive():
                        log("OCR 兜底 25 秒没返回（卡在截屏），放弃这条，等下次消息")
                        resp = False
                    else:
                        if "e" in _box:
                            raise _box["e"]
                        resp = _box.get("r")
                    if bool(resp):
                        fail_streak.pop(chat_username, None)
                        return True
                    log("兜底发送失败：%s" % resp)
                except Exception as e:
                    log("兜底发送异常：%r" % e)
            if chat_username:
                fail_streak[chat_username] = fail_streak.get(chat_username, 0) + 1
                if fail_streak[chat_username] >= 2:
                    dead_chats.add(chat_username)
                    log("连续发送失败，先停掉这个会话：", chat_display_name)
            log("发送最终失败，请把微信窗口保持在桌面、别最小化；内容：", text[:30])
            return False

    def send_at(member, text, chat_display_name, chat_username=""):
        """在群里真 @ 某个成员（UI 选人），失败返回 False 让调用方退回普通发送。"""
        nonlocal gui
        if not member or not text:
            return False
        if chat_username and (chat_username in dead_chats or not group_is_alive(chat_username)):
            return False
        if AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen():
            with pending_lock:
                pending_replies[chat_username or chat_display_name] = (text, chat_display_name, chat_username, time.time())
            log("你在游戏/全屏程序里，@ 回复先排队：", chat_display_name)
            return True
        with send_lock:
            with gui_lock:
                if gui is None:
                    log("初始化微信窗口驱动…（会抢一下焦点，约 5~10 秒）")
                    gui = WeChatGUI()
            try:
                ok = bool(with_window_on_top(lambda: gui.at_member(member, text, who=chat_display_name, verify=False)))
                if ok:
                    log("已 @ %s → %s" % (member, chat_display_name))
                    return True
                log("@ 成员失败（%s），改用普通发送" % member)
            except Exception as e:
                log("@ 成员异常：", repr(e))
        return False

    def fetch_original_image(msg):
        if AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen():
            log("当前休息或全屏，暂不打开微信下载图片")
            return None
        user=msg.get("username") or ""
        with send_lock:
            return with_window_on_top(lambda: _get_media().download_image_original(
                user,int(msg["local_id"]),chat_name=display_name(user),
                timeout=12.0,scroll=True,max_scrolls=2,shard=msg.get("shard")))

    def describe_image(msg):
        try:
            path=acquire_image(_get_media(),msg,fetch_original=lambda:fetch_original_image(msg),report=log)
            if not path:
                return screenshot_sticker(display_name(msg.get("username") or ""),msg)
            with open(path,"rb") as handle:
                raw=handle.read()
            raw,mime=prepare_image(raw,_get_media()._wxgf_to_jpg)
            text=request_vision(requests,bot_url.rsplit("/webhook",1)[0],raw,mime)
            log("图片识别成功：%d 字" % len(text))
            return text
        except Exception as error:
            log("图片识别失败：",str(error)[:220])
            return ""

    def transcribe_voice(msg):
        """语音消息 → 文字；失败返回空串。"""
        if not VOICE_ENABLED:
            log("语音识别已关闭（voice.enabled=false）")
            return ""
        try:
            import io
            import wave
            user = msg.get("username") or ""
            lid = msg.get("local_id")
            shard = msg.get("shard")
            if not user or lid is None:
                return ""
            path = _get_media().download_voice(user, int(lid), shard=shard)
            if not path:
                log("语音没落盘（这条微信没缓存到本地），跳过")
                return ""
            try:
                import pysilk
            except Exception:
                log("缺少 pysilk，装一下：pip install silk-python")
                return ""
            pcm = io.BytesIO()
            with open(path, "rb") as f:
                pysilk.decode(f, pcm, VOICE_SAMPLE_RATE)
            raw = pcm.getvalue()
            seconds = len(raw) / float(VOICE_SAMPLE_RATE * 2)
            if seconds < 0.3:
                log("语音太短（%.1fs），跳过" % seconds)
                return ""
            if seconds > VOICE_MAX_SECONDS:
                log("语音太长（%.0fs > %.0fs），跳过" % (seconds, VOICE_MAX_SECONDS))
                return ""
            wav_path = os.path.splitext(path)[0] + ".wav"
            with wave.open(wav_path, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(VOICE_SAMPLE_RATE)
                w.writeframes(raw)
            with open(wav_path, "rb") as f:
                text = asr_transcribe(f.read(), VOICE_API_KEY, VOICE_MODEL, VOICE_BASE_URL, VOICE_TIMEOUT)
            text = clean_transcript(text)
            log("语音识别（%.1fs）：%s" % (seconds, text[:60] or "（空）"))
            return text
        except Exception as e:
            log("语音识别失败：", repr(e))
            return ""

    def _account_root():
        try:
            for rel, path, _ in db._db_files:
                if os.path.basename(path).startswith("message_"):
                    p = os.path.dirname(path)
                    while p and not os.path.basename(p).startswith(("wxid", "all_users")):
                        parent = os.path.dirname(p)
                        if parent == p:
                            break
                        p = parent
                    return p
        except Exception:
            pass
        return ""

    def _find_sticker_file(md5):
        root = _account_root()
        if not root or not md5:
            return ""
        roots = [os.path.join(root, "cache"), os.path.join(root, "msg", "attach")]
        for base in roots:
            for dirpath, _dirs, files in os.walk(base):
                for name in files:
                    if md5 in name:
                        return os.path.join(dirpath, name)
        return ""

    def _sticker_label(content):
        """从表情 XML 的 desc（base64 protobuf）里提取表情名，比如「鲸鱼娘」"""
        try:
            import base64
            import re
            m = re.search(r'desc\s*=\s*"([^"]*)"', content or "")
            if not m:
                return ""
            raw = base64.b64decode(m.group(1))
            txt = raw.decode("utf-8", "ignore")
            parts = [x for x in re.findall(r"[\u4e00-\u9fa5A-Za-z0-9_]{2,}", txt) if x.lower() != "default"]
            return " ".join(parts[:3])
        except Exception:
            return ""

    def screenshot_sticker(who,msg=None):
        """只截已确认属于目标消息的媒体行，不再截整个聊天区底部。"""
        if not msg or not msg.get("username"):
            return ""
        if AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen():
            return ""
        def target_is_latest():
            recent=db.get_messages(msg["username"],limit=1)
            return bool(recent and same_message(msg,recent[0]))
        def capture_target():
            nonlocal gui
            from PIL import ImageGrab
            import io
            if not target_is_latest():
                log("媒体截图跳过：目标之后已有新消息，不能拿当前底部冒充")
                return None
            with gui_lock:
                if gui is None:
                    gui=WeChatGUI()
                u=UIA_CACHE.get("u") or gui._get_uia()
                UIA_CACHE["u"]=u
            if u is None:
                return None
            opened=False
            for alias in aliases_for(msg["username"],who):
                if u.open_chat(alias):
                    opened=True;break
            if not opened:
                log("媒体截图跳过：无法确认已打开目标会话")
                return None
            time.sleep(.25)
            if not target_is_latest():
                return None
            lst=u._message_list()
            if lst is None:
                return None
            lr=lst.BoundingRectangle
            visible=[]
            for child in lst.GetChildren():
                try:
                    cn=child.ClassName or ""
                    if cn in ("mmui::ChatItemView","mmui::ChatSystemInfoItemView"):
                        continue
                    r=child.BoundingRectangle
                    if lr.top <= (r.top+r.bottom)/2 <= lr.bottom and r.right>r.left and r.bottom>r.top:
                        visible.append((cn,child.Name or "",r))
                except Exception:
                    continue
            if not visible:
                return None
            recent=db.get_messages(msg["username"],limit=80)
            r=aligned_media_rect(visible,recent,msg,_get_media()._align_window)
            if r is None:
                log("媒体截图跳过：文本锚点不足或目标消息对齐不唯一")
                return None
            box=(max(lr.left,r.left),max(lr.top,r.top),min(lr.right,r.right),min(lr.bottom,r.bottom))
            if box[2]-box[0]<8 or box[3]-box[1]<8:
                return None
            import win32gui
            hwnd=find_weixin_hwnd()
            foreground=win32gui.GetForegroundWindow()
            if not hwnd or win32gui.GetAncestor(foreground,2)!=win32gui.GetAncestor(hwnd,2):
                log("媒体截图跳过：微信不在前台")
                return None
            image=ImageGrab.grab(bbox=tuple(int(v) for v in box))
            if not target_is_latest():
                return None
            buffer=io.BytesIO();image.save(buffer,"PNG")
            return prepare_image(buffer.getvalue())
        try:
            with send_lock:
                result=with_window_on_top(capture_target)
            if not result:
                return ""
            raw,mime=result
            text=request_vision(requests,bot_url.rsplit("/webhook",1)[0],raw,mime,
                prompt="这是已经按目标消息定位的微信图片或表情气泡截图。只描述其中的图片主体、动作和图片内文字。若只有文字气泡、没有图片或看不清，只回答看不清。不要推测图片外的聊天记录。",timeout=60)
            if not valid_description(text):
                log("媒体截图未得到可信的图片描述")
                return ""
            log("目标媒体截图识别成功：%d 字" % len(text))
            return text
        except Exception as error:
            log("媒体截图识别失败：",str(error)[:220])
            return ""

    def describe_sticker(msg):
        """优先读取、转码表情文件；截图兜底必须确认目标消息。"""
        import re
        content=str(msg.get("content") or "")
        try:
            match=re.search(r'md5="([0-9a-fA-F]{32})"',content)
            path=_find_sticker_file(match.group(1).lower()) if match else ""
            if path:
                with open(path,"rb") as handle:
                    raw=handle.read()
                if raw[:2]==b"\x07\x08":
                    raw=_get_media().decrypt_image(path)
                raw,mime=prepare_image(raw,_get_media()._wxgf_to_jpg)
                text=request_vision(requests,bot_url.rsplit("/webhook",1)[0],raw,mime,timeout=60)
                log("表情文件识别成功：%d 字" % len(text))
                return text
        except Exception as error:
            log("表情文件识别失败：",str(error)[:220])
        shot=screenshot_sticker(display_name(msg.get("username") or ""),msg)
        return shot or _sticker_label(content)

    def on_message_inner(msg, listener):
        try:
            username = msg.get("username") or ""
            if not username:
                return
            # 先过滤自己和过期事件，避免为不应处理的图片抢焦点或调用模型。
            if msg.get("sender_username")==me:
                return
            event_time=float(msg.get("create_time") or 0)
            if event_time and (event_time<START_TS-SKIP_OLDER_THAN or time.time()-event_time>STALE_AFTER):
                return
            if ONLY_CHATS and display_name(username) not in ONLY_CHATS:
                return
            mtype = msg.get("type") or ""
            content = (msg.get("content") or "").strip()
            if mtype == "图片":
                desc = describe_image(msg)
                content = "（对方发了一张图片，图里是：%s）" % desc if desc else "（对方发了一张图片，但程序这次未能下载或识别，尚无图片内容。）"
            if mtype == "语音":
                said = transcribe_voice(msg)
                if not said:
                    log("语音没识别出内容，先不说话")
                    return
                content = "（对方发了一条语音，说的是：%s）" % said
            if mtype in ("表情", "动画表情"):
                desc = describe_sticker(msg)
                if not desc:
                    log("表情包没认出来，先不说话")
                    return
                content = "（对方刚刚新发了一个表情包，内容是：%s）" % desc
            if mtype not in ("文本", "语音", "图片", "表情", "动画表情"):
                if "移出群聊" in content or "移出" in content:
                    dead_chats.add(username)
                    log("被移出群聊，停掉这个会话：", display_name(username))
                    return
                # 链接卡片 / 分享卡片：从 XML 里把 url 和 title 抠出来，当成一句带链接的话
                import re as _re
                mu = _re.search(r"<url>(.*?)</url>", content, _re.S)
                mt = _re.search(r"<title>(.*?)</title>", content, _re.S)
                if mu:
                    title = (mt.group(1).strip() if mt else "")[:60]
                    content = "分享了一个链接：%s %s" % (title, mu.group(1).strip())
                else:
                    return
            if ONLY_CHATS:
                try:
                    if display_name(username) not in ONLY_CHATS:
                        return
                except Exception:
                    return
            # 图片/语音/表情的 content 已经被上面替换成描述，别再重置回原始 XML
            if mtype == "文本":
                content = (msg.get("content") or "").strip()
            if not content or content.startswith("<"):
                return
            sender = msg.get("sender_username") or ""
            if sender == me:
                return  # 自己发的
            create_time = float(msg.get("create_time") or 0)
            if create_time and create_time < START_TS - SKIP_OLDER_THAN:
                return
            # 已经放了太久的消息（比如前面堵着几条），不再回
            if create_time and (time.time() - create_time) > STALE_AFTER:
                log("跳过过期消息（%.0fs 前）：%s" % (time.time() - create_time, content[:20]))
                return

            is_group = username.endswith("@chatroom")
            nickname = ""
            try:
                nickname = db.get_nickname(sender) or ""
            except Exception:
                nickname = ""
            if not nickname:
                nickname = "群友" if is_group else "微信好友"

            # 系统号 / 通知不接话：之前会跟「微信团队」对骂，还把通知当成人来问
            if is_system_notice(username, nickname, content):
                if ONLY_CHATS:
                    return
                log("跳过系统通知：", nickname, "：", content[:24])
                return
            # 同一人短时间内重复同一句 → 不再回（防刷屏 / 防通知重投）
            if duplicate_guard(username, sender, content):
                log("跳过重复消息：", nickname, "：", content[:20])
                return


            # 「拍了拍」这类系统提示不是人在说话，别接
            if "拍了拍" in content and "<url>" not in content:
                log("跳过拍一拍提示：", content[:24])
                return
            # 只把真正的 @ 当作 at_me；普通句子里提到「鲸鲸」不能误触发。
            # WeChat 会在 @昵称 后插入 U+2005，先换成普通空格再判定。
            import re as _mention_re
            _at_text = content.replace("\u2005", " ")
            addressed = any(
                a and _mention_re.search(
                    r"@\s*" + _mention_re.escape(str(a)) + r"(?=$|[\s，,：:！!~～…?？。\-—])",
                    _at_text,
                )
                for a in aliases
            )
            _at_remainder = _mention_re.sub(r"^[A-Za-z0-9_\-]{4,}:\s*", "", _at_text).strip()
            for _alias in aliases:
                if _alias:
                    _at_remainder = _mention_re.sub(r"@\s*" + _mention_re.escape(str(_alias)), " ", _at_remainder)
            _bare_mention = not _at_remainder.strip(" \t\r\n，,。.!！?？…~～")
            # 群里先说话、再单独发一个 @ → 把上一条问题补回来
            if username.endswith("@chatroom") and addressed and _bare_mention:
                try:
                    # get_messages 按新到旧返回；直接遍历，拿离这个裸 @ 最近的上一条。
                    for m in db.get_messages(username, limit=12):
                        if m.get("type") != "文本":
                            continue
                        if (m.get("sender_username") or "") != sender:
                            continue
                        prev = (m.get("content") or "").strip()
                        prev = __import__("re").sub(r"^[A-Za-z0-9_\-]{4,}:\s*", "", prev).strip()
                        if prev and not any(a in prev for a in aliases):
                            content = prev
                            log("补上一条问题：", prev[:20])
                            break
                except Exception as e:
                    log("补问题失败：", repr(e))
            # 把群消息里的其他 @ 对象一并交给服务端，帮助模型分清“你”是在说谁。
            _mentioned_names = []
            if is_group:
                for _hit in _mention_re.findall(r"@\s*([^\s@，,：:！!~～…?？。—]+)", _at_text):
                    _name = str(_hit).strip()
                    if _name and _name not in aliases and _name not in _mentioned_names:
                        _mentioned_names.append(_name)
            log("收到", ("群" if is_group else "私聊"), display_name(username), "←", nickname, "：", content[:30])
            payload = {
                "chat_id": username,
                "chat_type": "group" if is_group else "private",
                "user_id": sender or "unknown",
                "senderId": sender or "unknown",
                "sender_id": sender or "unknown",
                "senderName": nickname,
                "nickname": nickname,
                "text": content,
                "msg_id": "%s:%s:%s" % (username, msg.get("shard") or "", msg.get("local_id")),
                "at_me": addressed,
                "mentioned_names": _mentioned_names,
                "chat_title": display_name(username) if is_group else "",
            }


            try:
                r = requests.post(
                    bot_url,
                    json=payload,
                    headers={"x-bot-token": token} if token else {},
                    timeout=120,
                )
                data = r.json()
            except Exception as e:
                log("请求鲸鲸失败：", repr(e))
                return

            if data.get("action") != "reply" or not data.get("reply"):
                if is_group and addressed:
                    log("鲸鲸没接话：", nickname, "→", content[:20], "|", data.get("reason"))
                return

            target = display_name(username)
            bubbles = data.get("bubbles") or [data["reply"]]
            mention = str(data.get("mention") or "").strip()
            # 生成期间又来了新消息 → 这条旧回复就不发了（避免回上一句）
            # 不再因为“有新消息”丢掉旧回复：宁可晚一点，也要回
            if not rate_guard(username):
                log("这一分钟回太多了，先停一下：", target)
                return
            log("回复", ("群" if is_group else "私聊"), target, "→", nickname, "：", (bubbles[0] or "")[:40])

            first = True
            for line in bubbles:
                if not line:
                    continue
                # 第一条如果是骂人/点名，用真 @（UI 里选成员），而不是纯文本 @名字
                if first and mention and is_group:
                    body = line
                    for prefix in ("@%s" % mention, "@ %s" % mention):
                        if body.startswith(prefix):
                            body = body[len(prefix):].lstrip(" ，,：:")
                            break
                    if send_at(mention, body, target, username):
                        first = False
                        time.sleep(0.6)
                        continue
                    log("真 @ 失败，退回普通文本：", mention)
                    if not line.startswith("@"):
                        line = "@%s %s" % (mention, line)
                send_text(line, target, username, quote_text=(content if first and QUOTE_REPLY else None))
                first = False
                time.sleep(0.6)
        except Exception as e:
            log("处理消息异常：", repr(e))

    log("开始监听新消息…（Ctrl+C 退出）")
    executor = ThreadPoolExecutor(max_workers=1)

    def on_message(msg, listener):
        RECEIVE_HEALTH.incoming()
        # 每条消息丢线程池：发送慢不再阻塞后面消息的接收
        try:
            executor.submit(on_message_inner, msg, listener)
        except Exception as e:
            log("提交消息处理失败：", repr(e))

    class HealthyListener(Listener):
        def _poll_once(self):
            RECEIVE_HEALTH.poll_begin()
            try:
                super()._poll_once()
            except Exception as error:
                RECEIVE_HEALTH.poll_failed(error)
                raise
            else:
                RECEIVE_HEALTH.poll_ok()
    listener = HealthyListener(db, interval=0.4)
    RECEIVE_HEALTH.listener=listener
    listener.add_all(on_message)
    listener.start()
    def recent_chats(limit=2, within=1800, scan_limit=20, strict_recent=False):
        out = []
        try:
            for s in db.get_sessions(limit=scan_limit):
                u = s.get("username") or ""
                if not u or u == "filehelper":
                    continue
                try:
                    ms = db.get_messages(u, limit=1)
                except Exception:
                    continue
                if not ms:
                    continue
                t = float(ms[0].get("create_time") or 0)
                if strict_recent and not 0 < t <= time.time()+60:
                    continue
                if t and (time.time() - t) > within:
                    continue
                out.append((u, display_name(u)))
                if len(out) >= limit:
                    break
        except Exception:
            pass
        return out

    def notify_away():
        for u, name in recent_chats():
            send_text("我先去休息一下，晚点回你～", name, u, force=True)
            NOTIFIED.append((u, name))
            time.sleep(0.3)
        if NOTIFIED:
            log("已通知最近的聊天：", "、".join(n for _, n in NOTIFIED))

    def share_watch():
        """只向白名单内最近活跃的一个会话随机分享；空名单不发。"""
        state_file = os.path.join(ROOT, "data", "share-state.json")
        try:
            with open(state_file, "r", encoding="utf-8") as f:
                last = float(json.load(f).get("lastTs") or 0)
        except Exception:
            last = 0.0
        if not last:
            # 首次启动：至少等一分钟再检查分享条件
            last = time.time() - SHARE_EVERY * 60 + 60
        while True:
            time.sleep(30)
            policy=load_policy(CONFIG_PATH)
            if not policy['enabled'] or not policy['allowedChats'] or os.path.exists(os.path.join(ROOT,'data','PAUSED')):
                continue
            if time.time() - last < policy['everyMinutes'] * 60:
                continue
            if game_running() or away_active() or foreground_is_fullscreen():
                continue
            target = choose_target(recent_chats(limit=800, within=7200, scan_limit=800, strict_recent=True),policy)
            if not target:
                log("白名单里没有最近两小时活跃的会话，这次先不分享")
                last = time.time()
                continue
            u, name = target
            try:
                base = bot_url.rsplit("/webhook", 1)[0]
                r = requests.get(base + "/api/share?chat=" + urllib.parse.quote(u), timeout=40)
                data = r.json()
            except Exception as e:
                log("拉取视频失败：", repr(e))
                last = time.time()
                continue
            video = data.get("video")
            last = time.time()
            try:
                with open(state_file, "w", encoding="utf-8") as f:
                    json.dump({"lastTs": last}, f)
            except Exception:
                pass
            if not video:
                log("这次没挑到合适的视频")
                continue
            title = str(video.get("title") or "")[:60]
            link = str(video.get("url") or "")
            topic = str(data.get("topic") or "").strip()
            comment = str(data.get("comment") or "").strip()
            if not comment:
                comment = random.choice([
                    "这个看着还行，评论区比视频有意思",
                    "刚刷到，你们看看",
                    "有点意思，我接着刷了",
                ])
            text = "%s\n%s" % (link, comment)
            log("主动分享视频 →", name, str(video.get("title"))[:30])
            sent=send_if_allowed(CONFIG_PATH,u,name,text,send_text,paused=lambda:os.path.exists(os.path.join(ROOT,'data','PAUSED')))
            if not sent:log('分享跳过：名单已变更、已暂停或发送条件不满足')

    BATTERY_SENT = {"done": False}

    def battery_watch():
        while True:
            time.sleep(30)
            try:
                import psutil
                b = psutil.sensors_battery()
            except Exception:
                continue
            if not b or b.percent is None:
                continue
            pct = float(b.percent)
            if pct > 10:
                BATTERY_SENT["done"] = False
                continue
            if pct <= LOW_BATTERY_PCT and not BATTERY_SENT["done"]:
                BATTERY_SENT["done"] = True
                log("电量低（%.0f%%），给最近 3 个会话发晚安" % pct)
                try:
                    for u, name in recent_chats(limit=3, within=86400):
                        send_text(GOODNIGHT_TEXT, name, u, force=True)
                        time.sleep(0.4)
                except Exception as e:
                    log("发晚安失败：", repr(e))

    def notify_back():
        for u, name in list(NOTIFIED):
            send_text("我回来啦，刚在打游戏", name, u, force=True)
            time.sleep(0.3)
        NOTIFIED.clear()

    def game_watch():
        while True:
            time.sleep(4)
            running = game_running()
            if running and not AWAY["on"]:
                AWAY["on"] = True
                log("检测到游戏运行，进入休息模式（回复先排队）")
                if AWAY_NOTICE and not game_running():
                    try:
                        notify_away()
                    except Exception as e:
                        log("休息通知失败：", repr(e))
            elif not running and AWAY["on"]:
                AWAY["on"] = False
                log("游戏已退出，补发排队消息")
                with pending_lock:
                    items = list(pending_replies.values())
                    pending_replies.clear()
                now = time.time()
                fresh = [x for x in items if now - x[3] <= QUEUED_MAX_AGE]
                dropped = len(items) - len(fresh)
                fresh = fresh[-QUEUED_MAX_CHATS:]
                if dropped:
                    log("排队里有 %d 条已经太旧（>%ds），不补发" % (dropped, int(QUEUED_MAX_AGE)))
                for text, target, uname, _ts in fresh:
                    send_text(text, target, uname, force=True)
                if RETURN_NOTICE:
                    try:
                        notify_back()
                    except Exception as e:
                        log("回来通知失败：", repr(e))

    def digest_watch():
        last = time.time()
        while True:
            time.sleep(30)
            if DIGEST_MINUTES <= 0 or not MASTER_WXID:
                continue
            if time.time() - last < DIGEST_MINUTES * 60:
                continue
            if AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen():
                continue
            try:
                base = bot_url.rsplit("/webhook", 1)[0]
                r = requests.get(base + "/api/digest", params={"since": int(last * 1000)}, timeout=30)
                data = r.json()
            except Exception as e:
                log("拉取消息汇总失败：", repr(e))
                continue
            if data.get("count") and data.get("text"):
                name = display_name(MASTER_WXID) or "主人"
                log("给主人发消息汇总：%d 条" % data["count"])
                if send_text(data["text"], name, MASTER_WXID, force=True):
                    last = time.time()
            else:
                last = time.time()

    def warmup():
        """启动后预热发送通道，避免第一条回复慢 5~10 秒。"""
        time.sleep(3)
        if game_running():
            log("游戏在运行，跳过发送通道预热")
            return
        try:
            nonlocal gui
            with gui_lock:
                if gui is None:
                    gui = WeChatGUI()
            u = gui._get_uia()
            UIA_CACHE["u"] = u
            if u is None:
                log("发送通道预热：UIA 不可用（只剩 OCR 兜底，先跑「一键修复并自检.bat」）")
            else:
                win = getattr(u, "_win", None)
                try:
                    wcls = win.ClassName if win is not None else None
                    wname = win.Name if win is not None else None
                except Exception:                # noqa: BLE001
                    wcls, wname = None, None
                log("发送通道预热完成（UIA 可用，主窗类名=%r 名称=%r）" % (wcls, wname))
        except Exception as e:
            log("发送通道预热失败：", repr(e))

    def send_watchdog():
        """普通发送超时40秒，朋友圈选图流程超时90秒后重连。"""
        while True:
            time.sleep(5)
            timeout = SEND_STATE.get("timeout", 40)
            if SEND_STATE["active"] and (time.time() - SEND_STATE["start"]) > timeout:
                log("界面操作卡住超过 %d 秒，强制重启桥接进程…" % timeout)
                time.sleep(0.3)
                os._exit(2)

    def flush_pending():
        while True:
            time.sleep(2)
            if AWAY["on"] or away_active() or foreground_is_fullscreen():
                continue
            with pending_lock:
                if not pending_replies:
                    continue
                items = list(pending_replies.values())
                pending_replies.clear()
            now = time.time()
            fresh = [x for x in items if now - x[3] <= QUEUED_MAX_AGE][-QUEUED_MAX_CHATS:]
            for text, target, uname, _ts in fresh:
                log("补发排队消息 →", target)
                send_text(text, target, uname, force=True)

    threading.Thread(target=flush_pending, daemon=True).start()
    threading.Thread(target=game_watch, daemon=True).start()
    threading.Thread(target=digest_watch, daemon=True).start()
    threading.Thread(target=warmup, daemon=True).start()
    threading.Thread(target=send_watchdog, daemon=True).start()
    threading.Thread(target=battery_watch, daemon=True).start()
    threading.Thread(target=share_watch, daemon=True).start()
    from proactive_chat import ProactiveChatPoller
    proactive_poller = ProactiveChatPoller(
        base_url=bot_url.rsplit("/webhook", 1)[0], token=token, http=requests,
        send=lambda text, name, username: send_text(text, name, username, queue_if_busy=False),
        paused=lambda: (AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen()
                        or os.path.exists(os.path.join(ROOT, "data", "PAUSED"))),
        display_name=display_name, log=log,
    )
    threading.Thread(target=proactive_poller.run, daemon=True).start()
    if (cfg.get("actions") or {}).get("enabled"):
        from wechat_action_worker import WeChatActionWorker,send_group_verified,send_group_ui_once
        from moment_publisher import MomentPublisher,WeChatMomentUI
        from moment_camera import locate_camera
        from moment_dialogs import related_roots as moment_dialog_roots
        def action_paused():
            return (os.path.exists(os.path.join(ROOT,"data","WECHAT_STOPPED")) or AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen()
                    or os.path.exists(os.path.join(ROOT,"data","PAUSED")))
        def action_driver():
            nonlocal gui
            with gui_lock:
                if gui is None:gui=WeChatGUI()
                driver=UIA_CACHE.get("u") or gui._get_uia()
                UIA_CACHE["u"]=driver
                return driver
        def publish_action_moment(text):
            if action_paused():return {"outcome":"draft","error":"当前窗口忙碌，保留文案"}
            from wechatauto.moment import MomentDB
            from moment_media import prepare_moment_image
            job=action_worker.active_job or {}
            try:image_path=prepare_moment_image(ROOT,job.get('media'))
            except (ValueError,OSError):return {"outcome":"draft","error":"未能确认任务绑定的emotion配图，未打开选图窗口"}
            def still_authorized():
                job=action_worker.active_job
                return bool(job) and action_worker.post('/api/actions/validate',{'id':job['id'],'lease':job['lease']}).get('valid') is True
            publisher=MomentPublisher(WeChatMomentUI(action_driver,action_paused,still_authorized,report=log,camera_probe=locate_camera,dialog_roots=moment_dialog_roots),lambda:MomentDB(db).get_my_moments(limit=8))
            with send_lock:
                return with_window_on_top(lambda:publisher.publish(text,image_path=image_path),require_foreground=True)
        def action_send(text,name,username):
            sender=lambda text,name,username:send_text(text,name,username,queue_if_busy=False)
            if username.endswith("@chatroom"):
                def send_once(text,name,username):
                    if action_paused():return False
                    with send_lock:
                        if action_paused():return False
                        return with_window_on_top(lambda:send_group_ui_once(action_driver(),text,name))
                return send_group_verified(send_once,db.get_messages,text,name,username,me)
            return sender(text,name,username)
        action_worker=WeChatActionWorker(base_url=bot_url.rsplit("/webhook",1)[0],token=token,http=requests,
            send=action_send,publish_moment=publish_action_moment,paused=action_paused,
            display_name=display_name,log=log,dry_run=os.environ.get("WHALE_ACTION_DRY_RUN")=="1")
        threading.Thread(target=action_worker.run,daemon=True).start()
        log("v3 私聊动作通道已启动（群聊代发；朋友圈实验发表）")
    def agent_contact_sync():
        while True:
            try:
                contacts=[{"id":uid,"name":name} for uid,name in db.nickname_map(refresh=True).items() if isinstance(uid,str) and not uid.endswith("@chatroom")]
                response=requests.post(bot_url.rsplit("/webhook",1)[0]+"/api/agent/contacts",json={"contacts":contacts},headers={"X-Bot-Token":token},timeout=10)
                response.raise_for_status()
            except Exception as error:log("Agent 联系人同步本轮未完成：",type(error).__name__)
            time.sleep(300)
    if (cfg.get("agent") or {}).get("enabled"):
        threading.Thread(target=agent_contact_sync,daemon=True).start()
    log("已启动。鲸鲸地址：", bot_url)

    try:
        while True:
            time.sleep(1)
            if os.path.exists(os.path.join(ROOT,"data","WECHAT_STOPPED")):
                log("桌宠已关闭微信桥接")
                break
    except KeyboardInterrupt:
        log("正在退出…")
    listener.stop()
    RECEIVE_HEALTH.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
