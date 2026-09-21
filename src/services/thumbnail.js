'use strict';

/**
 * Thumbnail service — generates a real PNG capture of the first page
 * of a document (PDF, DOCX, PPTX, etc.) using puppeteer-core +
 * @sparticuz/chromium. Works on Vercel serverless AND Railway/VPS.
 *
 * Flow:
 *   1. Build a Google Docs Viewer URL from the document download URL
 *   2. Launch headless Chromium
 *   3. Wait for the first page to render
 *   4. Screenshot just the first page area
 *   5. Return PNG buffer (cached in memory for 1 hour)
 */

const { TtlCache } = require('./cache');

// Cache thumbnails for 1 hour — documents rarely change
const thumbCache = new TtlCache(60 * 60 * 1000, 500);

let _browser = null;
let _browserLaunchTime = null;
const BROWSER_MAX_AGE_MS = 10 * 60 * 1000; // recycle browser every 10 min

async function getBrowser() {
  const now = Date.now();
  // Recycle stale browser
  if (_browser && _browserLaunchTime && (now - _browserLaunchTime) > BROWSER_MAX_AGE_MS) {
    try { await _browser.close(); } catch (_) {}
    _browser = null;
  }
  if (_browser) return _browser;

  let chromium, puppeteer;
  try {
    chromium  = require('@sparticuz/chromium');
    puppeteer = require('puppeteer-core');
  } catch (err) {
    throw new Error('puppeteer-core or @sparticuz/chromium not installed: ' + err.message);
  }

  _browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    ignoreHTTPSErrors: true,
  });
  _browserLaunchTime = Date.now();
  return _browser;
}

/**
 * Generate a thumbnail PNG of the first page of a document.
 * @param {string} fileDownloadUrl  - full URL to download the document
 * @param {string} cacheKey         - unique key (e.g. "drive_42" or "cfile_99")
 * @returns {Buffer|null}           - PNG image buffer, or null on failure
 */
async function generateThumbnail(fileDownloadUrl, cacheKey) {
  // Check cache first
  const cached = thumbCache.get(cacheKey);
  if (cached) return cached;

  try {
    // Build Google Docs Viewer URL — renders the document in a browser
    const viewerUrl = `https://docs.google.com/viewer?url=${encodeURIComponent(fileDownloadUrl)}&embedded=true`;

    const browser = await getBrowser();
    const page = await browser.newPage();

    try {
      await page.setViewport({ width: 800, height: 1100 });

      // Navigate to Google Docs Viewer
      await page.goto(viewerUrl, {
        waitUntil: 'networkidle2',
        timeout: 25000,
      });

      // Wait for the document page to appear
      await page.waitForSelector('.drive-viewer-paginated-page, .page, canvas, iframe', {
        timeout: 15000,
      }).catch(() => {
        // Selector may not exist — proceed anyway
      });

      // Extra wait for render
      await new Promise(r => setTimeout(r, 2000));

      // Screenshot the first page area only
      const screenshot = await page.screenshot({
        type: 'jpeg',
        quality: 80,
        clip: { x: 0, y: 0, width: 800, height: 520 },
      });

      // Cache it
      thumbCache.set(cacheKey, screenshot);
      return screenshot;

    } finally {
      await page.close().catch(() => {});
    }
  } catch (err) {
    console.warn(`[thumbnail] Failed for ${cacheKey}:`, err.message);
    return null;
  }
}

module.exports = { generateThumbnail };
