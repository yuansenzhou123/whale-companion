import importlib.util
from pathlib import Path
import unittest


SPEC = importlib.util.spec_from_file_location(
    "proactive_chat", Path(__file__).resolve().parents[1] / "examples" / "proactive_chat.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Response:
    def __init__(self, data):
        self.data = data

    def raise_for_status(self):
        pass

    def json(self):
        return self.data


class FakeHttp:
    def __init__(self):
        self.message = {"id": "test-id", "chatId": "wxid_owner", "chatType": "private", "text": "来找你聊两句呀"}
        self.calls = []
        self.fail_ack_once = False
        self.on_next = lambda: None

    def post(self, url, json, headers, timeout):
        self.calls.append((url, json.copy(), headers.copy()))
        if url.endswith("/next"):
            self.on_next()
            message, self.message = self.message, None
            return Response({"ok": True, "message": message})
        if self.fail_ack_once:
            self.fail_ack_once = False
            raise OSError("temporary connection failure")
        return Response({"ok": True})


class ProactiveBridgeTests(unittest.TestCase):
    def setUp(self):
        self.http = FakeHttp()
        self.sent = []
        self.paused = False
        self.poller = MODULE.ProactiveChatPoller(
            "http://localhost:8787", "test-secret", self.http,
            lambda text, name, username: self.sent.append((text, name, username)) or True,
            lambda: self.paused, lambda username: "主人", lambda *args: None)

    def test_paused_does_not_request_or_send(self):
        self.paused = True
        self.assertFalse(self.poller.poll_once())
        self.assertEqual(self.http.calls, [])
        self.assertEqual(self.sent, [])

    def test_send_then_ack_with_token(self):
        self.assertTrue(self.poller.poll_once())
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0][2], "wxid_owner")
        self.assertEqual(self.http.calls[-1][1], {"id": "test-id", "sent": True})
        self.assertEqual(self.http.calls[0][2], {"X-Bot-Token": "test-secret"})

    def test_pause_during_generation_discards_without_sending(self):
        self.http.on_next = lambda: setattr(self, "paused", True)
        self.assertFalse(self.poller.poll_once())
        self.assertEqual(self.sent, [])
        self.assertFalse(self.http.calls[-1][1]["sent"])

    def test_group_is_never_a_target(self):
        self.http.message["chatId"] = "123@chatroom"
        self.http.message["chatType"] = "group"
        self.assertFalse(self.poller.poll_once())
        self.assertEqual(self.sent, [])

    def test_ack_failure_retries_ack_without_resending(self):
        self.http.fail_ack_once = True
        with self.assertRaises(OSError):
            self.poller.poll_once()
        self.assertIsNotNone(self.poller.pending_ack)
        self.assertEqual(len(self.sent), 1)
        self.assertFalse(self.poller.poll_once())
        self.assertEqual(len(self.sent), 1)
        self.assertIsNone(self.poller.pending_ack)
        acks = [body for url, body, _headers in self.http.calls if url.endswith("/ack")]
        self.assertEqual(acks, [{"id": "test-id", "sent": True}] * 2)

    def test_failed_send_reports_false(self):
        self.poller.send = lambda *args: False
        self.assertFalse(self.poller.poll_once())
        self.assertFalse(self.http.calls[-1][1]["sent"])


if __name__ == "__main__":
    unittest.main()
