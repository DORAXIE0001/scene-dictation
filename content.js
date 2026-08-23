// 练习内容数据：与页面逻辑分离，页面只读取这里导出的课程数组。
//
// ⚠️ 版权红线：本文件会进入公开仓库，只允许放三类素材——
//   1. 原创内容（自己写的台词、自己画的图）
//   2. 明确标注的模拟内容
//   3. 公有领域素材（如 Internet Archive 上版权已过期的影视）
// 禁止放任何未授权剧集的台词、字幕、音视频或演员图片。
// 你个人听写用的真实剧集台词，请写进 content.local.js（那个文件不要提交改动）。

window.BUILTIN_LESSONS = [
  {
    id: 'maple-street-morning',
    title: '清晨的厨房',
    series: '原创迷你剧《枫叶街》· 第 1 幕（模拟内容）',
    synopsis: '周一早晨，Grace 一边收拾厨房一边催促儿子 Tom 出门上学，两人手忙脚乱。',
    characters: [
      { name: 'Grace', desc: '母亲，语速快，做事利落' },
      { name: 'Tom', desc: '儿子，还没睡醒，慢吞吞' },
    ],
    tone: '轻快、日常、略带催促',
    sceneHint: '注意时间压力：所有台词都围绕「快迟到了」展开。',
    mediaMode: 'builtin',
    imageSrc: 'assets/kitchen.svg',
    imageAlt: '清晨厨房的插画：窗外天刚亮，桌上放着早餐',
    lines: [
      {
        id: 'ms1-1', speaker: 'Grace',
        zh: '我们得在八点前出门。',
        en: 'We need to leave before eight.',
        hint: '共 6 个单词，第一个词是 We，「在……之前」用 before。',
      },
      {
        id: 'ms1-2', speaker: 'Grace',
        zh: '你的外套还在楼上吗？',
        en: 'Is your coat still upstairs?',
        hint: '一般疑问句，以 Is 开头，「楼上」是一个单词。',
      },
      {
        id: 'ms1-3', speaker: 'Grace',
        zh: '别忘了带你的钥匙。',
        en: "Don't forget to take your keys.",
        hint: "以 Don't 开头（标点不计分），「钥匙」用复数。",
      },
      {
        id: 'ms1-4', speaker: 'Tom',
        zh: '早餐已经放在桌上了。',
        en: 'Breakfast is already on the table.',
        hint: '共 6 个单词，「已经」是 already。',
      },
      {
        id: 'ms1-5', speaker: 'Grace',
        zh: '今天轮到你倒垃圾。',
        en: "It's your turn to take out the trash.",
        hint: "以 It's 开头，「轮到你」是 your turn，「倒垃圾」是 take out the trash。",
      },
    ],
  },
  {
    id: 'my-local-clip',
    title: '我的本地片段',
    series: '本地视频模式 · 示例课程',
    synopsis: '从你电脑里选择一段你合法拥有的视频，把台词和时间点填进 content.local.js，就能对着真实剧集做听写。下面两句是原创示例台词，用来体验完整流程。',
    characters: [
      { name: '旁白', desc: '示例台词，供体验流程' },
    ],
    tone: '按你所选片段而定',
    sceneHint: '先点右侧「选择本地视频」挂载文件，再用播放器听当前句对应的时间段。',
    mediaMode: 'local',
    lines: [
      {
        id: 'local-1', speaker: '旁白',
        zh: '欢迎来到枫叶街。',
        en: 'Welcome to Maple Street.',
        hint: '共 4 个单词，第一个词是 Welcome。',
        startTime: 0, endTime: 4,
      },
      {
        id: 'local-2', speaker: '旁白',
        zh: '每个人都有自己的秘密。',
        en: 'Everyone has a secret of their own.',
        hint: '共 7 个单词，「秘密」是 secret。',
        startTime: 4, endTime: 9,
      },
    ],
  },
];
