import { setStatus, appendLog } from './store.js';

const BASE        = 'https://www.recreation.gov';
const TICKET_URL  = `${BASE}/ticket/253731/ticket/255`;
const RETRY_MS    = 300;
const MAX_WAIT_MS = 270_000; // 4.5 min — leaves room inside the 300s limit

function visitDate(override) {
  if (override) return override;
  const pt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  pt.setDate(pt.getDate() + 2);
  return `${pt.getMonth() + 1}/${pt.getDate()}/${pt.getFullYear()}`;
}

async function launchBrowser() {
  if (process.env.CHROME_EXECUTABLE_PATH) {
    // Local dev: use the system Chrome specified by CHROME_EXECUTABLE_PATH
    const puppeteer = await import('puppeteer-core');
    return puppeteer.default.launch({
      executablePath: process.env.CHROME_EXECUTABLE_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 1280, height: 800 },
    });
  }

  // Vercel / Lambda: use @sparticuz/chromium
  const chromium = (await import('@sparticuz/chromium')).default;
  const puppeteer = await import('puppeteer-core');
  return puppeteer.default.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
}

// Find a button by text content (XPath) and return it if enabled, null otherwise.
async function findEnabledButton(page, ...labels) {
  for (const label of labels) {
    const [el] = await page.$x(
      `//button[contains(normalize-space(.), '${label}') and not(@disabled) and not(@aria-disabled='true')]`
    );
    if (el) return el;
  }
  return null;
}

export async function runBooking({ dateOverride = null } = {}) {
  const email    = process.env.RECGOV_EMAIL;
  const password = process.env.RECGOV_PASSWORD;

  if (!email || !password) {
    await setStatus({ state: 'failed', message: 'RECGOV_EMAIL / RECGOV_PASSWORD not set' });
    return { ok: false };
  }

  const dateStr = visitDate(dateOverride);
  await setStatus({ state: 'running', message: `Booking for ${dateStr}`, log: '', timestamp: Date.now() });

  const log = async (msg) => { console.log(msg); await appendLog(msg); };

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    );

    // ── Login ────────────────────────────────────────────────────────────────
    await log('Loading recreation.gov...');
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Click "Sign In" link or button
    const signInEl =
      (await findEnabledButton(page, 'Sign In')) ??
      (await page.$('a[href*="signin"], a[href*="login"]'));
    if (!signInEl) throw new Error('Could not find Sign In link on homepage');
    await signInEl.click();

    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15_000 });
    await log('Entering credentials...');
    await page.type('input[type="email"], input[name="email"]', email, { delay: 40 });
    await page.type('input[type="password"], input[name="password"]', password, { delay: 40 });
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25_000 });
    await log('Logged in.');

    // ── Load ticket page ─────────────────────────────────────────────────────
    const ticketUrl = `${TICKET_URL}?date=${encodeURIComponent(dateStr)}`;
    await log(`Loading ticket page for ${dateStr}...`);
    await page.goto(ticketUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // ── Add-to-cart loop ─────────────────────────────────────────────────────
    await log('Waiting for Add to Cart...');
    let booked    = false;
    let attempts  = 0;
    const deadline = Date.now() + MAX_WAIT_MS;

    while (!booked && Date.now() < deadline) {
      attempts++;

      // Evaluate + click inside the page to avoid extra network round-trips
      const result = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b =>
          /add to cart|book now|reserve/i.test(b.textContent) &&
          !b.disabled &&
          b.getAttribute('aria-disabled') !== 'true'
        );
        if (!btn) return 'not-found';
        btn.click();
        return 'clicked';
      });

      if (result === 'clicked') {
        await log(`Clicked! Waiting for cart confirmation (attempt ${attempts})...`);
        try {
          await page.waitForFunction(
            () =>
              window.location.href.includes('cart') ||
              window.location.href.includes('checkout') ||
              !!document.querySelector('[class*="cart-confirm"], [data-testid*="cart"]'),
            { timeout: 5_000, polling: 100 }
          );
          booked = true;
          await log('Added to cart!');
          break;
        } catch {
          // Click didn't stick — keep looping
        }
      }

      if (attempts % 50 === 0) await log(`Still waiting... attempt ${attempts}`);

      await new Promise(r => setTimeout(r, RETRY_MS));

      // Reload every ~15 s to get fresh availability state
      if (attempts % 50 === 0) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 });
      }
    }

    if (!booked) {
      await setStatus({ state: 'failed', message: `Could not add to cart after ${attempts} attempts` });
      return { ok: false };
    }

    // ── Checkout ─────────────────────────────────────────────────────────────
    await log('Navigating to cart...');
    if (!page.url().includes('cart')) {
      await page.goto(`${BASE}/cart`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }

    const checkoutBtn = await findEnabledButton(page, 'Checkout', 'Proceed to Checkout', 'Continue');
    if (!checkoutBtn) throw new Error('Checkout button not found');
    await checkoutBtn.click();
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 });

    await log('Placing order...');
    const confirmBtn = await findEnabledButton(page, 'Place Order', 'Complete Purchase', 'Confirm', 'Submit');
    if (confirmBtn) await confirmBtn.click();

    try {
      await page.waitForSelector(
        '[class*="confirmation"], [class*="order-number"], [class*="success"]',
        { timeout: 30_000 }
      );
      await log('ORDER PLACED SUCCESSFULLY!');
    } catch {
      await log('Could not detect confirmation page — check your email / account.');
    }

    await setStatus({ state: 'success', message: `Booked for ${dateStr}!`, timestamp: Date.now() });
    return { ok: true, dateStr };

  } catch (err) {
    const msg = err.message ?? String(err);
    await log(`Error: ${msg}`);
    await setStatus({ state: 'failed', message: msg, timestamp: Date.now() });
    return { ok: false, error: msg };
  } finally {
    await browser.close();
  }
}
