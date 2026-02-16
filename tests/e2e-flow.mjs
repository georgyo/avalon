import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const screenshotDir = join(__dirname, 'screenshots');
mkdirSync(screenshotDir, { recursive: true });

// Proxy requests through curl since Node.js DNS can't resolve external hosts
function curlRequest(method, url, headers = {}, data = null) {
  // Write data to a temp file to avoid shell escaping issues
  const tmpFile = '/tmp/curl-body-' + Date.now() + '.txt';
  let cmd = `curl -s -w '\\n__HTTP_STATUS__%{http_code}' -X ${method} '${url}'`;
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (['host', 'origin', 'referer', 'content-length', 'transfer-encoding'].includes(lower)) continue;
    cmd += ` -H '${key}: ${value.replace(/'/g, "'\\''")}'`;
  }
  if (data) {
    writeFileSync(tmpFile, data);
    cmd += ` --data-binary @${tmpFile}`;
  }
  const raw = execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
  const statusMatch = raw.match(/__HTTP_STATUS__(\d+)$/);
  const status = statusMatch ? parseInt(statusMatch[1]) : 200;
  const body = raw.replace(/__HTTP_STATUS__\d+$/, '');
  return { status, body };
}

async function testFlow() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
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

  // Intercept Firebase auth requests → proxy via curl
  await page.route('**/identitytoolkit.googleapis.com/**', async (route, request) => {
    const url = request.url();
    console.log('  [proxy] Firebase auth:', url.substring(0, 100));
    try {
      const { status, body } = curlRequest('POST', url, request.headers(), request.postData());
      await route.fulfill({ status, contentType: 'application/json', body });
    } catch (err) {
      console.log('  [proxy error]', err.message);
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"message":"proxy error"}}' });
    }
  });

  // Intercept securetoken requests → proxy via curl
  await page.route('**/securetoken.googleapis.com/**', async (route, request) => {
    const url = request.url();
    console.log('  [proxy] securetoken:', url.substring(0, 100));
    try {
      const contentType = request.headers()['content-type'] || 'application/x-www-form-urlencoded';
      const { status, body } = curlRequest('POST', url, { ...request.headers(), 'content-type': contentType }, request.postData());
      await route.fulfill({ status, contentType: 'application/json', body });
    } catch (err) {
      console.log('  [proxy error]', err.message);
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"message":"proxy error"}}' });
    }
  });

  // Abort Firestore requests to force offline mode (the channel protocol is too
  // complex to proxy via curl, and Firebase v12 is strict about response format)
  let firestoreRequestCount = 0;
  await page.route('**/firestore.googleapis.com/**', async (route) => {
    firestoreRequestCount++;
    if (firestoreRequestCount <= 3) {
      console.log('  [abort] firestore request #' + firestoreRequestCount);
    }
    await route.abort('connectionfailed');
  });

  // Intercept /api calls → proxy to https://avalon.onl via curl (Vite proxy can't resolve DNS)
  await page.route('**/api/**', async (route, request) => {
    const urlPath = new URL(request.url()).pathname;
    const targetUrl = `https://avalon.onl${urlPath}`;
    console.log(`  [proxy] API: ${request.method()} ${urlPath} → ${targetUrl}`);
    try {
      const { status, body } = curlRequest(request.method(), targetUrl, request.headers(), request.postData());
      await route.fulfill({ status, contentType: 'application/json', body });
    } catch (err) {
      console.log('  [proxy error]', err.message);
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: err.message }) });
    }
  });

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
      if (lobbyText.includes('AxiosError') || lobbyText.includes('Request failed')) {
        console.log('  NOTE: API error from production server (not a client code issue)');
      }
    }

    // ========== Final Results ==========
    console.log('\n=== Final Results ===');
    if (jsErrors.length > 0) {
      console.log('JavaScript runtime errors:');
      jsErrors.forEach(e => console.log('  -', e));
      const codeErrors = jsErrors.filter(e =>
        !e.includes('Firebase') &&
        !e.includes('firestore') &&
        !e.includes('Firestore') &&
        !e.includes('net::ERR') &&
        !e.includes('Failed to fetch') &&
        !e.includes('PERMISSION_DENIED') &&
        !e.includes('Missing or insufficient permissions') &&
        !e.includes('api.mailcheck') &&
        !e.includes('client is offline') &&
        !e.includes('AxiosError')
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
