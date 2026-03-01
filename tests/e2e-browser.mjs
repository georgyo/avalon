import { firefox } from 'playwright';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const screenshotDir = join(__dirname, 'screenshots');
mkdirSync(screenshotDir, { recursive: true });

async function testBrowser() {
  const browser = await firefox.launch({ headless: true });
  const page = await browser.newPage();

  // Collect console errors
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });
  page.on('pageerror', err => {
    errors.push(err.message);
  });

  try {
    await page.goto('http://localhost:5173/', { waitUntil: 'networkidle', timeout: 30000 });

    // Wait a bit for any async errors
    await page.waitForTimeout(3000);

    // Take a screenshot for verification
    await page.screenshot({ path: join(screenshotDir, 'browser-test.png'), fullPage: true });

    // Check if the page loaded correctly
    const title = await page.title();
    console.log('Page title:', title);

    // Check for the app div
    const appExists = await page.$('#app');
    console.log('App div exists:', !!appExists);

    // Check for any visible content
    const bodyText = await page.textContent('body');
    console.log('Body has content:', bodyText.length > 0);
    console.log('Body snippet:', bodyText.substring(0, 200));

    // Filter out non-critical errors
    const criticalErrors = errors.filter(e =>
      !e.includes('api.mailcheck') &&
      !e.includes('net::ERR') &&
      !e.includes('favicon') &&
      !e.includes('Failed to fetch') &&
      !e.includes('404') &&
      !e.includes('WebSocket') &&
      !e.includes('NetworkError')
    );

    if (criticalErrors.length > 0) {
      console.log('CRITICAL ERRORS found:');
      criticalErrors.forEach(e => console.log('  -', e));
      process.exit(1);
    } else {
      console.log('No critical JavaScript errors detected');
      if (errors.length > 0) {
        console.log('Non-critical errors (expected - network):');
        errors.forEach(e => console.log('  -', e.substring(0, 100)));
      }
    }
  } catch (err) {
    console.error('Test failed:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

testBrowser();
