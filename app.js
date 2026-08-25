/* 剧情听写：页面逻辑。内容数据在 content.js / content.local.js。 */
(function () {
  'use strict';

  // ---------- 常量与存储键 ----------
  const KEY_SOUND = 'sd-sound-on';
  const KEY_STATS = 'sd-stats-v1';
  const KEY_PROGRESS = 'sd-progress-v1';
  const KEY_LOCAL_FILE_NAME = 'sd-local-file-name';
  const KEY_SRT_PREFIX = 'sd-srt-'; // 每课一份导入的字幕，存本机浏览器
  const KEY_SUB_MASK = 'sd-sub-mask'; // 遮挡视频内嵌硬字幕的黑条开关
  const STATS_KEEP_DAYS = 90;
  // 有效学习时长口径：页面可见 + 最近 90 秒内有操作时，每 15 秒累计一次
  const ACTIVE_WINDOW_MS = 90 * 1000;
  const ACTIVE_TICK_MS = 15 * 1000;

  const LESSONS = (window.BUILTIN_LESSONS || []).concat(window.PERSONAL_LESSONS || []);

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    soundToggle: $('soundToggle'), lessonSelect: $('lessonSelect'),
    sceneTitle: $('sceneTitle'), sceneSeries: $('sceneSeries'), sceneSynopsis: $('sceneSynopsis'),
    sceneCharacters: $('sceneCharacters'), sceneTone: $('sceneTone'), sceneHint: $('sceneHint'),
    statSentences: $('statSentences'), statWords: $('statWords'), statChecks: $('statChecks'),
    statPlays: $('statPlays'), statRecordings: $('statRecordings'), statMinutes: $('statMinutes'),
    statStreak: $('statStreak'), weekChart: $('weekChart'),
    video: $('sceneVideo'), image: $('sceneImage'),
    localOverlay: $('localOverlay'), localOverlayDesc: $('localOverlayDesc'), localFileInput: $('localFileInput'),
    mediaBar: $('mediaBar'), mediaBarStatus: $('mediaBarStatus'), srtFileInput: $('srtFileInput'),
    subMask: $('subMask'), maskToggle: $('maskToggle'),
    lineSpeaker: $('lineSpeaker'), lineProgress: $('lineProgress'), lineZh: $('lineZh'),
    letterTrack: $('letterTrack'), answerInput: $('answerInput'), feedback: $('feedback'),
    trackShell: $('trackShell'), trackPlaceholder: $('trackPlaceholder'),
    answerReveal: $('answerReveal'), answerText: $('answerText'),
    checkBtn: $('checkBtn'), hintBtn: $('hintBtn'), playBtn: $('playBtn'), recordBtn: $('recordBtn'),
    hintText: $('hintText'), recordArea: $('recordArea'), recordPlayback: $('recordPlayback'),
    listenBtn: $('listenBtn'),
    prevBtn: $('prevBtn'), nextBtn: $('nextBtn'), lineDots: $('lineDots'),
  };

  // ---------- 状态 ----------
  let lessonIndex = 0;
  let lineIndex = 0;
  let soundOn = localStorage.getItem(KEY_SOUND) !== '0';
  let stats = loadJSON(KEY_STATS, { days: {} });
  let progress = loadJSON(KEY_PROGRESS, {}); // { lineId: true }
  let audioCtx = null;
  let localFileUrl = null;
  let segmentWatcher = null;
  let mediaRecorder = null;
  let recordChunks = [];
  let recordUrl = null;
  let lastActivity = Date.now();
  // 输入判定的上一次快照，用来区分「新增错误」「新完成的单词」，删除字符时不触发任何声音
  let prevWrongCount = 0;
  let prevRedCount = 0;
  let prevCompleted = new Set();
  let prevInputLen = 0;

  // ---------- 工具 ----------
  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

  // 本地日期 yyyy-mm-dd（用电脑本地时区分天）
  function dateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }
  const todayKey = () => dateKey(new Date());

  // 判定口径：只比较字母和数字，忽略大小写、标点与多余空格
  const lettersOf = (s) => (s.match(/[a-z0-9]/gi) || []).join('').toLowerCase();
  function normalize(s) {
    return s.toLowerCase().split(/\s+/).map(lettersOf).filter(Boolean).join(' ');
  }

  function currentLesson() { return LESSONS[lessonIndex]; }

  // 本地课程若导入过字幕，用字幕生成的句子；否则用 content.js 里写的句子
  function importedSrt(lesson) {
    if (lesson.mediaMode !== 'local') return null;
    const imp = loadJSON(KEY_SRT_PREFIX + lesson.id, null);
    return (imp && Array.isArray(imp.lines) && imp.lines.length) ? imp : null;
  }
  function currentLines() {
    const lesson = currentLesson();
    const imp = importedSrt(lesson);
    return imp ? imp.lines : lesson.lines;
  }
  function currentLine() { return currentLines()[lineIndex]; }

  // ---------- 每日统计 ----------
  function dayStats(key) {
    if (!stats.days[key]) {
      stats.days[key] = { sentences: [], words: 0, checks: 0, plays: 0, recordings: 0, activeSeconds: 0 };
    }
    return stats.days[key];
  }

  function pruneStats() {
    const keys = Object.keys(stats.days).sort();
    while (keys.length > STATS_KEEP_DAYS) {
      delete stats.days[keys.shift()];
    }
  }

  function bump(field, amount) {
    const day = dayStats(todayKey());
    day[field] += (amount == null ? 1 : amount);
    pruneStats();
    saveJSON(KEY_STATS, stats);
    renderStats();
  }

  function markSentenceDone(lineId) {
    const day = dayStats(todayKey());
    // 同一句每天最多计入一次
    if (!day.sentences.includes(lineId)) day.sentences.push(lineId);
    pruneStats();
    saveJSON(KEY_STATS, stats);
    renderStats();
  }

  // 一天的「有效操作数」：用于 7 天柱状图和连续天数判定
  function dayActions(day) {
    if (!day) return 0;
    return day.sentences.length + day.words + day.checks + day.plays + day.recordings;
  }
  function dayIsActive(day) {
    return !!day && (dayActions(day) > 0 || day.activeSeconds > 0);
  }

  function streakDays() {
    // 从今天往回数连续有学习记录的天数；今天还没学则从昨天起算
    let count = 0;
    const cursor = new Date();
    if (!dayIsActive(stats.days[dateKey(cursor)])) {
      cursor.setDate(cursor.getDate() - 1);
    }
    while (dayIsActive(stats.days[dateKey(cursor)])) {
      count += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return count;
  }

  function renderStats() {
    const day = stats.days[todayKey()] || { sentences: [], words: 0, checks: 0, plays: 0, recordings: 0, activeSeconds: 0 };
    el.statSentences.textContent = day.sentences.length;
    el.statWords.textContent = day.words;
    el.statChecks.textContent = day.checks;
    el.statPlays.textContent = day.plays;
    el.statRecordings.textContent = day.recordings;
    el.statMinutes.textContent = Math.round(day.activeSeconds / 60) + ' 分钟';
    el.statStreak.textContent = streakDays();

    // 最近 7 天柱状图
    el.weekChart.innerHTML = '';
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push({ key: dateKey(d), label: String(d.getMonth() + 1) + '/' + d.getDate(), isToday: i === 0 });
    }
    const max = Math.max(1, ...days.map((d) => dayActions(stats.days[d.key])));
    days.forEach((d) => {
      const actions = dayActions(stats.days[d.key]);
      const bar = document.createElement('div');
      bar.className = 'week-bar' + (d.isToday ? ' is-today' : '');
      bar.title = d.label + '：' + actions + ' 次有效操作';
      const fill = document.createElement('div');
      fill.className = 'week-bar-fill';
      fill.style.height = Math.round((actions / max) * 100) + '%';
      const label = document.createElement('div');
      label.className = 'week-bar-day';
      label.textContent = d.label;
      bar.appendChild(fill);
      bar.appendChild(label);
      el.weekChart.appendChild(bar);
    });
  }

  // 有效学习时长计时器
  ['keydown', 'pointerdown', 'pointermove'].forEach((evt) => {
    document.addEventListener(evt, () => { lastActivity = Date.now(); }, { passive: true });
  });
  setInterval(() => {
    if (document.visibilityState === 'visible' && Date.now() - lastActivity < ACTIVE_WINDOW_MS) {
      bump('activeSeconds', ACTIVE_TICK_MS / 1000);
    }
  }, ACTIVE_TICK_MS);

  // ---------- 声音反馈 ----------
  function ensureAudioCtx() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function beep(freq, duration, type, volume) {
    if (!soundOn) return;
    const ctx = ensureAudioCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  }

  const tick = () => beep(1200, 0.05, 'square', 0.04);   // 正确字母：轻快短促
  const buzz = () => beep(180, 0.16, 'sawtooth', 0.06);  // 错误字母：较低提示音

  function speak(text) {
    if (!soundOn || !('speechSynthesis' in window)) return;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'en-US';
    utter.rate = 0.95;
    // 优先本机语音（localService）：Chrome 列表里混着 Google 网络语音，断网会静音
    const enVoices = speechSynthesis.getVoices().filter((v) => v.lang && v.lang.startsWith('en'));
    const voice = enVoices.find((v) => v.localService) || enVoices[0];
    if (voice) utter.voice = voice;
    speechSynthesis.speak(utter);
  }

  function setSoundUI() {
    el.soundToggle.textContent = soundOn ? '声音：开' : '声音：关';
    el.soundToggle.setAttribute('aria-pressed', String(soundOn));
  }
  el.soundToggle.addEventListener('click', () => {
    soundOn = !soundOn;
    localStorage.setItem(KEY_SOUND, soundOn ? '1' : '0');
    if (!soundOn && 'speechSynthesis' in window) speechSynthesis.cancel();
    setSoundUI();
  });

  // ---------- 逐字轨道 ----------
  // 把答案拆成 [{display, isLetter}] 的单词数组；标点只展示、不参与判定
  function trackModel(answer) {
    return answer.split(/\s+/).filter(Boolean).map((word) => ({
      word,
      cells: word.split('').map((ch) => ({ ch, isLetter: /[a-z0-9]/i.test(ch) })),
      letters: lettersOf(word),
    }));
  }

  // 对照 typed 内容给每个格子标状态，返回 {wrongCount, completed:Set<单词下标>}
  function evaluate(model, typed) {
    const typedWords = typed.split(/\s+/).filter(Boolean).map(lettersOf);
    let wrongCount = 0; // 全部错误，含轨道上看不见的（多打的字母、多打的词）
    let redCount = 0;   // 轨道上真正标红的格子数
    let pendingCount = 0; // 还空着没写的格子数
    let overflowWord = null; // 第一个被打超长的词
    const completed = new Set();
    model.forEach((wm, wi) => {
      const typedLetters = typedWords[wi] || '';
      let li = 0;
      wm.states = wm.cells.map((cell) => {
        if (!cell.isLetter) return { state: 'punct', show: cell.ch };
        const typedCh = typedLetters[li];
        const expected = cell.ch.toLowerCase();
        li += 1;
        if (typedCh == null) { pendingCount += 1; return { state: 'pending', show: '' }; }
        if (typedCh === expected.toLowerCase() || typedCh === lettersOf(cell.ch)) {
          return { state: 'correct', show: cell.ch };
        }
        wrongCount += 1;
        redCount += 1;
        return { state: 'wrong', show: typedCh };
      });
      if (typedLetters.length === wm.letters.length && typedLetters === wm.letters) {
        completed.add(wi);
      }
      // 单词打多了也算错（轨道上没有格子能显示，所以要单独记下是哪个词）
      if (typedLetters.length > wm.letters.length) {
        wrongCount += typedLetters.length - wm.letters.length;
        if (overflowWord == null) overflowWord = wm.word.replace(/[^a-z0-9']/gi, '');
      }
    });
    const extraWords = Math.max(0, typedWords.length - model.length);
    if (extraWords > 0) wrongCount += 1;
    return { wrongCount, redCount, pendingCount, extraWords, overflowWord, completed };
  }

  // 检查失败时说清楚差在哪：红格、没写完、多写了，三种情况提示不同
  function failureMessage(res) {
    if (res.redCount > 0) {
      return '有 ' + res.redCount + ' 个字母不对，看轨道上标红的位置。';
    }
    if (res.pendingCount > 0) {
      return '还没写完——轨道上还有 ' + res.pendingCount + ' 个空格没填。';
    }
    if (res.extraWords > 0) {
      return '多写了 ' + res.extraWords + ' 个词，删掉多出来的部分再检查。';
    }
    if (res.overflowWord) {
      return '「' + res.overflowWord + '」这个词多打了字母，删掉多余的再检查。';
    }
    return '和原句还对不上，检查一下有没有多打或漏打。';
  }

  function paintTrack(model) {
    el.letterTrack.innerHTML = '';
    // 光标落在第一个待输入的字母格上（输入始终追加在末尾，所以它就是下一个要写的位置）
    const showCaret = document.activeElement === el.answerInput;
    let caretPlaced = false;
    model.forEach((wm) => {
      const wordEl = document.createElement('span');
      wordEl.className = 'track-word';
      (wm.states || wm.cells.map((c) => ({ state: c.isLetter ? 'pending' : 'punct', show: c.isLetter ? '' : c.ch }))).forEach((st) => {
        const cell = document.createElement('span');
        cell.className = 'track-cell ' + st.state;
        if (showCaret && !caretPlaced && st.state === 'pending') {
          cell.className += ' caret';
          caretPlaced = true;
        }
        cell.textContent = st.show;
        wordEl.appendChild(cell);
      });
      el.letterTrack.appendChild(wordEl);
    });
    el.trackPlaceholder.hidden = el.answerInput.value.length > 0;
  }

  // ---------- 反馈文案 ----------
  function setFeedback(text, kind) {
    el.feedback.textContent = text;
    el.feedback.className = 'feedback' + (kind ? ' ' + kind : '');
  }

  // ---------- 画面区 ----------
  function stopSegmentWatcher() {
    if (segmentWatcher) {
      el.video.removeEventListener('timeupdate', segmentWatcher);
      segmentWatcher = null;
    }
  }

  function renderMedia() {
    const lesson = currentLesson();
    stopSegmentWatcher();
    el.video.pause();
    if (lesson.mediaMode === 'local') {
      el.image.hidden = true;
      if (localFileUrl) {
        // 防止从带 videoSrc 的内置课程切回来时还挂着别的源
        if (el.video.src !== localFileUrl) el.video.src = localFileUrl;
        el.video.hidden = false;
        el.localOverlay.hidden = true;
        seekToLine();
      } else {
        el.video.hidden = true;
        el.localOverlay.hidden = false;
        const savedName = localStorage.getItem(KEY_LOCAL_FILE_NAME);
        el.localOverlayDesc.textContent = savedName
          ? '刷新后浏览器出于安全要求需要重新选择文件（上次选的是「' + savedName + '」）。文件不会上传，也不会离开这台电脑。'
          : '从你的电脑选择一段你合法拥有的视频，文件不会上传，也不会离开这台电脑。';
      }
    } else {
      el.localOverlay.hidden = true;
      if (lesson.videoSrc) {
        el.video.hidden = false;
        el.image.hidden = true;
        if (el.video.getAttribute('src') !== lesson.videoSrc) {
          el.video.src = lesson.videoSrc;
          if (lesson.imageSrc) el.video.poster = lesson.imageSrc;
        }
      } else {
        el.video.hidden = true;
        // src 置空字符串会对页面自身发起无效请求，所以无图时直接隐藏
        el.image.hidden = !lesson.imageSrc;
        if (lesson.imageSrc) {
          el.image.src = lesson.imageSrc;
          el.image.alt = lesson.imageAlt || '';
        }
      }
    }
  }

  // 本地模式：切句时把播放头挪到该句起点，方便按播放键听当前句
  function seekToLine() {
    const line = currentLine();
    if (currentLesson().mediaMode === 'local' && localFileUrl && line.startTime != null) {
      try { el.video.currentTime = line.startTime; } catch (e) { /* 元数据未就绪时忽略 */ }
    }
  }

  el.localFileInput.addEventListener('change', () => {
    const file = el.localFileInput.files && el.localFileInput.files[0];
    if (!file) return;
    if (localFileUrl) URL.revokeObjectURL(localFileUrl);
    localFileUrl = URL.createObjectURL(file);
    localStorage.setItem(KEY_LOCAL_FILE_NAME, file.name);
    el.video.src = localFileUrl;
    el.video.hidden = false;
    el.localOverlay.hidden = true;
    el.video.addEventListener('loadedmetadata', seekToLine, { once: true });
    renderSubMask();
    setFeedback('已挂载本地文件「' + file.name + '」，文件只在本页面内播放。', 'ok');
  });

  // ---------- 字幕导入 ----------
  // 解析 .srt：每块 = 序号 + 时间行 + 若干文本行；双语字幕按"是否含汉字"拆成 zh / en
  function parseSrt(text) {
    const cues = [];
    const timeRe = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
    const blocks = text.replace(/^﻿/, '').split(/\r?\n\s*\r?\n/);
    blocks.forEach((block) => {
      const rows = block.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
      const ti = rows.findIndex((r) => timeRe.test(r));
      if (ti === -1) return;
      const m = rows[ti].match(timeRe);
      const start = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
      const end = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
      const textRows = rows.slice(ti + 1)
        // 去掉 <i> 之类的标签、{\an8} 之类的特效码、行首的对话短横线
        .map((r) => r.replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/^-+\s*/, '').trim())
        .filter(Boolean);
      const zh = textRows.filter((r) => /[一-鿿]/.test(r)).join(' ');
      const en = textRows.filter((r) => !/[一-鿿]/.test(r)).join(' ').replace(/\s+/g, ' ').trim();
      if (!/[a-z]/i.test(en)) return; // 纯音乐符号、纯中文条目对听写无意义，跳过
      cues.push({ start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10, en, zh });
    });
    return cues;
  }

  // 中文字幕文件常见 GBK 编码，UTF-8 读出替换符（�）就换 GBK 重解
  function decodeSrtBuffer(buf) {
    const utf8 = new TextDecoder('utf-8').decode(buf);
    if (!utf8.includes('�')) return utf8;
    try { return new TextDecoder('gbk').decode(buf); } catch (e) { return utf8; }
  }

  function applyImportedSrt(name, text) {
    const lesson = currentLesson();
    const cues = parseSrt(text);
    if (!cues.length) {
      setFeedback('没能从「' + name + '」解析出英文台词，确认它是 .srt 格式的英文或双语字幕。', 'err');
      return 0;
    }
    const lines = cues.map((c, i) => ({
      id: lesson.id + '-srt-' + i,
      speaker: '',
      zh: c.zh || '', // 空中文由渲染层显示弱提示

      en: c.en,
      hint: '共 ' + c.en.split(/\s+/).filter(Boolean).length + ' 个单词',
      // 前后各留 0.3 秒，播放片段听起来不掐头去尾
      startTime: Math.max(0, c.start - 0.3),
      endTime: c.end + 0.3,
    }));
    saveJSON(KEY_SRT_PREFIX + lesson.id, { name, lines });
    lineIndex = 0;
    renderLine();
    renderMediaBar();
    setFeedback('已导入「' + name + '」，共 ' + lines.length + ' 句。字幕只保存在这台电脑的浏览器里。', 'ok');
    return lines.length;
  }

  function renderMediaBar() {
    const lesson = currentLesson();
    el.mediaBar.hidden = lesson.mediaMode !== 'local';
    if (el.mediaBar.hidden) return;
    const imp = importedSrt(lesson);
    el.mediaBarStatus.textContent = imp
      ? '已导入「' + imp.name + '」（' + imp.lines.length + ' 句，刷新后仍保留）'
      : '选本集的 .srt 字幕文件，自动生成全部听写句（双语字幕可带出中文意思）';
  }

  // 遮字幕开关：很多下载视频把双语字幕烧进了画面，英文答案会直接暴露，用黑条盖住底部
  let subMaskOn = localStorage.getItem(KEY_SUB_MASK) === '1';
  function renderSubMask() {
    // 只在本地视频真正播放时遮挡；内置插画课程不该被黑条盖住
    el.subMask.hidden = !subMaskOn || currentLesson().mediaMode !== 'local' || !localFileUrl;
    el.maskToggle.textContent = subMaskOn ? '遮字幕：开' : '遮字幕：关';
    el.maskToggle.setAttribute('aria-pressed', String(subMaskOn));
  }
  el.maskToggle.addEventListener('click', () => {
    subMaskOn = !subMaskOn;
    localStorage.setItem(KEY_SUB_MASK, subMaskOn ? '1' : '0');
    renderSubMask();
  });
  renderSubMask();

  el.srtFileInput.addEventListener('change', () => {
    const file = el.srtFileInput.files && el.srtFileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      applyImportedSrt(file.name, decodeSrtBuffer(reader.result));
      el.srtFileInput.value = ''; // 允许重复选同一个文件
    };
    reader.readAsArrayBuffer(file);
  });

  window.addEventListener('beforeunload', () => {
    if (localFileUrl) URL.revokeObjectURL(localFileUrl);
    if (recordUrl) URL.revokeObjectURL(recordUrl);
  });

  function playSegment(line) {
    // 播放本地视频里 startTime ~ endTime 的片段
    stopSegmentWatcher();
    el.video.currentTime = line.startTime || 0;
    segmentWatcher = () => {
      if (line.endTime != null && el.video.currentTime >= line.endTime) {
        el.video.pause();
        stopSegmentWatcher();
      }
    };
    el.video.addEventListener('timeupdate', segmentWatcher);
    el.video.play();
  }

  // ---------- 听写主流程 ----------
  let model = [];

  function lineDone(line) { return !!progress[line.id]; }

  function setUnlocked(unlocked) {
    el.playBtn.disabled = !unlocked;
    el.recordBtn.disabled = !unlocked;
  }

  function renderLine() {
    const lines = currentLines();
    if (lineIndex >= lines.length) lineIndex = 0;
    const line = lines[lineIndex];
    model = trackModel(line.en);
    prevWrongCount = 0;
    prevRedCount = 0;
    prevCompleted = new Set();
    prevInputLen = 0;

    el.lineSpeaker.textContent = line.speaker || '';
    el.lineProgress.textContent = '第 ' + (lineIndex + 1) + ' / ' + lines.length + ' 句';
    // 纯英文字幕没有中文题面：降级为弱提示（兼容旧版导入数据里的长占位文案）
    const zhMissing = !line.zh || line.zh.startsWith('（这一句没有中文字幕');
    el.lineZh.textContent = zhMissing ? '这句没有中文提示——听本句片段，把听到的英文打出来' : line.zh;
    el.lineZh.className = 'line-zh' + (zhMissing ? ' placeholder' : '');
    // 听本句：本地课程且该句带时间点时显示，不要求先答对（听写本来就要先听）
    const canListen = currentLesson().mediaMode === 'local' && line.startTime != null;
    el.listenBtn.hidden = !canListen;
    el.hintText.hidden = true;
    el.hintText.textContent = line.hint || '暂无提示。';
    el.hintBtn.textContent = '显示提示';
    el.recordArea.hidden = true;
    stopRecordingIfAny();

    if (lineDone(line)) {
      // 已完成过的句子：恢复解锁状态并直接展示原句
      el.answerInput.value = line.en;
      const res = evaluate(model, line.en);
      paintTrack(model);
      prevWrongCount = res.wrongCount;
      prevRedCount = res.redCount;
      prevCompleted = res.completed;
      prevInputLen = line.en.length;
      el.answerReveal.hidden = false;
      el.answerText.textContent = line.en;
      setUnlocked(true);
      setFeedback('这句你已经完成过，可以直接播放原句或跟读。', 'ok');
    } else {
      el.answerInput.value = '';
      paintTrack(model);
      el.answerReveal.hidden = true;
      setUnlocked(false);
      setFeedback('');
    }

    renderDots();
    seekToLine();
    // 换句后光标留在轨道上，接着打字即可，不用再点一次
    if (document.activeElement === el.answerInput) paintTrack(model);
  }

  function renderDots() {
    const lines = currentLines();
    el.lineDots.innerHTML = '';
    if (lines.length > 20) {
      // 字幕导入后句子成百上千，圆点导航失效，换成计数 + 跳转框
      const doneCount = lines.filter(lineDone).length;
      const info = document.createElement('span');
      info.className = 'line-jump-info';
      info.textContent = '已完成 ' + doneCount + ' / ' + lines.length + ' 句';
      const jump = document.createElement('input');
      jump.type = 'number';
      jump.min = '1';
      jump.max = String(lines.length);
      jump.value = String(lineIndex + 1);
      jump.className = 'line-jump-input';
      jump.setAttribute('aria-label', '跳转到第几句');
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'btn';
      go.textContent = '跳转';
      const doJump = () => {
        const n = Math.min(lines.length, Math.max(1, Number(jump.value) || 1));
        lineIndex = n - 1;
        renderLine();
      };
      go.addEventListener('click', doJump);
      jump.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJump(); });
      el.lineDots.append(info, jump, go);
    } else {
      lines.forEach((line, i) => {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'line-dot' + (i === lineIndex ? ' current' : '') + (lineDone(line) ? ' done' : '');
        dot.setAttribute('aria-label', '第 ' + (i + 1) + ' 句' + (lineDone(line) ? '（已完成）' : ''));
        dot.addEventListener('click', () => { lineIndex = i; renderLine(); });
        el.lineDots.appendChild(dot);
      });
    }
    el.prevBtn.disabled = lineIndex === 0;
    el.nextBtn.disabled = lineIndex === lines.length - 1;
  }

  // 内容一变，上一次检查的失败提示就不再成立，避免它和轨道现状互相矛盾
  function clearStaleError() {
    if (el.feedback.classList.contains('err')) setFeedback('');
  }

  el.answerInput.addEventListener('input', (e) => {
    const val = el.answerInput.value;
    const grew = val.length > prevInputLen;
    const res = evaluate(model, val);
    paintTrack(model);

    if (grew) {
      const insertedLetter = e.data && lettersOf(e.data).length > 0;
      if (res.wrongCount > prevWrongCount) {
        buzz();
        el.trackShell.classList.remove('shake');
        // 强制重启动画
        void el.trackShell.offsetWidth;
        el.trackShell.classList.add('shake');
        // 错误分两种：轨道上标红的（打错字母）和标不出来的（这个词已经写满还在打）
        setFeedback(res.redCount > prevRedCount
          ? '这个字母不太对，看看红色的位置。'
          : '这个词已经写满了，多打的字母删掉。', 'err');
      } else {
        const newlyDone = [...res.completed].filter((wi) => !prevCompleted.has(wi));
        if (newlyDone.length > 0) {
          // 朗读真实单词（保留撇号，如 Don't），不能用去标点的字母串，否则缩写词发音会错
          const wordText = (wi) => model[wi].word.replace(/[^a-z0-9']/gi, '');
          newlyDone.forEach((wi) => {
            bump('words');
            speak(wordText(wi));
          });
          const lastWord = wordText(newlyDone[newlyDone.length - 1]);
          setFeedback(lastWord + ' 完成，听听它的发音。', 'ok');
        } else if (insertedLetter) {
          tick();
          setFeedback('对了，保持这个节奏。', 'ok');
        } else {
          clearStaleError();
        }
      }
    } else {
      // 删除字符：只更新轨道，不触发任何声音
      clearStaleError();
    }

    prevWrongCount = res.wrongCount;
    prevRedCount = res.redCount;
    prevCompleted = res.completed;
    prevInputLen = val.length;
  });

  // 点轨道任意位置都进入输入状态；光标一律回到末尾，与"追加输入"的判定逻辑保持一致
  function focusInput() {
    el.answerInput.focus({ preventScroll: true });
    const len = el.answerInput.value.length;
    el.answerInput.setSelectionRange(len, len);
  }
  el.trackShell.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    focusInput();
    paintTrack(model);
  });
  el.answerInput.addEventListener('focus', () => paintTrack(model));
  el.answerInput.addEventListener('blur', () => paintTrack(model));

  el.listenBtn.addEventListener('click', () => {
    if (!localFileUrl) {
      setFeedback('先在上方选择本集的视频文件，才能播放片段。', 'err');
      return;
    }
    playSegment(currentLine());
  });

  // 键盘闭环：回车检查，答对后回车去下一句；Shift+回车重听本句
  el.answerInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.shiftKey) {
      if (!el.listenBtn.hidden) el.listenBtn.click();
      return;
    }
    if (lineDone(currentLine())) {
      if (!el.nextBtn.disabled) { el.nextBtn.click(); el.answerInput.focus(); }
    } else {
      el.checkBtn.click();
    }
  });

  el.checkBtn.addEventListener('click', () => {
    const line = currentLine();
    const raw = el.answerInput.value.trim();
    if (!raw) {
      setFeedback('还没有输入内容，先把听到的英文打出来再检查。', 'err');
      return;
    }
    bump('checks');
    if (normalize(raw) === normalize(line.en)) {
      el.answerReveal.hidden = false;
      el.answerText.textContent = line.en;
      setUnlocked(true);
      progress[line.id] = true;
      saveJSON(KEY_PROGRESS, progress);
      markSentenceDone(line.id);
      renderDots();
      setFeedback('完全正确！原句和跟读已解锁。', 'ok');
    } else {
      setUnlocked(false);
      setFeedback(failureMessage(evaluate(model, raw)), 'err');
    }
  });

  el.hintBtn.addEventListener('click', () => {
    const show = el.hintText.hidden;
    el.hintText.hidden = !show;
    el.hintBtn.textContent = show ? '隐藏提示' : '显示提示';
  });

  el.playBtn.addEventListener('click', () => {
    const lesson = currentLesson();
    const line = currentLine();
    bump('plays');
    if (lesson.mediaMode === 'local' && localFileUrl && line.startTime != null) {
      playSegment(line);
    } else if (line.audioSrc) {
      new Audio(line.audioSrc).play();
    } else {
      // 没有音频素材时用浏览器语音兜底
      speak(line.en);
    }
  });

  // ---------- 跟读录音 ----------
  // 切句/切课程时终止录音要丢弃结果，否则异步的 onstop 会把上一句的录音挂到新句上
  let discardRecording = false;

  function stopRecordingIfAny() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      discardRecording = true;
      mediaRecorder.stop();
    }
    el.recordBtn.textContent = '开始跟读';
  }

  el.recordBtn.addEventListener('click', async () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      setFeedback('当前浏览器不支持录音，换用最新版 Chrome / Edge 试试。', 'err');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordChunks.push(e.data); };
      mediaRecorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (discardRecording) {
          // 因切句被终止的录音：只释放资源，不展示、不计数
          discardRecording = false;
          recordChunks = [];
          return;
        }
        if (recordUrl) URL.revokeObjectURL(recordUrl);
        recordUrl = URL.createObjectURL(new Blob(recordChunks, { type: mediaRecorder.mimeType || 'audio/webm' }));
        el.recordPlayback.src = recordUrl;
        el.recordArea.hidden = false;
        el.recordBtn.textContent = '重新跟读';
        bump('recordings');
        setFeedback('录音完成，点右侧播放键听听自己的发音。录音只保存在本页面，不会上传。', 'ok');
      };
      mediaRecorder.start();
      el.recordBtn.textContent = '停止录音';
      setFeedback('正在录音……大声读出这句台词，读完点「停止录音」。', 'ok');
    } catch (err) {
      // 用户拒绝麦克风权限等情况：给可理解的提示，页面不报错
      setFeedback('没拿到麦克风权限。请在浏览器地址栏左侧允许本站使用麦克风后重试。', 'err');
    }
  });

  // ---------- 导航 ----------
  el.prevBtn.addEventListener('click', () => { if (lineIndex > 0) { lineIndex -= 1; renderLine(); } });
  el.nextBtn.addEventListener('click', () => {
    if (lineIndex < currentLines().length - 1) { lineIndex += 1; renderLine(); }
  });

  // ---------- 课程渲染 ----------
  function renderLesson() {
    const lesson = currentLesson();
    el.sceneTitle.textContent = lesson.title;
    el.sceneSeries.textContent = lesson.series || '';
    el.sceneSynopsis.textContent = lesson.synopsis || '';
    el.sceneCharacters.innerHTML = '';
    (lesson.characters || []).forEach((c) => {
      const li = document.createElement('li');
      const b = document.createElement('b');
      b.textContent = c.name;
      li.appendChild(b);
      li.appendChild(document.createTextNode(' — ' + c.desc));
      el.sceneCharacters.appendChild(li);
    });
    el.sceneTone.textContent = lesson.tone || '';
    el.sceneHint.textContent = lesson.sceneHint || '';
    renderMedia();
    renderMediaBar();
    renderSubMask();
    renderLine();
  }

  el.lessonSelect.addEventListener('change', () => {
    lessonIndex = Number(el.lessonSelect.value);
    lineIndex = 0;
    renderLesson();
  });

  // ---------- 启动 ----------
  function init() {
    LESSONS.forEach((lesson, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = lesson.title + (lesson.mediaMode === 'local' ? '（本地视频）' : '');
      el.lessonSelect.appendChild(opt);
    });
    setSoundUI();
    renderStats();
    renderLesson();
    // 部分浏览器的语音列表是异步加载的，先触发一次加载
    if ('speechSynthesis' in window) speechSynthesis.getVoices();
  }

  init();

  // 仅供自动化测试调用的内部钩子，正常使用不依赖它
  window.__sdDebug = { parseSrt, applyImportedSrt };
})();
