/**
 * 移动端验收（team-lead 指定的 7 条标准）
 * 用法：node mobile-check.js
 */
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:8777/index.html';
let pass = 0, fail = 0;

function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });

  /* ============ iPhone 13 视口 ============ */
  console.log('\n=== 移动端 390×844 (DPR 3, touch) ===');
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('.card');
  await page.waitForTimeout(1500);

  const m = await page.evaluate(() => {
    const app = document.getElementById('app');
    /* 只统计真正可见的卡片（排除 hidden 的空槽位） */
    const cards = [...document.querySelectorAll('#grid-scroll .card')].filter(c => !c.hidden);
    const xs = [...new Set(cards.map(c => Math.round(c.getBoundingClientRect().x)))].sort((a, b) => a - b);
    const r = cards[0].getBoundingClientRect();
    const cover = cards[0].querySelector('.card-cover').getBoundingClientRect();
    return {
      gtc: getComputedStyle(app).gridTemplateColumns,
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      distinctX: xs.length, xs,
      cardW: Math.round(r.width), cardH: Math.round(r.height),
      coverW: Math.round(cover.width), coverH: Math.round(cover.height),
      visibleCards: cards.length
    };
  });
  console.log('  ' + JSON.stringify(m, null, 1).replace(/\n/g, '\n  '));

  ok(!m.gtc.includes('248px'), `gridTemplateColumns 不含 248px（实际 "${m.gtc}"）`);
  ok(m.scrollW <= m.innerW, `无横向溢出（scrollWidth ${m.scrollW} ≤ innerWidth ${m.innerW}）`);
  ok(m.distinctX === 2, `2 列（x 去重 ${m.distinctX} 个：${m.xs.join(', ')}）`);
  ok(m.cardW >= 160 && m.cardW <= 185, `卡片宽 160–185（实际 ${m.cardW}px）`);
  ok(m.cardH >= 280 && m.cardH <= 340, `卡片高 280–340（实际 ${m.cardH}px）`);

  /* 抽屉仍可用 */
  const drawer = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    document.getElementById('sidebar-toggle').click();
    await wait(450);
    const open = {
      scrim: getComputedStyle(document.getElementById('sidebar-scrim')).display,
      sbW: Math.round(document.getElementById('sidebar').getBoundingClientRect().width),
      gtc: getComputedStyle(document.getElementById('app')).gridTemplateColumns
    };
    document.getElementById('sidebar-scrim').click();
    await wait(450);
    const closed = { scrim: getComputedStyle(document.getElementById('sidebar-scrim')).display };
    return { open, closed };
  });
  console.log('  抽屉:', JSON.stringify(drawer));
  ok(drawer.open.scrim === 'block', '抽屉可展开');
  ok(!drawer.open.gtc.includes('248px'), '抽屉展开时主区 grid 仍不含 248px（不挤压内容）');
  ok(drawer.closed.scrim === 'none', '点遮罩可关闭抽屉');

  /* 套图页仍 2 列 */
  await page.evaluate(() => { document.querySelector('.card').click(); });
  await page.waitForSelector('#set-grid .set-cell', { timeout: 15000 });
  await page.waitForTimeout(800);
  const setGrid = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('#set-grid .set-cell')];
    const xs = [...new Set(cells.map(c => Math.round(c.getBoundingClientRect().x)))];
    const cs = getComputedStyle(document.getElementById('set-grid'));
    return { cols: xs.length, template: cs.gridTemplateColumns.split(' ').length, gap: cs.gap, n: cells.length };
  });
  console.log('  套图页:', JSON.stringify(setGrid));
  ok(setGrid.cols === 2, `套图页仍 2 列（实际 ${setGrid.cols}）`);

  /* 灯箱在手机上可用 */
  await page.evaluate(() => { document.querySelectorAll('#set-grid .set-cell')[0].click(); });
  await page.waitForSelector('#lightbox[data-open="1"]', { timeout: 15000 });
  await page.waitForTimeout(1200);
  const lbMobile = await page.evaluate(() => {
    const img = document.getElementById('lb-main');
    const r = img.getBoundingClientRect();
    return {
      open: document.getElementById('lightbox').dataset.open,
      loaded: img.classList.contains('is-loaded'),
      imgW: Math.round(r.width), imgH: Math.round(r.height),
      overflowX: document.documentElement.scrollWidth > window.innerWidth
    };
  });
  console.log('  灯箱:', JSON.stringify(lbMobile));
  ok(lbMobile.open === '1' && lbMobile.loaded, '手机端灯箱可打开并加载原图');
  ok(!lbMobile.overflowX, '灯箱未造成横向溢出');

  ok(errors.length === 0, `无 JS 报错（${errors.length} 条）`);
  await ctx.close();

  /* ============ 极窄机 320px ============ */
  console.log('\n=== 极窄机 320×568（应降为 1 列）===');
  const ctx2 = await browser.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p2 = await ctx2.newPage();
  await p2.goto(BASE, { waitUntil: 'load' });
  await p2.waitForSelector('.card');
  await p2.waitForTimeout(1200);
  const narrow = await p2.evaluate(() => {
    const cards = [...document.querySelectorAll('#grid-scroll .card')].filter(c => !c.hidden);
    const xs = [...new Set(cards.map(c => Math.round(c.getBoundingClientRect().x)))];
    return {
      cols: xs.length,
      cardW: Math.round(cards[0].getBoundingClientRect().width),
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      gtc: getComputedStyle(document.getElementById('app')).gridTemplateColumns
    };
  });
  console.log('  ' + JSON.stringify(narrow));
  ok(narrow.cols === 1, `320px → 1 列（实际 ${narrow.cols}）`);
  ok(!narrow.overflow && !narrow.gtc.includes('248px'), '320px 无溢出、侧栏不占位');
  await ctx2.close();

  /* ============ 平板 768/1024 不回归 ============ */
  console.log('\n=== 平板 / 桌面回归 ===');
  const cases = [
    { w: 768, want: 3, name: '768px' },
    { w: 1024, want: 4, name: '1024px' },
    { w: 1280, want: 5, name: '1280px' },
    { w: 1600, want: 6, name: '1600px' },
    { w: 1920, want: 6, name: '1920px' }
  ];
  const ctx3 = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const p3 = await ctx3.newPage();
  await p3.goto(BASE, { waitUntil: 'load' });
  await p3.waitForSelector('.card');
  for (const c of cases) {
    await p3.setViewportSize({ width: c.w, height: 950 });
    await p3.waitForTimeout(600);
    const r = await p3.evaluate(() => {
      const row = document.querySelector('#grid-scroll .grid-row');
      const cards = [...document.querySelectorAll('#grid-scroll .card')].filter(x => !x.hidden);
      const xs = [...new Set(cards.map(x => Math.round(x.getBoundingClientRect().x)))];
      return {
        cols: xs.length,
        slotCols: row ? Number(row.dataset.cols) : 0,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        sbW: Math.round(document.getElementById('sidebar').getBoundingClientRect().width)
      };
    });
    console.log(`  ${c.name} → ${r.cols} 列（行槽位 ${r.slotCols}），侧栏 ${r.sbW}px，溢出 ${r.overflow}`);
    ok(r.cols === c.want, `${c.name} → ${c.want} 列`);
    ok(!r.overflow, `${c.name} 无横向溢出`);
  }
  await ctx3.close();

  await browser.close();
  console.log(`\n══════ 移动端验收：${pass} 通过 / ${fail} 失败 ══════\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃:', e); process.exit(1); });
