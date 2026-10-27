"""Local recognition of the user-supplied Moments toolbar; no cloud vision calls.

Only the active WeChat window's upper-right strip is captured. A camera must match
its supplied shape and the neighbouring refresh/bell/window controls. The image
is never saved. A click always reobserves the current window before acting.
"""
import json,pathlib
from types import SimpleNamespace
import numpy as np
from PIL import Image

class CameraCaptureError(RuntimeError):pass

def white_mask(image):
    values=np.asarray(image.convert('RGB'));return np.min(values,axis=2)>=220

def components(mask):
    """Connected components from row runs, avoiding per-pixel desktop scans."""
    parents=[];runs=[];previous=[]
    def find(value):
        while parents[value]!=value:parents[value]=parents[parents[value]];value=parents[value]
        return value
    for y,row in enumerate(mask):
        edges=np.diff(np.r_[False,row,False].astype(np.int8));current=[]
        for left,right in zip(np.flatnonzero(edges==1),np.flatnonzero(edges==-1)):
            overlaps=[find(label) for a,b,label in previous if b>=left and a<=right]
            if overlaps:
                label=min(overlaps)
                for other in overlaps:parents[find(other)]=label
            else:label=len(parents);parents.append(label)
            current.append((int(left),int(right),label));runs.append((int(left),int(right),y,label))
        previous=current
    groups={}
    for left,right,y,label in runs:
        label=find(label)
        if label not in groups:groups[label]=[left,y,right,y+1,right-left]
        else:
            item=groups[label];item[0]=min(item[0],left);item[1]=min(item[1],y);item[2]=max(item[2],right);item[3]=max(item[3],y+1);item[4]+=right-left
    return list(groups.values())

def signature(mask):
    image=Image.fromarray(mask.astype(np.uint8)*255).resize((32,32),Image.Resampling.NEAREST)
    return np.asarray(image)>0

def similarity(left,right):
    union=np.count_nonzero(left|right)
    return float(np.count_nonzero(left&right)/union) if union else 0

def tolerant_similarity(left,right):
    def dilate(mask):
        padded=np.pad(mask,1);out=np.zeros_like(mask)
        for y in range(3):
            for x in range(3):out|=padded[y:y+mask.shape[0],x:x+mask.shape[1]]
        return out
    precision=np.count_nonzero(left&dilate(right))/max(1,np.count_nonzero(left))
    recall=np.count_nonzero(right&dilate(left))/max(1,np.count_nonzero(right))
    return float(2*precision*recall/(precision+recall)) if precision+recall else 0

def load_reference(file=None):
    file=pathlib.Path(file) if file else pathlib.Path(__file__).with_name('assets')/'moments-toolbar.json'
    data=json.loads(file.read_text(encoding='utf-8'))
    for item in data['icons'].values():item['mask']=np.array([[v=='1' for v in row] for row in item['rows']],dtype=bool)
    return data

def header_box(width,height):return (int(width*.55),0,width,min(360,max(120,int(height*.25))))

def detect_camera(image,reference=None):
    reference=reference or load_reference();mask=white_mask(image);items=[]
    for left,top,right,bottom,area in components(mask):
        width=right-left;height=bottom-top
        if width<8 or height<7 or width>110 or height>110 or area<25:continue
        items.append({'box':(left,top,right,bottom),'cx':(left+right)/2,'cy':(top+bottom)/2,'width':width,'height':height,'mask':signature(mask[top:bottom,left:right])})
    camera=reference['icons']['camera'];matches=[]
    for candidate in items:
        score=similarity(candidate['mask'],camera['mask'])
        aspect=(candidate['width']/candidate['height'])/(camera['width']/camera['height'])
        if score<.76 or not .7<=aspect<=1.35:continue
        scale=candidate['width']/camera['width'];neighbours=[]
        for name in ('refresh','bell','window'):
            template=reference['icons'][name];expected_x=candidate['cx']+template['dx']*scale;expected_y=candidate['cy']+template['dy']*scale
            half_w=template['width']*scale/2;half_h=template['height']*scale/2;padding=max(2,scale*3)
            left=max(0,int(expected_x-half_w-padding));right=min(mask.shape[1],int(expected_x+half_w+padding+1))
            top=max(0,int(expected_y-half_h-padding));bottom=min(mask.shape[0],int(expected_y+half_h+padding+1))
            patch=mask[top:bottom,left:right];ys,xs=np.nonzero(patch)
            if not len(xs):neighbours.append(0);continue
            neighbour=signature(patch[ys.min():ys.max()+1,xs.min():xs.max()+1])
            neighbours.append(tolerant_similarity(neighbour,template['mask']))
        if min(neighbours,default=0)>=.76:matches.append({'box':candidate['box'],'score':round(score,4),'contextScore':round(min(neighbours),4)})
    return matches[0] if len(matches)==1 else None

