/* 剧情听写：页面逻辑。内容数据在 content.js / content.local.js。 */
(function () {
  'use strict';

  // ---------- 常量与存储键 ----------
  const KEY_SOUND = 'sd-sound-on';
  const KEY_STATS = 'sd-stats-v1';
  const KEY_PROGRESS = 'sd-progress-v1';
  const KEY_LOCAL_FILE_NAME = 'sd-local-file-name';
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
    lineSpeaker: $('lineSpeaker'), lineProgress: $('lineProgress'), lineZh: $('lineZh'),
    letterTrack: $('letterTrack'), answerInput: $('answerInput'), feedback: $('feedback'),
    answerReveal: $('answerReveal'), answerText: $('answerText'),
    checkBtn: $('checkBtn'), hintBtn: $('hintBtn'), playBtn: $('playBtn'), recordBtn: $('recordBtn'),
    hintText: $('hintText'), recordArea: $('recordArea'), recordPlayback: $('recordPlayback'),
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
  function currentLine() { return currentLesson().lines[lineIndex]; }

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
    const voice = speechSynthesis.getVoices().find((v) => v.lang && v.lang.startsWith('en'));
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
    let wrongCount = 0;
    const completed = new Set();
    model.forEach((wm, wi) => {
      const typedLetters = typedWords[wi] || '';
      let li = 0;
      wm.states = wm.cells.map((cell) => {
        if (!cell.isLetter) return { state: 'punct', show: cell.ch };
        const typedCh = typedLetters[li];
        const expected = cell.ch.toLowerCase();
        li += 1;
        if (typedCh == null) return { state: 'pending', show: '' };
        if (typedCh === expected.toLowerCase() || typedCh === lettersOf(cell.ch)) {
          return { state: 'correct', show: cell.ch };
        }
        wrongCount += 1;
        return { state: 'wrong', show: typedCh };
      });
      if (typedLetters.length === wm.letters.length && typedLetters === wm.letters) {
        completed.add(wi);
      }
      // 单词打多了也算错
      if (typedLetters.length > wm.letters.length) wrongCount += typedLetters.length - wm.letters.length;
    });
    if (typedWords.length > model.length) wrongCount += 1;
    return { wrongCount, completed };
  }

  function paintTrack(model) {
    el.letterTrack.innerHTML = '';
    model.forEach((wm) => {
      const wordEl = document.createElement('span');
      wordEl.className = 'track-word';
      (wm.states || wm.cells.map((c) => ({ state: c.isLetter ? 'pending' : 'punct', show: c.isLetter ? '' : c.ch }))).forEach((st) => {
        const cell = document.createElement('span');
        cell.className = 'track-cell ' + st.state;
        cell.textContent = st.show;
        wordEl.appendChild(cell);
      });
      el.letterTrack.appendChild(wordEl);
    });
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
    setFeedback('已挂载本地文件「' + file.name + '」，文件只在本页面内播放。', 'ok');
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
    const lesson = currentLesson();
    const line = currentLine();
    model = trackModel(line.en);
    prevWrongCount = 0;
    prevCompleted = new Set();
    prevInputLen = 0;

    el.lineSpeaker.textContent = line.speaker || '';
    el.lineProgress.textContent = '第 ' + (lineIndex + 1) + ' / ' + lesson.lines.length + ' 句';
    el.lineZh.textContent = line.zh;
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
  }

  function renderDots() {
    const lesson = currentLesson();
    el.lineDots.innerHTML = '';
    lesson.lines.forEach((line, i) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'line-dot' + (i === lineIndex ? ' current' : '') + (lineDone(line) ? ' done' : '');
      dot.setAttribute('aria-label', '第 ' + (i + 1) + ' 句' + (lineDone(line) ? '（已完成）' : ''));
      dot.addEventListener('click', () => { lineIndex = i; renderLine(); });
      el.lineDots.appendChild(dot);
    });
    el.prevBtn.disabled = lineIndex === 0;
    el.nextBtn.disabled = lineIndex === lesson.lines.length - 1;
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
        el.answerInput.classList.remove('shake');
        // 强制重启动画
        void el.answerInput.offsetWidth;
        el.answerInput.classList.add('shake');
        setFeedback('这个字母不太对，看看红色的位置。', 'err');
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
        }
      }
    }
    // 删除字符：只更新轨道，不触发任何声音

    prevWrongCount = res.wrongCount;
    prevCompleted = res.completed;
    prevInputLen = val.length;
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
      setFeedback('还差一点，对照红色格子改一改，再检查一次。', 'err');
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
    if (lineIndex < currentLesson().lines.length - 1) { lineIndex += 1; renderLine(); }
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
})();
