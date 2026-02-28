import { firefox } from 'playwright';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const screenshotDir = join(__dirname, 'screenshots', 'full-game');
mkdirSync(screenshotDir, { recursive: true });

const PLAYER_NAMES = ['ALICE', 'BOB', 'CAROL', 'DAVE', 'EVE'];

const EVIL_ROLES = ['MORGANA', 'ASSASSIN', 'EVIL MINION', 'MORDRED', 'OBERON'];

function isErrorIgnorable(msg) {
  return (
    msg.includes('Firebase') ||
    msg.includes('firestore') ||
    msg.includes('Firestore') ||
    msg.includes('net::ERR') ||
    msg.includes('Failed to fetch') ||
    msg.includes('PERMISSION_DENIED') ||
    msg.includes('Missing or insufficient permissions') ||
    msg.includes('api.mailcheck') ||
    msg.includes('client is offline') ||
    msg.includes('AxiosError') ||
    msg.includes('NetworkError') ||
    msg.includes('Network Error') ||
    msg.includes('favicon') ||
    msg.includes('404')
  );
}

class PlayerContext {
  constructor(name, browser) {
    this.name = name;
    this.browser = browser;
    this.context = null;
    this.page = null;
    this.jsErrors = [];
    this.role = null;
    this.isAssassin = false;
    this.isEvil = false;
    this.stepNum = 0;
  }

  async init() {
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();

    this.page.on('pageerror', (err) => {
      this.jsErrors.push(err.message);
      if (!isErrorIgnorable(err.message)) {
        console.log(`  [JS ERROR ${this.name}]`, err.message.substring(0, 200));
      }
    });

    this.page.on('console', (msg) => {
      if (msg.type() === 'error' && !isErrorIgnorable(msg.text())) {
        console.log(`  [console.error ${this.name}]`, msg.text().substring(0, 200));
      }
    });
  }

  async screenshot(label) {
    this.stepNum++;
    const path = join(screenshotDir, `${this.name}-${this.stepNum}-${label}.png`);
    await this.page.screenshot({ path, fullPage: true });
    return path;
  }

  async bodyText() {
    return await this.page.textContent('body');
  }

  getCriticalErrors() {
    return this.jsErrors.filter((e) => !isErrorIgnorable(e));
  }

  async close() {
    if (this.context) await this.context.close();
  }
}

// ============ Helpers ============

async function login(player) {
  console.log(`  Logging in ${player.name}...`);
  await player.page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await player.page.waitForTimeout(2000);

  // Click anonymous tab
  await player.page.click('[data-testid="anonymous-tab"]');
  await player.page.waitForTimeout(500);

  // Click Login
  const loginBtn = player.page.locator('button:has-text("Login")');
  await loginBtn.last().click();

  // Wait for auth
  await player.page.waitForFunction(
    () => {
      const body = document.body.textContent || '';
      return body.includes('Your Name') || body.includes('Create Lobby') || body.includes('Logout');
    },
    { timeout: 20000 },
  );
  await player.page.waitForTimeout(1000);

  // Enter name
  const nameInput = player.page.locator('input').first();
  await nameInput.clear();
  await nameInput.type(player.name, { delay: 30 });
  await player.page.waitForTimeout(300);

  console.log(`  ${player.name} logged in`);
}

async function createLobby(player, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`  ${player.name} creating lobby (attempt ${attempt})...`);
    await player.page.click('button:has-text("Create Lobby")');

    try {
      await player.page.waitForFunction(
        () => {
          const body = document.body.textContent || '';
          return body.includes('Quit') || body.includes('Players');
        },
        { timeout: 15000 },
      );
      await player.page.waitForTimeout(1000);

      // Extract lobby code from toolbar
      const lobbyCode = await player.page.locator('span.font-weight-bold.text-cyan-lighten-5').textContent();
      console.log(`  Lobby created: ${lobbyCode}`);
      return lobbyCode.trim();
    } catch {
      const bodyText = await player.bodyText();
      console.log(`  Lobby creation failed: ${bodyText.substring(0, 200)}`);
      if (attempt < maxRetries) {
        console.log(`  Retrying in 3s...`);
        await player.page.waitForTimeout(3000);
      } else {
        throw new Error(`Failed to create lobby after ${maxRetries} attempts`);
      }
    }
  }
}

