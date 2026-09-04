#!/usr/bin/env python3
"""解析桥接：让网页借用本机已装的 AI 命令行工具做语言解析，不需要单独买 API 额度。

浏览器读不到这些工具的登录态（钥匙串 / 配置文件），但本地进程可以。
这个脚本就是那个中间人：网页 POST 一段提问过来 → 它调用本机的 CLI → 结果回给网页。
用的是你在那个工具里已经付过的额度。

用法：
    python3 tools/explain-bridge.py                # 自动挑一个可用的
    python3 tools/explain-bridge.py --engine codex # 指定引擎
    python3 tools/explain-bridge.py --list         # 看本机装了哪些、能不能用

安全边界：
  - 只绑 127.0.0.1，外网访问不到
  - 只接受听写页面的 Origin，防止你打开的其他网站偷用你的额度
  - 只按下面 ENGINES 里写死的命令模板执行，不跑网页传来的任意命令
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ALLOWED_ORIGINS = {
    'http://localhost:8788', 'http://127.0.0.1:8788',
    'http://localhost:8080', 'http://127.0.0.1:8080',
}
MAX_PROMPT = 8000
TIMEOUT_SEC = 180

# 每个引擎：命令模板 + 模型别名。argv 写死在这里，网页只能选引擎和模型，改不了命令。
ENGINES = {
    'claude': {
        'bin': 'claude',
        'args': lambda prompt, model: (
            ['claude', '-p', prompt, '--output-format', 'text']
            + (['--model', model] if model else [])
        ),
        'models': {'opus': 'opus', 'sonnet': 'sonnet', 'haiku': 'haiku'},
        'label': 'Claude Code（订阅额度）',
    },
    'codex': {
        'bin': 'codex',
        # codex exec 是它的无头模式；--skip-git-repo-check 避免在非仓库目录下拒绝执行
        'args': lambda prompt, model: (
            ['codex', 'exec', '--skip-git-repo-check']
            + (['--model', model] if model else [])
            + [prompt]
        ),
        'models': {'gpt-5.1-codex': 'gpt-5.1-codex', 'gpt-5.1': 'gpt-5.1'},
        'label': 'Codex（ChatGPT 额度）',
    },
    'gemini': {
        'bin': 'gemini',
        'args': lambda prompt, model: (
            ['gemini', '-p', prompt] + (['-m', model] if model else [])
        ),
        'models': {'gemini-3-pro': 'gemini-3-pro', 'gemini-3-flash': 'gemini-3-flash'},
        'label': 'Gemini CLI',
    },
}

# 各家 CLI 常见的"没登录/没配额度"提示；它们往往退出码为 0，只能按内容判断
AUTH_HINT = re.compile(
    r'Failed to authenticate|OAuth session expired|not logged in|please (run )?login'
    r'|must specify the .*API_KEY|unauthorized|invalid api key|quota|rate limit',
    re.I,
)


def available_engines():
    return {k: v for k, v in ENGINES.items() if shutil.which(v['bin'])}


def run_engine(engine, prompt, model):
    spec = ENGINES.get(engine)
    if not spec:
        raise ValueError('未知引擎：%s' % engine)
    if not shutil.which(spec['bin']):
        raise RuntimeError('本机没装 %s。' % spec['bin'])
    real_model = spec['models'].get(model, '') if model else ''
    proc = subprocess.run(spec['args'](prompt, real_model),
                          capture_output=True, text=True, timeout=TIMEOUT_SEC)
    out = (proc.stdout or '').strip()
    err = (proc.stderr or '').strip()
    if not out or AUTH_HINT.search(out + '\n' + err):
        detail = (out or err).splitlines()[0] if (out or err) else '没有任何输出'
        raise RuntimeError('%s 无法使用：%s' % (spec['bin'], detail[:200]))
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
        avail = available_engines()
        self._send(200, {
            'ok': True,
            'default': DEFAULT_ENGINE,
            'engines': [{'id': k, 'label': v['label'], 'models': list(v['models'])}
                        for k, v in avail.items()],
        }, self._origin_ok())

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
            engine = data.get('engine') or DEFAULT_ENGINE
            if not prompt:
                raise ValueError('提问内容为空')
            if len(prompt) > MAX_PROMPT:
                raise ValueError('提问内容过长')
            text = run_engine(engine, prompt, data.get('model') or '')
            self._send(200, {'text': text, 'engine': engine}, origin)
        except subprocess.TimeoutExpired:
            self._send(504, {'error': '%d 秒没返回，可能是模型太慢或卡住了。' % TIMEOUT_SEC}, origin)
        except Exception as exc:
            self._send(500, {'error': str(exc)}, origin)

    def log_message(self, fmt, *args):
        sys.stderr.write('[bridge] %s\n' % (fmt % args))


def probe(engine):
    """跑一句极短的提问，确认这个引擎当下真能用（装了不等于能用）。"""
    try:
        run_engine(engine, '只回答两个字：可用', '')
        return True, '可用'
    except Exception as exc:
        return False, str(exc)


def main():
    global DEFAULT_ENGINE
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8790)
    ap.add_argument('--engine', choices=list(ENGINES), help='指定引擎，默认自动挑一个可用的')
    ap.add_argument('--list', action='store_true', help='列出本机装了哪些、能不能用')
    args = ap.parse_args()

    avail = available_engines()

    if args.list:
        print('本机的 AI 命令行工具：\n')
        for key, spec in ENGINES.items():
            if key not in avail:
                print('  ✗ %-8s 未安装' % key)
                continue
            ok, msg = probe(key)
            print('  %s %-8s %s — %s' % ('✓' if ok else '!', key, spec['label'], msg))
        return

    if not avail:
        sys.exit('本机没有装任何支持的 AI 命令行工具（claude / codex / gemini）。')

    DEFAULT_ENGINE = args.engine or next(iter(avail))
    if DEFAULT_ENGINE not in avail:
        sys.exit('本机没装 %s。已装的有：%s' % (DEFAULT_ENGINE, '、'.join(avail)))

    print('解析桥接已启动：http://127.0.0.1:%d' % args.port)
    print('可用引擎：%s（默认 %s）' % ('、'.join(avail), DEFAULT_ENGINE))
    print('网页里的「解析这一句」会走这些工具的额度，不消耗 Anthropic API 额度。')
    print('停止：Ctrl+C')
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


DEFAULT_ENGINE = 'claude'

if __name__ == '__main__':
    main()
