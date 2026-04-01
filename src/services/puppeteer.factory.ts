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
    '--single-process',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-infobars',
      '--window-size=1280,800',
      `--user-data-dir=${sessionPath}`, 
    ],
  };
};



export const applyPageOptimizations = async (page: any) => {
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  );

  await page.setViewport({ width: 1280, height: 800 });

  // Reduce resource usage
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });
};