async function joinLobby(player, lobbyCode) {
  console.log(`  ${player.name} joining lobby ${lobbyCode}...`);

  // Click "Join Lobby" to show lobby input
  await player.page.click('button:has-text("Join Lobby")');
  await player.page.waitForTimeout(500);

  // Enter lobby code in the Lobby input field
  const lobbyInput = player.page.locator('input').first();
  await lobbyInput.clear();
  await lobbyInput.type(lobbyCode, { delay: 30 });
  await player.page.waitForTimeout(300);

  // Click "Join Lobby" again (the submit button)
  await player.page.click('button:has-text("Join Lobby")');

  await player.page.waitForFunction(
    () => {
      const body = document.body.textContent || '';
      return body.includes('Quit') || body.includes('Players');
    },
    { timeout: 15000 },
  );
  await player.page.waitForTimeout(500);
  console.log(`  ${player.name} joined lobby`);
}

async function startGame(admin) {
  console.log(`  ${admin.name} starting game...`);

  // Wait for Start Game button to be visible and enabled
  const startBtn = admin.page.locator('button:has-text("Start Game")');
  await startBtn.waitFor({ state: 'visible', timeout: 10000 });
  await admin.page.waitForTimeout(500);
  await startBtn.click();

  // Wait for game to start - the "Game Started" dialog or game board appears
  await admin.page.waitForFunction(
    () => {
      const body = document.body.textContent || '';
      return (
        body.includes('Game Started') ||
        body.includes('Team Proposal') ||
        body.includes('Propose a team')
      );
    },
    { timeout: 20000 },
  );
  await admin.page.waitForTimeout(1000);
  console.log(`  Game started`);
}

async function dismissOverlays(player) {
  // Dismiss "Game Started" dialog if present (persistent, must click "View Role")
  const viewRoleBtn = player.page.locator('button:has-text("View Role")');
  if ((await viewRoleBtn.count()) > 0 && (await viewRoleBtn.isVisible().catch(() => false))) {
    await viewRoleBtn.click();
    await player.page.waitForTimeout(500);
  }

  // Dismiss any non-persistent dialogs and bottom sheets by pressing Escape repeatedly
  // This handles: mission result dialogs, role bottom sheet, etc.
  for (let i = 0; i < 3; i++) {
    const overlay = player.page.locator('.v-overlay--active');
    if ((await overlay.count()) > 0) {
      await player.page.keyboard.press('Escape');
      await player.page.waitForTimeout(300);
    } else {
      break;
    }
  }
}

async function dismissAllOverlays(players) {
  for (const player of players) {
    await dismissOverlays(player);
  }
}

async function discoverRoles(players) {
  console.log('  Discovering roles...');
  for (const player of players) {
    // When game starts, a "Game Started" dialog appears with "View Role" button.
    // Clicking it closes the dialog and opens the role bottom sheet.
    const viewRoleBtn = player.page.locator('button:has-text("View Role")');
    if ((await viewRoleBtn.count()) > 0) {
      await viewRoleBtn.click();
      await player.page.waitForTimeout(800);
    } else {
      // Fallback: click the role button in toolbar
      const roleBtn = player.page.locator('button.role-btn');
      await roleBtn.click({ force: true });
      await player.page.waitForTimeout(800);
    }

    // Read the role text from the bottom sheet
    const bodyText = await player.bodyText();

    // Extract role: "Your role is ROLENAME."
    const roleMatch = bodyText.match(/Your role is ([A-Z ]+)\./);
    if (roleMatch) {
      player.role = roleMatch[1].trim();
    }

    // Check for assassin
    player.isAssassin = bodyText.includes('You are also the ASSASSIN');

    // Check team
    player.isEvil = EVIL_ROLES.includes(player.role) || bodyText.includes('evil team');

    console.log(`  ${player.name}: ${player.role}${player.isAssassin ? ' (ASSASSIN)' : ''}${player.isEvil ? ' [evil]' : ' [good]'}`);

    // Close the bottom sheet by pressing Escape
    await player.page.keyboard.press('Escape');
    await player.page.waitForTimeout(300);
  }
}

function detectPhase(bodyText) {
  if (bodyText.includes('Good wins!') || bodyText.includes('Evil wins!') || bodyText.includes('Game Canceled')) {
    return 'GAME_ENDED';
  }
  if (bodyText.includes('Assassination Attempt')) {
    return 'ASSASSINATION';
  }
  if (bodyText.includes('Mission in Progress')) {
    return 'MISSION_VOTE';
  }
  if (bodyText.includes('Team Proposal Vote')) {
    return 'PROPOSAL_VOTE';
  }
  if (bodyText.includes('Propose a team') || bodyText.includes('to propose a team')) {
    return 'TEAM_PROPOSAL';
  }
  return 'UNKNOWN';
}

