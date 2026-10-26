import io,os,sys,tempfile,unittest
from types import SimpleNamespace
sys.path.insert(0,os.path.join(os.getcwd(),"examples"))
from bridge_media import acquire_image,prepare_image,request_vision,same_message,valid_media_control,valid_description,aligned_media_rect,MAX_UPLOAD_BYTES
from PIL import Image


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.path=os.path.join(self.temp.name,"image.png")
        Image.new("RGB",(24,16),"blue").save(self.path)
        self.msg={"username":"fixture","local_id":3,"shard":"message_0.db","type":"图片"}

    def test_cache_miss_drives_wechat_download_for_exact_id(self):
        calls=[]
        def get(*args,**kw): calls.append((args,kw));return None
        media=SimpleNamespace(download_image=get)
        self.assertEqual(acquire_image(media,self.msg,fetch_original=lambda:self.path),self.path)
        self.assertEqual([c[1]["tier"] for c in calls],["full","best"])
        self.assertTrue(all(c[0]==("fixture",3) and c[1]["shard"]=="message_0.db" for c in calls))

    def test_full_image_does_not_open_wechat(self):
        def fail(): raise AssertionError("must not open UI")
        media=SimpleNamespace(download_image=lambda *args,**kw:self.path)
        self.assertEqual(acquire_image(media,self.msg,fetch_original=fail),self.path)

    def test_wxgf_is_converted_before_upload_and_mime_matches_bytes(self):
        with open(self.path,"rb") as handle: png=handle.read()
        output,mime=prepare_image(b"wxgf-fixture",lambda raw:png)
        self.assertEqual(mime,"image/jpeg");self.assertTrue(output.startswith(b"\xff\xd8"))
        with self.assertRaisesRegex(ValueError,"转换失败"):prepare_image(b"wxgf-fixture")

    def test_normalization_keeps_base64_inside_server_limit(self):
        buffer=io.BytesIO();Image.effect_noise((2400,2400),100).convert("RGB").save(buffer,"PNG")
        output,mime=prepare_image(buffer.getvalue());self.assertLessEqual(len(output),MAX_UPLOAD_BYTES)
        self.assertLess(len(output)*4/3+500,2*1024*1024)

    def test_http_error_is_not_silently_converted_to_empty_description(self):
        http=SimpleNamespace(post=lambda *args,**kw:SimpleNamespace(status_code=413,json=lambda:{"ok":False,"error":"body too large"}))
        with self.assertRaisesRegex(ValueError,"413"):request_vision(http,"http://localhost",b"fixture","image/png")
        http.post=lambda *args,**kw:SimpleNamespace(status_code=200,json=lambda:{"ok":True,"text":""})
        with self.assertRaisesRegex(ValueError,"空描述"):request_vision(http,"http://localhost",b"fixture","image/png")

    def test_only_target_message_may_be_screenshotted(self):
        self.assertTrue(same_message(self.msg,dict(self.msg)))
        self.assertFalse(same_message(self.msg,{**self.msg,"local_id":4}))
        self.assertFalse(same_message(self.msg,{**self.msg,"shard":"message_1.db"}))
        self.assertFalse(valid_media_control("mmui::ChatTextItemView","hello"))
        self.assertTrue(valid_media_control("mmui::ChatBubbleReferItemView","图片"))
        self.assertTrue(valid_media_control("mmui::ChatEmojiItemView",""))
        self.assertFalse(valid_description("最底部是一条文字消息，不是图片。"))
        self.assertTrue(valid_description("一只橘猫正在睡觉。"))

    def test_ambiguous_or_unanchored_media_rows_are_never_captured(self):
        visible=[("mmui::ChatTextItemView","anchor1",1),("mmui::ChatTextItemView","anchor2",2),("mmui::ChatBubbleReferItemView","图片",3)]
        rows=[self.msg,{"local_id":2,"type":"文本","content":"anchor2"},{"local_id":1,"type":"文本","content":"anchor1"}]
        self.assertEqual(aligned_media_rect(visible,rows,self.msg,lambda *a,**k:{"anchors":2,"ties":[0]}),3)
        self.assertIsNone(aligned_media_rect(visible,rows,self.msg,lambda *a,**k:{"anchors":2,"ties":[0,1]}))
        self.assertIsNone(aligned_media_rect(visible,rows,self.msg,lambda *a,**k:{"anchors":1,"ties":[0]}))


if __name__=="__main__":unittest.main()
