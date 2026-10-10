// Smoke test: the app shell renders without critical JavaScript errors (no Firebase, no emulator).

import { BASE_URL, launchBrowser, isErrorIgnorable, screenshotDirFor } from './e2e-full-game.mjs';
import { join } from 'path';

async function testBrowser() {
  const browser = await launchBrowser(process.env.BROWSER || 'firefox');
  const page = await browser.newPage();

  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });
  page.on('pageerror', err => {
    errors.push(err.message);
  });
  // nothing may talk to Firebase / Google backends any more
  const backendRequests = [];
  page.on('request', req => {
    if (/firebase|firestore|identitytoolkit|securetoken/i.test(req.url())) backendRequests.push(req.url());
  });

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForFunction(() => (document.body.textContent || '').includes('The Resistance Online'), null, { timeout: 30000 });
    await page.waitForTimeout(2000);

    await page.screenshot({ path: join(screenshotDirFor('browser'), 'browser-test.png'), fullPage: true });

    const title = await page.title();
    console.log('Page title:', title);
    const appExists = await page.$('#app');
    console.log('App div exists:', !!appExists);
    const bodyText = (await page.textContent('body')) ?? '';
    console.log('Body snippet:', bodyText.substring(0, 200));

    if (!appExists || !bodyText.includes('The Resistance Online')) {
      console.error('FAIL: app did not render (app div: ' + !!appExists + ')');
      process.exitCode = 1;
    }

    if (backendRequests.length > 0) {
      console.error('FAIL: the page still talks to Firebase:', backendRequests.slice(0, 3).join(', '));
      process.exitCode = 1;
    }

    const criticalErrors = errors.filter(e => !isErrorIgnorable(e) && !e.includes('404'));
    if (criticalErrors.length > 0) {
      console.log('CRITICAL ERRORS found:');
      criticalErrors.forEach(e => console.log('  -', e));
      process.exitCode = 1;
    } else {
      console.log('No critical JavaScript errors detected');
      if (errors.length > 0) {
        console.log('Non-critical errors (expected - network):');
        errors.forEach(e => console.log('  -', e.substring(0, 100)));
      }
    }
  } catch (err) {
    console.error('Test failed:', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

testBrowser();
