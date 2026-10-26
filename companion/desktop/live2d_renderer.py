"""Native Live2D renderer. No web view and no screen capture are used here."""
from pathlib import Path
import argparse
import json
import math
import sys

sys.path.insert(0,str(Path(__file__).resolve().parent))
from pet_controls import VisualCatalog, VisualControls

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODEL = ROOT/'live2D/runtime-mouse/whale-companion.model3.json'
EMOTION_EXPRESSIONS = {
    'neutral': None, 'happy': '开心兴奋', 'surprised': '感叹号',
    'sad': '悲伤', 'curious': '问号', 'thinking': '呆呆眼', 'sleepy': '闭眼口水',
}

class Live2DRenderer:
    def __init__(self, model_path=DEFAULT_MODEL, width=400, height=440, preferences=None):
        import glfw
        import live2d
        import OpenGL.GL as gl
        self.glfw, self.sdk, self.gl = glfw, live2d, gl
        self.width, self.height = width, height
        self.window = None
        self.model = None
        self.emotion = None
        self.clock = 0.0
        self.catalog = VisualCatalog(model_path)
        self.controls = VisualControls(self.catalog, preferences)
        self.active_expression = None
        self.applied_overlay = set()
        self.action = None
        self.gesture = None
        if not glfw.init():
            raise RuntimeError('无法初始化桌宠图形环境')
        try:
            glfw.window_hint(glfw.VISIBLE, glfw.FALSE)
            glfw.window_hint(glfw.ALPHA_BITS, 8)
            glfw.window_hint(glfw.CONTEXT_VERSION_MAJOR, 2)
            glfw.window_hint(glfw.CONTEXT_VERSION_MINOR, 1)
            self.window = glfw.create_window(width, height, 'Whale Live2D renderer', None, None)
            if not self.window:
                raise RuntimeError('无法创建 Live2D 图形上下文')
            glfw.make_context_current(self.window)
            glfw.swap_interval(0)
            live2d.enableLog(False)
            live2d.init()
            live2d.glInit()
            self.model = live2d.Model()
            self.model.LoadModelJson(str(Path(model_path).resolve()))
            self.model.Resize(width, height)
            self.model.SetScale(.7)
            self.model.SetOffset(0., .1)
            self.model.SetAutoBlink(True)
            self.model.SetAutoBreath(True)
            self.available_expressions = set(self.model.GetExpressions())
            self.defaults = {p:self.model.GetParamDefaultById(p) for p in self.model.GetParamIds()}
            self.model.StartMotion('Idle',0,priority=1)
            gl.glViewport(0, 0, width, height)
        except Exception:
            self.close()
            raise

    def stop_action(self):
        self.model.StopAllMotions()
        self.model.ResetAllParameters()
        self.action = None
        self.gesture = None
        self.model.StartMotion('Idle',0,priority=1)

    def play_motion(self, key):
        definition = self.catalog.motions[key]
        self.stop_action()
        self.model.StartMotion('Actions',definition['index'],priority=3)
        self.action = {**definition,'elapsed':0.}

    def play_gesture(self, name):
        if name not in self.catalog.gestures:
            raise ValueError('Unknown gesture')
        self.stop_action()
        self.gesture = {'name':name,'elapsed':0.,'duration':4.}

    def frame(self, emotion='neutral', gaze=None, talking=False, dt=1/25, expression_override=None):
        import numpy as np
        from PIL import Image
        if emotion not in EMOTION_EXPRESSIONS:
            emotion = 'neutral'
        expression = expression_override or self.controls.manual_face or (None if self.action else EMOTION_EXPRESSIONS[emotion])
        if expression != self.active_expression:
            self.model.ResetExpressions()
            if expression in self.available_expressions:
                self.model.SetExpression(expression)
            self.active_expression = expression
        self.emotion = emotion
        self.clock += dt
        if gaze is None:
            gaze = (self.width/2 + math.sin(self.clock*.5)*12, self.height*.4)
        self.model.Drag(*gaze)
        for pid in self.applied_overlay:
            self.model.SetSaveParamById(pid,self.defaults.get(pid,0.))
            self.model.SetParamById(pid,self.defaults.get(pid,0.))
        if self.action:
            self.action['elapsed'] += dt
            if self.action['elapsed'] >= self.action['duration']+.2:
                self.stop_action()
        if self.gesture:
            self.gesture['elapsed'] += dt
            if self.gesture['elapsed'] >= self.gesture['duration']:
                self.stop_action()
        self.model.Update(dt)
        manual_face = self.controls.manual_face or expression_override
        if emotion == 'sleepy' and not manual_face and not self.action:
            self.model.SetParamById('ParamEyeLOpen', .1)
            self.model.SetParamById('ParamEyeROpen', .1)
        if emotion == 'surprised' and not manual_face and not self.action:
            self.model.SetParamById('ParamMouthOpenY', .5)
        elif talking and not manual_face and not self.action:
            self.model.SetParamById('ParamMouthOpenY', .15 + abs(math.sin(self.clock*12))*.38)
        extra = self.action.get('requires',[]) if self.action else []
        if self.gesture:
            extra = (['蛋包饭'] if self.gesture['name']=='挤' else []) + [self.gesture['name']]
        names = sorted(self.controls.enabled) + list(extra)
        ids = {r['Id'] for r in self.catalog.parameters(names) if r['Id'] in self.defaults}
        base = {pid:self.model.GetParamValueById(pid) for pid in ids}
        values = self.controls.overlay(self.defaults,base,extra,skip=self.action['parameters'] if self.action else ())
        values = {pid:value for pid,value in values.items() if pid in self.defaults}
        for pid,value in values.items():
            self.model.SetParamById(pid,value)
        self.applied_overlay = set(values)
        self.sdk.clearBuffer(0., 0., 0., 0.)
        self.gl.glDisable(self.gl.GL_DEPTH_TEST)
        self.gl.glEnable(self.gl.GL_BLEND)
        self.gl.glBlendFuncSeparate(self.gl.GL_ONE, self.gl.GL_ONE_MINUS_SRC_ALPHA, self.gl.GL_ONE, self.gl.GL_ONE_MINUS_SRC_ALPHA)
        self.model.Draw()
        self.gl.glFinish()
        pixels = self.gl.glReadPixels(0, 0, self.width, self.height, self.gl.GL_RGBA, self.gl.GL_UNSIGNED_BYTE)
        rgba = np.frombuffer(pixels, dtype=np.uint8).reshape(self.height, self.width, 4)[::-1].copy()
        # Cubism renders premultiplied color. Pillow and PNG expect straight RGBA.
        alpha = rgba[:, :, 3:4].astype(np.float32)
        rgba[:, :, :3] = np.minimum(255, rgba[:, :, :3].astype(np.float32)*255/np.maximum(alpha, 1)).astype(np.uint8)
        self.glfw.poll_events()
        return Image.fromarray(rgba)

    def close(self):
        if self.model is not None:
            self.model.DestroyRenderer()
            self.model = None
            self.sdk.dispose()
        if self.window:
            self.glfw.destroy_window(self.window)
            self.window = None
        self.glfw.terminate()

def preview(output, emotion='happy', model=DEFAULT_MODEL):
    renderer = Live2DRenderer(model)
    try:
        for _ in range(40):
            frame = renderer.frame(emotion)
        frame.save(output)
        print(json.dumps({'preview': str(output), 'visibleBounds': frame.getbbox(), 'expressions': len(renderer.available_expressions)}))
    finally:
        renderer.close()

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--preview', required=True)
    parser.add_argument('--expression', default='happy', choices=EMOTION_EXPRESSIONS)
    args = parser.parse_args()
    preview(args.preview, args.expression)