async function waitForPhase(players, expectedPhases, timeoutMs = 30000) {
  if (typeof expectedPhases === 'string') expectedPhases = [expectedPhases];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let allReady = true;
    for (const player of players) {
      const text = await player.bodyText();
      const phase = detectPhase(text);
      if (!expectedPhases.includes(phase)) {
        allReady = false;
        break;
      }
    }
    if (allReady) return;
    await players[0].page.waitForTimeout(500);
  }

  // On timeout, report what each player sees
  for (const player of players) {
    const text = await player.bodyText();
    const phase = detectPhase(text);
    console.log(`  TIMEOUT: ${player.name} sees phase=${phase}`);
  }
  throw new Error(`Timed out waiting for phase(s): ${expectedPhases.join(', ')}`);
}

async function findProposer(players) {
  for (const player of players) {
    const text = await player.bodyText();
    if (text.includes('Propose a team of')) {
      return player;
    }
  }
  return null;
}

function extractTeamSize(bodyText) {
  const match = bodyText.match(/(?:Propose a|propose a) team of (\d+)/);
  return match ? parseInt(match[1]) : null;
}

async function proposeTeam(proposer, teamSize, allPlayers) {
  // Pick random players for the team
  const shuffled = [...allPlayers].sort(() => Math.random() - 0.5);
  const team = shuffled.slice(0, teamSize);
  const teamNames = team.map((p) => p.name);
  console.log(`  ${proposer.name} proposing team: ${teamNames.join(', ')}`);

  // Select players by clicking their checkboxes in the player list
  for (const name of teamNames) {
    const listItem = proposer.page.locator('.v-list-item', { hasText: name }).first();
    const checkbox = listItem.locator('.v-selection-control__input').first();
    await checkbox.click({ force: true });
    await proposer.page.waitForTimeout(200);
  }

  // Click "Propose Team"
  const proposeBtn = proposer.page.locator('button:has-text("Propose Team")');
  await proposeBtn.waitFor({ state: 'visible', timeout: 5000 });
  await proposeBtn.click();
  await proposer.page.waitForTimeout(500);

  return teamNames;
}

async function voteOnProposal(players) {
  let approves = 0;
  let rejects = 0;

  for (const player of players) {
    const text = await player.bodyText();
    if (!text.includes('Team Proposal Vote')) continue;

    // 70% chance to approve
    const approve = Math.random() < 0.7;

    if (approve) {
      await player.page.locator('button:has-text("Approve")').click();
      approves++;
    } else {
      await player.page.locator('button:has-text("Reject")').click();
      rejects++;
    }
    await player.page.waitForTimeout(200);
  }

  console.log(`  Votes: ${approves} approve, ${rejects} reject`);
  return approves > rejects;
}

async function doMission(players, teamNames) {
  let successes = 0;
  let fails = 0;

  for (const player of players) {
    if (!teamNames.includes(player.name)) continue;

    // Wait for mission buttons to appear for this player
    try {
      await player.page.locator('button:has-text("SUCCESS")').waitFor({ state: 'visible', timeout: 5000 });
    } catch {
      // Player may have already voted or buttons not visible
      continue;
    }

    // Evil players randomly fail (50% chance), good always succeed
    const voteFail = player.isEvil && Math.random() < 0.5;

    if (voteFail) {
      await player.page.locator('button:has-text("FAIL")').click();
      fails++;
    } else {
      await player.page.locator('button:has-text("SUCCESS")').click();
      successes++;
    }
    await player.page.waitForTimeout(200);
  }

  console.log(`  Mission votes: ${successes} success, ${fails} fail`);
}

