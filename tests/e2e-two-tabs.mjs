// Two tabs of one browser profile share the device key and IndexedDB; only one may run the protocol
// driver (Web Locks single writer, docs/p2p-protocol.md §3.9). The second tab is read-only until
// "Use here", which moves the writer role and makes the first tab read-only.

import {
  BASE_URL, launchBrowser, screenshotDirFor, PlayerContext, login, createLobby, waitForText, reportErrors,
} from './e2e-full-game.mjs';

async function testTwoTabs() {
  const browser = await launchBrowser(process.env.BROWSER || 'chromium');
  const player = new PlayerContext('ALICE', browser, screenshotDirFor('two-tabs'));
  await player.init();
  const first = player.page;
  try {
    console.log('\n=== Step 1: first tab logs in and creates a lobby ===');
    await login(player);
    const code = await createLobby(player);

    console.log('\n=== Step 2: second tab is read-only ===');
    const second = await player.context.newPage();
    player.attach(second);
    await second.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await second.waitForSelector('[data-testid="banner-read-only"]', { timeout: 30000 });
    await waitForText(second, 'Avalon is open in another tab', 5000);
    await waitForText(second, code, 30000);     // it still shows the lobby
    if ((await first.locator('[data-testid="banner-read-only"]').count()) > 0) {
      throw new Error('the first tab must keep the writer role');
    }
    console.log('  PASS: second tab shows the lobby read-only');

    console.log('\n=== Step 3: Use here ===');
    await second.click('[data-testid="use-here"]');
    await second.waitForSelector('[data-testid="banner-read-only"]', { state: 'detached', timeout: 15000 });
    await first.waitForSelector('[data-testid="banner-read-only"]', { timeout: 15000 });
    console.log('  PASS: the writer role moved to the second tab, the first tab is read-only');

    console.log('\n=== Step 4: the new writer can act ===');
    await second.click('button:has-text("Quit")');
    await second.locator('button:has-text("Leave Lobby")').click();
    await waitForText(second, ['Create Lobby'], 15000);
    console.log('  PASS: left the lobby from the second tab');

    if (reportErrors([player])) {
      console.log('\nFAIL: Critical JavaScript errors detected');
      process.exitCode = 1;
    } else {
      console.log('\nPASS: two-tabs test completed');
    }
  } catch (err) {
    console.error('\nFAIL:', err.message);
    process.exitCode = 1;
    await player.screenshot('error').catch(() => {});
  } finally {
    await player.close();
    await browser.close();
  }
}

testTwoTabs();
