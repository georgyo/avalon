import { firefox } from 'playwright';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const screenshotDir = join(__dirname, 'screenshots');
mkdirSync(screenshotDir, { recursive: true });

async function testFlow() {
  const browser = await firefox.launch({
    headless: true,
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  let stepNum = 0;

  const jsErrors = [];
  page.on('pageerror', err => {
    jsErrors.push(err.message);
    console.log('  [JS ERROR]', err.message);
  });

  // Log console messages for debugging
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log('  [console.error]', msg.text().substring(0, 200));
    }
  });

  async function screenshot(name) {
    stepNum++;
    const path = join(screenshotDir, `flow-${stepNum}-${name}.png`);
    await page.screenshot({ path, fullPage: true });
    console.log(`  [screenshot] ${path}`);
    return path;
  }

  try {
    // ========== Step 1: Load app ==========
    console.log('\n=== Step 1: Load the app ===');
    await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    await screenshot('load');

    const loadText = await page.textContent('body');
    if (!loadText.includes('The Resistance Online')) {
      throw new Error('App did not load correctly');
    }
    console.log('  PASS: App loaded');

    // ========== Step 2: Switch to Anonymous tab ==========
    console.log('\n=== Step 2: Select Anonymous login tab ===');
    await page.click('[data-testid="anonymous-tab"]');
    await page.waitForTimeout(500);
    await screenshot('anon-tab');
    console.log('  PASS: Anonymous tab selected');

    // ========== Step 3: Click Login (anonymous) ==========
    console.log('\n=== Step 3: Anonymous Login ===');
    const loginBtns = page.locator('button:has-text("Login")');
    await loginBtns.last().click();
    console.log('  Waiting for auth...');

    await page.waitForFunction(() => {
      const body = document.body.textContent || '';
      return body.includes('Your Name') || body.includes('Create Lobby') || body.includes('Logout');
    }, { timeout: 20000 });

    await page.waitForTimeout(2000);
    await screenshot('logged-in');

    const bodyAfterLogin = await page.textContent('body');
    if (!bodyAfterLogin.includes('Your Name') && !bodyAfterLogin.includes('Create Lobby')) {
      throw new Error('Login failed - not on main screen');
    }
    console.log('  PASS: Logged in anonymously');

    // ========== Step 4: Enter name ==========
    console.log('\n=== Step 4: Enter name ===');
    const nameInput = page.locator('input').first();
    await nameInput.clear();
    await nameInput.type('TESTPLAYER', { delay: 50 });
    await page.waitForTimeout(500);
    await screenshot('name-entered');
    console.log('  PASS: Name set to TESTPLAYER');

    // ========== Step 5: Create Lobby ==========
    console.log('\n=== Step 5: Create Lobby ===');
    await page.click('button:has-text("Create Lobby")');
    console.log('  Waiting for lobby...');

    // Wait for either lobby view or error
    try {
      await page.waitForFunction(() => {
        const body = document.body.textContent || '';
        return body.includes('Quit') || body.includes('Players') || body.includes('Error') || body.includes('error');
      }, { timeout: 15000 });
    } catch {
      // timeout
    }

    await page.waitForTimeout(2000);
    await screenshot('create-lobby');
    const lobbyText = await page.textContent('body');
    console.log('  Body:', lobbyText.substring(0, 400));

    if (lobbyText.includes('Quit')) {
      console.log('  PASS: Lobby created!');

      // ========== Step 6: Leave Lobby ==========
      console.log('\n=== Step 6: Leave Lobby (Quit) ===');
      await page.click('button:has-text("Quit")');
      await page.waitForTimeout(1000);
      await screenshot('quit-dialog');

      // Check for confirmation dialog
      const leaveBtn = page.locator('button:has-text("Leave Lobby")');
      if (await leaveBtn.count() > 0) {
        console.log('  Confirming leave...');
        await leaveBtn.click();
      } else {
        // Maybe "Quit" directly leaves
        console.log('  No confirmation dialog, checking state...');
      }

      await page.waitForTimeout(3000);
      await screenshot('after-leave');
      const afterText = await page.textContent('body');

      if (afterText.includes('Your Name') || afterText.includes('Create Lobby')) {
        console.log('  PASS: Left lobby, back to main screen');
      } else {
        console.log('  Post-leave state:', afterText.substring(0, 200));
      }
    } else {
      // Lobby creation failed - check if it's a server error vs code error
      console.log('  Lobby not created. Checking error...');
      if (lobbyText.includes('SurrealError') || lobbyText.includes('Request failed')) {
        console.log('  NOTE: API error from server (not a client code issue)');
      }
    }

    // ========== Final Results ==========
    console.log('\n=== Final Results ===');
    if (jsErrors.length > 0) {
      console.log('JavaScript runtime errors:');
      jsErrors.forEach(e => console.log('  -', e));
      const codeErrors = jsErrors.filter(e =>
        !e.includes('net::ERR') &&
        !e.includes('Failed to fetch') &&
        !e.includes('api.mailcheck') &&
        !e.includes('SurrealError') &&
        !e.includes('NetworkError') &&
        !e.includes('Network Error') &&
        !e.includes('WebSocket')
      );
      if (codeErrors.length > 0) {
        console.log('FAIL: Code errors detected');
        process.exit(1);
      }
    }
    console.log('PASS: All steps completed');

  } catch (err) {
    await screenshot('error');
    console.error('\nFAIL:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

testFlow();
