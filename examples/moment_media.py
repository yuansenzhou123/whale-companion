"""Resolve only the owner-approved emotion asset bound to a leased Moments job."""
import hashlib,io,pathlib
from PIL import Image

def prepare_moment_image(root,media):
    root=pathlib.Path(root).resolve()
    if not isinstance(media,dict) or media.get('source')!='emotion':raise ValueError('未绑定已授权的朋友圈配图')
    relative=media.get('relativePath','')
    if not isinstance(relative,str) or not relative.startswith('emotion/') or '\\' in relative or '..' in relative.split('/'):raise ValueError('朋友圈配图超出授权图库')
    catalog=(root/'emotion').resolve();source=(root/relative).resolve(strict=True)
    if not source.is_relative_to(catalog) or not source.is_file() or source.suffix.lower() not in ('.gif','.png','.jpg','.jpeg','.webp'):raise ValueError('朋友圈配图超出授权图库')
    if source.stat().st_size>20*1024*1024:raise ValueError('朋友圈配图过大')
    body=source.read_bytes();fingerprint=hashlib.sha256(body).hexdigest()
    if len(body)!=media.get('bytes') or fingerprint!=media.get('sha256'):raise ValueError('朋友圈配图已变更，未选择图片')
    with Image.open(io.BytesIO(body)) as image:
        if image.width*image.height>20000000:raise ValueError('朋友圈配图尺寸过大')
        image.seek(0);frame=image.convert('RGBA')
        folder=root/'data'/'moment-media';folder.mkdir(parents=True,exist_ok=True)
        output=folder/(fingerprint+'.png');temporary=folder/(fingerprint+'.png.tmp')
        frame.save(temporary,format='PNG');temporary.replace(output)
    return str(output)
