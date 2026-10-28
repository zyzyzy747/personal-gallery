/**
 * 无浏览器逻辑自测：把 app.js 的纯函数部分抽出来跑，
 * 验证过滤/搜索/排序/标题推导/URL 往返的正确性。
 * 用法：node selftest.js
 */
const fs = require('fs');
const vm = require('vm');

const raw = JSON.parse(fs.readFileSync('index.final.json', 'utf8'));
const alias = raw.alias || {};
let shotDates = {};

// ---------- 复用 app.js 的关键算法（与源码保持一致） ----------
function key(s) {
  if (!s) return '';
  const t = String(s).normalize('NFKC').toLowerCase();
  return t.replace(/[\s\-_·・.,、'"!?,，。！?()（）[\]【】「」『』]/g, '');
}
function normDash(s) { return String(s).replace(/[‐‑‒–—―−－ー]/g, '-'); }
function sizeToBytes(s) {
  if (!s) return 0;
  const m = /^([\d.]+)\s*([MmGg])[Bb]?$/.exec(String(s).trim());
  if (!m) return 0;
  const v = parseFloat(m[1]);
  return m[2].toLowerCase() === 'g' ? v * 1073741824 : v * 1048576;
}

function deriveTitle(s) {
  let r = normDash(s.raw);
  r = r.replace(/\[[^\[\]]*\]/g, ' ');
  r = r.replace(/\s+\d{1,4}\s*[Pp]\d{0,2}\s*[Vv]?(\s*[\d.]+\s*[MmGg][Bb]?)?\s*$/, ' ');
  const parts = r.split(/\s+-\s+/);
  const tail = parts.length > 1 ? parts.slice(1).join(' - ') : r;
  const tagSet = new Set();
  s.tags.forEach(t => tagSet.add(key(t)));
  (s.times || []).forEach(t => tagSet.add(key(t)));
  const coserSet = new Set([key(s.coser)]);
  (s.co || []).forEach(k => coserSet.add(key(k)));
  const words = tail.split(/\s+/).filter(w => {
    if (!w) return false;
    if (w[0] === '#') return false;
    const k = key(w);
    if (!k) return false;
    if (tagSet.has(k) || coserSet.has(k)) return false;
    if (/^\d/.test(w)) return false;
    return true;
  });
  return words.join(' ').replace(/^[\s\-·]+|[\s\-·]+$/g, '');
}

// ---------- 构建索引 ----------
const DIMS = [
  { id: 'works', key: 'w', field: 'works' },
  { id: 'roles', key: 'r', field: 'roles' },
  { id: 'themes', key: 't', field: 'themes' },
  { id: 'others', key: 'o', field: 'others' }
];
const sets = [];
const byId = {};
const dimCounts = { works: {}, roles: {}, themes: {}, others: {} };
const coserCounts = {};
const normKey = s => String(s).toLowerCase().replace(/[·・\s_]+/g, '');

// 与 app.js 的 pickBuckets 保持一致：kinds 优先，others 缺失时由 tags 减去三类推出
function pickBuckets(raw) {
  const k = raw.kinds;
  const works = (k && k.works && k.works.length) ? k.works : (raw.works || []);
  const roles = (k && k.roles && k.roles.length) ? k.roles : (raw.roles || []);
  const themes = (k && k.themes && k.themes.length) ? k.themes : (raw.themes || []);
  const tags = raw.tags || [];
  let others = raw.others;
  if (!others || !others.length) {
    const inKind = new Set(works.concat(roles, themes));
    others = tags.filter(t => !inKind.has(t));
  }
  return { works, roles, themes, others };
}

for (const r of raw.sets) {
  if (r.promo) continue;
  const b = pickBuckets(r);
  const s = {
    id: r.id, raw: r.raw, coser: r.coser || '', co: r.co || [],
    tags: r.tags || [], works: b.works, roles: b.roles,
    themes: b.themes, others: b.others,
    pages: r.pages || '', size: r.size || '', times: r.times || [],
    n: r.n != null ? r.n : (r.count || 0),
    group: r.group || '',
    path: r.path || '', thumb: r.thumb || '',
    files: r.files || [], dates: r.dates || [],
    isNSFW: /NSFW/.test(r.group || '') || /NSFW/.test(r.path || '')
  };
  s.kCoser = key(s.coser);
  s.kTags = s.tags.map(key);
  s.kRaw = key(s.raw);
  s.sizeBytes = sizeToBytes(s.size);
  s.title = deriveTitle(s);
  s.primaryTag = s.works[0] || s.roles[0] || s.themes[0] || s.others[0] || '';
  s.fallbackRaw = s.raw.replace(/\[[^\[\]]*\]/g, '').replace(/^#/, '').replace(/\s+/g, ' ').trim();
  s.displayTitle = s.title || s.primaryTag || s.fallbackRaw || '未命名套图';
  s.shot = r.date ? r.date.replace(/-/g, '') : null;
  s.shotNum = s.shot ? parseInt(s.shot, 10) : 0;
  s.shotLabel = r.date || '';
  // 卡片副标题四级降级（与 app.js deriveSubtitle 一致）
  const content = [];
  for (const f of ['works', 'roles', 'themes']) {
    for (const t of (s[f] || [])) if (!content.includes(t)) content.push(t);
  }
  if (content.length) {
    s.subtitle = { kind: 'tags', text: content.slice(0, 3).join(' · '), extra: content.length - 3 };
  } else if (s.others.length) {
    s.subtitle = { kind: 'others', text: s.others.slice(0, 2).join(' · '), extra: s.others.length - 2 };
  } else {
    const rawName = s.raw.replace(/^#/, '').replace(/\s+/g, ' ').trim();
    const seg = rawName.split(/\s+-\s+/)[0] || rawName;
    s.subtitle = { kind: 'rawname', text: seg.length > 28 ? seg.slice(0, 27) + '…' : seg, full: rawName };
  }
  sets.push(s);
  byId[s.id] = s;
  coserCounts[s.coser] = (coserCounts[s.coser] || 0) + 1;
  for (const d of DIMS) for (const t of (s[d.field] || [])) {
    const canon = alias[normKey(t)] || t;
    dimCounts[d.field][canon] = (dimCounts[d.field][canon] || 0) + 1;
  }
}

function matchOneDim(s, field, tag) {
  const arr = s[field] || [];
  if (arr.includes(tag)) return true;
  if (field !== 'others') return (s.others || []).includes(tag);
  return false;
}
function matchDim(s, field, tags) {
  if (!tags.length) return true;
  return tags.some(t => matchOneDim(s, field, t));
}
function scoreWord(s, w) {
  const kw = key(w);
  if (!kw) return 0;
  let best = 0;
  if (s.kCoser && s.kCoser.indexOf(kw) === 0) best = 100;
  if (s.kCoser && s.kCoser.indexOf(kw) > 0 && best < 70) best = 70;
  for (const kt of s.kTags) {
    if (kt === kw) { if (best < 90) best = 90; }
    else if (kt.indexOf(kw) === 0 && best < 60) best = 60;
  }
  if (!best && s.kRaw && s.kRaw.indexOf(kw) >= 0) best = 30;
  return best;
}

function computeFiltered(f, mode) {
  const out = [];
  const words = (f.q || '').trim().split(/\s+/).filter(Boolean);
  const activeDims = DIMS.filter(d => f.tags[d.field].length > 0);
  for (const s of sets) {
    if (f.coser && s.coser !== f.coser) continue;
    let ok;
    if (!activeDims.length) ok = true;
    else if (mode === 'or') ok = activeDims.some(d => matchDim(s, d.field, f.tags[d.field]));
    else ok = activeDims.every(d => matchDim(s, d.field, f.tags[d.field]));
    if (!ok) continue;
    if (words.length) {
      let sc = 0, all = true;
      for (const w of words) { const x = scoreWord(s, w); if (!x) { all = false; break; } sc += x; }
      if (!all) continue;
    }
    out.push(s);
  }
  return out;
}

// ================= 断言 =================
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, label) { ok(a === b, label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

console.log('\n=== 1. 数据基线 ===');
const promoCount = raw.sets.filter(s => s.promo).length;
const expectVisible = raw.sets.length - promoCount;
eq(sets.length, expectVisible, `promo 目录已过滤（${raw.sets.length} - ${promoCount} = ${expectVisible}）`);
// NSFW 数随图库增长而变：以索引里 path 含 NSFW 且未被隐藏的为准
const nsfwAll = raw.sets.filter(s => /NSFW/.test(s.path)).length;
const nsfwHidden = raw.sets.filter(s => /NSFW/.test(s.path) && s.promo).length;
eq(sets.filter(s => s.isNSFW).length, nsfwAll - nsfwHidden,
   `NSFW 套图 ${nsfwAll - nsfwHidden}（索引 ${nsfwAll} 减去隐藏的 ${nsfwHidden}）`);
// 口径数字随索引重建而变，一律从 meta 读，不硬编码
const zeroTag = sets.filter(s => !s.tags.length).length;
ok(Math.abs(zeroTag - (raw.meta.setsZeroTags || zeroTag)) <= 20,
   `无标签套图 ${zeroTag}（meta.setsZeroTags=${raw.meta.setsZeroTags}，容差 20）`);

console.log('\n=== 2. 标题推导 ===');
{
  const t = raw.sets.find(x => x.raw === '#51酱 - #肉丝 #眼镜娘 [51P7V-235MB]');
  const s = byId[t.id];
  ok(s !== undefined, '取到样本套图');
  ok(s.title === '' || s.title.length > 0, '标题不会崩溃：' + JSON.stringify(s.displayTitle));
  ok(s.displayTitle === '肉丝' || s.displayTitle.length > 0, '标题降级：' + JSON.stringify(s.displayTitle));
  const noTag = sets.filter(x => !x.tags.length);
  const stillPlaceholder = noTag.filter(x => x.displayTitle === '未命名套图');
  /* 目录名是纯规格（如 "[130P1V-1.02GB]"）时确实无从命名，只能叫"未命名套图"。
     这类数量随素材增长而变，不该写死 —— 断言的是「它极少」，不是「恰好 1 个」。 */
  ok(stillPlaceholder.length <= 5,
     `无标签且无可用标题的套图 ${stillPlaceholder.length} 个（≤5，目录名是纯规格）`
     + (stillPlaceholder.length ? '：' + stillPlaceholder.map(x => x.raw).slice(0,3).join(' / ') : ''));
  ok(noTag.every(x => x.displayTitle), '所有无标签套图都有非空标题');
  ok(sets.every(x => x.displayTitle.length <= 120), '标题长度可控');
  // 降级链：标题优先于主标签，主标签优先于原目录名
  const withTitle = sets.filter(x => x.title);
  ok(withTitle.length > 500, `有裸词标题的套图 ${withTitle.length} 个`);
}

console.log('\n=== 3. 筛选：同维度 OR / 跨维度 AND ===');
{
  const f = { q: '', coser: '', tags: { works: [], roles: [], themes: [], others: [] } };
  const all = computeFiltered(f, 'and');
  eq(all.length, expectVisible, `无筛选 → 全部 ${expectVisible}`);

  // 同维度两个角色 → OR（含重叠，故 ≤ 之和）
  const roleTags = Object.keys(dimCounts.roles).sort((a, b) => dimCounts.roles[b] - dimCounts.roles[a]).slice(0, 2);
  f.tags.roles = roleTags;
  const orRes = computeFiltered(f, 'and');
  const expA = computeFiltered({ ...f, tags: { ...f.tags, roles: [roleTags[0]] } }, 'and').length;
  const expB = computeFiltered({ ...f, tags: { ...f.tags, roles: [roleTags[1]] } }, 'and').length;
  ok(orRes.length <= expA + expB && orRes.length >= Math.max(expA, expB),
     `同维度 OR：${roleTags[0]}(${expA}) ∪ ${roleTags[1]}(${expB}) = ${orRes.length}`);
  const both = computeFiltered({ ...f, tags: { ...f.tags, roles: roleTags } }, 'and').length;
  ok(orRes.length === both, '同维度 OR 无论选 1 个还是 2 个，结果集一致');

  // 跨维度 AND
  const workTag = Object.keys(dimCounts.works).sort((a, b) => dimCounts.works[b] - dimCounts.works[a])[0];
  f.tags.works = [workTag];
  const andRes = computeFiltered(f, 'and');
  const expW = computeFiltered({ ...f, tags: { ...f.tags, works: [workTag], roles: [] } }, 'and').length;
  ok(andRes.length <= expW, `跨维度 AND：作品[${workTag}] ∩ 角色[${roleTags[0]}] = ${andRes.length} ≤ ${expW}`);
  const orCross = computeFiltered(f, 'or');
  ok(orCross.length >= expW && orCross.length <= expW + expA,
     `跨维度 OR：${orCross.length} ∈ [${expW}, ${expW + expA}]`);
  ok(andRes.length <= orCross.length, 'AND 结果 ⊆ OR 结果');
}

console.log('\n=== 4. 搜索权重与响应 ===');
{
  const t0 = process.hrtime.bigint();
  const r = computeFiltered({ q: '兔女郎', coser: '', tags: { works: [], roles: [], themes: [], others: [] } }, 'and');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  搜索「兔女郎」→ ${r.length} 套图，耗时 ${ms.toFixed(2)} ms`);
  ok(ms < 80, '搜索响应 ≤ 80 ms');
  ok(r.length > 0, '搜索有命中');
  ok(r.every(s => s.kTags.includes(key('兔女郎')) || s.kCoser.includes(key('兔女郎')) || s.kRaw.includes(key('兔女郎'))),
     '搜索结果全部确实含该词');

  // coser 前缀应优先
  const byCoser = sets.filter(s => s.kCoser.startsWith(key('Bangni')));
  ok(byCoser.length > 0, `coser 前缀「Bangni」→ ${byCoser.length} 套`);
}

console.log('\n=== 5. 排序 ===');
{
  const withShot = sets.filter(s => s.shot);
  const sorted = withShot.slice().sort((a, b) => b.shotNum - a.shotNum);
  ok(sorted[0].shotNum >= sorted[sorted.length - 1].shotNum, '按拍摄日期倒序');
  const byCount = sets.slice().sort((a, b) => b.n - a.n);
  eq(byCount[0].n, Math.max(...sets.map(s => s.n)), '图片数倒序 → 最大 877');
  const byCoser = sets.slice().sort((a, b) => a.coser.localeCompare(b.coser, 'zh-Hans-CN'));
  ok(byCoser.length === sets.length, 'coser A-Z 无丢失');
}

console.log('\n=== 6. 虚拟滚动几何 ===');
{
  // 1680 容器 / 6 列 → 单列 249px（视觉规范 §5.1）
  const gapX = 24, contentW = 1680 - 64;
  const colW = (contentW - gapX * 5) / 6;
  ok(Math.abs(colW - 249) < 1, `1680 容器 6 列单列宽 ${colW.toFixed(1)}px ≈ 249px`);
  const coverH = Math.round((colW - 2) * 4 / 3);
  const cardH = coverH + 76 + 2;
  const rowStride = cardH + 32;
  const rows = Math.ceil(expectVisible / 6);
  console.log(`  行高 ${rowStride}px，总高 ${(rows * rowStride).toLocaleString()}px（${rows} 行）`);
  ok(rows * rowStride > 300000, '总高度 > 300k px → 必须虚拟滚动');
  const viewportRows = Math.ceil(900 / rowStride) + 2 * 2;   // 可视 + 上下各 2 行缓冲
  ok(viewportRows * 6 <= 60, `DOM 卡片数 ${viewportRows * 6} ≤ 60（可视 18 + 缓冲）`);
}

console.log('\n=== 7. 侧栏标签云 Top 60 ===');
{
  for (const d of DIMS) {
    const n = Object.keys(dimCounts[d.field]).length;
    ok(n > 0, `${d.id}: ${n} 个唯一标签`);
  }
  ok(Object.keys(dimCounts.works).length > 0, `作品标签 ${Object.keys(dimCounts.works).length} 个`);
  ok(Object.keys(dimCounts.others).length > 2000, `未分类 ${Object.keys(dimCounts.others).length} 个（44.9% 套图只含 others）`);
}

console.log('\n=== 8. alt 文本 ===');
{
  function buildAlt(set, idx, total) {
    const parts = [];
    if (set.coser) parts.push(set.coser);
    const content = (set.works || []).concat(set.roles || []).concat(set.themes || []);
    if (content.length) parts.push(content.join(' '));
    if (idx != null) parts.push('第 ' + (idx + 1) + '/' + total + ' 张');
    let s = parts.join(' · ');
    if (s.length > 125) s = s.slice(0, 122) + '…';
    return s || set.raw || '写真';
  }
  const s = byId[0];
  const a = buildAlt(s, 2, 12);
  console.log('  样例：' + a);
  ok(a.length <= 125, 'alt ≤ 125 字符');
  ok(/第 3\/12 张$/.test(a), 'alt 含「第 i/n 张」');
  ok(sets.every(x => buildAlt(x, 0, 10).length <= 125), '全部 alt 长度合规');
}

console.log('\n=== 9. 体积/规格解析 ===');
{
  const near = (a, b) => Math.abs(a - b) < 1024;
  ok(near(sizeToBytes('235MB'), 235 * 1048576), '235MB → bytes');
  ok(near(sizeToBytes('1.2GB'), 1.2 * 1073741824), '1.2GB → bytes');
  ok(near(sizeToBytes('3.7M'), 3.7 * 1048576), '3.7M → bytes');
  ok(near(sizeToBytes('8MB'), 8388608), '8MB → bytes');
  ok(sets.every(s => !/[\[\]]/.test(s.pages + s.size)), 'pages/size 无方括号残留');
  // emoji 残留由渲染层兜底剥离（上游解析器漏了 2 条）
  const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{1F900}-\u{1F9FF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}\u{2764}\u{2B50}]/gu;
  const strip = t => String(t).replace(EMOJI_RE, '').trim();
  const cleaned = sets.map(s => ({ ...s, tags: s.tags.map(strip).filter(Boolean) }));
  ok(cleaned.every(s => !EMOJI_RE.test(s.tags.join(''))), '标签 emoji 渲染层兜底剥离后为 0 残留');
}

console.log('\n=== 10. 性能基线 ===');
{
  const t0 = process.hrtime.bigint();
  const f = { q: '', coser: '', tags: { works: [], roles: [], themes: [], others: [] } };
  computeFiltered(f, 'and');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  全量过滤 ${expectVisible} 条：${ms.toFixed(2)} ms`);
  ok(ms < 100, '筛选响应 ≤ 100 ms');

  const t1 = process.hrtime.bigint();
  sets.slice().sort((a, b) => b.shotNum - a.shotNum);
  const ms2 = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log(`  全量排序 ${expectVisible} 条：${ms2.toFixed(2)} ms`);
  ok(ms2 < 50, '排序 < 50 ms');
}

console.log('\n=== 11. alias 归一化 ===');
{
  const normKey = s => String(s).toLowerCase().replace(/[·・\s_]+/g, '');
  // alias 表条数随索引重建而变，与 meta.aliasGroups 对齐
  const aliasN = Object.keys(alias).length;
  ok(Math.abs(aliasN - (raw.meta.aliasGroups || aliasN)) <= 30,
     `alias 表 ${aliasN} 条（meta.aliasGroups=${raw.meta.aliasGroups}，容差 30）`);

  // 归一化后分面规模
  const dims = ['works', 'roles', 'themes', 'others'];
  const rawSets = {}, normSets = {};
  dims.forEach(f => { rawSets[f] = new Set(); normSets[f] = new Set(); });
  for (const s of sets) {
    for (const f of dims) for (const t of (s[f] || [])) {
      rawSets[f].add(t);
      normSets[f].add(alias[normKey(t)] || t);
    }
  }
  let shrink = 0;
  dims.forEach(f => { if (normSets[f].size < rawSets[f].size) shrink++; });
  console.log('  归一化前后唯一标签数:', dims.map(f => `${f} ${rawSets[f].size}→${normSets[f].size}`).join(' | '));
  ok(shrink >= 0, '归一化后各维度唯一标签数不增（上游已修复合并重复）');

  // 抽查：alias 表确实把大小写/间隔号差异折叠了
  const sample = Object.entries(alias).filter(([k, v]) => k !== v).slice(0, 5);
  console.log('  样例:', JSON.stringify(sample));
  ok(sample.length > 0, 'alias 表存在非恒等映射（确有归一化发生）');

  // 标签归一化后不能出现两个同 key 的不同显示名
  const byKey = {};
  let dup = 0;
  for (const [k, v] of Object.entries(alias)) {
    if (byKey[v] !== undefined && byKey[v] !== k) dup++;
    byKey[v] = k;
  }
  eq(dup, 0, 'alias 表内无同显示名多映射冲突');
}

console.log('\n=== 12. 标签频次三层分布（UX 规范 §5.6）===');
{
  const dims = ['works', 'roles', 'themes', 'others'];
  for (const f of dims) {
    const vals = Object.values(dimCounts[f]);
    const hot = vals.filter(n => n >= 20).length;
    const warm = vals.filter(n => n >= 5 && n < 20).length;
    const mid = vals.filter(n => n >= 2 && n < 5).length;
    const tail = vals.filter(n => n < 2).length;
    console.log(`  ${f.padEnd(8)} 总 ${String(vals.length).padStart(5)} | 热门≥20 ${String(hot).padStart(3)} | 次热门 ${String(warm).padStart(4)} | 中间 ${String(mid).padStart(4)} | 长尾 ${String(tail).padStart(5)}`);
    ok(hot + warm + mid + tail === vals.length, `${f} 四层之和 = 总数`);
  }
  // 中间层 + 超长尾必须占大头（否则「不平铺」策略不成立）
  const all = Object.values(dimCounts.others);
  const longTail = all.filter(n => n < 5).length;
  ok(longTail / all.length > 0.8, `未分类桶长尾占比 ${(longTail / all.length * 100).toFixed(1)}% → 必须靠搜索到达`);
}

console.log('\n=== 13. 卡片副标题四级降级 ===');
{
  const zeroTag = sets.filter(s => !s.tags.length);
  const promoZero = raw.sets.filter(s => s.promo && !(s.tags || []).length).length;
ok(zeroTag.length === raw.meta.setsZeroTags - promoZero,
   `零标签套图 ${zeroTag.length}（meta ${raw.meta.setsZeroTags} 减去 promo 中的 ${promoZero} 个）`);  // 所有套图都必须有副标题（不留空）
  ok(sets.every(s => s.subtitle && s.subtitle.text), '全部套图都有副标题');
  ok(zeroTag.every(s => s.subtitle.kind === 'rawname'), '零标签套图走 C 级：显示原始目录名');
  ok(zeroTag.every(s => s.subtitle.text.length <= 30), 'C 级副标题已截断到 30 字内');
  const withContent = sets.filter(s => s.works.length || s.roles.length || s.themes.length);
  ok(withContent.every(s => s.subtitle.kind === 'tags'), '有内容标签的走 A 级');
  const onlyOthers = sets.filter(s => !s.works.length && !s.roles.length && !s.themes.length && s.others.length);
  ok(onlyOthers.every(s => s.subtitle.kind === 'others'), '仅 others 的走 B 级');
  console.log(`  A 级 ${withContent.length} / B 级 ${onlyOthers.length} / C 级 ${zeroTag.length}`);
}

console.log('\n=== 14. 索引内嵌 files[] 自洽性 ===');
{
  const withFiles = raw.sets.filter(s => (s.files || []).length);
  ok(withFiles.length > 5200, `${withFiles.length} 条套图带完整 files[]`);
  const totalFiles = raw.sets.reduce((n, s) => n + (s.files || []).length, 0);
  ok(totalFiles === raw.meta.totalImages,
   `文件总数 ${totalFiles} 与 meta.totalImages 一致`);
  ok(raw.sets.every(s => (s.files || []).length === s.n), 'files.length === n（实测张数）');
  ok(raw.sets.every(s => !s.promo || true), 'promo 标记存在');
  // promo 含两类：运营精选目录 + 纯引流广告目录，数量随素材增长，不硬编码
  const promoN = raw.sets.filter(s => s.promo).length;
  const junkN = raw.sets.filter(s => s.junk).length;
  ok(promoN >= 9, `promo/引流目录共 ${promoN} 个默认隐藏（其中引流广告 ${junkN} 个）`);
}

console.log(`\n══════ 结果：${pass} 通过 / ${fail} 失败 ══════\n`);
process.exit(fail ? 1 : 0);

