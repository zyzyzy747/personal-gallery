/* ============================================================================
 * 写真图库 · 前端主逻辑
 * ----------------------------------------------------------------------------
 * 规范：docs/01-visual-direction.md (视觉) / docs/02-ux-spec.md (体验)
 * 无框架、无构建、无 CDN —— 打开 index.html 即可运行（需经 serve.py 提供
 * index.final.json 与 /raw/ 原图路由）。
 *
 * 模块顺序：
 *   0 常量  1 工具  2 状态  3 数据加载与索引  4 筛选/搜索  5 URL 同步
 *   6 虚拟滚动网格  7 侧栏  8 标签浏览  9 最近新增  10 套图页
 *   11 灯箱状态机  12 路由  13 启动
 * ========================================================================= */
(function () {
  'use strict';

  /* ==================================================================
   * 0. 常量
   * ================================================================== */

  var GRID = {
    maxContainer: 1680,
    gapX: 24,
    gapY: 32,
    gapXCompact: 14,
    gapYCompact: 20,
    /* infoH / infoHCompact 不再硬编码：虚拟滚动按绝对定位铺行（row.style.top = i * rowStride），
       这里的数值必须与 design-tokens.css 的 --card-info-h 完全一致，否则每行会错位。
       改为运行时从 CSS 变量读取，杜绝「改了 CSS 忘了改 JS」的漂移（视觉规范 §6.3）。 */
    bufferRows: 2,
    /* 容器宽度 → 列数（视觉规范 §5.1）。
       末两档对手机做了适配：iPhone 全系 390–430px，若沿用「<400 → 1 列」
       会让手机只有 1 列（卡片 220×381，一屏放不下两张）。
       改为 ≥360 即 2 列（每列约 169px），仅 <360（极窄机）才降到 1 列。
       注意：必须与 style.css 的列数媒体查询保持同步，否则 JS 度量与 CSS 渲染错位。 */
    colSteps: [
      { min: 1440, n: 6 },
      { min: 1100, n: 5 },
      { min: 860, n: 4 },
      { min: 620, n: 3 },
      { min: 360, n: 2 },
      { min: 0, n: 1 }
    ]
  };

  /* 读取设计 token（CSS 自定义属性），失败时回退到规范默认值。
     注意：紧凑密度的覆盖写在 .app[data-density="compact"] 上而不是 :root，
     所以必须在 .app 元素上取值，否则紧凑模式会读到标准密度的数值。 */
  function cssPx(name, fallback) {
    try {
      var el = document.querySelector('.app') || document.documentElement;
      var v = parseFloat(getComputedStyle(el).getPropertyValue(name));
      return isFinite(v) ? v : fallback;
    } catch (e) { return fallback; }
  }

  var DIMS = [
    { id: 'works', key: 'w', label: '作品', field: 'works' },
    { id: 'roles', key: 'r', label: '角色', field: 'roles' },
    { id: 'themes', key: 't', label: '主题', field: 'themes' },
    { id: 'others', key: 'o', label: '未分类', field: 'others' }
  ];

  var DIM_BY_FIELD = { works: 'works', roles: 'roles', themes: 'themes', others: 'others' };

  var SORT_OPTIONS = [
    { id: 'newest', label: '最近新增' },
    { id: 'count-desc', label: '图片数 ↓' },
    { id: 'coser-asc', label: 'coser A-Z' },
    { id: 'size-desc', label: '体积 ↓' }
  ];

  var LS = {
    theme: 'wg.theme',
    density: 'wg.density',
    nsfw: 'wg.nsfwBlur',
    favs: 'wg.favs',
    recent: 'wg.recentSearch'
  };

  var SS = { tagDim: 'wg.tagDim', tagScroll: 'wg.tagScroll', filterHash: 'wg.filterHash' };

  /* 原图路径前缀。整理后库根是 E:\Download\01-图库\（见 app/paths.py）；
     旧前缀保留一份，是为了兼容「还没重启的旧服务进程」——它启动时把
     RAW_ROOTS 读进了内存，仍是 E:\download\Telegram。两个前缀都命中不了
     时按绝对路径直接发，服务端会拒绝，属于应当暴露的配置错误。 */
  var RAW_ROOTS = ['E:\\Download\\01-图库\\', 'E:\\download\\Telegram\\'];

  /* ==================================================================
   * 1. 工具
   * ================================================================== */

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** 标签归一化键（UX 规范 §3.2 的 key() 规则）：NFKC + 小写 + 去分隔符 */
  function key(s) {
    if (!s) return '';
    var t = String(s).normalize('NFKC').toLowerCase();
    return t.replace(/[\s\-_·・.,、'"!?,，。！?()（）[\]【】「」『』]/g, '');
  }

  /** 目录名里的各种破折号统一成 '-'（UX 规范 §3.2 S0） */
  function normDash(s) {
    return String(s).replace(/[‐‑‒–—―−－ー]/g, '-');
  }

  function debounce(fn, ms) {
    var t = 0;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function fmtInt(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** 20260511 → 2026-05-11 */
  function fmtDate(yyyymmdd) {
    if (!yyyymmdd || yyyymmdd.length !== 8) return '';
    return yyyymmdd.slice(0, 4) + '-' + yyyymmdd.slice(4, 6) + '-' + yyyymmdd.slice(6, 8);
  }

  function sizeToBytes(s) {
    if (!s) return 0;
    var m = /^([\d.]+)\s*([MmGg])[Bb]?$/.exec(String(s).trim());
    if (!m) return 0;
    var v = parseFloat(m[1]);
    return m[2].toLowerCase() === 'g' ? v * 1073741824 : v * 1048576;
  }

  function fmtBytes(b) {
    if (!b) return '';
    if (b >= 1073741824) return (b / 1073741824).toFixed(2).replace(/\.?0+$/, '') + 'GB';
    if (b >= 1048576) return Math.round(b / 1048576) + 'MB';
    if (b >= 1024) return Math.round(b / 1024) + 'KB';
    return b + 'B';
  }

  /** alt 文本（UX 规范 §7.4），≤125 字符 */
  function buildAlt(set, idx, total) {
    var parts = [];
    if (set.coser) parts.push(set.coser);
    var content = (set.works || []).concat(set.roles || []).concat(set.themes || []);
    if (content.length) parts.push(content.join(' '));
    if (idx != null) parts.push('第 ' + (idx + 1) + '/' + total + ' 张');
    var s = parts.join(' · ');
    if (s.length > 125) s = s.slice(0, 122) + '…';
    return s || set.raw || '写真';
  }

  /** 原图 URL：把库根之后的相对路径做逐段编码 */
  function rawUrl(setPath, filename) {
    var rel = setPath || '';
    for (var k = 0; k < RAW_ROOTS.length; k++) {
      var i = rel.indexOf(RAW_ROOTS[k]);
      if (i >= 0) { rel = rel.slice(i + RAW_ROOTS[k].length); break; }
    }
    rel = rel.replace(/\\/g, '/');
    var segs = rel.split('/').map(encodeURIComponent);
    if (filename) segs.push(encodeURIComponent(filename));
    return '/raw/' + segs.join('/');
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        resolve();
      } catch (e) { reject(e); }
    });
  }

  var toastTimer = 0;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.setAttribute('data-show', '1');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.removeAttribute('data-show'); }, 1800);
  }

  /* ==================================================================
   * 2. 状态
   * ================================================================== */

  var state = {
    view: 'grid',                 // grid | tags | recent | set
    q: '',
    coser: '',
    tags: { works: [], roles: [], themes: [], others: [] },
    mode: 'and',                  // and | or —— 仅作用于跨维度
    sort: 'newest',
    setId: null,
    lbIndex: null,                // L3 灯箱当前图（null = 关闭）
    lbPushed: false,              // 灯箱是否 push 了 history（用于 Esc 回退）
    panelOpen: true,              // 元数据面板状态（灯箱关闭后不清零 —— 恢复路径 ①）
    selected: {},                 // 多选
    density: 'comfortable',
    nsfwBlur: true,
    theme: 'dark',
    tagDim: 'roles',
    recentDays: 7
  };

  /* ==================================================================
   * 3. 数据加载与索引
   * ================================================================== */

  var DB = {
    sets: [],                 // 规范化后的套图数组
    byId: {},
    coserCounts: {},          // coser → count
    tagCounts: {},            // 归一化标签 → count
    dimCounts: { works: {}, roles: {}, themes: {}, others: {} },
    tagSets: {},              // 归一化标签 → [setId]
    tagMeta: {},              // 归一化标签 → {dims:{dim:count}, sets:[setId]}
    coserSets: {},            // coser → [setId]
    alias: {},                // 归一化键 → 显示名（来自 index.final.json）
    shotDates: {},            // setId → YYYYMMDD
    thumbMeta: {},            // setId → {c, l}
    fileCache: {},            // setId → {files, dims, shot, span}
    mangaSets: [],            // 漫画/插画（独立模块，不进写真网格）
    active: null,             // 当前浏览的数据源（写真 DB.sets / 漫画 DB.mangaSets）
    novels: [],               // 小说库（懒加载，进小说视图才请求）
    novelMeta: null,
    novelsLoaded: false
  };

  var perf = window.__perf = {
    t0: performance.now(),
    marks: {},
    mark: function (name) { this.marks[name] = Math.round(performance.now() - this.t0); }
  };

  /* 从目录名声明的规格串里解析出张数。
     规格样例："51P7V" / "143P" / "25P3V-134MB" / "119P-221MB"
     声明值常与实际文件数不符（实测 95.5% 的卡片偏大），因此它只作对照标注，
     卡片上的权威计数一律用实测值 set.n。 */
  function parseClaimedPages(pages) {
    if (!pages) return 0;
    var m = /(\d+)\s*[Pp]/.exec(pages);
    return m ? parseInt(m[1], 10) : 0;
  }

  /**
   * emoji 剥离（UX 规范 §3.7 S6）。
   * 上游解析器漏了 2 条（如「制尻工坊 色色名器倒模🥳」），
   * 渲染层兜底：标签里不允许出现 emoji 码位。
   */
  var EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{1F900}-\u{1F9FF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}\u{2764}\u{2B50}]/gu;

  function stripEmoji(t) {
    if (!t) return '';
    return String(t).replace(EMOJI_RE, '').replace(/\s+/g, ' ').trim();
  }

  /**
   * 标签归一化键（与 fix_index.py 的 norm_key 一致）：
   * 去 `·・空格_` + 转小写。用于 alias 表查表，
   * 保证「JK / jk / JK」「Blue Archive / BlueArchive」被折叠成同一项。
   */
  function normKey(t) {
    if (!t) return '';
    return String(t).toLowerCase().replace(/[·・\s_]+/g, '');
  }

  /* ---- 标签类型就地修正（UX 规范 §5.4）----
     静态服务器无法写文件，因此修正结果存 localStorage，
     并提供「导出 overrides.json」按钮让用户手动落盘到 app/library-overrides.json。 */
  var OVERRIDE_KEY = 'wg.tagTypeOverrides';
  var OVERRIDES = null;

  function loadOverrides() {
    if (OVERRIDES) return OVERRIDES;
    try { OVERRIDES = JSON.parse(localStorage.getItem(OVERRIDE_KEY) || '{}'); }
    catch (e) { OVERRIDES = {}; }
    if (!OVERRIDES || typeof OVERRIDES !== 'object') OVERRIDES = {};
    return OVERRIDES;
  }

  function saveOverrides() {
    try { localStorage.setItem(OVERRIDE_KEY, JSON.stringify(OVERRIDES)); } catch (e) {}
  }

  /** 取标签的生效维度：用户修正优先于索引分类 */
  function effectiveDim(tag) {
    var ov = loadOverrides();
    var o = ov[normKey(tag)];
    if (o && DIMS.some(function (d) { return d.field === o.dim; })) return o.dim;
    return null;
  }

  /** 导出 overrides.json（让用户手动存到 app/library-overrides.json） */
  function exportOverrides() {
    var ov = loadOverrides();
    var keys = Object.keys(ov);
    if (!keys.length) { toast('暂无标签类型修正记录'); return; }
    var payload = {
      _note: '前端就地修正导出的标签类型映射。放到 app/library-overrides.json 即可持久化到索引。',
      _exportedAt: new Date().toISOString(),
      overrides: ov
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'library-overrides.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('已导出 ' + keys.length + ' 条修正');
  }

  /**
   * 索引 schema 适配器。
   * index.final.json 由 fix_index.py 持续重建，字段形态在演进：
   *   v1  顶层 works/roles/themes/others 四桶，n = 图片数
   *   v2  新增 kinds.{works,roles,themes}，others = tags - 三类，count = 图片数
   * 两种形态并存时以 kinds 为准（它是新解析器的产物），并做交叉校验。
   * 这样前端不依赖索引的具体版本，索引重建后无需改代码。
   */
  function pickBuckets(raw) {
    var k = raw.kinds;
    var works = (k && k.works && k.works.length) ? k.works : (raw.works || []);
    var roles = (k && k.roles && k.roles.length) ? k.roles : (raw.roles || []);
    var themes = (k && k.themes && k.themes.length) ? k.themes : (raw.themes || []);
    var tags = raw.tags || [];
    /* others 优先用索引给的；缺失则由 tags 减去三类推出 */
    var others = raw.others;
    if (!others || !others.length) {
      var inKind = {};
      works.concat(roles, themes).forEach(function (t) { inKind[t] = 1; });
      others = tags.filter(function (t) { return !inKind[t]; });
    }
    return { works: works, roles: roles, themes: themes, others: others };
  }

  function normalizeSet(raw) {
    var b = pickBuckets(raw);
    var s = {
      id: raw.id,
      raw: raw.raw,
      coser: raw.coser || '',
      co: raw.co || [],
      tags: (raw.tags || []).map(stripEmoji).filter(Boolean),
      works: b.works.map(stripEmoji).filter(Boolean),
      roles: b.roles.map(stripEmoji).filter(Boolean),
      themes: b.themes.map(stripEmoji).filter(Boolean),
      others: b.others.map(stripEmoji).filter(Boolean),
      pages: raw.pages || '',
      claimedPages: parseClaimedPages(raw.pages || ''),
      size: raw.size || '',
      times: raw.times || [],
      emoji: raw.emoji || [],
      promo: !!raw.promo,
      n: raw.n != null ? raw.n : (raw.count || 0),
      group: raw.group || '',
      path: raw.path || '',
      files: raw.files || [],            // 完整文件清单（权威）
      dates: raw.dates || [],            // 完整拍摄日期列表
      thumb: raw.thumb || '',
      thumbUrl: raw.thumb ? 'assets/' + raw.thumb : '',
      /* 2x 封面：手机 DPR 3 下 240px 素材有效 DPR 只有 1.44，明显糊。
         480px 版把有效 DPR 提到 2.87；桌面 DPR 1 不加载，不增加流量。 */
      thumb2xUrl: raw.thumb2x ? 'assets/' + raw.thumb2x : '',
      /* 散图集：平铺在分组目录下、按月聚合出来的虚拟套图；
         manga 为真表示内容类型是漫画/插画，单独成模块 */
      loose: !!raw.loose,
      manga: !!raw.manga,
      month: raw.month || '',
      /* 视频：本机无 ffmpeg 抽帧，封面用浏览器 <video preload="metadata"> 的首帧，
         播放依赖 serve.py 的 Range（已实现 206 分段，可拖进度条） */
      videos: raw.videos || [],
      vn: raw.vn || (raw.videos || []).length,
      lqipUrl: raw.thumb ? 'assets/lqip/' + raw.thumb.split('/').pop() : ''
    };
    /* NSFW 判定：优先用 group 字段，回退到 path（两版索引都能用） */
    s.isNSFW = /NSFW/.test(s.group) || /NSFW/.test(s.path);
    s.kCoser = key(s.coser);
    s.kTags = s.tags.map(key);
    s.kRaw = key(s.raw);
    s.kCo = s.co.map(key);
    s.sizeBytes = sizeToBytes(s.size);
    s.title = deriveTitle(s);

    /* 类型词/技术词不作为标题。
       漫画库的目录名常是 `#媚黑 #漫画 #potion` 这种纯标签串，
       解析后 themes=['漫画']、others=['potion'] —— 若直接取第一个，
       270 个漫画会有大量卡片同时叫「漫画」，完全没有区分度。
       跳过泛词后：potion / 碧蓝档案 / SDxjhxy，才是真正能认出内容的那一层。 */
    var GENERIC_TAGS = {
      '漫画': 1, '写真': 1, '套图': 1, '图片': 1, '视频': 1, '插画': 1,
      'cg': 1, '二次元': 1, '原创': 1, '合集': 1, '资源': 1, '图包': 1,
      '无水印': 1, '有码': 1, '无码': 1, 'ai': 1, 'tt': 1, 'p': 1, 'v': 1
    };
    var firstSpecific = function (arr) {
      for (var gi = 0; gi < arr.length; gi++) {
        if (!GENERIC_TAGS[key(arr[gi])]) return arr[gi];
      }
      return '';
    };
    s.primaryTag = firstSpecific(s.works) || firstSpecific(s.roles)
      || firstSpecific(s.themes) || firstSpecific(s.others) || '';

    /* 虚拟套图（散图按月聚合）没有标签、也没有「标题词」可推导：
       coser 胶囊已经是分组名，标题就用月份，副标题留空——
       否则 raw（"分组 · 月份"）会被同时当成标题和副标题，重复显示。 */
    if (s.loose) {
      var mk = s.month || '';
      s.title = (mk && mk !== '000000')
        ? mk.slice(0, 4) + '年' + mk.slice(4, 6) + '月'
        : '日期未知';
      s.displayTitle = s.title;
      s.titleFromTag = false;
      s.subtitle = { kind: 'none', text: '' };
      return s;
    }
    /* 标题降级链（30% 的套图完全没有内容标签，必须有可读的兜底）：
       ① 目录名里的裸词标题  ② 主标签  ③ 去掉 # 与规格后的原目录名 */
    s.fallbackRaw = s.raw
      .replace(/\[[^\[\]]*\]/g, '')
      .replace(/^#/, '')
      .replace(/\s+/g, ' ')
      .trim();
    s.displayTitle = s.title || s.primaryTag || s.fallbackRaw || '未命名套图';
    s.titleFromTag = !s.title && !!s.primaryTag;
    /* 卡片副标题（UX 规范 §5.7 四级降级）：
       A 有内容标签  B 仅 others  C 完全无标签 → 显示原始目录名  D 目录名过长 → coser 段 + … */
    s.subtitle = deriveSubtitle(s);
    return s;
  }

  /**
   * 卡片副标题四级降级（UX 规范 §5.7）。
   * 30.0% 的套图四个标签桶全空 —— 留空会让卡片看起来像「加载失败」，
   * 必须用原始目录名兜底（等宽 12px 次级色，单行 ellipsis）。
   */
  function deriveSubtitle(s) {
    var content = [];
    ['works', 'roles', 'themes'].forEach(function (f) {
      (s[f] || []).forEach(function (t) { if (content.indexOf(t) < 0) content.push(t); });
    });
    if (content.length) {
      return { kind: 'tags', text: content.slice(0, 3).join(' · '), extra: content.length - 3 };
    }
    if (s.others && s.others.length) {
      return { kind: 'others', text: s.others.slice(0, 2).join(' · '), extra: s.others.length - 2 };
    }
    /* C 级：完全无标签 → 原始目录名 */
    var raw = s.raw.replace(/^#/, '').replace(/\s+/g, ' ').trim();
    var seg = raw.split(/\s+-\s+/)[0] || raw;
    if (seg.length > 28) {
      return { kind: 'rawname', text: seg.slice(0, 27) + '…', full: raw };
    }
    return { kind: 'rawname', text: seg, full: raw };
  }

  /**
   * 从目录名推导「标题词」（视觉规范 §4.4 重排后的第 ② 层）。
   * 规则：剥离尾部 [...] 与裸规格 → 切分 ' - ' → 取尾段中
   * 既不是 #标签、也不是已知 tag/时间/coser 的裸词。
   */
  function deriveTitle(s) {
    var raw = normDash(s.raw);
    raw = raw.replace(/\[[^\[\]]*\]/g, ' ');
    raw = raw.replace(/\s+\d{1,4}\s*[Pp]\d{0,2}\s*[Vv]?(\s*[\d.]+\s*[MmGg][Bb]?)?\s*$/, ' ');
    var parts = raw.split(/\s+-\s+/);
    var tail = parts.slice(1).join(' - ');
    if (!tail) tail = raw;
    var tagSet = {};
    s.tags.forEach(function (t) { tagSet[key(t)] = 1; });
    (s.times || []).forEach(function (t) { tagSet[key(t)] = 1; });
    var coserSet = {};
    coserSet[s.kCoser] = 1;
    s.kCo.forEach(function (k) { coserSet[k] = 1; });
    var words = tail.split(/\s+/).filter(function (w) {
      if (!w) return false;
      if (w.charAt(0) === '#') return false;
      var k = key(w);
      if (!k) return false;
      if (tagSet[k] || coserSet[k]) return false;
      if (/^\d/.test(w)) return false;
      return true;
    });
    return words.join(' ').replace(/^[\s\-·]+|[\s\-·]+$/g, '');
  }

  /**
   * 读 JSON。
   * @param url   相对路径
   * @param ver   版本号；有值时拼 ?v=<ver> 并允许长缓存，内容一变 URL 就变。
   *              没有版本号时退回 force-cache —— 但那样内容更新后拿不到新数据，
   *              所以核心索引一定要传版本号。
   */
  /* ==================================================================
   * 小说库
   * 和图片库完全独立的模块：没有封面、没有缩略图，靠书名 + 字数 + 分类浏览。
   * 数据懒加载（进小说视图才请求），不拖慢图片库首屏。
   * ================================================================== */

  var novelState = { q: '', cat: '', shown: 80, list: [] };
  var NOVEL_PAGE = 80;

  function loadNovels() {
    if (DB.novelsLoaded) return Promise.resolve();
    return loadJSON('assets/novels.json', DB.nversion || DB.version)
      .then(function (d) {
        DB.novels = (d && d.list) || [];
        DB.novelMeta = (d && d.meta) || null;
        DB.novelsLoaded = true;
        /* 分类下拉：来源站点（cool18/xbookcn）+ 主题分类混在一起，按数量降序 */
        var sel = $('#novel-cat');
        if (sel && DB.novelMeta) {
          var counts = {};
          DB.novels.forEach(function (n) { counts[n.c] = (counts[n.c] || 0) + 1; });
          sel.textContent = '';
          var opt0 = el('option', '', '全部分类（' + DB.novels.length + '）');
          opt0.value = '';
          sel.appendChild(opt0);
          Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })
            .forEach(function (c) {
              var o = el('option', '', c + '（' + counts[c] + '）');
              o.value = c;
              sel.appendChild(o);
            });
        }
        var nm = document.getElementById('nav-novel');
        if (nm) { nm.hidden = DB.novels.length === 0; }
        var nc = document.getElementById('nav-count-novel');
        if (nc) nc.textContent = fmtInt(DB.novels.length);
      })
      .catch(function () { DB.novelsLoaded = true; });
  }

  function fmtWords(n) {
    if (n >= 10000) return (n / 10000).toFixed(1) + ' 万字';
    return fmtInt(n) + ' 字';
  }

  function fmtMB(b) {
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    return Math.max(1, Math.round(b / 1024)) + ' KB';
  }

  function renderNovelPage() {
    var host = $('#novel-list');
    if (!host) return;
    var q = novelState.q.trim().toLowerCase();
    var cat = novelState.cat;

    novelState.list = DB.novels.filter(function (n) {
      if (cat && n.c !== cat) return false;
      if (q && n.t.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });

    host.textContent = '';
    $('#novel-count').textContent = fmtInt(novelState.list.length) + ' 本';

    if (!novelState.list.length) {
      var empty = el('div', 'novel-empty', DB.novelsLoaded ? '没有匹配的书' : '加载中…');
      host.appendChild(empty);
      return;
    }

    var frag = document.createDocumentFragment();
    var end = Math.min(novelState.shown, novelState.list.length);
    for (var i = 0; i < end; i++) {
      var n = novelState.list[i];
      var row = el('a', 'novel-row');
      row.href = 'novel/' + n.p.split('/').map(encodeURIComponent).join('/');
      /* IIFE 把「当前这本」绑进闭包。
         var 是函数作用域：直接写 openReader(n) 的话，所有行共享同一个 n，
         循环结束后它指向最后一本 —— 表现就是「点哪本都打开同一本」。 */
      (function (book) {
        row.addEventListener('click', function (e) {
          e.preventDefault();
          /* 电子书格式分流：只有 txt / epub 能在阅读器里读，
             mobi / chm / pdf 这类直接走下载，别让读者对着乱码发呆。 */
          if (!canReadBook(book)) { window.location.href = row.href; return; }
          openReader(book);
        });
      })(n);
      // 悬停提示：书名 / 分类 / 字数 / 体积。用 \\n 拼接在 JS 里是换行，
      // 注意这里是真实的反斜杠+n，不能是字面换行（会导致语法错误）
      row.title = n.t + '\n分类：' + n.c
        + (n.w ? '\n约 ' + fmtWords(n.w) : '') + ' · ' + fmtMB(n.s)
        + (n.f && n.f !== 'txt' ? '\n格式：' + n.f.toUpperCase() : '');
      row.appendChild(el('span', 'novel-title', n.t));
      var meta = el('span', 'novel-meta');
      meta.appendChild(el('span', 'novel-tag', n.c));
      if (n.f && n.f !== 'txt') {
        meta.appendChild(el('span', 'novel-tag', n.f.toUpperCase()));
      }
      meta.appendChild(el('span', 'novel-size', n.w ? fmtWords(n.w) : '—'));
      meta.appendChild(el('span', 'novel-size', fmtMB(n.s)));
      row.appendChild(meta);
      frag.appendChild(row);
    }
    host.appendChild(frag);

    if (end < novelState.list.length) {
      var more = el('button', 'btn btn-secondary novel-more',
                    '加载更多（已显示 ' + end + ' / ' + fmtInt(novelState.list.length) + '）');
      more.type = 'button';
      more.addEventListener('click', function () {
        novelState.shown += NOVEL_PAGE;
        renderNovelPage();
      });
      host.appendChild(more);
    }
  }

  /* ---------------- 小说在线预览 ---------------- */

  var reader = { path: '', title: '', text: '', page: 0, perPage: 2200, size: 17 };
  var READER_SIZES = [15, 16, 17, 18, 20, 22];

  /* 阅读器能直接打开的格式（txt 与 epub 都由 /novel-text/ 转成纯文本）。
     mobi / azw3 / chm / pdf 只入库可下载 —— 没有通用纯文本解包方案。 */
  var READABLE_FMT = { txt: 1, epub: 1 };
  function canReadBook(n) { return !n.f || READABLE_FMT[n.f] === 1; }

  function openReader(n) {
    var dlHref = 'novel/' + n.p.split('/').map(encodeURIComponent).join('/');
    if (!canReadBook(n)) {
      reader.path = n.p;
      reader.title = n.t;
      reader.text = '';
      reader.page = 0;
      $('#reader-title').textContent = n.t;
      $('#reader-body').textContent =
        '这是 ' + String(n.f || '').toUpperCase() + ' 格式，阅读器不支持在线打开。\n\n'
        + '点右下角「下载原文」取回原文件，用本机阅读器打开。';
      $('#reader-page').textContent = '—';
      $('#reader-download').href = dlHref;
      state.view = 'reader';
      switchView('reader');
      return;
    }
    var wantPath = n.p;        // 本次目标，用于识别「过期响应」
    reader.path = n.p;
    reader.title = n.t;
    reader.page = 0;
    reader.text = '';
    $('#reader-title').textContent = n.t;
    $('#reader-body').textContent = '加载中…';
    $('#reader-page').textContent = '—';
    $('#reader-download').href = 'novel/' + n.p.split('/').map(encodeURIComponent).join('/');
    state.view = 'reader';
    switchView('reader');

    var url = 'novel-text/' + n.p.split('/').map(encodeURIComponent).join('/');
    fetch(url, { cache: 'force-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (txt) {
        /* 连点几本时，先发的请求可能后返回。路径已经变了说明用户切走了，
           这时把正文写进去就会「显示的是上一本」——直接丢弃。 */
        if (reader.path !== wantPath) return;
        reader.text = txt || '';
        renderReaderPage();
      })
      .catch(function (e) {
        if (reader.path !== wantPath) return;
        $('#reader-body').textContent = '读取失败：' + e.message;
      });
  }

  function renderReaderPage() {
    var body = $('#reader-body');
    var text = reader.text;
    if (!text) { body.textContent = ''; return; }

    /* 按段切再累加成页：直接按字数硬切会把一段话截断在两页之间，读起来断裂 */
    var paras = text.split(/\r?\n/);
    var pages = [];
    var cur = [];
    var curLen = 0;
    for (var i = 0; i < paras.length; i++) {
      var line = paras[i].trim();
      if (!line) continue;
      if (curLen + line.length > reader.perPage && cur.length) {
        pages.push(cur);
        cur = [];
        curLen = 0;
      }
      cur.push(line);
      curLen += line.length;
    }
    if (cur.length) pages.push(cur);
    if (!pages.length) pages.push(['（空文件）']);

    reader.pages = pages;
    if (reader.page >= pages.length) reader.page = pages.length - 1;
    if (reader.page < 0) reader.page = 0;

    body.textContent = '';
    var pageParas = pages[reader.page];
    for (var j = 0; j < pageParas.length; j++) {
      var pEl = document.createElement('p');
      pEl.textContent = pageParas[j];
      body.appendChild(pEl);
    }
    body.style.fontSize = reader.size + 'px';
    $('#reader-page').textContent = (reader.page + 1) + ' / ' + pages.length;
    $('#reader-prev').disabled = reader.page <= 0;
    $('#reader-next').disabled = reader.page >= pages.length - 1;
    $('#reader-scroll').scrollTop = 0;
  }

  function loadJSON(url, ver) {
    var full = ver ? (url + '?v=' + encodeURIComponent(ver)) : url;
    var opt = ver ? { cache: 'force-cache' } : { cache: 'no-cache' };
    return fetch(full, opt).then(function (r) {
      if (!r.ok) throw new Error(full + ' → HTTP ' + r.status);
      return r.json();
    });
  }

  /** 取数据版本号；失败不影响使用，只是退化成每次验证缓存 */
  function fetchVersion() {
    return fetch('assets/version.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return j || {}; })
      .catch(function () { return {}; });
  }

  function bootData() {
    var t0 = performance.now();
    return fetchVersion().then(function (vj) {
      var ver = vj.v || '';
      DB.version = ver;
      /* 小说库有自己的版本号：爬虫每抓一批它就变一次，
         若与图片索引共用版本号，手机每次刷新都要白下 1.3 MB 没变的索引 */
      DB.nversion = vj.nv || ver;
      return Promise.all([
        loadJSON('index.final.json', ver),
        loadJSON('assets/thumbmeta.json', ver).catch(function () { return {}; }),
        loadJSON('assets/auto-tags.json', ver).catch(function () { return {}; })
      ]);
    }).then(function (res) {
      var unified = res[0];
      perf.mark('dataFetch');
      DB.thumbMeta = res[1] || {};
      /* 视觉自动标注：只覆盖「解析不出任何标签」的套图，缺失该文件不影响使用 */
      DB.autoTags = res[2] || {};
      DB.alias = unified.alias || {};

      var i, s, t, d;
      for (i = 0; i < unified.sets.length; i++) {
        var raw = unified.sets[i];
        if (raw.promo) continue;               // 运营/广告目录默认隐藏
        s = normalizeSet(raw);

        /* 合并视觉自动标注（assets/auto-tags.json）。
           只有套图本身零标签时才补，避免盖掉目录名里解析出的真实标签。
           标的是主题类（内衣/泳装/女仆…），与解析标签同权参与筛选与搜索，
           但打 autoTagged 标记，界面可以把它们和人工/解析标签区分开。 */
        var at = DB.autoTags[String(raw.id)];
        if (at && at.tags && at.tags.length && !s.tags.length) {
          s.themes = at.tags.slice();
          s.tags = at.tags.slice();
          s.autoTagged = true;
        }

        DB.byId[s.id] = s;
        if (s.manga) {
          /* 漫画/插画不进写真网格，走独立的「漫画」模块 */
          DB.mangaSets.push(s);
          continue;                        // 不参与写真的标签分面统计
        }
        DB.sets.push(s);

        /* 拍摄日期直接取索引内嵌的 date 字段（YYYY-MM-DD）。
           不再依赖 assets/shotdates.json —— 那份数据按旧索引的 id 索引，
           与当前 sets 顺序不一致，会导致日期整体错位。 */
        s.shot = raw.date ? raw.date.replace(/-/g, '') : null;
        s.shotNum = s.shot ? parseInt(s.shot, 10) : 0;
        s.shotLabel = raw.date || '';

        t = s.coser;
        DB.coserCounts[t] = (DB.coserCounts[t] || 0) + 1;
        (DB.coserSets[t] = DB.coserSets[t] || []).push(s.id);

        /* 分面计数：标签先经 alias 表归一化再计数，
           否则「JK / jk」「Blue Archive / BlueArchive」会被拆成两项。
           同时应用用户就地修正的标签类型（UX 规范 §5.4）。 */
        for (d = 0; d < DIMS.length; d++) {
          var field = DIMS[d].field;
          var arr = s[field] || [];
          for (var j = 0; j < arr.length; j++) {
            t = arr[j];
            var canon = DB.alias[normKey(t)] || t;
            var ovDim = effectiveDim(canon);
            var dim = ovDim || field;
            DB.tagCounts[canon] = (DB.tagCounts[canon] || 0) + 1;
            DB.dimCounts[dim][canon] = (DB.dimCounts[dim][canon] || 0) + 1;
            (DB.tagSets[canon] = DB.tagSets[canon] || []).push(s.id);
            /* 记录该标签出现过的原始维度，供搜索分组与修正入口使用 */
            var meta = DB.tagMeta[canon] || (DB.tagMeta[canon] = { dims: {}, sets: [] });
            meta.dims[dim] = (meta.dims[dim] || 0) + 1;
            if (meta.sets.indexOf(s.id) < 0) meta.sets.push(s.id);
          }
        }
      }

      perf.mark('indexBuilt');
      perf.dataMs = Math.round(performance.now() - t0);
      perf.setCount = DB.sets.length;
    });
  }

  /**
   * 取套图的文件清单。
   * 文件名清单直接用 index.final.json 内嵌的 files[]（权威，已抽样 40 套图
   * 与 E 盘目录 100% 一致）；原图宽高来自 assets/dims/<id>.json（按新 id 对齐，
   * 旧的 assets/files/<id>.json 是按旧索引顺序生成的，4310/5292 条错位）。
   */
  function loadSetFiles(id) {
    if (DB.fileCache[id]) return Promise.resolve(DB.fileCache[id]);
    var set = DB.byId[id];
    if (!set) return Promise.reject(new Error('未知套图 ' + id));
    var files = set.files || [];
    return loadJSON('assets/dims/' + id + '.json').then(function (rec) {
      var rec2 = { id: id, files: files, dims: rec.dims || [], shot: set.shot,
                   span: (set.dates || []).length, videos: set.videos || [] };
      DB.fileCache[id] = rec2;
      return rec2;
    }).catch(function () {
      /* 尺寸索引缺失时退化为无宽高信息，图片仍可正常加载 */
      var rec2 = { id: id, files: files, dims: [], shot: set.shot,
                   span: (set.dates || []).length, videos: set.videos || [] };
      DB.fileCache[id] = rec2;
      return rec2;
    });
  }

  /* ==================================================================
   * 4. 筛选 / 搜索
   * ================================================================== */

  function tagKeyToField() {
    /* 同一标签可能在多个维度出现。侧栏按维度分组选中；搜索/卡片点击的标签
     * 落到「它出现频次最高的维度」，保证同一标签只有一个入口。 */
    var map = {};
    Object.keys(DB.tagCounts).forEach(function (tag) {
      var best = 'others', bestN = -1;
      DIMS.forEach(function (d) {
        var n = DB.dimCounts[d.field][tag] || 0;
        if (n > bestN) { bestN = n; best = d.field; }
      });
      map[tag] = best;
    });
    return map;
  }
  var TAG_FIELD = null;

  function fieldOfTag(tag) {
    if (!TAG_FIELD) TAG_FIELD = tagKeyToField();
    return TAG_FIELD[tag] || 'others';
  }

  /** 标签在套图内的原始维度（用于卡片上的标签片归属） */
  function rawDimOfTag(set, tag) {
    var fields = ['works', 'roles', 'themes', 'others'];
    for (var i = 0; i < fields.length; i++) {
      var arr = set[fields[i]] || [];
      for (var j = 0; j < arr.length; j++) if (arr[j] === tag) return fields[i];
    }
    return fieldOfTag(tag);
  }

  /** 标签归一化后的规范名 */
  function canonTag(tag) {
    return DB.alias[normKey(tag)] || tag;
  }

  function hasTag(s, tag) {
    var k = key(tag);
    for (var i = 0; i < s.kTags.length; i++) if (s.kTags[i] === k) return true;
    return false;
  }

  /**
   * 维度内的标签匹配（UX 规范 §5.2）。
   * 规则：标签按身份匹配（同一字符串在库里可能被分类为不同维度），
   * 但要落在该维度或「未分类」桶内 —— `others` 是低置信度兜底桶，
   * §3.8 明确低置信度标签不显示类型图标，因此它对任何维度都可见。
   * 用户就地修正过的标签（§5.4）按修正后的维度匹配。
   */
  function matchDim(s, field, tags) {
    if (!tags.length) return true;
    for (var i = 0; i < tags.length; i++) {
      if (matchOneDim(s, field, tags[i])) return true;
    }
    return false;
  }

  function matchOneDim(s, field, tag) {
    var canon = canonTag(tag);
    var arr = s[field] || [];
    for (var i = 0; i < arr.length; i++) if (canonTag(arr[i]) === canon) return true;
    if (field !== 'others') {
      var o = s.others || [];
      for (var j = 0; j < o.length; j++) if (canonTag(o[j]) === canon) return true;
    }
    return false;
  }

  /** 某个标签在这套图里被归到哪个维度 */
  function dimOfTagInSet(set, tag) {
    var canon = canonTag(tag);
    var fields = ['works', 'roles', 'themes', 'others'];
    for (var i = 0; i < fields.length; i++) {
      var arr = set[fields[i]] || [];
      for (var j = 0; j < arr.length; j++) if (canonTag(arr[j]) === canon) return fields[i];
    }
    return fieldOfTag(canon);
  }

  /**
   * 搜索：多词 AND，单词内按权重排序（UX 规范 §5.1）
   * coser 前缀 100 > 标签精确 90 > coser 子串 70 > 标签前缀 60 > 目录名子串 30
   */
  function scoreWord(s, w) {
    var kw = key(w);
    if (!kw) return 0;
    var best = 0;
    if (s.kCoser && s.kCoser.indexOf(kw) === 0) best = 100;
    if (s.kCoser && s.kCoser.indexOf(kw) > 0 && best < 70) best = 70;
    for (var i = 0; i < s.kTags.length; i++) {
      var kt = s.kTags[i];
      if (kt === kw) { if (best < 90) best = 90; }
      else if (kt.indexOf(kw) === 0 && best < 60) best = 60;
    }
    if (!best && s.kRaw && s.kRaw.indexOf(kw) >= 0) best = 30;
    return best;
  }

  function matchSearch(s, words) {
    if (!words.length) return 0;
    var total = 0;
    for (var i = 0; i < words.length; i++) {
      var sc = scoreWord(s, words[i]);
      if (!sc) return 0;
      total += sc;
    }
    return total;
  }

  function currentFilterState() {
    return {
      q: state.q,
      coser: state.coser,
      tags: {
        works: state.tags.works.slice(),
        roles: state.tags.roles.slice(),
        themes: state.tags.themes.slice(),
        others: state.tags.others.slice()
      },
      mode: state.mode,
      sort: state.sort
    };
  }

  function hasAnyFilter(f) {
    if (f.q) return true;
    if (f.coser) return true;
    for (var i = 0; i < DIMS.length; i++) if (f.tags[DIMS[i].field].length) return true;
    return false;
  }

  function filterCount(f) {
    var n = f.q ? 1 : 0;
    if (f.coser) n++;
    DIMS.forEach(function (d) { n += f.tags[d.field].length; });
    return n;
  }

  /** 核心过滤：同维度 OR，跨维度 AND（默认）/ OR（mode=or） */
  function computeFiltered(f, useSearch) {
    var out = [];
    var words = (f.q || '').trim().split(/\s+/).filter(Boolean);
    var activeDims = DIMS.filter(function (d) { return f.tags[d.field].length > 0; });
    var scores = null;

    if (useSearch && words.length) {
      scores = new Map();
    }

    var pool = DB.active || DB.sets;
    for (var i = 0; i < pool.length; i++) {
      var s = pool[i];
      if (f.coser && s.coser !== f.coser) continue;

      var ok;
      if (!activeDims.length) ok = true;
      else if (state.mode === 'or') {
        ok = false;
        for (var d = 0; d < activeDims.length; d++) {
          if (matchDim(s, activeDims[d].field, f.tags[activeDims[d].field])) { ok = true; break; }
        }
      } else {
        ok = true;
        for (var d2 = 0; d2 < activeDims.length; d2++) {
          if (!matchDim(s, activeDims[d2].field, f.tags[activeDims[d2].field])) { ok = false; break; }
        }
      }
      if (!ok) continue;

      if (scores) {
        var sc = matchSearch(s, words);
        if (!sc) continue;
        scores.set(s.id, sc);
      }
      out.push(s);
    }
    return { list: out, scores: scores };
  }

  function sortSets(list, scores) {
    var arr = list.slice();
    var mode = state.sort;
    if (scores && scores.size) {
      arr.sort(function (a, b) {
        var d = scores.get(b.id) - scores.get(a.id);
        if (d) return d;
        return b.shotNum - a.shotNum;
      });
      return arr;
    }
    if (mode === 'count-desc') {
      arr.sort(function (a, b) { return b.n - a.n; });
    } else if (mode === 'coser-asc') {
      arr.sort(function (a, b) {
        var c = a.coser.localeCompare(b.coser, 'zh-Hans-CN');
        return c !== 0 ? c : (b.shotNum - a.shotNum);
      });
    } else if (mode === 'size-desc') {
      arr.sort(function (a, b) { return b.sizeBytes - a.sizeBytes; });
    } else {
      arr.sort(function (a, b) { return b.shotNum - a.shotNum; });
    }
    return arr;
  }

  /* ==================================================================
   * 5. URL 同步
   * ================================================================== */

  function buildHash() {
    var path = '#/';
    if (state.view === 'tags') path = '#/tags';
    else if (state.view === 'recent') path = '#/recent';
    else if (state.view === 'manga') path = '#/manga';
    else if (state.view === 'novel') path = '#/novel';
    else if (state.view === 'set') path = '#/set/' + state.setId;

    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.coser) params.set('c', state.coser);
    DIMS.forEach(function (d) {
      state.tags[d.field].forEach(function (t) { params.append(d.key, t); });
    });
    if (state.mode !== 'and') params.set('mode', state.mode);
    if (state.sort !== 'newest') params.set('sort', state.sort);

    var tagTotal = DIMS.reduce(function (n, d) { return n + state.tags[d.field].length; }, 0);
    var qs = params.toString();

    /* URL 长度保护：标签数 > 8 改用短 hash（UX 规范 §5.3） */
    if (tagTotal > 8 && qs) {
      var h = hashString(qs);
      try { sessionStorage.setItem(SS.filterHash, qs); } catch (e) {}
      params = new URLSearchParams();
      params.set('f', h);
    }

    /* 灯箱索引是 query 参数，不是独立路由（UX 规范 §1.4） */
    if (state.view === 'set' && state.lbIndex != null) params.set('i', String(state.lbIndex));

    var finalQs = params.toString();
    return path + (finalQs ? '?' + finalQs : '');
  }

  function hashString(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36);
  }

  function writeURL(push) {
    var h = buildHash();
    if (location.hash === h) return false;
    if (push) history.pushState(null, '', h);
    else history.replaceState(null, '', h);
    return true;
  }

  function readURL() {
    var raw = location.hash.replace(/^#/, '') || '/';
    var qi = raw.indexOf('?');
    var path = qi >= 0 ? raw.slice(0, qi) : raw;
    var qs = qi >= 0 ? raw.slice(qi + 1) : '';
    var params = new URLSearchParams(qs);

    var next = {
      view: 'grid', q: '', coser: '',
      tags: { works: [], roles: [], themes: [], others: [] },
      mode: params.get('mode') === 'or' ? 'or' : 'and',
      sort: params.get('sort') || 'newest',
      setId: null, lbIndex: null
    };

    if (path === '/tags') next.view = 'tags';
    else if (path === '/recent') next.view = 'recent';
    else if (path === '/manga') next.view = 'manga';
    else if (path === '/novel') next.view = 'novel';
    else if (path.indexOf('/set/') === 0) {
      next.view = 'set';
      next.setId = parseInt(path.slice(5), 10);
    }

    if (params.get('f')) {
      var saved = null;
      try { saved = sessionStorage.getItem(SS.filterHash); } catch (e) {}
      if (saved) {
        var sp = new URLSearchParams(saved);
        next.q = sp.get('q') || '';
        next.coser = sp.get('c') || '';
        if (sp.get('mode') === 'or') next.mode = 'or';
        if (sp.get('sort')) next.sort = sp.get('sort');
        DIMS.forEach(function (d) {
          sp.getAll(d.key).forEach(function (t) { next.tags[d.field].push(t); });
        });
      }
    } else {
      next.q = params.get('q') || '';
      next.coser = params.get('c') || '';
      DIMS.forEach(function (d) {
        params.getAll(d.key).forEach(function (t) { next.tags[d.field].push(t); });
      });
    }

    var i = params.get('i');
    if (i != null && !isNaN(parseInt(i, 10))) next.lbIndex = parseInt(i, 10);
    return next;
  }

  /* ==================================================================
   * 6. 虚拟滚动网格（L1-A）
   * ================================================================== */

  var grid = {
    scroller: null, spacer: null, inner: null,
    list: [], rowCount: 0, metrics: null,
    rendered: new Map(),     // rowIndex → element
    pool: [],
    poolCols: 0,             // 池内行是按几列建的（列数变则作废）
    focusIndex: -1,
    orderSig: ''
  };

  function computeMetrics() {
    var inner = grid.inner;
    var cs = getComputedStyle(inner);
    var padL = parseFloat(cs.paddingLeft) || 0;
    var padR = parseFloat(cs.paddingRight) || 0;
    var rawW = inner.clientWidth;
    if (!rawW && grid.metrics) return grid.metrics;   // 视图隐藏，保留上次度量

    /* 断点按视口宽度判定（视觉规范 §5.1：≥1440:6 · 1100:5 · 860:4 · 620:3 · 400:2 · <400:1） */
    var vw = window.innerWidth;
    var cols = 1;
    for (var i = 0; i < GRID.colSteps.length; i++) {
      if (vw >= GRID.colSteps[i].min) { cols = GRID.colSteps[i].n; break; }
    }

    var compact = state.density === 'compact';
    /* 全部从 CSS token 读取，保证 JS 度量与实际渲染同源（视觉规范 §6.3 卡片总高恒定） */
    var gapX = cssPx('--grid-gap-x', compact ? GRID.gapXCompact : GRID.gapX);
    var gapY = cssPx('--grid-gap-y', compact ? GRID.gapYCompact : GRID.gapY);
    var infoH = cssPx('--card-info-h', 88);

    var containerW = Math.min(rawW, GRID.maxContainer);
    var contentW = containerW - padL - padR;
    var colW = (contentW - gapX * (cols - 1)) / cols;
    var coverH = Math.round((colW - 2) * (4 / 3));      // 卡片左右各 1px 边框
    var cardH = coverH + infoH + 2;
    var rowStride = cardH + gapY;

    return { cols: cols, colW: colW, coverH: coverH, cardH: cardH, rowStride: rowStride, gapX: gapX, gapY: gapY };
  }

  function rowElsFor(i) {
    var m = grid.metrics;
    var start = i * m.cols;
    var end = Math.min(start + m.cols, grid.list.length);
    var out = [];
    for (var k = start; k < end; k++) out.push(grid.list[k]);
    return out;
  }

  function fillCard(card, set) {
    var cover = $('.card-cover', card);
    var lqip = $('.lqip', card);
    var thumb = $('.thumb', card);
    var meta = DB.thumbMeta[String(set.id)];

    cover.style.backgroundColor = (meta && meta.c) || '#16171B';
    cover.setAttribute('data-sensitive', set.isNSFW && state.nsfwBlur ? '1' : '0');
    $('.sensitive-veil', cover).hidden = !(set.isNSFW && state.nsfwBlur);
    $('.sensitive-hint', cover).hidden = !(set.isNSFW && state.nsfwBlur);

    if (lqip.dataset.src !== set.lqipUrl) {
      lqip.dataset.src = set.lqipUrl;
      lqip.classList.remove('is-loaded');
      lqip.onload = function () { lqip.classList.add('is-loaded'); };
      lqip.onerror = function () { lqip.classList.add('is-loaded'); };
      lqip.src = set.lqipUrl;
    }

    if (thumb.dataset.src !== set.thumbUrl) {
      thumb.dataset.src = set.thumbUrl;
      thumb.classList.remove('is-loaded');
      thumb.onload = function () { thumb.classList.add('is-loaded'); };
      thumb.onerror = function () { thumb.classList.add('is-loaded'); };
      /* 高分屏才加载 2x：用 devicePixelRatio 判断比 srcset 更可控
         （srcset 不配 sizes 会按 100vw 估需求，桌面大屏反而会选 2x） */
      var hiDPR = window.devicePixelRatio > 1.5;
      thumb.src = (hiDPR && set.thumb2xUrl) ? set.thumb2xUrl : set.thumbUrl;
    }

    var coserEl = $('.coser-pill', card);
    coserEl.textContent = set.coser || '未署名';
    coserEl.title = set.co && set.co.length ? set.coser + ' / ' + set.co.join(' / ') : set.coser;

    var titleEl = $('.card-title', card);
    titleEl.textContent = set.displayTitle;
    titleEl.classList.toggle('is-empty', !set.title && !set.primaryTag);

    var row2 = $('.card-row2', card);
    row2.textContent = '';
    // 档案章：实测张数为准（目录名声明值常与实际不符，实测 95.5% 的卡片偏大）
    row2.appendChild(el('span', 'stamp', set.n + ' 张'));
    if (set.vn) row2.appendChild(el('span', 'stamp', set.vn + ' 视频'));
    if (set.size) row2.appendChild(el('span', 'stamp', set.size));
    if (set.shotLabel) row2.appendChild(el('span', 'stamp stamp-plain', set.shotLabel));
    // 声明张数与实测不一致时给出对照，避免用户以为数据缺失
    if (set.pages && set.claimedPages && set.claimedPages !== set.n) {
      var claim = el('span', 'stamp stamp-plain', '标称 ' + set.claimedPages);
      claim.title = '目录名标注 ' + set.pages + '，实际 ' + set.n + ' 张';
      row2.appendChild(claim);
    }
    if (!row2.childNodes.length) row2.appendChild(el('span', 'stamp stamp-plain', set.n + ' 张'));

    var row3 = $('.card-row3', card);
    row3.textContent = '';
    var sub = set.subtitle;

    if (sub.kind === 'tags') {
      /* A 级：有内容标签 → 最多 3 个，超出 +N */
      var chips = chipListFor(set);
      for (var i = 0; i < Math.min(3, chips.length); i++) {
        row3.appendChild(makeTagChip(chips[i], set));
      }
      if (chips.length > 3) {
        var more = el('button', 'tag-chip-more', '+' + (chips.length - 3));
        more.type = 'button';
        more.title = chips.slice(3).join(' / ');
        more.setAttribute('aria-label', '还有 ' + (chips.length - 3) + ' 个标签');
        more.addEventListener('click', function (e) {
          e.stopPropagation();
          toast('其余标签：' + chips.slice(3).join(' · '));
        });
        row3.appendChild(more);
      }
    } else if (sub.kind === 'others') {
      /* B 级：仅 others → 前 2 个 + 「未分类」虚线胶囊 */
      var others = (set.others || []).slice(0, 2);
      others.forEach(function (t) { row3.appendChild(makeTagChip(t, set)); });
      var oc = el('span', 'tag-chip tag-chip-others', '未分类');
      oc.title = '该套图只有未分类标签，共 ' + (set.others || []).length + ' 个';
      row3.appendChild(oc);
    } else {
      /* C 级：完全无标签 → 原始目录名（等宽次级色，单行 ellipsis）
         留空会让 30% 的卡片看起来像「加载失败」 */
      var raw = el('span', 'card-rawname', sub.text);
      raw.title = sub.full || sub.text;
      row3.appendChild(raw);
    }

    card.dataset.id = set.id;
    card.setAttribute('role', 'gridcell');
    card.setAttribute('tabindex', '-1');
    card.setAttribute('aria-label', ariaLabelFor(set));
    card.dataset.selected = state.selected[set.id] ? '1' : '0';

    var favBtn = $('[data-act="fav"]', card);
    favBtn.setAttribute('aria-pressed', isFav(set.id) ? 'true' : 'false');
  }

  function ariaLabelFor(set) {
    var parts = [set.coser || '未署名', set.displayTitle];
    if (set.n) parts.push(set.n + ' 张');
    if (set.shotLabel) parts.push(set.shotLabel);
    return parts.join(' · ');
  }

  /** 卡片的标签片顺序：作品 → 角色 → 主题 → 未分类 */
  function chipListFor(set) {
    var out = [];
    ['works', 'roles', 'themes', 'others'].forEach(function (f) {
      (set[f] || []).forEach(function (t) { if (out.indexOf(t) < 0) out.push(t); });
    });
    /* 标题降级用了主标签时，标签行不再重复它 */
    if (set.titleFromTag && out.length) out.shift();
    return out;
  }

  function makeTagChip(tag, set) {
    var field = set ? dimOfTagInSet(set, tag) : fieldOfTag(tag);
    var chip = el('button', 'tag-chip', tag);
    chip.type = 'button';
    chip.dataset.dim = field;
    chip.dataset.tag = tag;
    chip.setAttribute('aria-pressed', isTagSelected(tag) ? 'true' : 'false');
    if (isTagSelected(tag)) chip.classList.add('is-active');
    chip.title = tag + '（' + dimLabel(field) + '）';
    chip.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleTag(tag, field);
    });
    /* 右键（或长按）打开「修正标签类型」菜单 —— UX 规范 §5.4 */
    chip.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openTagTypeMenu(tag, field, chip);
    });
    return chip;
  }

  function dimLabel(field) {
    for (var i = 0; i < DIMS.length; i++) if (DIMS[i].field === field) return DIMS[i].label;
    return '未分类';
  }

  /** 标签类型就地修正菜单（UX 规范 §5.4） */
  function openTagTypeMenu(tag, currentField, anchor) {
    closeTagTypeMenu();
    var menu = el('div', 'tag-type-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '修正「' + tag + '」的类型');
    menu.appendChild(el('div', 'tag-type-title', '把「' + tag + '」归到：'));

    DIMS.forEach(function (d) {
      var b = el('button', 'tag-type-item' + (d.field === currentField ? ' is-current' : ''));
      b.type = 'button';
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', d.field === currentField ? 'true' : 'false');
      b.textContent = d.label;
      b.addEventListener('click', function () {
        applyTagTypeOverride(tag, d.field);
        closeTagTypeMenu();
      });
      menu.appendChild(b);
    });

    var reset = el('button', 'tag-type-item tag-type-reset');
    reset.type = 'button';
    reset.setAttribute('role', 'menuitem');
    reset.textContent = '恢复默认分类';
    reset.addEventListener('click', function () {
      var ov = loadOverrides();
      delete ov[normKey(tag)];
      saveOverrides();
      closeTagTypeMenu();
      toast('已恢复「' + tag + '」的默认分类');
      rebuildIndex();
    });
    menu.appendChild(reset);

    document.body.appendChild(menu);
    var r = anchor.getBoundingClientRect();
    var mw = menu.offsetWidth, mh = menu.offsetHeight;
    var left = Math.min(r.left, window.innerWidth - mw - 12);
    var top = r.bottom + 6;
    if (top + mh > window.innerHeight - 12) top = Math.max(12, r.top - mh - 6);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.hidden = false;

    tagTypeMenu = menu;
    setTimeout(function () {
      document.addEventListener('click', onDocClickCloseMenu, true);
      document.addEventListener('keydown', onMenuKey, true);
    }, 0);
  }

  var tagTypeMenu = null;

  function closeTagTypeMenu() {
    if (!tagTypeMenu) return;
    tagTypeMenu.remove();
    tagTypeMenu = null;
    document.removeEventListener('click', onDocClickCloseMenu, true);
    document.removeEventListener('keydown', onMenuKey, true);
  }

  function onDocClickCloseMenu(e) {
    if (tagTypeMenu && !tagTypeMenu.contains(e.target)) closeTagTypeMenu();
  }

  function onMenuKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeTagTypeMenu(); }
  }

  /** 应用标签类型修正并重建索引 */
  function applyTagTypeOverride(tag, dim) {
    var ov = loadOverrides();
    ov[normKey(tag)] = { dim: dim, name: tag, at: new Date().toISOString() };
    saveOverrides();
    toast('「' + tag + '」已归到「' + dimLabel(dim) + '」');
    rebuildIndex();
  }

  /** 标签类型修正后需要重算分面计数与筛选结果 */
  function rebuildIndex() {
    var keepQ = state.q, keepCoser = state.coser;
    var keepTags = state.tags;
    DB.tagCounts = {};
    DB.dimCounts = { works: {}, roles: {}, themes: {}, others: {} };
    DB.tagSets = {};
    DB.tagMeta = {};
    TAG_FIELD = null;

    DB.sets.forEach(function (s) {
      DIMS.forEach(function (d) {
        (s[d.field] || []).forEach(function (t) {
          var canon = canonTag(t);
          var dim = effectiveDim(canon) || d.field;
          DB.tagCounts[canon] = (DB.tagCounts[canon] || 0) + 1;
          DB.dimCounts[dim][canon] = (DB.dimCounts[dim][canon] || 0) + 1;
          (DB.tagSets[canon] = DB.tagSets[canon] || []).push(s.id);
          var meta = DB.tagMeta[canon] || (DB.tagMeta[canon] = { dims: {}, sets: [] });
          meta.dims[dim] = (meta.dims[dim] || 0) + 1;
          if (meta.sets.indexOf(s.id) < 0) meta.sets.push(s.id);
        });
      });
    });

    state.q = keepQ; state.coser = keepCoser; state.tags = keepTags;
    refreshAll();
  }

  /**
   * 建一行。槽位数 = 当前列数（不再固定 6 个），
   * 否则手机 2 列时每行 4 个空槽，既浪费 DOM 又让「列数」类断言失真。
   */
  function makeRow(cols) {
    var n = cols || (grid.metrics && grid.metrics.cols) || 6;
    var row = el('div', 'grid-row');
    row.setAttribute('role', 'row');
    row.dataset.cols = String(n);
    var tpl = $('#tpl-card');
    for (var i = 0; i < n; i++) {
      var card = tpl.content.firstElementChild.cloneNode(true);
      card.setAttribute('role', 'gridcell');
      card.addEventListener('click', function (e) {
        var id = parseInt(this.dataset.id, 10);
        if (!isNaN(id)) openSet(id, e.target.closest('[data-act="fav"]') ? 'fav' : 'open');
      });
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); openSet(parseInt(this.dataset.id, 10), 'open'); }
        else if (e.key === ' ') { e.preventDefault(); toggleSelect(parseInt(this.dataset.id, 10)); }
      });
      row.appendChild(card);
    }
    return row;
  }

  function syncGridDOM() {
    var scroller = grid.scroller;
    var m = grid.metrics;
    var top = scroller.scrollTop;
    var vh = scroller.clientHeight;
    var buf = GRID.bufferRows * m.rowStride;

    var first = Math.max(0, Math.floor((top - buf) / m.rowStride));
    var last = Math.min(grid.rowCount - 1, Math.floor((top + vh + buf) / m.rowStride));
    if (grid.rowCount === 0) { first = 0; last = -1; }

    /* 回收越界的行 */
    grid.rendered.forEach(function (node, idx) {
      if (idx < first || idx > last) {
        node.remove();
        grid.rendered.delete(idx);
        grid.pool.push(node);
      }
    });

    /* 补齐需要的行 */
    for (var i = first; i <= last; i++) {
      var row = grid.rendered.get(i);
      if (!row) {
        row = grid.pool.pop() || makeRow(m.cols);
        /* 池里可能是旧列数建的行（视口刚变过）→ 槽位数不符就丢弃重建 */
        if (row.dataset.cols !== String(m.cols)) {
          row.remove();
          row = makeRow(m.cols);
        }
        var sets = rowElsFor(i);
        var cards = row.children;
        for (var c = 0; c < cards.length; c++) {
          if (c < sets.length) {
            cards[c].hidden = false;
            fillCard(cards[c], sets[c]);
          } else {
            cards[c].hidden = true;
            cards[c].removeAttribute('data-id');
          }
        }
        grid.spacer.appendChild(row);
        grid.rendered.set(i, row);
      }
      /* 视口变化后列数与行高会变 → 每行都要重设几何 */
      row.style.top = (i * m.rowStride) + 'px';
      row.style.gridTemplateColumns = 'repeat(' + m.cols + ', minmax(0, 1fr))';
    }

    /* DOM 顺序 = 视觉顺序（无障碍 §7.3）：只在行集合变化时重排 */
    var order = Array.from(grid.rendered.keys()).sort(function (a, b) { return a - b; });
    var sig = order.join(',');
    if (sig !== grid.orderSig) {
      grid.orderSig = sig;
      var frag = document.createDocumentFragment();
      for (var k = 0; k < order.length; k++) frag.appendChild(grid.rendered.get(order[k]));
      grid.spacer.appendChild(frag);
    }
  }

  function renderGrid(resetScroll) {
    var f = currentFilterState();
    var t0 = performance.now();
    var res = computeFiltered(f, true);
    var list = sortSets(res.list, res.scores);
    perf.mark('filter');

    grid.list = list;
    grid.metrics = computeMetrics();
    grid.rowCount = Math.ceil(list.length / grid.metrics.cols);
    grid.spacer.style.height = (Math.max(0, grid.rowCount) * grid.metrics.rowStride) + 'px';
    grid.spacer.setAttribute('role', 'grid');
    grid.spacer.setAttribute('aria-rowcount', String(grid.rowCount));
    grid.spacer.setAttribute('aria-colcount', String(grid.metrics.cols));

    if (resetScroll) grid.scroller.scrollTop = 0;
    /* 列数变了的话，旧行槽位数不再匹配 → 池整体作废，避免复用出错行 */
    var reusePool = grid.poolCols === grid.metrics.cols;
    grid.rendered.forEach(function (n) {
      n.remove();
      if (reusePool) grid.pool.push(n);
    });
    if (!reusePool) grid.pool.length = 0;
    grid.poolCols = grid.metrics.cols;
    grid.rendered.clear();
    grid.orderSig = '';

    /* 空结果 → 渲染放宽建议，而不是空白页 */
    if (!list.length) {
      grid.spacer.style.height = '0px';
      var empty = renderGridEmptyState(f);
      grid.spacer.appendChild(empty);
      grid.spacer.setAttribute('role', 'grid');
      grid.spacer.setAttribute('aria-rowcount', '0');
      grid.spacer.setAttribute('aria-colcount', String(grid.metrics.cols));
      var cnt0 = $('#grid-count');
      cnt0.textContent = '0 套图';
      if (state.view !== 'manga') $('#nav-count-all').textContent = fmtInt(list.length);
      perf.mark('gridRender');
      perf.filterMs = Math.round(performance.now() - t0);
      return list;
    }

    syncGridDOM();

    var cnt = $('#grid-count');
    cnt.textContent = fmtInt(list.length) + (state.view === 'manga' ? ' 个漫画合集' : ' 套图');
    /* 漫画视图下不能覆盖侧栏「全部套图」的写真总数，否则会显示成 10 */
    if (state.view !== 'manga') $('#nav-count-all').textContent = fmtInt(list.length);
    perf.mark('gridRender');
    perf.filterMs = Math.round(performance.now() - t0);
    return list;
  }

  function setActiveCard(id) {
    var card = grid.spacer.querySelector('.card[data-id="' + id + '"]');
    if (card) { card.focus({ preventScroll: true }); return; }
    var idx = grid.list.findIndex(function (s) { return s.id === id; });
    if (idx < 0) return;
    var m = grid.metrics;
    var row = Math.floor(idx / m.cols);
    grid.scroller.scrollTop = Math.max(0, row * m.rowStride - m.rowStride);
    requestAnimationFrame(function () {
      syncGridDOM();
      var c = grid.spacer.querySelector('.card[data-id="' + id + '"]');
      if (c) c.focus({ preventScroll: true });
    });
  }

  /* ==================================================================
   * 7. 侧栏
   * ================================================================== */

  function renderSidebarCounts() {
    $('#nav-count-all').textContent = fmtInt(DB.sets.length);
    /* 有漫画数据才露出「漫画」导航项，避免空入口 */
    var mn = DB.mangaSets.length;
    var nm = document.getElementById('nav-manga');
    if (nm) nm.hidden = mn === 0;
    var mcnt = document.getElementById('nav-count-manga');
    if (mcnt) mcnt.textContent = fmtInt(mn);
    $('#nav-count-tags').textContent = fmtInt(Object.keys(DB.tagCounts).length);
    var withShot = DB.sets.filter(function (s) { return s.shot; }).length;
    $('#nav-count-recent').textContent = fmtInt(withShot);
    $('#brand-sub').textContent = fmtInt(DB.sets.length) + ' 套 · ' + fmtInt(Object.keys(DB.tagCounts).length) + ' 标签';
  }

  function renderCoserList(filterText) {
    var host = $('#coser-list');
    host.textContent = '';
    var q = key(filterText || '');
    var entries = Object.keys(DB.coserCounts).filter(function (c) {
      return !q || key(c).indexOf(q) >= 0;
    });
    entries.sort(function (a, b) { return DB.coserCounts[b] - DB.coserCounts[a]; });
    var limit = state.coserExpanded ? entries.length : 40;
    entries = entries.slice(0, limit);

    entries.forEach(function (c) {
      var b = el('button', 'facet-row');
      b.type = 'button';
      b.setAttribute('aria-pressed', state.coser === c ? 'true' : 'false');
      var nm = el('span', 'facet-name', c);
      nm.title = c;
      b.appendChild(nm);
      b.appendChild(el('span', 'facet-n', fmtInt(DB.coserCounts[c])));
      b.addEventListener('click', function () {
        state.coser = (state.coser === c) ? '' : c;
        refreshAll();
      });
      host.appendChild(b);
    });

    if (entries.length === 0) {
      host.appendChild(el('p', 'applied-empty', '没有匹配的 coser'));
    }
    if (!state.coserExpanded && Object.keys(DB.coserCounts).length > 40) {
      var more = el('button', 'facet-row');
      more.type = 'button';
      more.appendChild(el('span', 'facet-name', '展开全部 ' + fmtInt(Object.keys(DB.coserCounts).length) + ' 位'));
      more.addEventListener('click', function () { state.coserExpanded = true; renderCoserList($('#coser-filter-input').value); });
      host.appendChild(more);
    }
  }

  /**
   * 标签区三层结构（UX 规范 §5.6）。
   * 实测频次分布很反直觉：81.8% 的标签只出现 2–4 次，不是「只出现 1 次」。
   * 因此不做平铺：
   *   热门层  freq ≥ 20  → 全部显式列出，不折叠
   *   次热门  freq 5–19  → 默认折叠，展开后按字首分组
   *   中间层  freq 2–4   → 不平铺，只能通过顶部标签搜索到达
   *   超长尾  freq 1     → 同上
   */
  var TAG_TIERS = [
    { id: 'hot',  min: 20, label: '热门' },
    { id: 'warm', min: 5,  label: '次热门' },
    { id: 'mid',  min: 2,  label: '中间层' },
    { id: 'tail', min: 0,  label: '超长尾' }
  ];

  function tierOf(freq) {
    if (freq >= 20) return 'hot';
    if (freq >= 5) return 'warm';
    if (freq >= 2) return 'mid';
    return 'tail';
  }

  /** 按字首分组（中文取首字，拉丁取首字母大写） */
  function groupByInitial(names) {
    var groups = {};
    names.forEach(function (n) {
      var ch = (n || '').charAt(0);
      var g = /[a-zA-Z]/.test(ch) ? ch.toUpperCase() : (ch || '#');
      (groups[g] = groups[g] || []).push(n);
    });
    return Object.keys(groups).sort().map(function (g) {
      return { initial: g, names: groups[g] };
    });
  }

  function makeTagPill(tag, count, dim) {
    var b = el('button', 'tag-pill');
    b.type = 'button';
    b.setAttribute('aria-pressed', isTagSelected(tag) ? 'true' : 'false');
    if (isTagSelected(tag)) b.classList.add('is-active');
    var nm = el('span', 'pill-name', tag);
    nm.title = tag;
    b.appendChild(nm);
    b.appendChild(el('span', 'pill-n', fmtInt(count)));
    b.addEventListener('click', function () { toggleTag(tag, dim); });
    return b;
  }

  /**
   * 渲染某维度的标签云（热门 + 次热门两层）。
   * 中间层与超长尾不平铺，只在标签搜索框里可达。
   */
  function renderTagCloud(field) {
    var host = $('#cloud-' + field);
    var counts = DB.dimCounts[field];
    var names = Object.keys(counts);
    names.sort(function (a, b) { return counts[b] - counts[a]; });

    var hot = [], warm = [], mid = 0, tail = 0;
    names.forEach(function (t) {
      var f = counts[t];
      if (f >= 20) hot.push(t);
      else if (f >= 5) warm.push(t);
      else if (f >= 2) mid++;
      else tail++;
    });

    host.textContent = '';

    /* 热门层：全部显式列出 */
    if (hot.length) {
      var hotSec = el('div', 'tier-sec');
      hotSec.appendChild(el('div', 'tier-head', '热门 · ' + hot.length + ' 个'));
      var hotCloud = el('div', 'tagcloud');
      hot.forEach(function (t) { hotCloud.appendChild(makeTagPill(t, counts[t], field)); });
      hotSec.appendChild(hotCloud);
      host.appendChild(hotSec);
    }

    /* 次热门层：默认折叠，展开后按字首分组 */
    if (warm.length) {
      var warmSec = el('div', 'tier-sec');
      var warmHead = el('button', 'tier-head tier-toggle');
      warmHead.type = 'button';
      warmHead.setAttribute('aria-expanded', 'false');
      warmHead.appendChild(el('span', null, '次热门 · ' + warm.length + ' 个'));
      warmHead.appendChild(el('span', 'tier-caret', '▸'));
      warmSec.appendChild(warmHead);

      var warmBody = el('div', 'tier-body');
      warmBody.hidden = true;
      groupByInitial(warm).forEach(function (g) {
        var grp = el('div', 'tier-group');
        grp.appendChild(el('div', 'tier-initial', g.initial));
        var gc = el('div', 'tagcloud');
        g.names.forEach(function (t) { gc.appendChild(makeTagPill(t, counts[t], field)); });
        grp.appendChild(gc);
        warmBody.appendChild(grp);
      });
      warmSec.appendChild(warmBody);
      warmHead.addEventListener('click', function () {
        var open = warmBody.hidden;
        if (open) warmBody.removeAttribute('hidden'); else warmBody.setAttribute('hidden', '');
        warmHead.setAttribute('aria-expanded', open ? 'true' : 'false');
        $('.tier-caret', warmHead).textContent = open ? '▾' : '▸';
      });
      host.appendChild(warmSec);
    }

    /* 中间层 + 超长尾：不平铺，提示只能搜索到达 */
    var hidden = mid + tail;
    if (hidden) {
      var note = el('div', 'tier-note',
        '另有 ' + fmtInt(mid) + ' 个标签（2–4 次）与 ' + fmtInt(tail) + ' 个（1 次）不在此列出，用上方「标签搜索」可达');
      host.appendChild(note);
    }

    var c = document.querySelector('[data-facet-count="' + field + '"]');
    if (c) c.textContent = fmtInt(names.length);
  }

  /** 未分类桶：与其它维度同一套三层结构。
   *  注意「未分类」桶默认**展开**（UX 规范 §3.8 / §5.6）：
   *  覆盖 2376 套图 = 44.9%，折叠等于近半数据不可达。
   *  桶内 2842 个标签里 2450 个只出现 1 次，因此不做平铺，
   *  只显式列出热门 + 次热门两层，其余靠标签搜索到达。 */
  function renderOthersCloud() {
    renderTagCloud('others');
  }

  /** 标签全局搜索：覆盖全部维度 + 中间层 + 超长尾 */
  function renderTagSearch(q) {
    var host = $('#tag-search-results');
    host.textContent = '';
    var kw = key(q || '');
    if (!kw) { host.removeAttribute('data-open'); return; }

    var hits = [];
    Object.keys(DB.tagCounts).forEach(function (t) {
      var k = key(t);
      var idx = k.indexOf(kw);
      if (idx < 0) return;
      var dim = effectiveDim(t) || fieldOfTag(t);
      hits.push({
        tag: t, count: DB.tagCounts[t], dim: dim,
        score: (idx === 0 ? 1000 : 500) + DB.tagCounts[t]
      });
    });
    hits.sort(function (a, b) { return b.score - a.score; });
    hits = hits.slice(0, 40);

    if (!hits.length) {
      host.appendChild(el('div', 'tier-note', '没有匹配的标签'));
      return;
    }
    hits.forEach(function (h) {
      var b = el('button', 'tag-pill');
      b.type = 'button';
      b.setAttribute('aria-pressed', isTagSelected(h.tag) ? 'true' : 'false');
      if (isTagSelected(h.tag)) b.classList.add('is-active');
      var nm = el('span', 'pill-name', h.tag);
      nm.title = h.tag + '（' + dimLabel(h.dim) + '）';
      b.appendChild(nm);
      b.appendChild(el('span', 'pill-n', fmtInt(h.count)));
      b.addEventListener('click', function () { toggleTag(h.tag, h.dim); });
      host.appendChild(b);
    });
    if (hits.length === 40) {
      host.appendChild(el('div', 'tier-note', '仅显示前 40 个，继续输入以缩小范围'));
    }
    host.setAttribute('data-open', '1');
  }

  function renderApplied() {
    var host = $('#applied-list');
    host.textContent = '';
    var n = 0;

    if (state.q) {
      host.appendChild(makeChip('搜索', state.q, 'search', function () {
        state.q = ''; $('#search-input').value = ''; refreshAll();
      }));
      n++;
    }
    if (state.coser) {
      host.appendChild(makeChip('coser', state.coser, 'coser', function () {
        state.coser = ''; refreshAll();
      }));
      n++;
    }
    DIMS.forEach(function (d) {
      state.tags[d.field].forEach(function (t) {
        host.appendChild(makeChip(d.label, t, '', function () {
          toggleTag(t, d.field);
        }));
        n++;
      });
    });

    $('#applied-n').textContent = n ? n + ' 项' : '';
    $('#applied-empty').hidden = n > 0;
    $('#clear-all').hidden = n === 0;
    var ovN = Object.keys(loadOverrides()).length;
    var ovCount = $('#override-count');
    if (ovCount) ovCount.textContent = ovN ? String(ovN) : '';
    $('#override-export').title = ovN
      ? ovN + ' 条标签类型修正已保存到 localStorage，点击导出为 library-overrides.json'
      : '暂无标签类型修正。右键卡片上的标签片可修正其分类';

    var modeBtn = $('#mode-and');
    if (modeBtn) modeBtn.setAttribute('aria-pressed', state.mode === 'and' ? 'true' : 'false');
    var modeBtn2 = $('#mode-or');
    if (modeBtn2) modeBtn2.setAttribute('aria-pressed', state.mode === 'or' ? 'true' : 'false');
  }

  function makeChip(dimLabel, text, kind, onRemove) {
    var c = el('span', 'chip' + (kind ? ' chip-' + kind : ''));
    c.appendChild(el('span', 'chip-label', (dimLabel && dimLabel !== '搜索' ? dimLabel + '：' : '') + text));
    var x = el('button', 'chip-x');
    x.type = 'button';
    x.setAttribute('aria-label', '移除筛选 ' + text);
    x.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    x.addEventListener('click', onRemove);
    c.appendChild(x);
    return c;
  }

  function isTagSelected(tag) {
    for (var i = 0; i < DIMS.length; i++) {
      if (state.tags[DIMS[i].field].indexOf(tag) >= 0) return true;
    }
    return false;
  }

  function toggleTag(tag, field) {
    var f = field || fieldOfTag(tag);
    /* 一个标签只允许存在于一个维度里，避免同标签跨维度重复计入 AND */
    DIMS.forEach(function (d) {
      var arr = state.tags[d.field];
      var i = arr.indexOf(tag);
      if (i >= 0 && d.field !== f) arr.splice(i, 1);
    });
    var arr = state.tags[f];
    var i = arr.indexOf(tag);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(tag);
    if (state.view !== 'grid') state.view = 'grid';
    refreshAll();
  }

  function refreshAll() {
    renderCoserList($('#coser-filter-input').value);
    DIMS.forEach(function (d) {
      if (d.field === 'others') renderOthersCloud(); else renderTagCloud(d.field);
    });
    renderApplied();
    /* 漫画视图复用 grid 的渲染流程，只换了 DB.active 指向的数据源 */
    if (state.view === 'grid' || state.view === 'manga') renderGrid(true);
    writeURL(false);
  }

  /* ==================================================================
   * 8. L1-B 标签浏览
   * ================================================================== */

  var tagPage = { dim: 'roles', list: [], limit: 120 };

  function renderTagPage() {
    var dimsHost = $('#tag-dims');
    dimsHost.textContent = '';
    var dims = [
      { id: 'works', label: '作品', field: 'works' },
      { id: 'roles', label: '角色', field: 'roles' },
      { id: 'themes', label: '主题', field: 'themes' },
      { id: 'others', label: '未分类', field: 'others' },
      { id: 'coser', label: 'coser', field: null }
    ];
    dims.forEach(function (d) {
      var b = el('button', 'dim-btn', d.label);
      b.type = 'button';
      b.setAttribute('aria-pressed', tagPage.dim === d.id ? 'true' : 'false');
      b.addEventListener('click', function () {
        tagPage.dim = d.id;
        tagPage.limit = 120;
        try { sessionStorage.setItem(SS.tagDim, d.id); } catch (e) {}
        renderTagPage();
      });
      dimsHost.appendChild(b);
    });

    var listHost = $('#tag-list');
    listHost.textContent = '';

    var entries;
    if (tagPage.dim === 'coser') {
      entries = Object.keys(DB.coserCounts).map(function (c) { return { name: c, count: DB.coserCounts[c], sets: DB.coserSets[c] || [] }; });
      entries.sort(function (a, b) { return b.count - a.count; });
    } else {
      var counts = DB.dimCounts[tagPage.dim];
      entries = Object.keys(counts).map(function (t) { return { name: t, count: counts[t], sets: DB.tagSets[t] || [] }; });
      entries.sort(function (a, b) { return b.count - a.count; });
    }

    tagPage.list = entries;
    var shown = entries.slice(0, tagPage.limit);
    shown.forEach(function (e) {
      var row = el('button', 'tag-row');
      row.type = 'button';
      var main = el('div', 'tag-row-main');
      main.appendChild(el('div', 'tag-row-name', e.name));
      main.appendChild(el('div', 'tag-row-meta', fmtInt(e.count) + ' 套图'));
      row.appendChild(main);

      var strip = el('div', 'tag-strip');
      e.sets.slice(0, 3).forEach(function (sid) {
        var s = DB.byId[sid];
        if (!s || !s.thumbUrl) return;
        var img = el('img');
        img.src = s.thumbUrl;
        img.alt = '';
        img.loading = 'lazy';
        img.width = 40; img.height = 52;
        strip.appendChild(img);
      });
      row.appendChild(strip);

      row.addEventListener('click', function () {
        /* 标签页不新建结果页 → 跳到全部套图并把标签作为已应用筛选 chips */
        try {
          sessionStorage.setItem(SS.tagScroll, String(window.scrollY));
          sessionStorage.setItem(SS.tagDim, tagPage.dim);
        } catch (e) {}
        if (tagPage.dim === 'coser') {
          state.coser = e.name;
          DIMS.forEach(function (d) { state.tags[d.field] = []; });
        } else {
          DIMS.forEach(function (d) { state.tags[d.field] = []; });
          state.tags[tagPage.dim] = [e.name];
          state.coser = '';
        }
        state.view = 'grid';
        state.q = '';
        $('#search-input').value = '';
        switchView('grid');
        refreshAll();
        writeURL(true);
      });
      listHost.appendChild(row);
    });

    $('#tags-count').textContent = fmtInt(entries.length) + ' 个' +
      (tagPage.dim === 'coser' ? ' coser' : '标签');

    if (entries.length > tagPage.limit) {
      var more = el('button', 'btn btn-secondary');
      more.type = 'button';
      more.textContent = '加载更多（还有 ' + fmtInt(entries.length - tagPage.limit) + '）';
      more.style.gridColumn = '1 / -1';
      more.addEventListener('click', function () {
        tagPage.limit += 120;
        renderTagPage();
      });
      listHost.appendChild(more);
    }
  }

  /* ==================================================================
   * 9. L1-C 最近新增
   * ================================================================== */

  /** YYYYMMDD → Date（UTC，避免时区偏移） */
  function ymdToDate(ymd) {
    var y = parseInt(ymd.slice(0, 4), 10);
    var m = parseInt(ymd.slice(4, 6), 10);
    var d = parseInt(ymd.slice(6, 8), 10);
    return Date.UTC(y, m - 1, d);
  }

  /** Date → YYYYMMDD */
  function dateToYmd(ts) {
    var dt = new Date(ts);
    var m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    var d = String(dt.getUTCDate()).padStart(2, '0');
    return String(dt.getUTCFullYear()) + m + d;
  }

  function renderRecentPage() {
    var host = $('#recent-page');
    host.textContent = '';
    var withShot = DB.sets.filter(function (s) { return s.shot; });
    if (!withShot.length) {
      host.appendChild(emptyState('尚未建立索引', '没有可用的拍摄日期', '扫描目录'));
      return;
    }
    /* 全库最新拍摄日（YYYYMMDD 字符串） */
    var maxYmd = withShot.reduce(function (m, s) { return s.shot > m ? s.shot : m; }, '00000000');
    /* 时间线默认窗口 = 最近 N 天（按真实日历天，不是 YYYYMMDD 数字减法） */
    var cutoffTs = ymdToDate(maxYmd) - (state.recentDays - 1) * 86400000;
    var cutoff = dateToYmd(cutoffTs);
    var inWindow = withShot.filter(function (s) { return s.shot >= cutoff; })
      .sort(function (a, b) { return b.shotNum - a.shotNum; });

    /* 按日期分组 */
    var groups = [];
    var last = null;
    inWindow.forEach(function (s) {
      if (!last || last.date !== s.shot) {
        last = { date: s.shot, label: s.shotLabel, sets: [] };
        groups.push(last);
      }
      last.sets.push(s);
    });

    groups.forEach(function (g) {
      var sec = el('section', 'timeline-group');
      var head = el('div', 'timeline-head');
      head.appendChild(el('h2', null, relativeLabel(g.label, maxYmd)));
      head.appendChild(el('span', 'timeline-n', '共 ' + g.sets.length + ' 套 · ' + g.label));
      sec.appendChild(head);

      var cards = el('div', 'timeline-cards');
      /* 每组只先渲染前 N 张，其余按「加载更多」增量追加 —— 时间线不能一次进 5283 张卡 */
      var shown = Math.min(g.sets.length, 12);
      for (var i = 0; i < shown; i++) cards.appendChild(makeTimelineCard(g.sets[i]));
      if (g.sets.length > shown) {
        var moreInGroup = el('button', 'tag-chip-more', '+' + (g.sets.length - shown) + ' 展开');
        moreInGroup.type = 'button';
        moreInGroup.addEventListener('click', function () {
          var rest = g.sets.slice(shown);
          rest.forEach(function (s) { cards.appendChild(makeTimelineCard(s)); });
          moreInGroup.remove();
        });
        cards.appendChild(moreInGroup);
      }
      sec.appendChild(cards);
      host.appendChild(sec);
    });

    $('#recent-count').textContent = fmtInt(inWindow.length) + ' 套 · 最近 ' + state.recentDays + ' 天';

    if (withShot.length > inWindow.length) {
      var more = el('button', 'btn btn-secondary');
      more.type = 'button';
      more.textContent = '加载更早（每次 30 天）';
      more.style.marginTop = '16px';
      more.addEventListener('click', function () {
        state.recentDays += 30;
        renderRecentPage();
      });
      host.appendChild(more);
    }
  }

  function relativeLabel(label, maxYmd) {
    var days = Math.round((ymdToDate(maxYmd) - ymdToDate(label.replace(/-/g, ''))) / 86400000);
    if (days <= 0) return '最新 · ' + label;
    if (days === 1) return '昨天 · ' + label;
    if (days <= 7) return '本周 · ' + label;
    return '更早 · ' + label;
  }

  function makeTimelineCard(set) {
    var tpl = $('#tpl-card');
    var card = tpl.content.firstElementChild.cloneNode(true);
    card.classList.add('timeline-card');
    fillCard(card, set);
    card.addEventListener('click', function () { openSet(set.id, 'open'); });
    return card;
  }

  /* ==================================================================
   * 10. L2 套图页
   * ================================================================== */

  var setPage = { id: null, files: null, ready: false, rendered: 0, batch: 60 };

  function openSet(id, mode) {
    if (mode === 'fav') { toggleFav(id); return; }
    state.view = 'set';
    state.setId = id;
    state.lbIndex = null;
    switchView('set');
    writeURL(true);
    renderSetPage(id);
  }

  function renderSetPage(id) {
    var s = DB.byId[id];
    var header = $('#set-header');
    header.textContent = '';
    if (!s) {
      header.appendChild(el('h1', 'set-title', '套图不存在'));
      return;
    }
    var title = el('h1', 'set-title', s.displayTitle);
    header.appendChild(title);

    var sub = el('div', 'set-sub');
    var cp = el('span', 'coser-pill', s.coser || '未署名');
    cp.addEventListener('click', function () {
      state.coser = s.coser; state.view = 'grid'; switchView('grid'); refreshAll(); writeURL(true);
    });
    sub.appendChild(cp);
    chipListFor(s).slice(0, 6).forEach(function (t) { sub.appendChild(makeTagChip(t, s)); });
    header.appendChild(sub);

    var stamps = el('div', 'set-sub');
    if (s.pages) stamps.appendChild(el('span', 'stamp', s.pages));
    if (s.size) stamps.appendChild(el('span', 'stamp', s.size));
    if (s.shotLabel) stamps.appendChild(el('span', 'stamp', s.shotLabel));
    stamps.appendChild(el('span', 'stamp stamp-plain', s.n + ' 张'));
    header.appendChild(stamps);

    var raw = el('div', 'set-raw', s.raw);
    raw.title = s.raw;
    header.appendChild(raw);

    var gridHost = $('#set-grid');
    gridHost.textContent = '';
    gridHost.setAttribute('aria-busy', 'true');

    loadSetFiles(id).then(function (rec) {
      setPage.id = id;
      setPage.files = rec;
      setPage.ready = true;
      setPage.rendered = 0;
      gridHost.textContent = '';
      gridHost.removeAttribute('aria-busy');
      if (!rec.files.length) {
        gridHost.appendChild(emptyState('此套图暂无可显示的图片', '套图内图片全部损坏或仅剩 .part 残片', '查看原始目录'));
        return;
      }
      appendSetBatch(rec, 0);
    }).catch(function () {
      gridHost.removeAttribute('aria-busy');
      gridHost.appendChild(emptyState('无法读取套图文件清单', '派生索引尚未生成', '重新加载'));
    });
  }

  /** 套图页同样按批追加，避免 877 张图一次性进 DOM */
  function appendSetBatch(rec, from) {
    var s = DB.byId[setPage.id];
    var gridHost = $('#set-grid');
    var end = Math.min(from + setPage.batch, rec.files.length);
    var frag = document.createDocumentFragment();
    /* 视频排在最前：数量少（最多十几个）、体积大，先看到更符合预期 */
    if (from === 0 && rec.videos && rec.videos.length) {
      for (var vi = 0; vi < rec.videos.length; vi++) {
        frag.appendChild(makeVideoCell(s, rec.videos[vi]));
      }
    }
    for (var i = from; i < end; i++) {
      frag.appendChild(makeSetCell(s, rec, i));
    }
    gridHost.appendChild(frag);
    setPage.rendered = end;

    var more = $('#set-more');
    if (end < rec.files.length) {
      if (!more) {
        more = el('button', 'btn btn-secondary');
        more.id = 'set-more';
        more.type = 'button';
        more.style.gridColumn = '1 / -1';
        more.addEventListener('click', function () {
          appendSetBatch(rec, setPage.rendered);
        });
        gridHost.appendChild(more);
      }
      more.textContent = '加载更多（已显示 ' + end + ' / ' + rec.files.length + '）';
      more.hidden = false;
    } else if (more) {
      more.hidden = true;
    }
  }

  /**
   * 视频单元。用浏览器原生 <video controls>：
   * - preload="metadata" 只取首帧当封面，不下载整个文件
   * - 原生控件自带进度条/音量/全屏，比自己造播放器可靠
   * - 拖动进度条依赖服务端 Range（serve.py 已实现 206）
   * 没有 ffmpeg 抽帧，所以不做静态封面图。
   */
  function makeVideoCell(s, name) {
    var wrap = el('div', 'set-cell set-video');
    var v = document.createElement('video');
    v.controls = true;
    v.preload = 'metadata';
    v.playsInline = true;
    v.src = rawUrl(s.path, name) + '#t=0.1';   // 加 #t 让它显示首帧
    wrap.appendChild(v);
    var cap = el('span', 'set-video-name', name);
    cap.title = name;
    wrap.appendChild(cap);
    return wrap;
  }

  function makeSetCell(s, rec, i) {
    var cell = el('button', 'set-cell');
    cell.type = 'button';
    var dim = (rec.dims && rec.dims[i]) || [0, 0];
    if (dim[0] && dim[1]) {
      cell.style.aspectRatio = dim[0] + ' / ' + dim[1];
    }
    var img = el('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    if (dim[0]) img.width = dim[0];
    if (dim[1]) img.height = dim[1];
    img.alt = buildAlt(s, i, rec.files.length);
    img.addEventListener('load', function () { img.classList.add('is-loaded'); });
    img.src = rawUrl(s.path, rec.files[i]);
    cell.appendChild(img);
    cell.appendChild(el('span', 'set-cell-n', String(i + 1)));
    cell.addEventListener('click', function () {
      lastTrigger = cell;
      openLightbox(i);
    });
    return cell;
  }

  /* ==================================================================
   * 11. L3 灯箱状态机
   * ================================================================== */

  var lb = {
    state: 'closed',        // closed | loading | loaded | navigating | error
    setId: null,
    index: -1,
    files: [],
    immersive: false,
    errorSkipped: 0,
    preloaded: {},
    lastSwipeAt: 0
  };

  function openLightbox(index, fromUrl) {
    if (state.view !== 'set' || state.setId == null) return;
    state.lbIndex = index;
    lb.setId = state.setId;
    lb.index = index;
    lb.files = (setPage.files && setPage.files.files) || [];
    lb.state = 'loading';
    lb.errorSkipped = 0;
    lb.immersive = false;
    var box = $('#lightbox');
    box.setAttribute('data-open', '1');
    box.setAttribute('data-immersive', '0');
    $('#lb-panel').setAttribute('data-open', state.panelOpen ? '1' : '0');
    $('#lb-info').setAttribute('aria-pressed', state.panelOpen ? 'true' : 'false');
    $('#lightbox').setAttribute('data-panel', state.panelOpen ? '1' : '0');
    renderLbPanel();
    renderLbStrip();
    loadLbImage(index);
    if (!fromUrl) {
      /* 推入一条带 ?i= 的历史：浏览器后退 = 关灯箱，再后退 = 回列表 */
      var h = buildHash();
      if (location.hash !== h) { history.pushState(null, '', h); lbOwnEntry = true; }
    }
    setTimeout(function () { $('#lb-close').focus(); }, 0);
  }

  /**
   * 关闭灯箱。三条恢复路径都指向这里。
   * - Esc / × / 背景点击 → closeLightbox()
   * 若灯箱历史项是本会话推入的，则 history.back()（保证前进/后退栈干净）；
   * 若是直接深链进来的，则 replaceState 去掉 ?i=（不会把用户踢出应用）。
   */
  function closeLightbox(restoreFocus, fromUrl) {
    lb.state = 'closed';
    $('#lightbox').setAttribute('data-open', '0');
    $('#lightbox').setAttribute('data-immersive', '0');
    state.lbIndex = null;
    lb.immersive = false;
    if (!fromUrl) {
      if (lbOwnEntry) {
        lbOwnEntry = false;
        history.back();
      } else {
        writeURL(false);
      }
    }
    if (restoreFocus && lastTrigger) {
      try { lastTrigger.focus({ preventScroll: true }); } catch (e) {}
    }
  }

  var lbOwnEntry = false;
  var lastTrigger = null;

  function loadLbImage(index) {
    if (index < 0 || index >= lb.files.length) { lb.state = 'loaded'; updateLbCounter(); return; }
    lb.index = index;
    lb.state = lb.state === 'closed' ? 'loading' : 'navigating';

    var img = $('#lb-main');
    var loader = $('#lb-loader');
    var errBox = $('#lb-error');

    loader.hidden = false;
    errBox.hidden = true;
    img.classList.remove('is-loaded');
    updateLbCounter();
    setLbProgress(index + 1, lb.files.length);

    var set = DB.byId[lb.setId];
    var url = rawUrl(set.path, lb.files[index]);
    var probe = new Image();
    var timer = setTimeout(function () {
      /* 5s 超时自动跳过（UX 规范 §4.4 ③） */
      if (lb.state === 'loading' || lb.state === 'navigating') {
        lb.errorSkipped++;
        toast('已跳过 ' + lb.errorSkipped + ' 张');
        nextLbImage(1, true);
      }
    }, 5000);

    probe.onload = function () {
      clearTimeout(timer);
      img.src = url;
      img.alt = buildAlt(set, index, lb.files.length);
      loader.hidden = true;
      img.classList.add('is-loaded');
      lb.state = 'loaded';
      updateLbCounter();
      highlightStrip();
      prefetchAround(index);
    };
    probe.onerror = function () {
      clearTimeout(timer);
      loader.hidden = true;
      errBox.hidden = false;
      lb.state = 'error';
      $('#lb-error-note').textContent = '文件：' + (lb.files[index] || '—');
      updateLbCounter();
    };
    probe.src = url;
  }

  function nextLbImage(delta, skip) {
    var next = lb.index + delta;
    if (next < 0 || next >= lb.files.length) {
      updateLbCounter();
      return;
    }
    if (skip) lb.errorSkipped++;
    loadLbImage(next);
  }

  function prefetchAround(index) {
    for (var d = -2; d <= 2; d++) {
      var i = index + d;
      if (i < 0 || i >= lb.files.length || lb.preloaded[i]) continue;
      lb.preloaded[i] = true;
      var set = DB.byId[lb.setId];
      var p = new Image();
      p.src = rawUrl(set.path, lb.files[i]);
    }
  }

  function setLbProgress(cur, total) {
    var p = $('#lb-progress');
    p.textContent = '载入中 ' + cur + '/' + total;
    var loader = $('#lb-loader');
    loader.setAttribute('aria-valuenow', String(cur));
    loader.setAttribute('aria-valuetext', '载入中 ' + cur + '/' + total);
  }

  function updateLbCounter() {
    $('#lb-counter').textContent = (lb.index + 1) + ' / ' + lb.files.length;
    var atFirst = lb.index <= 0;
    var atLast = lb.index >= lb.files.length - 1;
    $('#lb-prev').querySelector('button').disabled = atFirst;
    $('#lb-next').querySelector('button').disabled = atLast;
    $('#lb-prev').setAttribute('aria-disabled', atFirst ? 'true' : 'false');
    $('#lb-next').setAttribute('aria-disabled', atLast ? 'true' : 'false');
  }

  function renderLbStrip() {
    var strip = $('#lb-strip');
    strip.textContent = '';
    if (!lb.files.length) return;
    var set = DB.byId[lb.setId];
    lb.files.forEach(function (fname, i) {
      var img = el('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.width = 48; img.height = 64;
      img.alt = '';
      img.setAttribute('role', 'tab');
      img.src = rawUrl(set.path, fname);
      img.addEventListener('click', function () { loadLbImage(i); });
      strip.appendChild(img);
    });
    highlightStrip();
  }

  function highlightStrip() {
    var imgs = $$('#lb-strip img');
    for (var i = 0; i < imgs.length; i++) {
      if (i === lb.index) imgs[i].setAttribute('aria-current', 'true');
      else imgs[i].removeAttribute('aria-current');
    }
    var cur = imgs[lb.index];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  function renderLbPanel() {
    var s = DB.byId[lb.setId];
    if (!s) return;
    $('#lb-panel-title').textContent = s.displayTitle;
    var tagHost = $('#lb-panel-tags');
    tagHost.textContent = '';
    chipListFor(s).forEach(function (t) { tagHost.appendChild(makeTagChip(t, s)); });

    $('#lb-panel-raw').textContent = s.raw;
    $('#lb-panel-raw').title = s.raw;
    $('#lb-meta-count').textContent = s.n + ' 张';
    $('#lb-meta-pages').textContent = s.pages || '—';
    $('#lb-meta-size').textContent = s.size || '—';
    $('#lb-meta-shot').textContent = s.shotLabel || '日期未知';
    $('#lb-meta-path').textContent = s.path;
    $('#lb-meta-path').title = s.path;
    $('#lb-setname').textContent = s.displayTitle;
    $('#lb-meta-file').textContent = lb.files[lb.index] || '—';

    /* 同 coser 的其他套图（流程 B 的收口） */
    var sec = $('#lb-same-coser-sec');
    var strip = $('#lb-same-coser');
    strip.textContent = '';
    var same = DB.coserSets[s.coser] || [];
    var others = same.filter(function (id) { return id !== s.id; }).slice(0, 12);
    if (others.length) {
      sec.hidden = false;
      $('#lb-same-coser-title').textContent = '同 coser 的其他套图（' + others.length + '）';
      others.forEach(function (id) {
        var o = DB.byId[id];
        var img = el('img');
        img.src = o.thumbUrl;
        img.alt = ariaLabelFor(o);
        img.loading = 'lazy';
        img.title = o.displayTitle;
        img.addEventListener('click', function () {
          state.lbIndex = null;
          lb.setId = id;
          lb.index = -1;
          lb.files = [];
          renderLbPanel();
          loadSetFiles(id).then(function (rec) {
            lb.files = rec.files;
            renderLbStrip();
            loadLbImage(0);
            writeURL(true);
          });
        });
        strip.appendChild(img);
      });
    } else {
      sec.hidden = true;
    }
  }

  function togglePanel(force) {
    state.panelOpen = force != null ? force : !state.panelOpen;
    $('#lb-panel').setAttribute('data-open', state.panelOpen ? '1' : '0');
    $('#lb-info').setAttribute('aria-pressed', state.panelOpen ? 'true' : 'false');
    /* 面板展开时给底栏让出右侧宽度，保证 ⓘ 按钮始终可见可点（恢复路径 ①） */
    $('#lightbox').setAttribute('data-panel', state.panelOpen ? '1' : '0');
    /* 面板状态存在 state 里，灯箱关闭后不清零 —— 恢复路径 ① */
  }

  function setImmersive(on) {
    lb.immersive = on;
    $('#lightbox').setAttribute('data-immersive', on ? '1' : '0');
  }

  /**
   * 下滑手势关闭灯箱（UX 规范 §4.2）。
   * 阈值：垂直位移 > 80px 且平均速度 > 0.5px/ms（快速下滑）。
   * 只在主图区域上生效，不与横向翻页手势冲突。
   */
  function bindSwipeToClose() {
    var stage = $('#lb-stage');
    var startY = 0, startX = 0, startT = 0, tracking = false;

    stage.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { tracking = false; return; }
      tracking = true;
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      startT = Date.now();
    }, { passive: true });

    stage.addEventListener('touchmove', function (e) {
      if (!tracking || e.touches.length !== 1) return;
      var dy = e.touches[0].clientY - startY;
      var dx = e.touches[0].clientX - startX;
      /* 横向为主 → 让位给翻页手势 */
      if (Math.abs(dx) > Math.abs(dy)) { tracking = false; return; }
      /* 下滑时给一点跟随反馈，暗示「松手可关闭」 */
      if (dy > 0 && dy < 160) {
        var img = $('#lb-main');
        img.style.transform = 'translateY(' + Math.round(dy * 0.4) + 'px)';
        img.style.opacity = String(Math.max(0.6, 1 - dy / 240));
      }
    }, { passive: true });

    stage.addEventListener('touchend', function (e) {
      if (!tracking) return;
      tracking = false;
      var t = e.changedTouches[0];
      var dy = t.clientY - startY;
      var dx = t.clientX - startX;
      var dt = Date.now() - startT;
      var img = $('#lb-main');
      img.style.transform = '';
      img.style.opacity = '';

      if (dt <= 0) return;
      var velocity = dy / dt;                    // px/ms
      if (dy > 80 && velocity > 0.5 && Math.abs(dx) < Math.abs(dy)) {
        lb.lastSwipeAt = Date.now();
        closeLightbox(true);
      }
    }, { passive: true });

    stage.addEventListener('touchcancel', function () {
      tracking = false;
      var img = $('#lb-main');
      img.style.transform = '';
      img.style.opacity = '';
    }, { passive: true });
  }

  /* ---- 收藏 ---- */
  function getFavs() {
    try { return JSON.parse(localStorage.getItem(LS.favs) || '[]'); } catch (e) { return []; }
  }
  function isFav(id) { return getFavs().indexOf(id) >= 0; }
  function toggleFav(id) {
    var f = getFavs();
    var i = f.indexOf(id);
    if (i >= 0) f.splice(i, 1); else f.push(id);
    try { localStorage.setItem(LS.favs, JSON.stringify(f)); } catch (e) {}
    $('#lb-fav').setAttribute('aria-pressed', isFav(id) ? 'true' : 'false');
    toast(isFav(id) ? '已收藏' : '已取消收藏');
    var btn = grid.spacer.querySelector('.card[data-id="' + id + '"] [data-act="fav"]');
    if (btn) btn.setAttribute('aria-pressed', isFav(id) ? 'true' : 'false');
  }

  function toggleSelect(id) {
    if (state.selected[id]) delete state.selected[id];
    else state.selected[id] = true;
    var card = grid.spacer.querySelector('.card[data-id="' + id + '"]');
    if (card) card.dataset.selected = state.selected[id] ? '1' : '0';
  }

  /* ---- 搜索建议 ---- */
  var sugIndex = -1, sugItems = [];

  /**
   * 搜索命中分类（UX 规范 §5.6）。
   * 用户搜「碧蓝航线」会同时命中作品标签和 coser 名，平铺在一起会让用户困惑
   * 「为什么搜作品出来一堆人名」—— 所以必须按命中字段分组。
   *
   * 组顺序按权重降序：
   *   角色标签 90 › 联合 coser/别名 85 › 作品 80 › coser 子串 70
   *   › 主题 60 / 未分类 55 › 目录名 30
   * coser 前缀匹配权重最高（100）。
   */
  var SEARCH_GROUPS = [
    { id: 'role',  label: '角色标签', weight: 90, dim: 'roles' },
    { id: 'alias', label: '联合 coser / 别名', weight: 85, dim: null },
    { id: 'work',  label: '作品', weight: 80, dim: 'works' },
    { id: 'coser', label: 'coser 名', weight: 70, dim: null },
    { id: 'theme', label: '主题', weight: 60, dim: 'themes' },
    { id: 'other', label: '未分类', weight: 55, dim: 'others' },
    { id: 'raw',   label: '目录名', weight: 30, dim: null }
  ];

  function groupById(gid) {
    for (var i = 0; i < SEARCH_GROUPS.length; i++) if (SEARCH_GROUPS[i].id === gid) return SEARCH_GROUPS[i];
    return { id: gid, label: gid, weight: 0, dim: null };
  }

  /** 把一次搜索拆成按命中字段分组的候选 */
  function collectSearchGroups(q) {
    var kw = key(q);
    var groups = {};
    function push(gid, name, count, payload) {
      if (!groups[gid]) groups[gid] = [];
      groups[gid].push({ name: name, count: count, payload: payload });
    }

    /* coser：前缀匹配权重最高（100），子串匹配 70 */
    Object.keys(DB.coserCounts).forEach(function (c) {
      var idx = key(c).indexOf(kw);
      if (idx < 0) return;
      push('coser', c, DB.coserCounts[c],
        { type: 'coser', value: c, weight: idx === 0 ? 100 : 70 });
    });

    /* 标签：按其生效维度分组（只做前缀匹配） */
    Object.keys(DB.tagCounts).forEach(function (t) {
      if (key(t).indexOf(kw) !== 0) return;
      var dim = effectiveDim(t) || fieldOfTag(t);
      var gid = dim === 'roles' ? 'role' : dim === 'works' ? 'work'
               : dim === 'themes' ? 'theme' : 'other';
      push(gid, t, DB.tagCounts[t], { type: 'tag', value: t, dim: dim, weight: 90 });
    });

    /* 目录名：子串匹配 30（最多 6 条，避免噪声） */
    var rawHits = 0;
    for (var i = 0; i < DB.sets.length && rawHits < 6; i++) {
      var s = DB.sets[i];
      if (s.kRaw.indexOf(kw) >= 0) {
        push('raw', s.raw, 1, { type: 'raw', value: s.raw, weight: 30 });
        rawHits++;
      }
    }

    var order = Object.keys(groups).sort(function (a, b) {
      var ga = groupById(a), gb = groupById(b);
      if (ga.weight !== gb.weight) return gb.weight - ga.weight;
      return a.localeCompare(b);
    });
    return order.map(function (gid) {
      var g = groupById(gid);
      g.items = groups[gid].sort(function (x, y) { return y.count - x.count; });
      return g;
    });
  }

  function renderSuggest(q) {
    var host = $('#suggest');
    host.textContent = '';
    sugItems = [];
    sugIndex = -1;
    var kw = key(q);
    if (!kw) { host.removeAttribute('data-open'); $('#search').setAttribute('aria-expanded', 'false'); return; }

    var groups = collectSearchGroups(q);

    groups.forEach(function (g) {
      if (!g.items.length) return;
      /* 组标题 = 命中字段名 */
      host.appendChild(el('div', 'suggest-group-title',
        g.label + ' · ' + g.items.length + ' 个套图'));

      /* 每组最多 4 条 */
      g.items.slice(0, 4).forEach(function (it) {
        var b = el('button', 'suggest-item');
        b.type = 'button';
        b.setAttribute('role', 'option');
        b.appendChild(el('span', 'sug-name', it.name));
        b.appendChild(el('span', 'sug-n', fmtInt(it.count)));
        b.addEventListener('click', function () { applySuggestion(it.payload); });
        host.appendChild(b);
        sugItems.push({ payload: it.payload, node: b });
      });

      /* 「查看全部（N）」→ 用该命中字段做筛选 */
      if (g.items.length > 4) {
        var all = el('button', 'suggest-item suggest-item-all');
        all.type = 'button';
        all.setAttribute('role', 'option');
        all.appendChild(el('span', 'sug-name', '查看全部（' + g.items.length + '）'));
        all.addEventListener('click', function () { applySearchGroupAll(g); });
        host.appendChild(all);
        sugItems.push({ payload: null, node: all });
      }
    });

    if (!sugItems.length) {
      host.appendChild(el('div', 'suggest-group-title', '无匹配建议'));
    }
    host.setAttribute('data-open', '1');
    $('#search').setAttribute('aria-expanded', 'true');
  }

  /** 「查看全部（N）」：把该组的全部命中项作为筛选条件应用到网格页 */
  function applySearchGroupAll(g) {
    if (g.dim) {
      DIMS.forEach(function (d) { state.tags[d.field] = []; });
      state.tags[g.dim] = g.items.map(function (x) { return x.name; });
      state.coser = '';
      state.q = '';
    } else if (g.id === 'coser') {
      DIMS.forEach(function (d) { state.tags[d.field] = []; });
      state.coser = g.items[0].name;
      state.q = '';
    } else {
      state.q = g.items[0].payload.value;
    }
    $('#search-input').value = state.q;
    $('#search').setAttribute('data-has-value', state.q ? '1' : '0');
    $('#suggest').removeAttribute('data-open');
    state.view = 'grid';
    switchView('grid');
    refreshAll();
    writeURL(true);
  }

  function applySuggestion(item) {
    if (item.type === 'coser') {
      state.coser = item.value;
      DIMS.forEach(function (d) { state.tags[d.field] = []; });
    } else {
      DIMS.forEach(function (d) { state.tags[d.field] = []; });
      state.tags[fieldOfTag(item.value)] = [item.value];
      state.coser = '';
    }
    state.q = '';
    $('#search-input').value = '';
    $('#search').setAttribute('data-has-value', '0');
    $('#suggest').removeAttribute('data-open');
    state.view = 'grid';
    switchView('grid');
    refreshAll();
    writeURL(true);
  }

  /* ==================================================================
   * 12. 路由 / 视图切换
   * ================================================================== */

  function switchView(view) {
    state.view = view;
    /* 漫画视图复用 grid 的 DOM，靠 DB.active 切换数据源，不复制一套渲染逻辑 */
    var domView = (view === 'manga') ? 'grid' : view;
    ['grid', 'tags', 'recent', 'set', 'novel', 'reader'].forEach(function (v) {
      var sec = $('#view-' + v);
      if (sec) sec.setAttribute('data-active', v === domView ? '1' : '0');
    });
    if (view === 'manga') DB.active = DB.mangaSets;
    else if (view === 'grid') DB.active = DB.sets;
    /* 漫画没有标签体系，侧栏的标签云在漫画模式下隐藏（CSS 按这个属性选） */
    document.documentElement.setAttribute('data-kind', view === 'manga' ? 'manga' : 'photo');
    $$('.nav-item').forEach(function (b) {
      var on = b.dataset.nav === view || (view === 'set' && b.dataset.nav === 'grid');
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    if (view === 'tags') renderTagPage();
    if (view === 'recent') renderRecentPage();
    if (view === 'novel') loadNovels().then(renderNovelPage);
  }

  function applyURL(next, push) {
    var changedView = next.view !== state.view;
    var changedSet = next.setId !== state.setId;

    state.q = next.q;
    state.coser = next.coser;
    DIMS.forEach(function (d) { state.tags[d.field] = next.tags[d.field]; });
    state.mode = next.mode;
    state.sort = next.sort;

    switchView(next.view);

    if (next.view === 'set' && (changedSet || !setPage.ready)) {
      renderSetPage(next.setId);
    }
    if (next.view === 'grid' || next.view === 'manga') {
      renderGrid(true);
    }
    renderCoserList($('#coser-filter-input').value);
    DIMS.forEach(function (d) {
      if (d.field === 'others') renderOthersCloud(); else renderTagCloud(d.field);
    });
    renderApplied();

    if (next.lbIndex != null && next.view === 'set') {
      if (lb.state === 'closed' || lb.setId !== next.setId) {
        lb.setId = next.setId;
        loadSetFiles(next.setId).then(function (rec) {
          lb.files = rec.files;
          setPage.files = rec;
          openLightbox(next.lbIndex, true);
        });
      } else {
        loadLbImage(next.lbIndex);
      }
    } else if (lb.state !== 'closed') {
      closeLightbox(false, true);
      lbOwnEntry = false;
    }

    if (push) writeURL(true); else writeURL(false);
  }

  /* ==================================================================
   * 13. 启动
   * ================================================================== */

  function bindEvents() {
    /* --- 顶栏 --- */
    $('#search-input').addEventListener('input', debounce(function (e) {
      state.q = e.target.value.trim();
      $('#search').setAttribute('data-has-value', state.q ? '1' : '0');
      renderSuggest(state.q);
      if (state.view !== 'grid') { state.view = 'grid'; switchView('grid'); }
      renderGrid(true);
      writeURL(false);
    }, 120));

    $('#search-input').addEventListener('focus', function () {
      if (state.q) renderSuggest(state.q);
    });

    $('#search-clear').addEventListener('click', function () {
      state.q = '';
      $('#search-input').value = '';
      $('#search').setAttribute('data-has-value', '0');
      $('#suggest').removeAttribute('data-open');
      renderGrid(true);
      writeURL(false);
      $('#search-input').focus();
    });

    $('#search-input').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        $('#suggest').removeAttribute('data-open');
        $('#search').setAttribute('aria-expanded', 'false');
        return;
      }
      if (!sugItems.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sugIndex = clamp(sugIndex + (e.key === 'ArrowDown' ? 1 : -1), 0, sugItems.length - 1);
        sugItems.forEach(function (it, i) { it.node.setAttribute('aria-selected', i === sugIndex ? 'true' : 'false'); });
        sugItems[sugIndex].node.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        applySuggestion(sugItems[sugIndex >= 0 ? sugIndex : 0]);
      }
    });

    $('#sort-select').addEventListener('change', function (e) {
      state.sort = e.target.value;
      if (state.view === 'grid') renderGrid(true);
      writeURL(false);
    });

    $('#theme-toggle').addEventListener('click', function () {
      setTheme(state.theme === 'dark' ? 'light' : 'dark');
    });

    $('#density-comfortable').addEventListener('click', function () { setDensity('comfortable'); });
    $('#density-compact').addEventListener('click', function () { setDensity('compact'); });

    $('#sidebar-collapse').addEventListener('click', function () {
      var app = $('#app');
      var collapsed = app.getAttribute('data-sidebar') === 'collapsed';
      app.setAttribute('data-sidebar', collapsed ? 'expanded' : 'collapsed');
      try { localStorage.setItem('wg.sidebar', collapsed ? 'expanded' : 'collapsed'); } catch (e) {}
      requestAnimationFrame(function () { renderGrid(false); });
    });

    $('#sidebar-toggle').addEventListener('click', function () {
      var app = $('#app');
      var open = app.getAttribute('data-drawer') === '1';
      app.setAttribute('data-drawer', open ? '0' : '1');
      $('#sidebar-toggle').setAttribute('aria-expanded', open ? 'false' : 'true');
    });

    $('#sidebar-scrim').addEventListener('click', function () {
      $('#app').setAttribute('data-drawer', '0');
      $('#sidebar-toggle').setAttribute('aria-expanded', 'false');
    });

    /* --- 侧栏 --- */
    $$('.nav-item').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.dataset.nav;
        if (v === 'grid') { state.q = ''; $('#search-input').value = ''; $('#search').setAttribute('data-has-value', '0'); }
        /* 进漫画模块时清掉写真侧的筛选条件：漫画没有标签体系，coser 也是另一批 */
        if (v === 'manga') {
          state.q = ''; $('#search-input').value = ''; $('#search').setAttribute('data-has-value', '0');
          state.coser = '';
          DIMS.forEach(function (d) { state.tags[d.field] = []; });
        }
        state.view = v;
        switchView(v);
        refreshAll();
        writeURL(true);
      });
    });

    /* 小说：搜索 + 分类筛选 */
    var nSearch = $('#novel-search');
    if (nSearch) nSearch.addEventListener('input', function () {
      novelState.q = this.value; novelState.shown = NOVEL_PAGE; renderNovelPage();
    });
    var nCat = $('#novel-cat');
    if (nCat) nCat.addEventListener('change', function () {
      novelState.cat = this.value; novelState.shown = NOVEL_PAGE; renderNovelPage();
    });

    /* 阅读器：翻页 / 字号 / 返回 */
    var rBack = $('#reader-back');
    if (rBack) rBack.addEventListener('click', function () {
      switchView('novel');
      writeURL(true);
      renderNovelPage();
    });
    var rPrev = $('#reader-prev');
    if (rPrev) rPrev.addEventListener('click', function () {
      if (reader.page > 0) { reader.page--; renderReaderPage(); }
    });
    var rNext = $('#reader-next');
    if (rNext) rNext.addEventListener('click', function () {
      if (reader.pages && reader.page < reader.pages.length - 1) {
        reader.page++; renderReaderPage();
      }
    });
    var rInc = $('#reader-font-inc');
    if (rInc) rInc.addEventListener('click', function () {
      var i = READER_SIZES.indexOf(reader.size);
      reader.size = READER_SIZES[Math.min(READER_SIZES.length - 1, i + 1)];
      renderReaderPage();
    });
    var rDec = $('#reader-font-dec');
    if (rDec) rDec.addEventListener('click', function () {
      var i = READER_SIZES.indexOf(reader.size);
      reader.size = READER_SIZES[Math.max(0, i - 1)];
      renderReaderPage();
    });

    $('#coser-filter-input').addEventListener('input', debounce(function (e) {
      renderCoserList(e.target.value);
    }, 120));

    $('#tag-search-input').addEventListener('input', debounce(function (e) {
      renderTagSearch(e.target.value);
    }, 120));

    $('#clear-all').addEventListener('click', function () {
      state.q = ''; state.coser = '';
      DIMS.forEach(function (d) { state.tags[d.field] = []; });
      $('#search-input').value = '';
      $('#search').setAttribute('data-has-value', '0');
      refreshAll();
    });

    $('#override-export').addEventListener('click', exportOverrides);

    var modeAnd = $('#mode-and'), modeOr = $('#mode-or');
    if (modeAnd) modeAnd.addEventListener('click', function () { state.mode = 'and'; refreshAll(); });
    if (modeOr) modeOr.addEventListener('click', function () { state.mode = 'or'; refreshAll(); });

    $('#nsfw-switch').addEventListener('click', function () {
      state.nsfwBlur = !state.nsfwBlur;
      this.setAttribute('aria-pressed', state.nsfwBlur ? 'true' : 'false');
      $('#nsfw-state').textContent = state.nsfwBlur ? '开' : '关';
      try { localStorage.setItem(LS.nsfw, state.nsfwBlur ? '1' : '0'); } catch (e) {}
      if (state.view === 'grid') renderGrid(false);
    });

    /* --- 网格滚动 --- */
    grid.scroller = $('#grid-scroll');
    grid.inner = $('.grid-inner');
    grid.spacer = $('#grid-spacer');

    var ticking = false;
    grid.scroller.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        syncGridDOM();
        var compact = grid.scroller.scrollTop > 120;
        $('#topbar').setAttribute('data-compact', compact ? '1' : '0');
      });
    }, { passive: true });

    var ro = new ResizeObserver(debounce(function () {
      if (state.view === 'grid') renderGrid(false);
    }, 80));
    ro.observe(grid.inner);

    /* 列数断点按视口宽度判定（视觉规范 §5.1），
       容器有 max-width:1680 上限，元素尺寸不随视口变 → 必须监听 window resize */
    window.addEventListener('resize', debounce(function () {
      if (state.view === 'grid') renderGrid(false);
    }, 120));

    /* --- 灯箱 --- */
    $('#lb-close').addEventListener('click', function () { closeLightbox(true); });
    $('#lb-back').addEventListener('click', function () {
      if (lb.state !== 'closed') { closeLightbox(true); return; }
      state.view = 'grid'; switchView('grid'); refreshAll(); writeURL(true);
    });
    $('#lb-info').addEventListener('click', function () { togglePanel(); });
    $('#lb-fav').addEventListener('click', function () { if (lb.setId != null) toggleFav(lb.setId); });
    $('#lb-copy').addEventListener('click', function () {
      var s = DB.byId[lb.setId];
      if (!s) return;
      var f = lb.files[lb.index];
      copyText(s.path + '\\' + f).then(function () { toast('已复制文件路径'); });
    });
    $('#lb-copy-raw').addEventListener('click', function () {
      var s = DB.byId[lb.setId];
      if (!s) return;
      copyText(s.raw).then(function () { toast('已复制原始目录名'); });
    });
    $('#lb-retry').addEventListener('click', function () { loadLbImage(lb.index); });
    $('#lb-skip').addEventListener('click', function () { nextLbImage(1, true); });
    $('#lb-grid').addEventListener('click', function () { goToSetGrid(); });
    $('#lb-help').addEventListener('click', function () { $('#lb-help-overlay').hidden = false; $('#lb-help-close').focus(); });
    $('#lb-help-close').addEventListener('click', function () { $('#lb-help-overlay').hidden = true; $('#lb-help').focus(); });

    $('#lb-prev').addEventListener('click', function () { nextLbImage(-1); });
    $('#lb-next').addEventListener('click', function () { nextLbImage(1); });
    /* 翻页热区是可聚焦控件（role=button），需支持键盘激活 */
    ['lb-prev', 'lb-next'].forEach(function (id) {
      var zone = $('#' + id);
      zone.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (id === 'lb-prev') nextLbImage(-1); else nextLbImage(1);
        }
      });
    });

    /* 灯箱焦点陷阱（无障碍 §7.3）：焦点锁在灯箱内 */
    $('#lightbox').addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var focusables = $$('#lightbox button:not([disabled]), #lightbox a[href], #lightbox [tabindex="0"], #lightbox input')
        .filter(function (n) { return n.offsetParent !== null && !n.closest('[hidden]'); });
      if (!focusables.length) return;
      var first = focusables[0], lastEl = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault(); first.focus();
      }
    });

    /* 恢复路径 ②：点击主图 = 切换沉浸模式，绝不关闭灯箱 */
    $('#lb-main').addEventListener('click', function (e) {
      e.stopPropagation();
      /* 滑动关闭后不要立刻触发点击 → 切换沉浸 */
      if (Date.now() - lb.lastSwipeAt < 350) return;
      setImmersive(!lb.immersive);
    });

    /* 明确的背景点击才关闭 */
    $('#lb-bg').addEventListener('click', function () { closeLightbox(true); });

    /* 下滑手势关闭（UX 规范 §4.2）：位移 > 80px 且速度 > 0.5px/ms */
    bindSwipeToClose();

    /* 键盘 */
    document.addEventListener('keydown', onGlobalKey);

    /* 路由 */
    window.addEventListener('popstate', function () {
      applyURL(readURL(), false);
    });
    window.addEventListener('hashchange', function () {
      var next = readURL();
      if (buildHash() !== location.hash) applyURL(next, false);
    });
  }

  function goToSetGrid() {
    var idx = lb.index;
    closeLightbox(false);
    switchView('set');
    requestAnimationFrame(function () {
      var cells = $$('#set-grid .set-cell');
      if (cells[idx]) {
        cells[idx].scrollIntoView({ block: 'center', behavior: 'smooth' });
        cells[idx].focus({ preventScroll: true });
      }
    });
  }

  function onGlobalKey(e) {
    var tag = (e.target && e.target.tagName) || '';
    var typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);

    /* "/" 聚焦搜索 */
    if (!typing && e.key === '/') {
      e.preventDefault();
      $('#search-input').focus();
      $('#search-input').select();
      return;
    }

    if (lb.state !== 'closed') {
      if (e.key === 'Escape') {
        e.preventDefault();
        /* Esc 逐级退出：面板 → immersive → 灯箱 */
        if (!$('#lb-help-overlay').hidden) { $('#lb-help-overlay').hidden = true; return; }
        if (state.panelOpen) { togglePanel(false); return; }
        if (lb.immersive) { setImmersive(false); return; }
        closeLightbox(true);
        return;
      }
      if (typing) return;
      switch (e.key) {
        case 'ArrowLeft': e.preventDefault(); nextLbImage(-1); break;
        case 'ArrowRight': e.preventDefault(); nextLbImage(1); break;
        case 'Home': e.preventDefault(); loadLbImage(0); break;
        case 'End': e.preventDefault(); loadLbImage(lb.files.length - 1); break;
        case 'i': case 'I': e.preventDefault();
          /* immersive 模式下工具栏整体 pointer-events:none，用户看不到也点不到。
             此时按 I 的语义是「我要看元数据」→ 先退出 immersive 再展开面板，
             否则面板状态被藏在一个看不见的层里，违反恢复路径 ①。 */
          if (lb.immersive) { setImmersive(false); togglePanel(true); }
          else { togglePanel(); }
          break;
        case 'f': case 'F': e.preventDefault(); if (lb.setId != null) toggleFav(lb.setId); break;
        case ' ': e.preventDefault(); setImmersive(!lb.immersive); break;
        case 'g': case 'G': e.preventDefault(); goToSetGrid(); break;
        case '?': e.preventDefault(); $('#lb-help-overlay').hidden = false; break;
        case '+': case '=': e.preventDefault(); zoomLb(1); break;
        case '-': e.preventDefault(); zoomLb(-1); break;
        case '0': e.preventDefault(); zoomLb(0); break;
      }
      return;
    }

    if (typing) return;

    /* 网格方向键导航（无障碍 §7.3） */
    if (state.view === 'grid' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) >= 0) {
      var m = grid.metrics;
      if (!m || !grid.list.length) return;
      var cur = grid.focusIndex;
      var nextIdx = cur;
      if (cur < 0) nextIdx = 0;
      else if (e.key === 'ArrowLeft') nextIdx = Math.max(0, cur - 1);
      else if (e.key === 'ArrowRight') nextIdx = Math.min(grid.list.length - 1, cur + 1);
      else if (e.key === 'ArrowUp') nextIdx = Math.max(0, cur - m.cols);
      else if (e.key === 'ArrowDown') nextIdx = Math.min(grid.list.length - 1, cur + m.cols);
      if (nextIdx !== cur) {
        e.preventDefault();
        grid.focusIndex = nextIdx;
        setActiveCard(grid.list[nextIdx].id);
      }
      return;
    }

    if (e.key === 'Escape' && state.q) {
      state.q = ''; $('#search-input').value = '';
      $('#search').setAttribute('data-has-value', '0');
      renderGrid(true); writeURL(false);
    }
  }

  var lbZoom = 1;
  function zoomLb(delta) {
    if (delta === 0) lbZoom = 1;
    else lbZoom = clamp(lbZoom * (delta > 0 ? 1.5 : 1 / 1.5), 1, 4);
    var img = $('#lb-main');
    img.style.transform = lbZoom === 1 ? '' : 'scale(' + lbZoom + ')';
    img.style.transformOrigin = 'center center';
    toast(lbZoom === 1 ? '适应窗口' : Math.round(lbZoom * 100) + '%');
  }

  function setTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(LS.theme, theme); } catch (e) {}
    var icon = $('#theme-icon');
    if (icon) {
      icon.innerHTML = theme === 'dark'
        ? '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9"/>'
        : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>';
    }
  }

  function setDensity(d) {
    state.density = d;
    $('#app').setAttribute('data-density', d);
    $('#density-comfortable').setAttribute('aria-pressed', d === 'comfortable' ? 'true' : 'false');
    $('#density-compact').setAttribute('aria-pressed', d === 'compact' ? 'true' : 'false');
    try { localStorage.setItem(LS.density, d); } catch (e) {}
    if (state.view === 'grid') renderGrid(false);
  }

  function emptyState(title, body, action) {
    var w = el('div', 'empty');
    w.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>';
    w.appendChild(el('h2', null, title));
    w.appendChild(el('p', null, body));
    var b = el('button', 'btn btn-ghost', action);
    b.type = 'button';
    w.appendChild(b);
    return w;
  }

  /**
   * 空结果页（UX 规范 §5.5）：绝不只显示"没找到"。
   * 保留 chips 可见 + 给带预估数量的放宽建议 + 一键清空。
   */
  function renderGridEmptyState(f) {
    var host = el('div');
    host.style.position = 'absolute';
    host.style.inset = '0';

    var w = el('div', 'empty');
    w.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>';

    var desc = [];
    if (f.q) desc.push('「' + f.q + '」');
    if (f.coser) desc.push(f.coser);
    DIMS.forEach(function (d) {
      f.tags[d.field].forEach(function (t) { desc.push(t); });
    });
    w.appendChild(el('h2', null, '没有匹配' + (desc.length ? '「' + desc.join(' + ') + '」' : '当前条件') + '的套图'));

    /* 当前筛选 chips（可见） */
    var chipRow = el('div', 'empty-chips');
    if (f.q) chipRow.appendChild(makeChip('搜索', f.q, 'search', function () {
      state.q = ''; $('#search-input').value = ''; refreshAll();
    }));
    if (f.coser) chipRow.appendChild(makeChip('coser', f.coser, 'coser', function () {
      state.coser = ''; refreshAll();
    }));
    DIMS.forEach(function (d) {
      f.tags[d.field].forEach(function (t) {
        chipRow.appendChild(makeChip(d.label, t, '', function () { toggleTag(t, d.field); }));
      });
    });
    if (chipRow.childNodes.length) w.appendChild(chipRow);

    /* 放宽建议（带预估结果数） */
    var sug = el('div', 'empty-suggest');
    var ul = el('ul');
    var probes = [];

    DIMS.forEach(function (d) {
      f.tags[d.field].forEach(function (t) {
        var probe = currentFilterState();
        probe.tags[d.field] = probe.tags[d.field].filter(function (x) { return x !== t; });
        probes.push({
          label: '移除「' + t + '」',
          count: computeFiltered(probe, true).list.length,
          apply: function () { toggleTag(t, d.field); }
        });
      });
    });
    if (state.mode === 'and' && DIMS.some(function (d) { return f.tags[d.field].length > 0; })) {
      var probe2 = currentFilterState();
      probe2.mode = 'or';
      probes.push({
        label: '放宽到「任一满足」',
        count: computeFiltered(probe2, true).list.length,
        apply: function () { state.mode = 'or'; refreshAll(); }
      });
    }
    if (f.q) {
      var probe3 = currentFilterState();
      probe3.q = '';
      probes.push({
        label: '在全部套图中搜「' + f.q + '」',
        count: computeFiltered(probe3, true).list.length,
        apply: function () { state.q = ''; $('#search-input').value = ''; refreshAll(); }
      });
    }
    if (f.coser) {
      var probe4 = currentFilterState();
      probe4.coser = '';
      probes.push({
        label: '不限 coser',
        count: computeFiltered(probe4, true).list.length,
        apply: function () { state.coser = ''; refreshAll(); }
      });
    }

    probes.sort(function (a, b) { return b.count - a.count; });
    probes.slice(0, 5).forEach(function (p) {
      var li = el('li');
      var b = el('button', null, '· ' + p.label);
      b.type = 'button';
      b.addEventListener('click', p.apply);
      li.appendChild(b);
      li.appendChild(el('span', 'sug-n', '→ ' + fmtInt(p.count) + ' 个结果'));
      ul.appendChild(li);
    });
    if (probes.length) {
      sug.appendChild(el('div', 'panel-sec-title', '试试'));
      sug.appendChild(ul);
      w.appendChild(sug);
    }

    w.appendChild(el('p', null, '当前筛选已在上方列出，可逐项移除。'));

    var clear = el('button', 'btn btn-ghost', '清空全部筛选');
    clear.type = 'button';
    clear.addEventListener('click', function () {
      state.q = ''; state.coser = '';
      DIMS.forEach(function (d) { state.tags[d.field] = []; });
      $('#search-input').value = '';
      $('#search').setAttribute('data-has-value', '0');
      refreshAll();
    });
    w.appendChild(clear);

    host.appendChild(w);
    return host;
  }

  /* ---- 启动 ---- */
  function boot() {
    /* 恢复偏好 */
    try {
      var th = localStorage.getItem(LS.theme);
      /* 默认走暗色（视觉规范 §8）：系统浅色偏好不改变默认档，
         只有用户显式切换过才用 localStorage 里的值。 */
      if (!th) th = 'dark';
      setTheme(th);
      var de = localStorage.getItem(LS.density) || 'comfortable';
      setDensity(de);
      var ns = localStorage.getItem(LS.nsfw);
      state.nsfwBlur = ns === null ? true : ns === '1';
      $('#nsfw-switch').setAttribute('aria-pressed', state.nsfwBlur ? 'true' : 'false');
      $('#nsfw-state').textContent = state.nsfwBlur ? '开' : '关';
      var sb = localStorage.getItem('wg.sidebar');
      if (sb) $('#app').setAttribute('data-sidebar', sb);
    } catch (e) {}

    bindEvents();

    bootData().then(function () {
      perf.mark('dataReady');
      renderSidebarCounts();
      /* 小说库异步预加载：导航项要等数据到齐才知道该不该显示，
         而「进小说视图」又依赖导航项可点 —— 不预加载就是死锁。 */
      loadNovels();
      var next = readURL();
      applyURL(next, false);
      perf.mark('firstPaint');

      /* 首次进入后统计可见缩略图数 */
      setTimeout(function () {
        var n = grid.spacer.querySelectorAll('.thumb').length;
        perf.visibleThumbs = n;
        perf.domNodes = document.getElementsByTagName('*').length;
        var m = performance.memory;
        if (m) perf.heapMB = Math.round(m.usedJSHeapSize / 1048576);
        perf.mark('sampled');
      }, 800);
    }).catch(function (err) {
      console.error(err);
      $('#grid-count').textContent = '索引加载失败';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
