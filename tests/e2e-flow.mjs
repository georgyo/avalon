// Single-device flow against the peer-to-peer stack: load, anonymous login ("choose a name"), create a
// lobby (4-letter code and fingerprint, docs/p2p-protocol.md §4.1), a join attempt for a code nobody
// uses, leave the lobby, log out (forget the device key).

import {
  BASE_URL, PlayerContext, launchBrowser, screenshotDirFor, waitForText, createLobby, reportErrors,
} from './e2e-full-game.mjs';

async function testFlow() {
  const browser = await launchBrowser(process.env.BROWSER || 'firefox');
  const player = new PlayerContext('TESTPLAYER', browser, screenshotDirFor('flow'));
  await player.init();
  const page = player.page;

  try {
    console.log('\n=== Step 1: Load the app ===');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForText(page, 'The Resistance Online', 30000);
    await player.screenshot('load');
    if ((await page.locator('[data-testid="email-tab"]').count()) > 0) {
      throw new Error('the email login tab must be gone (anonymous device keys only)');
    }
    console.log('  PASS: App loaded, no email login');

    console.log('\n=== Step 2: Choose a name and log in ===');
    await page.click('[data-testid="anonymous-tab"]');
    const loginBtn = page.locator('[data-testid="login-button"]');
    if (!(await loginBtn.isDisabled())) throw new Error('Login must need a name');
    await page.locator('[data-testid="login-name"] input').fill('MERLIN');
    await page.waitForTimeout(200);
    if (!(await loginBtn.isDisabled())) throw new Error('a role name must not be accepted as a name');
    await page.locator('[data-testid="login-name"] input').fill('testplayer');
    await loginBtn.click();
    await waitForText(page, ['Create Lobby'], 20000);
    const prefilled = await page.locator('input').first().inputValue();
    if (prefilled !== 'TESTPLAYER') throw new Error(`lobby screen name should be prefilled, got "${prefilled}"`);
    await player.screenshot('logged-in');
    console.log('  PASS: Logged in with an anonymous device key');

    console.log('\n=== Step 3: Join a lobby that does not exist ===');
    await page.click('button:has-text("Join Lobby")');
    await page.locator('[data-testid="lobby-code"] input').fill('XQXQ');
    await page.click('button:has-text("Join Lobby")');
    await waitForText(page, 'Lobby XQXQ not found', 20000);
    await page.click('button:has-text("Cancel")');
    await waitForText(page, 'Create Lobby', 5000);
    console.log('  PASS: unknown code reported');

    console.log('\n=== Step 4: Create Lobby ===');
    const code = await createLobby(player);
    await page.waitForSelector('[data-testid="lobby-fingerprint"]', { timeout: 15000 });
    const fingerprint = (await page.locator('[data-testid="lobby-fingerprint"]').textContent()).trim();
    // 32 bits of the lobbyId, XXXX-XXXX (§4.1)
    if (!/^· [0-9A-F]{4}-[0-9A-F]{4}$/.test(fingerprint)) throw new Error(`bad lobby fingerprint "${fingerprint}"`);
    await waitForText(page, 'Need at least 5 players', 5000);
    await player.screenshot('create-lobby');
    console.log(`  PASS: Lobby ${code} ${fingerprint} created`);

    console.log('\n=== Step 5: Leave Lobby (Quit) ===');
    await page.click('button:has-text("Quit")');
    await page.locator('button:has-text("Leave Lobby")').click();
    await waitForText(page, ['Your Name', 'Create Lobby'], 15000);
    await player.screenshot('after-leave');
    console.log('  PASS: Left lobby, back to main screen');

    console.log('\n=== Step 6: Reload keeps the device identity ===');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForText(page, 'Create Lobby', 30000);
    console.log('  PASS: still logged in after reload');

    console.log('\n=== Step 7: Logout ===');
    await page.click('button:has-text("Logout")');
    await waitForText(page, 'The Resistance Online', 15000);
    await page.locator('[data-testid="login-button"]').waitFor({ state: 'visible', timeout: 15000 });
    console.log('  PASS: logged out');

    console.log('\n=== Final Results ===');
    if (reportErrors([player])) {
      console.log('FAIL: Code errors detected');
      process.exitCode = 1;
    } else {
      console.log('PASS: All steps completed');
    }
  } catch (err) {
    await player.screenshot('error').catch(() => {});
    console.error('\nFAIL:', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

testFlow();
