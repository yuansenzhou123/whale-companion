"""微信主动私聊轮询；复用桥接的身份目标、暂停判断和实际发送通道。"""
import time


class ProactiveChatPoller:
    def __init__(self, base_url, token, http, send, paused, display_name, log):
        self.base_url = base_url.rstrip("/")
        self.headers = {"X-Bot-Token": token}
        self.http = http
        self.send = send
        self.paused = paused
        self.display_name = display_name
        self.log = log
        self.pending_ack = None

    def post(self, endpoint, body):
        response = self.http.post(self.base_url + endpoint, json=body,
                                  headers=self.headers, timeout=60)
        response.raise_for_status()
        return response.json()

    def acknowledge(self):
        if self.pending_ack:
            result = self.post("/api/proactive/ack", self.pending_ack)
            if not result.get("ok"):
                self.log("主动聊天确认已失效，跳过旧消息")
            self.pending_ack = None

    def poll_once(self):
        # 确认失败只重试确认，绝不重发正文。
        self.acknowledge()
        if self.paused():
            return False
        result = self.post("/api/proactive/next", {})
        message = result.get("message") if result.get("ok") else None
        if not message:
            return False
        message_id = message.get("id")
        username = str(message.get("chatId") or "")
        text = str(message.get("text") or "").strip()
        if not message_id:
            return False
        self.pending_ack = {"id": message_id, "sent": False}
        valid = message.get("chatType") == "private" and username and not username.endswith("@chatroom") and text
        sent = False
        if valid and not self.paused():
            try:
                sent = bool(self.send(text, self.display_name(username), username))
            except Exception as error:
                self.log("主动聊天发送失败：", type(error).__name__)
        self.pending_ack["sent"] = sent
        self.acknowledge()
        if sent:
            self.log("主动找主人聊天 →", self.display_name(username))
        return sent

    def run(self):
        while True:
            time.sleep(30)
            try:
                self.poll_once()
            except Exception as error:
                self.log("主动聊天这次先跳过：", type(error).__name__)
