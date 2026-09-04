/* 语言解析面板：把当前台词交给 Claude，讲清词义、语法、语境和地道用法。
 *
 * 两种用法，都不需要后端：
 *   1. 填了自己的 Anthropic API Key → 浏览器直连 API，结果就地渲染
 *   2. 没填 Key → 「复制提问」把台词和上下文整理成一段话，粘到任意 AI 里
 *
 * Key 只写进这台电脑的 localStorage，只发往 api.anthropic.com，不进代码仓库。
 */
(function () {
  'use strict';

  const KEY_API = 'sd-anthropic-key';
  const KEY_MODEL = 'sd-explain-model';
  const KEY_CACHE = 'sd-explain-cache-v1';
  const CACHE_MAX = 200; // 解析结果按句缓存，超量按最早使用时间淘汰

  const BRIDGE_URL = 'http://127.0.0.1:8790';  // 本地桥接，走 Claude 订阅
  const API_URL = 'https://api.anthropic.com/v1/messages';
  const API_VERSION = '2023-06-01';

  const MODELS = [
    { id: 'claude-opus-5', label: 'Claude Opus 5（默认，讲得最透）' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5（更快更省）' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5（最省）' },
  ];
  // effort 只有 Opus / Sonnet 家族支持，Haiku 4.5 传了会 400
  const SUPPORTS_EFFORT = new Set(['claude-opus-5', 'claude-sonnet-5']);
  // 桥接走 claude CLI，模型用短别名
  const CLI_ALIAS = { 'claude-opus-5': 'opus', 'claude-sonnet-5': 'sonnet', 'claude-haiku-4-5': 'haiku' };

  const $ = (id) => document.getElementById(id);
  const el = {
    btn: $('explainBtn'), copyBtn: $('explainCopyBtn'), status: $('explainStatus'),
    body: $('explainBody'), settings: $('explainSettings'),
    key: $('explainKey'), model: $('explainModel'),
    saveBtn: $('explainSaveBtn'), clearBtn: $('explainClearCacheBtn'),
    source: $('explainSource'),
  };

  let bridgeUp = false; // 本地桥接是否在线（在线就优先用它，不花 API 的钱）
  let ctx = null;       // 当前句的上下文，由 app.js 通过 setLine 传入
  let running = false;  // 正在请求中，避免重复点击重复计费
  let abort = null;

  // ---------- 存储 ----------
  const getKey = () => localStorage.getItem(KEY_API) || '';
  const getModel = () => localStorage.getItem(KEY_MODEL) || MODELS[0].id;

  function loadCache() {
    try { return JSON.parse(localStorage.getItem(KEY_CACHE)) || {}; } catch (e) { return {}; }
  }
  function saveCache(cache) {
    // 超量时按写入时间淘汰最旧的，避免把 localStorage 撑爆
    const ids = Object.keys(cache);
    if (ids.length > CACHE_MAX) {
      ids.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0))
        .slice(0, ids.length - CACHE_MAX)
        .forEach((id) => { delete cache[id]; });
    }
    try { localStorage.setItem(KEY_CACHE, JSON.stringify(cache)); } catch (e) { /* 配额满就放弃缓存 */ }
  }

  // ---------- 渲染 ----------
  function setStatus(text, kind) {
    el.status.textContent = text || '';
    el.status.className = 'explain-status' + (kind ? ' ' + kind : '');
  }

  // 极简 Markdown：只认 ## 标题、- 列表、**加粗**，够用且不引依赖
  function render(md) {
    el.body.innerHTML = '';
    let list = null;
    md.split('\n').forEach((raw) => {
      const line = raw.trimEnd();
      if (!line.trim()) { list = null; return; }
      if (line.startsWith('## ')) {
        list = null;
        const h = document.createElement('h3');
        h.className = 'explain-heading';
        h.textContent = line.slice(3).trim();
        el.body.appendChild(h);
        return;
      }
      if (/^[-*]\s+/.test(line)) {
        if (!list) { list = document.createElement('ul'); list.className = 'explain-list'; el.body.appendChild(list); }
        const li = document.createElement('li');
        inline(li, line.replace(/^[-*]\s+/, ''));
        list.appendChild(li);
        return;
      }
      list = null;
      const p = document.createElement('p');
      p.className = 'explain-para';
      inline(p, line);
      el.body.appendChild(p);
    });
  }

  // 把 **加粗** 渲染成 <strong>，其余按纯文本插入（不解析 HTML，避免注入）
  function inline(parent, text) {
    text.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
      if (!part) return;
      if (part.startsWith('**') && part.endsWith('**')) {
        const b = document.createElement('strong');
        b.textContent = part.slice(2, -2);
        parent.appendChild(b);
      } else {
        parent.appendChild(document.createTextNode(part));
      }
    });
  }

  // ---------- 提问内容 ----------
  function buildPrompt(c) {
    const before = c.prevLines && c.prevLines.length ? c.prevLines.join('\n') : '（本句是开头）';
    const after = c.nextLine || '（本句是结尾）';
    return [
      '我在用美剧做英语听写练习，请帮我把下面这一句讲透。',
      '',
      '剧集片段：' + (c.lessonTitle || '未标注'),
      '前面几句：',
      before,
      '',
      '要讲的这一句：',
      c.en,
      '',
      '后面一句：' + after,
      '',
      '请用中文回答，严格按下面的小标题输出，不要写额外的开场白和总结：',
      '',
      '## 翻译',
      '一句自然的中文，不要直译腔。',
      '',
      '## 词汇与短语',
      '挑这句里真正值得记的 2-4 个（生词、搭配、俚语、缩写），每条一行，格式：',
      '- **原词** — 中文意思（在这句里的具体用法或语气）',
      '如果整句都是简单词，就说明它为什么简单却地道，不要硬凑生词。',
      '',
      '## 语法',
      '只讲这句里真实出现的结构（时态、从句、省略、倒装、虚拟语气等），1-3 条，格式：',
      '- **结构名** — 它在这句里怎么用、为什么这么用',
      '',
      '## 语境',
      '结合前后文，说这句话在剧情里的作用、说话人的语气和潜台词。2-3 句。',
      '',
      '## 地道用法',
      '这句话或其中的说法在日常生活里怎么用，给一个我能直接照搬的例句（英文+中文）。',
    ].join('\n');
  }

  // ---------- 走本地桥接（Claude 订阅） ----------
  // 浏览器读不到钥匙串里的 OAuth 登录态，但本地进程可以；
  // 桥接脚本替网页调 `claude -p`，用的就是订阅额度。
  async function probeBridge() {
    try {
      const res = await fetch(BRIDGE_URL + '/health', { signal: AbortSignal.timeout(1200) });
      bridgeUp = res.ok;
    } catch (e) {
      bridgeUp = false;
    }
    renderSource();
    return bridgeUp;
  }

  async function callBridge(c) {
    abort = new AbortController();
    const res = await fetch(BRIDGE_URL + '/explain', {
      method: 'POST',
      signal: abort.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: buildPrompt(c), model: CLI_ALIAS[getModel()] || '' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('桥接返回 ' + res.status));
    return data.text || '';
  }

  // ---------- 调用 API ----------
  async function callClaude(c, onDelta) {
    const model = getModel();
    const body = {
      model,
      max_tokens: 4000,
      stream: true,
      system: '你是一位教中文母语者学英语的老师，讲解准确、克制、不说空话。学习者能看懂剧情大意，卡在细节的词义、语法和言外之意上。',
      messages: [{ role: 'user', content: buildPrompt(c) }],
    };
    // 这是一次简短的讲解，用低 effort 换更短的等待；Haiku 不支持这个参数
    if (SUPPORTS_EFFORT.has(model)) body.output_config = { effort: 'low' };

    abort = new AbortController();
    const res = await fetch(API_URL, {
      method: 'POST',
      signal: abort.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': getKey(),
        'anthropic-version': API_VERSION,
        // 浏览器直连需要显式声明，否则 API 不返回 CORS 头
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error.message; } catch (e) { detail = res.statusText; }
      throw new Error(friendlyError(res.status, detail));
    }

    // 解析 SSE：只关心文本增量，thinking 增量忽略
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const chunks = buf.split('\n\n');
      buf = chunks.pop();
      for (const chunk of chunks) {
        const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        let evt;
        try { evt = JSON.parse(dataLine.slice(5).trim()); } catch (e) { continue; }
        if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
          text += evt.delta.text;
          onDelta(text);
        } else if (evt.type === 'error') {
          throw new Error(friendlyError(0, evt.error && evt.error.message));
        }
      }
    }
    return text;
  }

  function friendlyError(status, detail) {
    if (status === 401) return 'API Key 不对或已失效，在「解析设置」里重新填一次。';
    if (status === 429) return '请求太频繁或额度用完了，等一会儿再试。';
    if (status === 400) return '请求被拒绝：' + (detail || '参数有误');
    if (status >= 500) return 'Anthropic 服务端暂时出错，稍后再试。';
    return detail || '请求失败';
  }

  // ---------- 主流程 ----------
  async function explain(force) {
    if (!ctx || running) return;
    const cache = loadCache();
    if (!force && cache[ctx.lineId]) {
      render(cache[ctx.lineId].md);
      setStatus('这句之前解析过，直接读的本地缓存。', 'ok');
      return;
    }
    // 桥接优先：走订阅不额外花钱；没桥接才退回 API key
    if (!bridgeUp) await probeBridge();
    if (!bridgeUp && !getKey()) {
      setStatus('本地桥接没启动，也没填 API Key。可先点「复制提问」，或看下方设置里的两种办法。', 'err');
      el.settings.open = true;
      return;
    }
    running = true;
    el.btn.disabled = true;
    el.btn.textContent = '解析中…';
    el.body.innerHTML = '';
    const started = Date.now();
    const tick = setInterval(() => {
      if (running) setStatus('解析中… 已等待 ' + Math.round((Date.now() - started) / 1000) + ' 秒', '');
    }, 1000);
    setStatus('解析中…', '');
    try {
      const md = bridgeUp ? await callBridge(ctx) : await callClaude(ctx, render);
      if (bridgeUp) render(md);
      const c2 = loadCache();
      c2[ctx.lineId] = { md, at: Date.now() };
      saveCache(c2);
      setStatus('解析完成（' + (bridgeUp ? '走订阅' : 'API') + '）。同一句再看不会重复请求。', 'ok');
    } catch (err) {
      if (err.name === 'AbortError') { setStatus('已取消。', ''); }
      else { setStatus(err.message, 'err'); }
    } finally {
      clearInterval(tick);
      running = false;
      el.btn.disabled = false;
      el.btn.textContent = '解析这一句';
      abort = null;
    }
  }

  // ---------- 对外接口：app.js 每次换句都调一次 ----------
  function setLine(next) {
    ctx = next;
    if (abort) abort.abort();
    el.body.innerHTML = '';
    const has = ctx && loadCache()[ctx.lineId];
    if (has) {
      render(has.md);
      setStatus('这句之前解析过。', 'ok');
    } else {
      setStatus(ctx && ctx.solved ? '' : '注意：解析会显示这句的英文原文。', ctx && ctx.solved ? '' : 'warn');
    }
    el.btn.disabled = !ctx;
    el.copyBtn.disabled = !ctx;
  }

  // 让人一眼看到解析走的是哪条路、要不要花钱
  function renderSource() {
    if (!el.source) return;
    if (bridgeUp) {
      el.source.textContent = '当前走本地桥接（Claude 订阅，不额外计费）';
      el.source.className = 'explain-source ok';
    } else if (getKey()) {
      el.source.textContent = '当前走 API Key（按 token 计费）';
      el.source.className = 'explain-source';
    } else {
      el.source.textContent = '未连接：可启动本地桥接走订阅，或填 API Key';
      el.source.className = 'explain-source warn';
    }
  }

  // ---------- 事件 ----------
  el.btn.addEventListener('click', () => explain(false));

  el.copyBtn.addEventListener('click', async () => {
    if (!ctx) return;
    try {
      await navigator.clipboard.writeText(buildPrompt(ctx));
      setStatus('问题已复制，粘到任意 AI 里就能问。', 'ok');
    } catch (e) {
      setStatus('复制失败，可能是浏览器没给剪贴板权限。', 'err');
    }
  });

  el.saveBtn.addEventListener('click', () => {
    const k = el.key.value.trim();
    if (k) localStorage.setItem(KEY_API, k); else localStorage.removeItem(KEY_API);
    localStorage.setItem(KEY_MODEL, el.model.value);
    renderSource();
    setStatus(k ? '已保存，可以点「解析这一句」了。' : '已清空 Key。', 'ok');
    el.settings.open = false;
  });

  el.clearBtn.addEventListener('click', () => {
    localStorage.removeItem(KEY_CACHE);
    el.body.innerHTML = '';
    setStatus('本地解析缓存已清空。', 'ok');
  });

  // ---------- 启动 ----------
  MODELS.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    el.model.appendChild(opt);
  });
  el.model.value = getModel();
  el.key.value = getKey();
  el.btn.disabled = true;
  el.copyBtn.disabled = true;
  renderSource();
  probeBridge();

  window.SceneExplain = { setLine };
})();
