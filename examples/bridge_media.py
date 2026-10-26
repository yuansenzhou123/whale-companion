"""Image acquisition/normalization and strict vision response handling.

No UI or network activity on import. Callers provide the downloader, HTTP client
and optional UI fetch operation; tests can exercise the full path without WeChat.
"""
import base64
import io
import os

MAX_UPLOAD_BYTES = 1300000  # base64 plus JSON fits the server's 2 MiB body limit


def acquire_image(media, msg, fetch_original=None, report=lambda *args: None):
    user = msg.get("username") or ""
    local_id = msg.get("local_id")
    if not user or local_id is None:
        report("图片缺少会话或消息编号")
        return None
    for _tier in ("full", "best"):
        try:
            found = media.download_image(user, int(local_id), tier=_tier, shard=msg.get("shard"))
            if found and os.path.isfile(found):
                report("图片档位：%s → %d KB" % (_tier, os.path.getsize(found) // 1024))
                return found
        except Exception as error:
            report("图片下载失败（tier=%s）：%s" % (_tier, type(error).__name__))
    if fetch_original:
        try:
            found = fetch_original()
            if found and os.path.isfile(found):
                report("图片档位：微信界面下载 → %d KB" % (os.path.getsize(found) // 1024))
                return found
        except Exception as error:
            report("微信界面取图失败：", type(error).__name__)
        # WeChat may finish writing the target file even if the original-only UI
        # request times out. Check the same message again, never another message.
        for _tier in ("full", "best"):
            try:
                found = media.download_image(user, int(local_id), tier=_tier, shard=msg.get("shard"))
                if found and os.path.isfile(found):
                    return found
            except Exception:
                pass
    report("图片取不到本地文件")
    return None


def prepare_image(raw, wxgf_decoder=None):
    from PIL import Image, ImageOps
    if raw[:4] == b"wxgf":
        raw = wxgf_decoder(raw) if wxgf_decoder else None
        if not raw:
            raise ValueError("微信图片格式转换失败，缺少转码工具或格式不受支持")
    if not raw:
        raise ValueError("图片文件为空")
    with Image.open(io.BytesIO(raw)) as source:
        source.seek(0)
        image = ImageOps.exif_transpose(source).convert("RGBA")
        background = Image.new("RGB", image.size, "white")
        background.paste(image, mask=image.getchannel("A"))
        background.thumbnail((4096, 4096), Image.Resampling.LANCZOS)
        for quality in (90, 80, 68, 55):
            buffer = io.BytesIO()
            background.save(buffer, "JPEG", quality=quality, optimize=True)
            if len(buffer.getvalue()) <= MAX_UPLOAD_BYTES:
                return buffer.getvalue(), "image/jpeg"
        while min(background.size) > 32:
            background = background.resize((max(1,int(background.width*.8)),max(1,int(background.height*.8))), Image.Resampling.LANCZOS)
            buffer = io.BytesIO();background.save(buffer,"JPEG",quality=68,optimize=True)
            if len(buffer.getvalue()) <= MAX_UPLOAD_BYTES:
                return buffer.getvalue(), "image/jpeg"
    raise ValueError("图片超过识图接口的上传大小限制")


def request_vision(http, base_url, raw, mime, prompt="", timeout=90):
    payload={"image":base64.b64encode(raw).decode("ascii"),"mime":mime}
    if prompt:
        payload["prompt"]=prompt
    response=http.post(base_url.rstrip("/")+"/api/vision",json=payload,timeout=timeout)
    try:
        result=response.json()
    except Exception as error:
        raise ValueError("识图接口没有返回JSON，HTTP %s" % response.status_code) from error
    if response.status_code != 200 or result.get("ok") is False:
        message=str(result.get("error") or "请求失败")[:200]
        raise ValueError("识图接口 HTTP %s：%s" % (response.status_code,message))
    text=str(result.get("text") or "").strip()
    if not text:
        raise ValueError("识图接口返回空描述")
    if len(text) > 600:
        text=text[:600]+"…"
    return text


def same_message(first, second):
    if not first or not second:
        return False
    if first.get("local_id") is None or str(first.get("local_id")) != str(second.get("local_id")):
        return False
    for key in ("shard","server_id","sender_username"):
        if first.get(key) and second.get(key) and str(first[key]) != str(second[key]):
            return False
    if first.get("create_time") and second.get("create_time") and abs(float(first["create_time"])-float(second["create_time"])) > 1:
        return False
    return first.get("type") == second.get("type")


def valid_media_control(class_name, name):
    import re
    return name in ("图片","[图片]","表情","[表情]","动画表情") or bool(re.search(r"Image|Picture|Emotion|Emoticon|Sticker|Emoji",class_name))


def valid_description(text):
    return bool(text and not any(term in text for term in ("看不清","未见图片","没有图片","不是图片","不是表情","文字消息","绿色气泡的文字","模糊")))


def aligned_media_rect(visible, rows, target, align):
    """Require two text anchors and an unambiguous target row before capture."""
    ui=[]
    for class_name,name,rect in visible:
        if valid_media_control(class_name,name):ui.append(("image",name,rect))
        elif class_name=="mmui::ChatTextItemView":ui.append(("text",name,rect))
    db=[]
    for row in reversed(rows):
        kind="text" if row.get("type")=="文本" else "image" if row.get("type") in ("图片","表情","动画表情") else None
        if kind:db.append({"kind":kind,"content":row.get("content") or "","row":row})
    target_indexes=[i for i,item in enumerate(db) if same_message(target,item["row"])]
    if len(target_indexes)!=1:return None
    result=align(ui,db,min_score=1.0,min_text_anchors=2)
    if not result or result.get("anchors",0)<2:return None
    positions={target_indexes[0]-offset for offset in result.get("ties",[])}
    if len(positions)!=1:return None
    position=positions.pop()
    if position!=len(ui)-1 or position<0 or ui[position][0]!="image":return None
    return ui[position][2]