def capture_header(hwnd,expected_pid):
    # Lazy imports keep tests and offline screenshot recognition independent of Windows.
    import win32gui,win32ui,win32con,win32process
    if not hwnd or not win32gui.IsWindow(hwnd):raise CameraCaptureError('camera_window_missing')
    hwnd=win32gui.GetAncestor(hwnd,2)
    if win32process.GetWindowThreadProcessId(hwnd)[1]!=expected_pid:raise CameraCaptureError('camera_window_changed')
    foreground=win32gui.GetForegroundWindow()
    if not foreground or win32gui.GetAncestor(foreground,2)!=hwnd:raise CameraCaptureError('camera_window_not_foreground')
    if not win32gui.IsWindowVisible(hwnd) or win32gui.IsIconic(hwnd):raise CameraCaptureError('camera_window_hidden')
    left,top,right,bottom=win32gui.GetWindowRect(hwnd);x1,y1,x2,y2=header_box(right-left,bottom-top)
    width,height=x2-x1,y2-y1
    if width<200 or height<90:raise CameraCaptureError('camera_window_too_small')
    dc=win32gui.GetDC(0);source=target=bitmap=None
    try:
        source=win32ui.CreateDCFromHandle(dc);target=source.CreateCompatibleDC();bitmap=win32ui.CreateBitmap();bitmap.CreateCompatibleBitmap(source,width,height);target.SelectObject(bitmap)
        target.BitBlt((0,0),(width,height),source,(left+x1,top+y1),win32con.SRCCOPY)
        image=Image.frombuffer('RGB',(width,height),bitmap.GetBitmapBits(True),'raw','BGRX',0,1).copy()
        return image,(left+x1,top+y1),hwnd
    except Exception as error:raise CameraCaptureError('camera_capture_failed') from error
    finally:
        if target is not None:target.DeleteDC()
        if source is not None:source.DeleteDC()
        if bitmap is not None:win32gui.DeleteObject(bitmap.GetHandle())
        win32gui.ReleaseDC(0,dc)

def native_click(hwnd,expected_pid,point):
    import win32gui,win32process,win32api,win32con
    foreground=win32gui.GetForegroundWindow();target=win32gui.WindowFromPoint(point)
    if not foreground or win32gui.GetAncestor(foreground,2)!=hwnd or not target or win32gui.GetAncestor(target,2)!=hwnd:raise CameraCaptureError('camera_target_occluded')
    if win32process.GetWindowThreadProcessId(target)[1]!=expected_pid:raise CameraCaptureError('camera_window_changed')
    win32api.SetCursorPos(point);win32api.mouse_event(win32con.MOUSEEVENTF_LEFTDOWN,0,0,0,0);win32api.mouse_event(win32con.MOUSEEVENTF_LEFTUP,0,0,0,0)

class VisualCamera:
    def __init__(self,hwnd,pid,available,reference,capture=capture_header,click=native_click,report=None):
        self.hwnd=hwnd;self.pid=pid;self.available=available;self.reference=reference;self.capture=capture;self.click=click;self.report=report or (lambda *args:None)
        self.Name='相机（本地图标识别）';self.ControlTypeName='ButtonControl';self.IsOffscreen=False;self.IsEnabled=True
    def observe(self):
        self.available();image,origin,hwnd=self.capture(self.hwnd,self.pid);match=detect_camera(image,self.reference)
        if match is None:return None
        x1,y1,x2,y2=match['box'];self.BoundingRectangle=SimpleNamespace(left=origin[0]+x1,top=origin[1]+y1,right=origin[0]+x2,bottom=origin[1]+y2)
        self.hwnd=hwnd;self.match=match;return self
    def Click(self):
        # Never use the earlier observation's coordinates after state or focus changes.
        if self.observe() is None:raise CameraCaptureError('camera_icon_changed')
        self.available();r=self.BoundingRectangle;point=(int((r.left+r.right)/2),int((r.top+r.bottom)/2))
        self.click(self.hwnd,self.pid,point);self.report('朋友圈流程：已通过本地图标及相邻工具栏核对并点击相机')

def locate_camera(main,available,report=None):
    hwnd=getattr(main,'NativeWindowHandle',0);parent=main;pid=main.ProcessId
    for _ in range(6):
        if hwnd:break
        try:parent=parent.GetParentControl();hwnd=getattr(parent,'NativeWindowHandle',0)
        except Exception:break
    return VisualCamera(hwnd,pid,available,load_reference(),report=report).observe()
