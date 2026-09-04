#!/usr/bin/env python3
"""解析桥接：让网页用你的 Claude 订阅做语言解析，不需要 API key。

浏览器读不到 macOS 钥匙串，但本地进程可以。这个脚本就是那个中间人：
网页 POST 一段提问过来 → 它调用本机的 `claude -p` → 把结果回给网页。
`claude` 用的是钥匙串里的 OAuth 登录态，也就是你订阅里已经付过的额度。

用法：
    python3 tools/explain-bridge.py          # 默认监听 127.0.0.1:8790
    python3 tools/explain-bridge.py --port 9000

前置条件：终端里 `claude -p "hi"` 能正常返回（不行就先跑 `claude` 重新登录）。

安全边界：
  - 只绑 127.0.0.1，外网访问不到
  - 只接受来自听写网页的 Origin，防止你打开的其他网站偷用你的订阅额度
  - 只跑 `claude -p`，不执行网页传来的任何其他命令
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 只信任本机的听写页面；其他站点即使知道端口也调不动
ALLOWED_ORIGINS = {
    'http://localhost:8788', 'http://127.0.0.1:8788',
    'http://localhost:8080', 'http://127.0.0.1:8080',
}
ALLOWED_MODELS = {'opus', 'sonnet', 'haiku'}
MAX_PROMPT = 8000       # 一句台词的提问远小于此，超了说明来源可疑
TIMEOUT_SEC = 180


def run_claude(prompt, model):
    cmd = ['claude', '-p', prompt, '--output-format', 'text']
    if model in ALLOWED_MODELS:
        cmd += ['--model', model]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT_SEC)
    out = (proc.stdout or '').strip()
    err = (proc.stderr or '').strip()
    # claude 登录失效时会把提示打到 stdout 且退出码为 0，所以要按内容判断
    if not out or re.search(r'Failed to authenticate|OAuth session expired', out + err, re.I):
        raise RuntimeError('claude 未登录或登录已过期：在终端跑一次 `claude` 重新登录后再试。')
    return out


class Handler(BaseHTTPRequestHandler):
    def _origin_ok(self):
        origin = self.headers.get('Origin')
        return origin if origin in ALLOWED_ORIGINS else None

    def _send(self, code, payload, origin=None):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        origin = self._origin_ok()
        self.send_response(204 if origin else 403)
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'content-type')
            self.send_header('Access-Control-Max-Age', '600')
            self.send_header('Vary', 'Origin')
        self.end_headers()

    def do_GET(self):
        if self.path != '/health':
            self._send(404, {'error': 'not found'}, self._origin_ok())
            return
        self._send(200, {'ok': True, 'claude': bool(shutil.which('claude'))}, self._origin_ok())

    def do_POST(self):
        origin = self._origin_ok()
        if not origin:
            self._send(403, {'error': '来源不被允许'})
            return
        if self.path != '/explain':
            self._send(404, {'error': 'not found'}, origin)
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
            data = json.loads(self.rfile.read(length) or b'{}')
            prompt = (data.get('prompt') or '').strip()
            model = data.get('model') or ''
            if not prompt:
                raise ValueError('提问内容为空')
            if len(prompt) > MAX_PROMPT:
                raise ValueError('提问内容过长')
            text = run_claude(prompt, model)
            self._send(200, {'text': text}, origin)
        except subprocess.TimeoutExpired:
            self._send(504, {'error': 'claude 超时（%d 秒）没有返回。' % TIMEOUT_SEC}, origin)
        except Exception as exc:  # 把原因原样回给页面，方便你看到问题出在哪
            self._send(500, {'error': str(exc)}, origin)

    def log_message(self, fmt, *args):
        sys.stderr.write('[bridge] %s\n' % (fmt % args))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8790)
    args = ap.parse_args()

    if not shutil.which('claude'):
        sys.exit('找不到 claude 命令，请先安装 Claude Code。')
    print('解析桥接已启动：http://127.0.0.1:%d' % args.port)
    print('网页里的「解析这一句」现在会走你的 Claude 订阅，不消耗 API 额度。')
    print('停止：Ctrl+C')
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