async function doAssassination(players) {
  // Find the assassin
  const assassin = players.find((p) => p.isAssassin);
  if (!assassin) {
    console.log('  No assassin found, waiting for game end...');
    return;
  }

  console.log(`  ${assassin.name} (assassin) selecting target...`);

  // Wait for assassination UI
  await assassin.page.waitForFunction(
    () => {
      const body = document.body.textContent || '';
      return body.includes('Assassination Attempt');
    },
    { timeout: 10000 },
  );
  await assassin.page.waitForTimeout(500);

  // Dismiss any overlays (mission result dialog) on the assassin's page
  await dismissOverlays(assassin);
  await assassin.page.waitForTimeout(300);

  // Pick a random good player (not self) to assassinate
  const goodPlayers = players.filter((p) => !p.isEvil);
  const target = goodPlayers[Math.floor(Math.random() * goodPlayers.length)];

  console.log(`  Assassinating ${target.name}...`);

  // Click the target's checkbox
  const listItem = assassin.page.locator('.v-list-item', { hasText: target.name }).first();
  const checkbox = listItem.locator('.v-selection-control__input').first();
  await checkbox.click({ force: true });
  await assassin.page.waitForTimeout(300);

  // Wait for button to update from "Select target" to "Assassinate TARGET"
  await assassin.page.waitForTimeout(500);

  // Click the "Assassinate TARGET" button
  const assassinateBtn = assassin.page.locator(`button:has-text("Assassinate ${target.name}")`);
  await assassinateBtn.waitFor({ state: 'visible', timeout: 10000 });
  await assassinateBtn.click();
  await assassin.page.waitForTimeout(500);

  console.log(`  ${target.name} was assassinated`);
}

// ============ Main Test ============

