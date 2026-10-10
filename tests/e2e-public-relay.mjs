// The own relay goes away in the middle of a game and the players finish it through a public relay
// (docs/p2p-protocol.md §7.1). Needs the stack of tests/e2e-stack.mjs with its public relay stand-in
// (PUBLIC_RELAY_URL); skipped when that is turned off (PUBLIC_RELAY=0).
//
// Every device's own-relay websocket (and /api/relay-info) is cut for the rest of the game; the public
// relay stays reachable. No device may show the reconnecting banner, and the game must reach the
// same outcome everywhere. Afterwards the own relay is reachable again and every device redials it.

import {
  launchBrowser, screenshotDirFor, setUpGame, readRole, dismissAllOverlays, waitForPhase, findProposer,
  extractTeamSize, proposeTeam, playUntilEnd, waitForText, endResult, reportErrors, quitAllPlayers,
} from './e2e-full-game.mjs';

const COUNT = 5;
const PUBLIC_RELAY_URL = process.env.PUBLIC_RELAY_URL || '';

async function waitFor(cond, ms, what) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function testPublicRelay() {
  if (!PUBLIC_RELAY_URL) {
    console.log('SKIP: no public relay stand-in (PUBLIC_RELAY_URL unset; run through tests/e2e-stack.mjs)');
    return;
  }
  const publicPort = new URL(PUBLIC_RELAY_URL).port;
  const isPublic = (url) => new URL(url).port === publicPort;
  const isOwn = (url) => !isPublic(url);

  const browser = await launchBrowser(process.env.BROWSER || 'chromium');
  let players = [];
  try {
    ({ players } = await setUpGame(browser, COUNT, screenshotDirFor('public-relay'), { routeWs: true }));
    for (const player of players) Object.assign(player, await readRole(player));
    await dismissAllOverlays(players);

    console.log('\n=== Step 1: every device is connected to both relays ===');
    for (const player of players) {
      await waitFor(async () => {
        const urls = player.openRelays();
        return urls.some(isOwn) && urls.some(isPublic);
      }, 30000, `${player.name} connected to the own and the public relay`);
    }
    console.log('  PASS: own relay and public relay open on every device');

    console.log('\n=== Step 2: a team is proposed, then the own relay becomes unreachable ===');
    await waitForPhase(players, 'TEAM_PROPOSAL');
    const proposer = await findProposer(players);
    await proposeTeam(proposer, extractTeamSize(await proposer.bodyText()), players);
    await waitForPhase(players, 'PROPOSAL_VOTE');
    for (const player of players) await player.netDown(isOwn);
    for (const player of players) {
      if (player.openRelays().some(isOwn)) throw new Error(`${player.name} still has an own-relay socket`);
    }
    console.log('  own relay cut on every device');

    console.log('\n=== Step 3: the game is played to the end through the public relay ===');
    const bannerSeen = new Set();
    const watch = setInterval(async () => {
      for (const player of players) {
        const n = await player.page.locator('[data-testid="banner-reconnecting"], [data-testid="banner-offline"]').count().catch(() => 0);
        if (n > 0) bannerSeen.add(player.name);
      }
    }, 500);
    try {
      await playUntilEnd(players);
      const results = [];
      for (const player of players) {
        await waitForText(player.page, ['Good wins!', 'Evil wins!', 'Game Canceled'], 90000);
        results.push(endResult(await player.bodyText()));
      }
      if (new Set(results).size !== 1) throw new Error(`players disagree on the outcome: ${results.join(', ')}`);
      if (results[0] === 'Game Canceled') throw new Error('the game must not end canceled');
      console.log(`  PASS: game ended (${results[0]}) with the own relay unreachable`);
    } finally {
      clearInterval(watch);
    }
    if (bannerSeen.size > 0) throw new Error(`reconnecting banner shown on ${[...bannerSeen].join(', ')} while the public relay was up`);
    console.log('  PASS: no device showed the reconnecting banner');
    for (const player of players) {
      if (player.openRelays().some(isOwn)) throw new Error(`${player.name} reached the own relay during the outage`);
    }

    console.log('\n=== Step 4: the own relay is reachable again and every device redials it ===');
    for (const player of players) player.netUp();
    for (const player of players) {
      await waitFor(async () => player.openRelays().some(isOwn), 45000, `${player.name} redialed the own relay`);
    }
    console.log('  PASS: every device redialed the own relay');

    await quitAllPlayers(players);
    if (reportErrors(players)) {
      console.log('\nFAIL: Critical JavaScript errors detected');
      process.exitCode = 1;
    } else {
      console.log('\nPASS: public relay test completed');
    }
  } catch (err) {
    console.error('\nFAIL:', err.message);
    process.exitCode = 1;
    for (const player of players) await player.screenshot('error').catch(() => {});
    await quitAllPlayers(players);
  } finally {
    for (const player of players) await player.close();
    await browser.close();
  }
}

testPublicRelay();
