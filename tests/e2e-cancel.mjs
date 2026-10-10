// A device disappears (its browser context is closed) during a game; the others see who is blocking,
// cancel, and the reveal shows every role (docs/p2p-protocol.md §3.7, §5.12-5.13, §7.8, §12).

import {
  launchBrowser, screenshotDirFor, setUpGame, readRole, dismissAllOverlays, waitForPhase, findProposer,
  extractTeamSize, proposeTeam, voteOnProposal, waitForText, reportErrors, quitAllPlayers, assertEndTableRoles,
} from './e2e-full-game.mjs';

const COUNT = 5;

async function testCancel() {
  const browser = await launchBrowser(process.env.BROWSER || 'chromium');
  let players = [];
  try {
    ({ players } = await setUpGame(browser, COUNT, screenshotDirFor('cancel')));
    for (const player of players) Object.assign(player, await readRole(player));
    await dismissAllOverlays(players);

    console.log('\n=== Step 1: a team is proposed ===');
    await waitForPhase(players, 'TEAM_PROPOSAL');
    const proposer = await findProposer(players);
    const teamSize = extractTeamSize(await proposer.bodyText());
    await proposeTeam(proposer, teamSize, players);
    await waitForPhase(players, 'PROPOSAL_VOTE');

    console.log('\n=== Step 2: one device votes, then goes away ===');
    // It commits its vote and disappears, so the automatic vote reveal (vr) waits for it (§5.8, §7.7).
    const gone = players.find((p) => p !== players[0] && p !== proposer) || players[COUNT - 1];
    const remaining = players.filter((p) => p !== gone);
    await gone.page.locator('button:has-text("Approve")').click();
    await gone.page.waitForFunction(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('Approve'));
      return !btn || btn.disabled;
    }, null, { timeout: 30000 });
    await gone.page.waitForTimeout(1500);
    await gone.close();
    console.log(`  ${gone.name} voted; closed its browser context`);
    await voteOnProposal(remaining, 1);

    // everyone else waits for the missing reveal; the stall notice names the blocking device after 10 s (§7.8)
    const canceller = remaining[0];
    await canceller.page.waitForSelector('[data-testid="stall-notice"]', { timeout: 60000 });
    await waitForText(canceller.page, `Ask ${gone.name} to open Avalon`, 60000);
    console.log(`  PASS: ${canceller.name} sees that ${gone.name}'s device is blocking`);

    console.log('\n=== Step 3: cancel ===');
    await canceller.page.click('button:has-text("Quit")');
    // the Quit dialog's button (the stall notice has its own "Cancel game" button, data-testid="stall-cancel")
    await canceller.page.getByRole('button', { name: 'Cancel Game', exact: true }).click();

    for (const player of remaining) {
      await waitForText(player.page, 'Game Canceled', 60000);
    }
    const message = (await canceller.page.locator('[data-testid="endgame-message"]').textContent()).trim();
    console.log('  outcome:', message);
    if (!message.includes(`Canceled by ${canceller.name}`)) throw new Error(`unexpected outcome message "${message}"`);
    if (!message.includes(gone.name)) throw new Error(`the outcome should name the stalled seat ${gone.name}`);

    // the reveal: the remaining seats revealed their keys, the missing seat's role follows by elimination
    // (exactly one unknown seat, §5.12), so every role is shown
    await waitForText(canceller.page, 'Close', 10000);
    await canceller.page.waitForFunction(
      (name) => !(document.body.textContent || '').includes(`Waiting for ${name} to reveal`), gone.name, { timeout: 30000 },
    ).catch(() => {});
    await assertEndTableRoles(canceller, players);
    console.log('  PASS: every role revealed after the cancel');

    await quitAllPlayers(remaining);
    if (reportErrors(remaining)) {
      console.log('\nFAIL: Critical JavaScript errors detected');
      process.exitCode = 1;
    } else {
      console.log('\nPASS: cancel test completed');
    }
  } catch (err) {
    console.error('\nFAIL:', err.message);
    process.exitCode = 1;
    for (const player of players) await player.screenshot('error').catch(() => {});
  } finally {
    for (const player of players) await player.close();
    await browser.close();
  }
}

testCancel();
