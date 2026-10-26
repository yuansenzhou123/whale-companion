"""Soft, rounded speech bubbles, painted only when their content changes."""
from pathlib import Path
import math
import os
import time
from PIL import Image,ImageDraw,ImageFilter,ImageFont

PALETTES = {
    'neutral':('#fcfdff','#eef5ff','#bed2f2','#e2edff'),
    'happy':('#fffdfd','#fff0f5','#e9bfd6','#fce2ed'),
    'surprised':('#fffef8','#fff6df','#e5d4a1','#fff0c8'),
    'sad':('#fbfdff','#eff2fc','#c8ccea','#e6eafa'),
    'curious':('#fbfffe','#edf9f7','#b9dbdc','#def2ef'),
    'thinking':('#fefcff','#f4effc','#d3c6ec','#eee4fb'),
    'sleepy':('#fcfdff','#f0f4fc','#cad5e9','#e6edf9'),
}

def rgb(hex_color):
    return tuple(bytes.fromhex(hex_color.lstrip('#')))

class BubblePainter:
    def __init__(self,width=400,height=160):
        self.width,self.height,self.scale = width,height,2
        fonts = Path(os.environ.get('WINDIR','C:/Windows'))/'Fonts'
        self.body_path = next((fonts/p for p in ['SIMYOU.TTF','simyou.ttf','msyh.ttc'] if (fonts/p).exists()),None)
        if not self.body_path:
            raise RuntimeError('找不到可用的中文字体')
        self.fonts = {size:ImageFont.truetype(str(self.body_path),size*self.scale) for size in [20,19,18,17,16]}
        self.name_font = ImageFont.truetype(str(self.body_path),15*self.scale)
        self.caption_font = ImageFont.truetype(str(fonts/'msyh.ttc'),11*self.scale)
        self.punctuation_fonts = {f.size:ImageFont.truetype(str(fonts/'msyh.ttc'),f.size) for f in [*self.fonts.values(),self.name_font]}
        self.key,self.image,self.started = None,None,0

    def measure(self,text,font,spacing=.4):
        return sum(font.getlength(c) for c in text)+max(0,len(text)-1)*spacing*self.scale

    def lines(self,text,font,width):
        result,line = [],''
        closing='，。！？、；：）】》”’…～,.!?:;)]'
        opening='（【《“‘(['
        for ch in str(text):
            if ch=='\n':
                result.append(line)
                line=''
                continue
            if line and self.measure(line+ch,font)>width*self.scale:
                if ch in closing and self.measure(line+ch,font)<(width+15)*self.scale:
                    line+=ch
                    continue
                carry=''
                if line[-1:] in opening:
                    carry,line=line[-1],line[:-1]
                result.append(line)
                line=carry
            line+=ch
        if line or not result:
            result.append(line)
        return result

    def text(self,draw,position,text,font,fill,spacing=.4,stroke=0):
        x,y=[v*self.scale for v in position]
        baseline=y-font.getbbox('鲸',anchor='ls')[1]
        for ch in text:
            glyph_font=self.punctuation_fonts[font.size] if ch in '～~' else font
            draw.text((round(x),round(baseline)),ch,font=glyph_font,fill=fill,stroke_width=stroke,stroke_fill=fill,anchor='ls')
            x+=font.getlength(ch)+spacing*self.scale

    def short_caption(self,title,width):
        text=str(title).strip() or '陪你看这一段'
        if text.startswith('鲸鲸 ·'):
            text='陪你看这一段'
        while text and self.caption_font.getlength(text)>width*self.scale:
            text=text[:-2]+'…' if not text.endswith('…') else text[:-2]+'…'
        return text

    def paint(self,title,text,mood='neutral'):
        s=self.scale
        w,h=self.width*s,self.height*s
        image=Image.new('RGBA',(w,h))
        width=self.width-60
        for size,font in self.fonts.items():
            lines=self.lines(str(text).strip(),font,width)
            if len(lines)<=3:
                break
        if len(lines)>3:
            lines=lines[:3]
            lines[-1]=lines[-1][:-1]+'…'
        line_height=26 if size>=19 else 24
        card_bottom=self.height-20
        card_height=54+len(lines)*line_height
        top=max(8,card_bottom-card_height)
        left,right=10,self.width-10
        box=tuple(round(v*s) for v in (left,top,right,card_bottom))
        mask=Image.new('L',(w,h))
        md=ImageDraw.Draw(mask)
        md.rounded_rectangle(box,radius=27*s,fill=255)
        tail=[((self.width/2-10)*s,(card_bottom-3)*s),((self.width/2+3)*s,(card_bottom+12)*s),((self.width/2+16)*s,(card_bottom-3)*s)]
        md.polygon(tail,fill=255)
        shadow=Image.new('RGBA',(w,h))
        shifted=Image.new('L',(w,h))
        shifted.paste(mask,(0,3*s))
        shadow.putalpha(shifted.filter(ImageFilter.GaussianBlur(3*s)).point(lambda a:round(a*.14)))
        shadow_rgb=Image.new('RGBA',(w,h),(88,108,165,0))
        shadow_rgb.putalpha(shadow.getchannel('A'))
        image.alpha_composite(shadow_rgb)
        first,last,edge,badge=PALETTES.get(mood,PALETTES['neutral'])
        first,last=rgb(first),rgb(last)
        gradient=Image.new('RGBA',(1,h))
        for y in range(h):
            t=max(0,min(1,(y/s-top)/max(1,card_bottom-top)))
            gradient.putpixel((0,y),tuple(round(a+(b-a)*t) for a,b in zip(first,last))+(250,))
        gradient=gradient.resize((w,h))
        gradient.putalpha(mask.point(lambda a:round(a*.98)))
        image.alpha_composite(gradient)
        draw=ImageDraw.Draw(image)
        draw.rounded_rectangle(box,radius=27*s,outline=rgb(edge)+(255,),width=2)
        draw.line([tail[0],tail[1],tail[2]],fill=rgb(edge)+(255,),width=2,joint='curve')
        draw.polygon([(p[0],p[1]-s) for p in tail],fill=last+(250,))
        # A tiny whale name badge and hand-drawn accents keep the header light.
        badge_box=tuple(round(v*s) for v in (24,top+11,109,top+36))
        draw.rounded_rectangle(badge_box,radius=12*s,fill=rgb(badge)+(255,))
        draw.ellipse(tuple(round(v*s) for v in (32,top+20,49,top+29)),fill=(122,159,219,255))
        draw.polygon([(47*s,(top+23)*s),(53*s,(top+18)*s),(53*s,(top+27)*s)],fill=(122,159,219,255))
        draw.ellipse(tuple(round(v*s) for v in (35,top+22,36.5,top+23.5)),fill=(255,255,255,255))
        draw.arc(tuple(round(v*s) for v in (36,top+13,43,top+22)),190,320,fill=(122,159,219,255),width=2)
        self.text(draw,(57,top+16),'鲸鲸',self.name_font,(86,105,157,255),spacing=1)
        caption=self.short_caption(title,self.width-150)
        draw.text((121*s,(top+18)*s),caption,font=self.caption_font,fill=(132,140,168,255),anchor='lt')
        # A small pink heart outside the text area.
        cx,cy=self.width-24,top+11
        heart=[]
        for i in range(40):
            a=i*math.tau/40
            heart.append(((cx+math.sin(a)**3*4)*s,(cy-(13*math.cos(a)-5*math.cos(2*a)-2*math.cos(3*a)-math.cos(4*a))/4)*s))
        draw.polygon(heart,fill=(232,164,190,255))
        y=top+43
        for line in lines:
            self.text(draw,(29,y),line,font,(73,83,127,255),stroke=0)
            y+=line_height
        return image.resize((self.width,self.height),Image.Resampling.LANCZOS)

    def render(self,title,text,mood='neutral',animate=True):
        key=(title,text,mood)
        if key!=self.key:
            self.image=self.paint(title,text,mood)
            self.key,self.started=key,time.monotonic()
        progress=min(1,(time.monotonic()-self.started)/.18) if animate else 1
        if progress>=1:
            return self.image
        frame=self.image.copy()
        opacity=1-(1-progress)**3
        frame.putalpha(frame.getchannel('A').point([round(a*opacity) for a in range(256)]))
        return frame