async function testFullGame() {
  console.log('\n=== Full Game E2E Test ===\n');

  const browser = await firefox.launch({ headless: true });
  const players = [];

  try {
    // ========== Step 1: Create player contexts ==========
    console.log('=== Step 1: Initialize players ===');
    for (const name of PLAYER_NAMES) {
      const player = new PlayerContext(name, browser);
      await player.init();
      players.push(player);
    }
    console.log(`  Created ${players.length} player contexts`);

    // ========== Step 2: Login all players ==========
    console.log('\n=== Step 2: Login all players ===');
    for (const player of players) {
      await login(player);
      await player.screenshot('logged-in');
    }

    // ========== Step 3: Create and join lobby ==========
    console.log('\n=== Step 3: Create and join lobby ===');
    const lobbyCode = await createLobby(players[0]);
    await players[0].screenshot('lobby-created');

    for (let i = 1; i < players.length; i++) {
      await joinLobby(players[i], lobbyCode);
      await players[i].screenshot('lobby-joined');
    }

    // Wait for all players to appear
    await players[0].page.waitForTimeout(2000);
    await players[0].screenshot('lobby-full');

    // Verify all players are visible
    const lobbyText = await players[0].bodyText();
    for (const name of PLAYER_NAMES) {
      if (!lobbyText.includes(name)) {
        throw new Error(`Player ${name} not visible in lobby`);
      }
    }
    console.log('  All 5 players in lobby');

    // ========== Step 4: Start game ==========
    console.log('\n=== Step 4: Start game ===');
    await startGame(players[0]);

    // Wait for all players to see game started (dialog or game board)
    for (const player of players) {
      await player.page.waitForFunction(
        () => {
          const body = document.body.textContent || '';
          return body.includes('Game Started') || body.includes('Team Proposal');
        },
        { timeout: 20000 },
      );
    }
    console.log('  All players see game started');

    for (const player of players) {
      await player.screenshot('game-started');
    }

    // ========== Step 5: Discover roles ==========
    console.log('\n=== Step 5: Discover roles ===');
    await discoverRoles(players);

    // Ensure all overlays are dismissed before game loop
    await dismissAllOverlays(players);
    await players[0].page.waitForTimeout(500);

    // ========== Step 6: Play the game ==========
    console.log('\n=== Step 6: Play game loop ===');
    const MAX_ITERATIONS = 50;
    let iteration = 0;
    let gameEnded = false;

    while (iteration < MAX_ITERATIONS && !gameEnded) {
      iteration++;
      const referenceText = await players[0].bodyText();
      const phase = detectPhase(referenceText);

      console.log(`\n  --- Iteration ${iteration}, Phase: ${phase} ---`);

      // Dismiss any overlays (mission result dialogs, etc.) before acting
      await dismissAllOverlays(players);

      switch (phase) {
        case 'TEAM_PROPOSAL': {
          // Find the proposer
          const proposer = await findProposer(players);
          if (!proposer) {
            throw new Error('No proposer found in TEAM_PROPOSAL phase');
          }
          const teamSize = extractTeamSize(await proposer.bodyText());
          console.log(`  Proposer: ${proposer.name}, team size: ${teamSize}`);

          const teamNames = await proposeTeam(proposer, teamSize, players);

          // Wait for vote phase
          await waitForPhase(players, ['PROPOSAL_VOTE', 'GAME_ENDED']);

          // Check if game ended (5 rejected proposals)
          const postText = await players[0].bodyText();
          if (detectPhase(postText) === 'GAME_ENDED') {
            gameEnded = true;
            break;
          }

          // Vote on the proposal
          console.log('  Voting on proposal...');
          const approved = await voteOnProposal(players);
          console.log(`  Proposal ${approved ? 'APPROVED' : 'REJECTED'}`);

          // Wait for next phase
          await waitForPhase(players, ['MISSION_VOTE', 'TEAM_PROPOSAL', 'GAME_ENDED']);

          const nextText = await players[0].bodyText();
          const nextPhase = detectPhase(nextText);

          if (nextPhase === 'GAME_ENDED') {
            gameEnded = true;
          } else if (nextPhase === 'MISSION_VOTE') {
            // Do the mission
            console.log('  Mission in progress...');
            await doMission(players, teamNames);

            // Wait for next phase
            await waitForPhase(players, ['TEAM_PROPOSAL', 'ASSASSINATION', 'GAME_ENDED']);
            const afterMissionText = await players[0].bodyText();
            const afterMissionPhase = detectPhase(afterMissionText);

            if (afterMissionPhase === 'GAME_ENDED') {
              gameEnded = true;
            } else if (afterMissionPhase === 'ASSASSINATION') {
              console.log('  Assassination phase!');
              await doAssassination(players);
              await waitForPhase(players, 'GAME_ENDED');
              gameEnded = true;
            }
          }
          break;
        }

        case 'PROPOSAL_VOTE': {
          // Shouldn't normally start here, but handle it
          console.log('  Voting on proposal...');
          await voteOnProposal(players);
          await waitForPhase(players, ['MISSION_VOTE', 'TEAM_PROPOSAL', 'GAME_ENDED']);
          break;
        }

        case 'MISSION_VOTE': {
          // Determine team from page text
          console.log('  Mission vote phase (recovering)...');
          // We don't know the team names from context, try to find them
          for (const player of players) {
            const text = await player.bodyText();
            const hasButtons = await player.page.locator('button:has-text("SUCCESS")').count();
            if (hasButtons > 0) {
              const voteFail = player.isEvil && Math.random() < 0.5;
              if (voteFail) {
                await player.page.locator('button:has-text("FAIL")').click();
              } else {
                await player.page.locator('button:has-text("SUCCESS")').click();
              }
              await player.page.waitForTimeout(200);
            }
          }
          await waitForPhase(players, ['TEAM_PROPOSAL', 'ASSASSINATION', 'GAME_ENDED']);
          break;
        }

        case 'ASSASSINATION': {
          console.log('  Assassination phase!');
          await doAssassination(players);
          await waitForPhase(players, 'GAME_ENDED');
          gameEnded = true;
          break;
        }

        case 'GAME_ENDED': {
          gameEnded = true;
          break;
        }

        default: {
          console.log(`  Unknown phase, waiting...`);
          await players[0].page.waitForTimeout(1000);
        }
      }
    }

    if (!gameEnded) {
      throw new Error(`Game did not end after ${MAX_ITERATIONS} iterations`);
    }

    // ========== Step 7: Verify game end ==========
    console.log('\n=== Step 7: Game ended ===');
    await players[0].page.waitForTimeout(1000);

    const endText = await players[0].bodyText();
    if (endText.includes('Good wins!')) {
      console.log('  Result: Good wins!');
    } else if (endText.includes('Evil wins!')) {
      console.log('  Result: Evil wins!');
    } else if (endText.includes('Game Canceled')) {
      console.log('  Result: Game Canceled');
    } else {
      console.log('  Result: Unknown (game may have ended differently)');
    }

    // Take final screenshots of all players
    for (const player of players) {
      await player.screenshot('game-ended');
    }

    // ========== Final Results ==========
    console.log('\n=== Final Results ===');
    let hasCritical = false;
    for (const player of players) {
      const critical = player.getCriticalErrors();
      if (critical.length > 0) {
        console.log(`  ${player.name} critical JS errors:`);
        critical.forEach((e) => console.log(`    - ${e}`));
        hasCritical = true;
      }
    }

    if (hasCritical) {
      console.log('\nFAIL: Critical JavaScript errors detected');
      process.exit(1);
    }

    console.log('\nPASS: Full game completed');
  } catch (err) {
    console.error('\nFAIL:', err.message);
    // Screenshot all players on failure
    for (const player of players) {
      try {
        await player.screenshot('error');
      } catch {
        // ignore screenshot errors
      }
    }
    process.exit(1);
  } finally {
    for (const player of players) {
      await player.close();
    }
    await browser.close();
  }
}

testFullGame();
