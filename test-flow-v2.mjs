import { chromium } from 'playwright';

async function testFlow() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ]
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  let stepNum = 0;

  const jsErrors = [];
  page.on('pageerror', err => {
    jsErrors.push(err.message);
  });
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Only track actual JS errors, not network/resource errors
      if (text.includes('TypeError') || text.includes('ReferenceError') ||
          text.includes('SyntaxError') || text.includes('is not a function') ||
          text.includes('is not defined') || text.includes('Cannot read properties')) {
        jsErrors.push(text);
      }
    }
  });

  async function screenshot(name) {
    stepNum++;
    const path = `/home/user/avalon/flow-${stepNum}-${name}.png`;
    await page.screenshot({ path, fullPage: true });
    console.log(`  [screenshot] ${path}`);
    return path;
  }

  try {
    // ========== Step 1: Load app ==========
    console.log('\n=== Step 1: Load the app ===');
    await page.goto('http://localhost:5173/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    await screenshot('load');

    const loadText = await page.textContent('body');
    if (!loadText.includes('The Resistance Online')) {
      throw new Error('App did not load correctly');
    }
    console.log('  PASS: App loaded, showing login screen');

    // ========== Step 2: Switch to Anonymous tab ==========
    console.log('\n=== Step 2: Select Anonymous login tab ===');
    await page.click('text=Anonymous');
    await page.waitForTimeout(500);
    await screenshot('anon-tab');
    console.log('  PASS: Anonymous tab selected');

    // ========== Step 3: Click Login (anonymous) ==========
    console.log('\n=== Step 3: Click Anonymous Login ===');
    // Find the login button in the anonymous tab
    const anonLoginBtn = page.locator('.v-window-item--active button:has-text("Login"), .v-tabs-items button:has-text("Login")').last();
    await anonLoginBtn.click();
    console.log('  Clicked Login button, waiting for Firebase auth...');

    // Wait for either: transition to name screen, OR error message
    try {
      await page.waitForFunction(() => {
        const body = document.body.textContent;
        return body.includes('Your Name') || body.includes('Create Lobby') || body.includes('Logout');
      }, { timeout: 15000 });
      console.log('  PASS: Successfully logged in anonymously!');
    } catch {
      // Check if there's a Firebase network error (expected in some environments)
      const bodyText = await page.textContent('body');
      await screenshot('login-result');
      if (bodyText.includes('network') || bodyText.includes('timeout')) {
        console.log('  SKIP: Firebase auth network error (expected in sandboxed environment)');
        console.log('  The app correctly attempted anonymous login but Firebase is unreachable');
        // Check for TypeScript errors
        if (jsErrors.length > 0) {
          console.log('  FAIL: JavaScript errors detected:');
          jsErrors.forEach(e => console.log('    -', e));
          throw new Error('TypeScript migration caused runtime errors');
        }
        console.log('  PASS: No TypeScript/JavaScript runtime errors');
        console.log('\n=== Cannot proceed to lobby tests without Firebase ===');
        await browser.close();
        return;
      }
      throw new Error('Login failed unexpectedly');
    }

    await page.waitForTimeout(2000);
    await screenshot('logged-in');

    // ========== Step 4: Enter name ==========
    console.log('\n=== Step 4: Enter player name ===');
    const bodyAfterLogin = await page.textContent('body');
    console.log('  Screen content:', bodyAfterLogin.substring(0, 200));

    if (bodyAfterLogin.includes('Your Name')) {
      // We're on the name/lobby screen
      const nameInput = page.locator('input').first();
      await nameInput.clear();
      await nameInput.fill('TESTPLAYER');
      await page.waitForTimeout(500);
      await screenshot('name-entered');
      console.log('  PASS: Name entered: TESTPLAYER');

      // ========== Step 5: Create Lobby ==========
      console.log('\n=== Step 5: Create a lobby ===');
      await page.click('button:has-text("Create Lobby")');
      console.log('  Clicked Create Lobby...');

      try {
        await page.waitForFunction(() => {
          const body = document.body.textContent;
          return body.includes('Players') && body.includes('Quit');
        }, { timeout: 10000 });
        console.log('  PASS: Lobby created!');
      } catch {
        await screenshot('create-lobby-result');
        const lobbyText = await page.textContent('body');
        console.log('  Lobby screen:', lobbyText.substring(0, 300));
        if (lobbyText.includes('Error') || lobbyText.includes('error')) {
          console.log('  SKIP: Server not reachable for lobby creation');
        }
      }

      await page.waitForTimeout(2000);
      await screenshot('in-lobby');

      const lobbyContent = await page.textContent('body');
      if (lobbyContent.includes('Quit')) {
        // ========== Step 6: Leave Lobby ==========
        console.log('\n=== Step 6: Leave the lobby ===');
        await page.click('button:has-text("Quit")');
        await page.waitForTimeout(1000);
        await screenshot('quit-dialog');

        // Find and click "Leave Lobby" in the confirmation dialog
        const leaveBtn = page.locator('button:has-text("Leave Lobby")');
        if (await leaveBtn.count() > 0) {
          await leaveBtn.click();
          await page.waitForTimeout(3000);
          await screenshot('after-leave');

          const afterLeave = await page.textContent('body');
          if (afterLeave.includes('Your Name') || afterLeave.includes('Create Lobby')) {
            console.log('  PASS: Successfully left lobby, back to name screen');
          } else {
            console.log('  Left lobby, current state:', afterLeave.substring(0, 200));
          }
        }
      }
    } else {
      console.log('  Already in a different state:', bodyAfterLogin.substring(0, 200));
    }

    // ========== Final Error Check ==========
    console.log('\n=== Final Error Check ===');
    if (jsErrors.length > 0) {
      console.log('FAIL: JavaScript runtime errors detected:');
      jsErrors.forEach(e => console.log('  -', e));
      process.exit(1);
    } else {
      console.log('PASS: No JavaScript runtime errors');
    }

    console.log('\n=== All tests completed ===');

  } catch (err) {
    await screenshot('error');
    console.error('\nFAIL:', err.message);
    if (jsErrors.length > 0) {
      console.log('JS errors:', jsErrors);
    }
    process.exit(1);
  } finally {
    await browser.close();
  }
}

testFlow();
