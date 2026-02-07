import { chromium } from 'playwright';

async function testBrowser() {
  const browser = await chromium.launch({ headless: true });
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
    await page.screenshot({ path: '/home/user/avalon/browser-test.png', fullPage: true });

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

    // Filter out non-critical errors (like Firebase/network errors which are expected)
    const criticalErrors = errors.filter(e =>
      !e.includes('Firebase') &&
      !e.includes('firestore') &&
      !e.includes('api.mailcheck') &&
      !e.includes('net::ERR') &&
      !e.includes('favicon') &&
      !e.includes('Failed to fetch') &&
      !e.includes('404')
    );

    if (criticalErrors.length > 0) {
      console.log('CRITICAL ERRORS found:');
      criticalErrors.forEach(e => console.log('  -', e));
      process.exit(1);
    } else {
      console.log('No critical JavaScript errors detected');
      if (errors.length > 0) {
        console.log('Non-critical errors (expected - network/Firebase):');
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
