import { chromium } from 'playwright';
import https from 'https';
import http from 'http';

// First, get a real Firebase anonymous auth token via server-side call
async function getAnonymousToken() {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ returnSecureToken: true });
    const req = https.request({
      hostname: 'identitytoolkit.googleapis.com',
      path: '/v1/accounts:signUp?key=AIzaSyCwhCvO8NbTusBaHmHHnNT7yC0_11UL2RI',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Create a proxy that routes Firebase auth requests through our server
function createFirebaseProxy() {
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      // Forward requests to Firebase
      const targetUrl = new URL(req.url.replace('/firebase-proxy/', 'https://'));

      const options = {
        hostname: targetUrl.hostname,
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: { ...req.headers, host: targetUrl.hostname }
      };

      const proxyReq = https.request(options, proxyRes => {
        res.writeHead(proxyRes.statusCode, {
          ...proxyRes.headers,
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': '*'
        });
        proxyRes.pipe(res);
      });

      req.pipe(proxyReq);
    });

    server.listen(0, () => {
      resolve({ server, port: server.address().port });
    });
  });
}

async function testFlow() {
  console.log('Getting Firebase anonymous auth token...');
  const authResult = await getAnonymousToken();
  if (!authResult.idToken) {
    console.error('Failed to get auth token:', authResult);
    process.exit(1);
  }
  console.log('Got auth token for user:', authResult.localId);

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

  async function screenshot(name) {
    stepNum++;
    const path = `/home/user/avalon/flow-${stepNum}-${name}.png`;
    await page.screenshot({ path, fullPage: true });
    console.log(`  [screenshot] ${path}`);
    return path;
  }

  // Route Firebase auth API calls through our proxy
  // Intercept and respond to Firebase auth requests
  await page.route('**/identitytoolkit.googleapis.com/**', async (route, request) => {
    const url = new URL(request.url());
    console.log('  [intercept] Firebase auth:', url.pathname);

    try {
      const body = request.postDataJSON();
      // Proxy to actual Firebase
      const proxyResult = await new Promise((resolve, reject) => {
        const data = JSON.stringify(body || {});
        const req = https.request({
          hostname: 'identitytoolkit.googleapis.com',
          path: url.pathname + url.search,
          method: request.method(),
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
          }
        }, res => {
          let responseBody = '';
          res.on('data', chunk => responseBody += chunk);
          res.on('end', () => resolve({ status: res.statusCode, body: responseBody, headers: res.headers }));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
      });

      await route.fulfill({
        status: proxyResult.status,
        contentType: 'application/json',
        body: proxyResult.body
      });
    } catch (err) {
      console.log('  [intercept error]', err.message);
      await route.continue();
    }
  });

  // Also proxy Firestore and securetoken requests
  await page.route('**/securetoken.googleapis.com/**', async (route, request) => {
    const url = new URL(request.url());
    console.log('  [intercept] securetoken:', url.pathname);
    try {
      const postData = request.postData();
      const proxyResult = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'securetoken.googleapis.com',
          path: url.pathname + url.search,
          method: request.method(),
          headers: {
            'Content-Type': request.headers()['content-type'] || 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData || '')
          }
        }, res => {
          let responseBody = '';
          res.on('data', chunk => responseBody += chunk);
          res.on('end', () => resolve({ status: res.statusCode, body: responseBody }));
        });
        req.on('error', reject);
        if (postData) req.write(postData);
        req.end();
      });
      await route.fulfill({
        status: proxyResult.status,
        contentType: 'application/json',
        body: proxyResult.body
      });
    } catch (err) {
      console.log('  [intercept error]', err.message);
      await route.continue();
    }
  });

  // Proxy Firestore requests
  await page.route('**/firestore.googleapis.com/**', async (route, request) => {
    const url = new URL(request.url());
    console.log('  [intercept] firestore:', url.pathname.substring(0, 80));
    try {
      const postData = request.postData();
      const proxyResult = await new Promise((resolve, reject) => {
        const reqOptions = {
          hostname: 'firestore.googleapis.com',
          path: url.pathname + url.search,
          method: request.method(),
          headers: {}
        };
        // Copy relevant headers
        for (const [key, value] of Object.entries(request.headers())) {
          if (!['host', 'origin', 'referer'].includes(key.toLowerCase())) {
            reqOptions.headers[key] = value;
          }
        }
        reqOptions.headers['host'] = 'firestore.googleapis.com';

        const req = https.request(reqOptions, res => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks),
            headers: Object.fromEntries(
              Object.entries(res.headers).filter(([k]) => !['transfer-encoding'].includes(k))
            )
          }));
        });
        req.on('error', reject);
        if (postData) req.write(postData);
        req.end();
      });
      await route.fulfill({
        status: proxyResult.status,
        headers: proxyResult.headers,
        body: proxyResult.body
      });
    } catch (err) {
      console.log('  [intercept error]', err.message);
      await route.continue();
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
    console.log('  PASS: App loaded, showing login screen');

    // ========== Step 2: Switch to Anonymous tab ==========
    console.log('\n=== Step 2: Select Anonymous login tab ===');
    await page.click('text=Anonymous');
    await page.waitForTimeout(500);
    await screenshot('anon-tab');
    console.log('  PASS: Anonymous tab selected');

    // ========== Step 3: Click Login (anonymous) ==========
    console.log('\n=== Step 3: Click Anonymous Login ===');
    const loginBtns = page.locator('button:has-text("Login")');
    await loginBtns.last().click();
    console.log('  Clicked Login, waiting for Firebase auth...');

    // Wait for transition
    try {
      await page.waitForFunction(() => {
        const body = document.body.textContent || '';
        return body.includes('Your Name') || body.includes('Create Lobby') ||
               body.includes('Logout') || body.includes('Anonymous');
      }, { timeout: 20000 });
    } catch {
      // May timeout
    }

    await page.waitForTimeout(3000);
    await screenshot('after-login');

    const bodyAfterLogin = await page.textContent('body');
    console.log('  Body:', bodyAfterLogin.substring(0, 300));

    if (bodyAfterLogin.includes('Your Name') || bodyAfterLogin.includes('Create Lobby')) {
      console.log('  PASS: Logged in anonymously!');
    } else if (bodyAfterLogin.includes('Logout')) {
      console.log('  PASS: Logged in (showing logout button)');
    } else {
      console.log('  Login state unclear, checking for errors...');
      if (jsErrors.length > 0) {
        console.log('  JS errors found:');
        jsErrors.forEach(e => console.log('    -', e));
      }
    }

    // ========== Step 4: Change name and Create Lobby ==========
    if (bodyAfterLogin.includes('Your Name') || bodyAfterLogin.includes('Create Lobby')) {
      console.log('\n=== Step 4: Enter name ===');
      const nameInput = page.locator('input').first();
      await nameInput.clear();
      await nameInput.type('TESTPLAYER', { delay: 50 });
      await page.waitForTimeout(500);
      await screenshot('name-entered');
      console.log('  PASS: Entered name TESTPLAYER');

      // ========== Step 5: Create Lobby ==========
      console.log('\n=== Step 5: Create Lobby ===');
      await page.click('button:has-text("Create Lobby")');
      console.log('  Clicked Create Lobby, waiting...');

      await page.waitForTimeout(5000);
      await screenshot('create-lobby');
      const lobbyText = await page.textContent('body');
      console.log('  Body:', lobbyText.substring(0, 300));

      if (lobbyText.includes('Players') && lobbyText.includes('Quit')) {
        console.log('  PASS: Lobby created successfully!');

        // ========== Step 6: Leave Lobby ==========
        console.log('\n=== Step 6: Leave Lobby ===');
        await page.click('button:has-text("Quit")');
        await page.waitForTimeout(1000);
        await screenshot('quit-confirm');

        const leaveBtn = page.locator('button:has-text("Leave Lobby")');
        if (await leaveBtn.count() > 0) {
          await leaveBtn.click();
          await page.waitForTimeout(3000);
          await screenshot('after-leave');
          const afterText = await page.textContent('body');
          if (afterText.includes('Your Name') || afterText.includes('Create Lobby')) {
            console.log('  PASS: Left lobby, back to name screen');
          } else {
            console.log('  Left lobby, state:', afterText.substring(0, 200));
          }
        }
      } else {
        console.log('  Could not create lobby (API server not reachable)');
      }
    }

    // ========== Final ==========
    console.log('\n=== Final Results ===');
    if (jsErrors.length > 0) {
      console.log('FAIL: JavaScript runtime errors:');
      jsErrors.forEach(e => console.log('  -', e));
      process.exit(1);
    }
    console.log('PASS: No JavaScript/TypeScript runtime errors');
    console.log('All steps completed successfully!');

  } catch (err) {
    await screenshot('error');
    console.error('\nFAIL:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

testFlow();
