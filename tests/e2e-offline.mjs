// One device goes offline for 20 s in the middle of a game (context.setOffline), votes while offline,
// and the game continues once it is back (docs/p2p-protocol.md §7.4, §7.8, §12).

import {
  launchBrowser, screenshotDirFor, setUpGame, readRole, dismissAllOverlays, waitForPhase, findProposer,
  extractTeamSize, proposeTeam, voteOnProposal, playUntilEnd, waitForText, endResult, reportErrors,
  quitAllPlayers, detectPhase,
} from './e2e-full-game.mjs';

const COUNT = 5;
const OFFLINE_MS = 20000;

async function testOffline() {
  const browser = await launchBrowser(process.env.BROWSER || 'chromium');
  let players = [];
  try {
    ({ players } = await setUpGame(browser, COUNT, screenshotDirFor('offline')));
    for (const player of players) Object.assign(player, await readRole(player));
    await dismissAllOverlays(players);

    console.log('\n=== Step 1: a team is proposed ===');
    await waitForPhase(players, 'TEAM_PROPOSAL');
    const proposer = await findProposer(players);
    const teamSize = extractTeamSize(await proposer.bodyText());
    await proposeTeam(proposer, teamSize, players);
    await waitForPhase(players, 'PROPOSAL_VOTE');

    console.log(`\n=== Step 2: one device is offline for ${OFFLINE_MS / 1000} s ===`);
    const offline = players.find((p) => p !== proposer) || players[1];
    const online = players.filter((p) => p !== offline);
    await offline.context.setOffline(true);
    const t0 = Date.now();
    await voteOnProposal(online, 1);

    // the offline device shows the connection banner (§7.8: "Reconnecting..." after 3 s). Whether the
    // browser drops an open websocket on setOffline differs between engines, so this is reported, not required.
    let sawBanner = false;
    try {
      await offline.page.waitForSelector('[data-testid="banner-reconnecting"], [data-testid="banner-offline"]', { timeout: 8000 });
      sawBanner = true;
      console.log(`  PASS: ${offline.name} shows the reconnecting banner`);
    } catch {
      console.log(`  NOTE: ${offline.name} showed no reconnecting banner (the websocket may have survived setOffline)`);
    }

    // it votes while offline: the move is saved and sent on reconnect
    await offline.page.locator('button:has-text("Approve")').click();
    console.log(`  ${offline.name} voted while offline`);
    await offline.page.waitForTimeout(3000);
    const phaseWhileOffline = detectPhase(await online[0].bodyText());
    if (sawBanner && phaseWhileOffline !== 'PROPOSAL_VOTE') {
      throw new Error(`the vote cannot complete while ${offline.name} is offline, phase is ${phaseWhileOffline}`);
    }

    await offline.page.waitForTimeout(Math.max(0, OFFLINE_MS - (Date.now() - t0)));
    await offline.context.setOffline(false);
    console.log(`  ${offline.name} is back online`);

    console.log('\n=== Step 3: the game continues ===');
    await waitForPhase(players, ['MISSION_VOTE', 'GAME_ENDED'], 90000);
    await offline.page.waitForSelector('[data-testid="banner-reconnecting"], [data-testid="banner-offline"]', { state: 'detached', timeout: 60000 });
    console.log('  PASS: the proposal vote completed after the reconnect');

    await playUntilEnd(players);
    const results = [];
    for (const player of players) {
      await waitForText(player.page, ['Good wins!', 'Evil wins!', 'Game Canceled'], 60000);
      results.push(endResult(await player.bodyText()));
    }
    if (new Set(results).size !== 1) throw new Error(`players disagree on the outcome: ${results.join(', ')}`);
    if (results[0] === 'Game Canceled') throw new Error('the game must not end canceled');
    console.log(`  PASS: game ended (${results[0]})`);

    await quitAllPlayers(players);
    if (reportErrors(players)) {
      console.log('\nFAIL: Critical JavaScript errors detected');
      process.exitCode = 1;
    } else {
      console.log('\nPASS: offline test completed');
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

testOffline();
