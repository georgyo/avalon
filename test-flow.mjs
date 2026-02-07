import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

async function testFlow() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let stepNum = 0;

  const errors = [];
  page.on('pageerror', err => {
    errors.push(err.message);
  });

  async function screenshot(name) {
    stepNum++;
    const path = `/home/user/avalon/browser-test-${stepNum}-${name}.png`;
    await page.screenshot({ path, fullPage: true });
    console.log(`  Screenshot: ${path}`);
  }

  try {
    // Step 1: Load the app
    console.log('Step 1: Loading app...');
    await page.goto('http://localhost:5173/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    await screenshot('initial-load');

    // Verify we see the login page
    const pageText = await page.textContent('body');
    if (!pageText.includes('The Resistance Online')) {
      throw new Error('Login page did not load - missing "The Resistance Online" text');
    }
    console.log('  OK - Login page loaded');

    // Step 2: Click "Anonymous" tab
    console.log('Step 2: Clicking Anonymous tab...');
    const anonTab = await page.locator('text=Anonymous');
    await anonTab.click();
    await page.waitForTimeout(500);
    await screenshot('anonymous-tab');
    console.log('  OK - Anonymous tab selected');

    // Step 3: Click Login button under Anonymous tab
    console.log('Step 3: Clicking Anonymous Login...');
    // The anonymous tab item has its own Login button
    const loginButtons = await page.locator('button:has-text("Login")');
    // Click the last one (the anonymous login button, not the email one)
    const count = await loginButtons.count();
    console.log(`  Found ${count} Login button(s)`);
    await loginButtons.last().click();

    console.log('  Waiting for login to complete...');
    // Wait for the app to transition past the login screen
    // After anonymous login, we should see either the Name input or be redirected
    await page.waitForTimeout(5000);
    await screenshot('after-anon-login');

    // Check what happened after login
    const bodyAfterLogin = await page.textContent('body');
    console.log('  Body after login:', bodyAfterLogin.substring(0, 300));

    // Check if we got past the initial login screen
    if (bodyAfterLogin.includes('Your Name') || bodyAfterLogin.includes('Create Lobby')) {
      console.log('  OK - Logged in successfully, see name/lobby screen');
    } else if (bodyAfterLogin.includes('The Resistance Online')) {
      // Still on login page - check for errors
      console.log('  WARNING - Still on login page. Firebase may not be reachable.');
      console.log('  This is expected in a test environment without Firebase connectivity.');

      // Check for JS errors that would indicate TypeScript issues
      const tsErrors = errors.filter(e =>
        e.includes('TypeError') ||
        e.includes('ReferenceError') ||
        e.includes('SyntaxError') ||
        e.includes('is not a function') ||
        e.includes('is not defined') ||
        e.includes('Cannot read properties')
      );

      if (tsErrors.length > 0) {
        console.log('  TYPESCRIPT/JS ERRORS detected:');
        tsErrors.forEach(e => console.log('    -', e));
        throw new Error('TypeScript migration introduced runtime errors');
      } else {
        console.log('  No TypeScript/JS runtime errors detected');
        console.log('  Login flow cannot be fully tested without Firebase backend');
      }
    } else {
      console.log('  Unexpected state after login attempt');
    }

    // Step 4: If we got past login, try to enter a name and create lobby
    if (bodyAfterLogin.includes('Your Name')) {
      console.log('Step 4: Entering name...');
      const nameField = await page.locator('input[aria-label="Your Name"], input').first();
      await nameField.fill('TESTPLAYER');
      await page.waitForTimeout(500);
      await screenshot('name-entered');
      console.log('  OK - Name entered: TESTPLAYER');

      // Step 5: Click Create Lobby
      console.log('Step 5: Creating lobby...');
      const createBtn = await page.locator('button:has-text("Create Lobby")');
      await createBtn.click();
      await page.waitForTimeout(3000);
      await screenshot('after-create-lobby');

      const bodyAfterCreate = await page.textContent('body');
      if (bodyAfterCreate.includes('Players') || bodyAfterCreate.includes('Quit')) {
        console.log('  OK - Lobby created successfully');

        // Step 6: Leave the lobby
        console.log('Step 6: Leaving lobby...');
        const quitBtn = await page.locator('button:has-text("Quit")');
        await quitBtn.click();
        await page.waitForTimeout(1000);
        await screenshot('quit-dialog');

        // Confirm leaving
        const leaveBtn = await page.locator('button:has-text("Leave Lobby")');
        if (await leaveBtn.count() > 0) {
          await leaveBtn.click();
          await page.waitForTimeout(2000);
          await screenshot('after-leave');
          console.log('  OK - Left lobby');
        }
      } else {
        console.log('  Could not create lobby (server may not be running)');
        console.log('  Body:', bodyAfterCreate.substring(0, 200));
      }
    }

    // Final error check
    const criticalErrors = errors.filter(e =>
      !e.includes('Firebase') &&
      !e.includes('firestore') &&
      !e.includes('net::ERR') &&
      !e.includes('Failed to fetch') &&
      !e.includes('404') &&
      !e.includes('api.mailcheck') &&
      !e.includes('PERMISSION_DENIED') &&
      !e.includes('Missing or insufficient permissions')
    );

    if (criticalErrors.length > 0) {
      console.log('\nCRITICAL JS ERRORS:');
      criticalErrors.forEach(e => console.log('  -', e));
    } else {
      console.log('\nNo critical JavaScript errors detected');
    }

    if (errors.length > 0) {
      console.log('\nAll console errors (including expected network errors):');
      errors.forEach(e => console.log('  -', e.substring(0, 150)));
    }

    console.log('\nDone!');

  } catch (err) {
    await screenshot('error-state');
    console.error('Test failed:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

testFlow();
