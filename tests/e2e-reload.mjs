// Reload a page during the setup (shuffling/dealing) and in the middle of a mission
// (docs/p2p-protocol.md §3.9-3.10, §12). The reloaded device must recover its secrets from IndexedDB, keep
// the same role, never be asked for a choice twice, and the game must finish normally.

import {
  launchBrowser, screenshotDirFor, PlayerContext, PLAYER_NAMES, login, createLobby, joinLobby,
  waitForAllInLobby, waitForText, readRole, dismissAllOverlays, waitForPhase, detectPhase, findProposer,
  extractTeamSize, proposeTeam, voteOnProposal, doMission, playUntilEnd, endResult, reportErrors,
  quitAllPlayers, assertEndTableRoles,
} from './e2e-full-game.mjs';

const COUNT = 5;

async function reload(player) {
  console.log(`  reloading ${player.name}...`);
  await player.page.reload({ waitUntil: 'domcontentloaded' });
}

async function testReload() {
  const browser = await launchBrowser(process.env.BROWSER || 'chromium');
  const screenshotDir = screenshotDirFor('reload');
  const players = [];
  try {
    for (const name of PLAYER_NAMES.slice(0, COUNT)) {
      const player = new PlayerContext(name, browser, screenshotDir);
      await player.init();
      players.push(player);
    }
    for (const player of players) await login(player);
    const code = await createLobby(players[0]);
    for (const player of players.slice(1)) await joinLobby(player, code);
    await waitForAllInLobby(players[0], players.map((p) => p.name));

    console.log('\n=== Step 1: reload a device during the setup ===');
    const reloader = players[COUNT - 1];
    await players[0].page.locator('button:has-text("Start Game")').click();
    await reloader.page.waitForSelector('[data-testid="setup-progress"]', { timeout: 20000 });
    console.log('  setup seen on', reloader.name, ':', (await reloader.page.locator('[data-testid="setup-progress-text"]').textContent().catch(() => '')).trim());
    await reload(reloader);
    await Promise.all(players.map((p) => waitForText(p.page, ['Game Started', 'Team Proposal'], 90000)));
    console.log('  PASS: setup completed for everyone after the reload');

    for (const player of players) Object.assign(player, await readRole(player));
    console.log('  roles:', players.map((p) => `${p.name}=${p.role}`).join(', '));
    await dismissAllOverlays(players);

    console.log('\n=== Step 2: reload a team member in the middle of a mission ===');
    let reloadedMidMission = false;
    for (let round = 0; round < 10 && !reloadedMidMission; round++) {
      await waitForPhase(players, ['TEAM_PROPOSAL', 'GAME_ENDED']);
      if (detectPhase(await players[0].bodyText()) === 'GAME_ENDED') break;
      const proposer = await findProposer(players);
      const teamSize = extractTeamSize(await proposer.bodyText());
      const team = await proposeTeam(proposer, teamSize, players);
      await waitForPhase(players, ['PROPOSAL_VOTE']);
      await voteOnProposal(players, 1);          // everyone approves
      await waitForPhase(players, ['MISSION_VOTE']);

      // the first team member votes, then reloads before the mission resolves
      const member = players.find((p) => team.includes(p.name));
      const others = players.filter((p) => team.includes(p.name) && p !== member);
      await doMission([member], team);
      await reload(member);
      await waitForText(member.page, ['Mission in Progress'], 60000);
      await member.page.waitForTimeout(1000);
      if ((await member.page.locator('button:has-text("SUCCESS")').count()) > 0) {
        throw new Error(`${member.name} was asked for a mission vote twice after reloading`);
      }
      const roleAfter = await readRole(member);
      if (roleAfter.role !== member.role) throw new Error(`${member.name}'s role changed across a reload: ${member.role} -> ${roleAfter.role}`);
      console.log(`  PASS: ${member.name} kept the role ${member.role} and its mission vote`);

      // a second member reloads before voting and votes afterwards
      if (others.length) {
        const late = others[0];
        await reload(late);
        await waitForText(late.page, ['Mission in Progress'], 60000);
        await dismissAllOverlays([late]);
      }
      await doMission(others, team);
      await waitForPhase(players, ['TEAM_PROPOSAL', 'ASSASSINATION', 'GAME_ENDED'], 60000);
      reloadedMidMission = true;
    }
    if (!reloadedMidMission) throw new Error('never reached a mission');

    console.log('\n=== Step 3: finish the game ===');
    await playUntilEnd(players);
    const results = [];
    for (const player of players) {
      await waitForText(player.page, ['Good wins!', 'Evil wins!', 'Game Canceled'], 60000);
      results.push(endResult(await player.bodyText()));
    }
    if (new Set(results).size !== 1) throw new Error(`players disagree on the outcome: ${results.join(', ')}`);
    if (results[0] === 'Game Canceled') throw new Error('the game must not end canceled');
    await assertEndTableRoles(players[1], players);
    console.log(`  PASS: game ended (${results[0]}), roles revealed`);

    await quitAllPlayers(players);
    if (reportErrors(players)) {
      console.log('\nFAIL: Critical JavaScript errors detected');
      process.exitCode = 1;
    } else {
      console.log('\nPASS: reload test completed');
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

testReload();
