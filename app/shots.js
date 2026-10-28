// 截图：用于人工核对视觉规范
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8777/';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 950 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('.card');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'shot-01-grid.png' });

  // 滚到中段
  await page.evaluate(() => { document.getElementById('grid-scroll').scrollTop = 80000; });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'shot-02-grid-scrolled.png' });

  // 浅色
  await page.click('#theme-toggle');
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'shot-03-light.png' });
  await page.click('#theme-toggle');
  await page.waitForTimeout(500);

  // 标签浏览
  await page.evaluate(() => { document.querySelector('[data-nav="tags"]').click(); });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'shot-04-tags.png' });

  // 最近新增
  await page.evaluate(() => { document.querySelector('[data-nav="recent"]').click(); });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'shot-05-recent.png' });

  // 套图页
  await page.evaluate(() => { document.querySelector('[data-nav="grid"]').click(); });
  await page.waitForTimeout(900);
  await page.evaluate(() => { document.querySelector('.card').click(); });
  await page.waitForSelector('#set-grid .set-cell');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'shot-06-set.png' });

  // 灯箱
  await page.evaluate(() => { document.querySelectorAll('#set-grid .set-cell')[1].click(); });
  await page.waitForSelector('#lightbox[data-open="1"]');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'shot-07-lightbox.png' });

  // 灯箱 · 面板收起
  await page.evaluate(() => { document.getElementById('lb-info').click(); });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'shot-08-lightbox-nopanel.png' });

  // 移动端
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await m.newPage();
  await mp.goto(BASE, { waitUntil: 'load' });
  await mp.waitForSelector('.card');
  await mp.waitForTimeout(2500);
  await mp.screenshot({ path: 'shot-09-mobile.png' });

  await browser.close();
  console.log('截图完成');
})();
