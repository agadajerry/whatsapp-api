import puppeteer from 'puppeteer-extra';
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
import * as fs from 'fs';

puppeteer.use(StealthPlugin());

export const createPuppeteerConfig = (sessionPath: string) => {
  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }

  return {
    headless: true,
    executablePath: require('puppeteer').executablePath(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--disable-gpu',
      '--disable-infobars',
      '--window-size=1280,800',
      '--no-zygote'
      // ✅ REMOVED: --single-process  → crashes Chromium's renderer/browser IPC
     
      // ✅ REMOVED: --user-data-dir   → conflicts with LocalAuth's own dataPath
    ],
  };
};

export const applyPageOptimizations = async (page: any) => {
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  );

  await page.setViewport({ width: 1280, height: 800 });

  // ✅ Only block fonts — images/stylesheets are needed for WhatsApp Web to
  //    render the post-QR authenticated shell correctly.
  await page.setRequestInterception(true);
  page.on('request', (req: any) => {
    if (req.resourceType() === 'font') {
      req.abort();
    } else {
      req.continue();
    }
  });
};