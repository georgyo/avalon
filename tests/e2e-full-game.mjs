// Full game, played by PLAYERS (5..10, default 5) browser contexts against the peer-to-peer stack
// (tests/e2e-stack.mjs: GUN relay + vite). Every context is a separate device with its own anonymous key;
// the relay only forwards signed messages, the games' secrets live in the pages.
//
//   PLAYERS=10 node tests/e2e-full-game.mjs        BROWSER=chromium|firefox (default: firefox for 5
//   players, chromium otherwise, docs/p2p-protocol.md §12), RNG_SEED=<n> to replay a run,
//   ENFORCE_PERF=1 to fail when setup takes longer than SETUP_BUDGET_MS (default 15000, §12),
//   EVIL_FAIL_RATE=<0..1> how often an evil team member plays FAIL (default 0.5; 0 makes good win three
//   missions, so the game always reaches the assassination).
//
// This module also exports the helpers the other e2e tests use (e2e-reload, e2e-cancel, e2e-offline, ...).
// It only runs the full game when executed directly.

import { chromium, firefox } from 'playwright';
import { existsSync, mkdirSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const BASE_URL = process.env.BASE_URL || 'http://localhost:5173/';
export const PLAYER_NAMES = ['ALICE', 'BOB', 'CAROL', 'DAVE', 'EVE', 'FRANK', 'GRACE', 'HEIDI', 'IVAN', 'JUDY'];
export const EVIL_ROLES = ['MORGANA', 'ASSASSIN', 'EVIL MINION', 'MORDRED', 'OBERON'];

export function screenshotDirFor(name) {
  const dir = join(__dirname, 'screenshots', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Seeded PRNG for reproducible test runs. Set RNG_SEED env var to replay a specific run.
export const rngSeed = process.env.RNG_SEED ? parseInt(process.env.RNG_SEED, 10) : (Date.now() & 0xffffffff);

// Simple mulberry32 PRNG — deterministic given the same seed
function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const random = mulberry32(rngSeed);
export const EVIL_FAIL_RATE = process.env.EVIL_FAIL_RATE ? Number(process.env.EVIL_FAIL_RATE) : 0.5;

export function isErrorIgnorable(msg) {
  return (
    // GUN/SEA log rejected writes (forged or overwritten values) to the console (§7.1)
    msg.includes('Data hash not same as hash!') ||
    msg.includes('Signature did not match') ||
    // relay connection churn (reconnects, offline tests)
    msg.includes('WebSocket') ||
    msg.includes('websocket') ||
    msg.includes('net::ERR') ||
    msg.includes('ERR_INTERNET_DISCONNECTED') ||
    msg.includes('Failed to fetch') ||
    msg.includes('NetworkError') ||
    msg.includes('Network Error') ||
    msg.includes('Failed to load resource') ||
    msg.includes('favicon')
  );
}

// ============ Browsers ============

// Chromium: the bundled Playwright build, else CHROMIUM_PATH, else a build found under
// PLAYWRIGHT_BROWSERS_PATH (e.g. a preinstalled /opt/pw-browsers/chromium-*/chrome-linux/chrome).
function chromiumExecutable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    // fall through
  }
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      const exe = join(root, dir, 'chrome-linux', 'chrome');
      if (existsSync(exe)) return exe;
    }
  }
  return undefined;
}

export async function launchBrowser(kind = process.env.BROWSER || 'chromium') {
  const headlessEnv = process.env.HEADLESS;
  const headless = headlessEnv == null ? true : !/^(false|0|no)$/i.test(headlessEnv);
  if (kind === 'firefox') {
    try {
      return await firefox.launch({ headless });
    } catch (err) {
      if (process.env.BROWSER === 'firefox') throw err;
      console.log(`  firefox is not available (${err.message.split('\n')[0]}); using chromium`);
    }
  }
  return chromium.launch({ headless, executablePath: chromiumExecutable() });
}

// ============ Players ============

export class PlayerContext {
  constructor(name, browser, screenshotDir) {
    this.name = name;
    this.browser = browser;
    this.screenshotDir = screenshotDir;
    this.context = null;
    this.page = null;
    this.jsErrors = [];
    this.role = null;
    this.isAssassin = false;
    this.isEvil = false;
    this.stepNum = 0;
  }

  /**
   * `o.routeWs`: route the GUN websocket through Playwright, so that `netDown()` / `netUp()` cause a
   * real outage (context.setOffline does not close an open websocket in Chromium).
   */
  async init(context = null, o = {}) {
    this.context = context || (await this.browser.newContext());
    if (o.routeWs) {
      // `down`: null, or a predicate on the websocket URL (which relays are unreachable).
      this.net = { down: null, live: new Set() };
      await this.context.routeWebSocket(/\/gun$/, (ws) => {
        if (this.net.down && this.net.down(ws.url())) {
          ws.close({ code: 1001, reason: 'outage' }).catch(() => {});
          return;
        }
        const server = ws.connectToServer();
        const entry = { ws, server, url: ws.url() };
        this.net.live.add(entry);
        ws.onClose(() => this.net.live.delete(entry));
        server.onClose(() => this.net.live.delete(entry));
      });
      // The own relay's /api/relay-info is unreachable while it is down too.
      await this.context.route('**/api/relay-info', (route) => {
        if (this.net.down && this.net.down(route.request().url().replace(/\/api\/relay-info.*$/, '/gun').replace(/^http/, 'ws'))) {
          route.abort('connectionrefused').catch(() => {});
        } else {
          route.continue().catch(() => {});
        }
      });
    }
    this.page = await this.context.newPage();
    this.attach(this.page);
  }

  /** URLs of this device's open relay websockets (requires init(..., { routeWs: true })). */
  openRelays() {
    return this.net ? [...this.net.live].map((e) => e.url) : [];
  }

  /**
   * A real network outage for this device's GUN sockets (requires init(..., { routeWs: true })):
   * every relay, or only those whose websocket URL satisfies `match`.
   */
  async netDown(match = () => true) {
    if (!this.net) throw new Error('netDown() needs init({ routeWs: true })');
    this.net.down = match;
    for (const entry of [...this.net.live]) {
      if (!match(entry.url)) continue;
      await entry.ws.close({ code: 1001, reason: 'outage' }).catch(() => {});
      await entry.server.close({ code: 1001, reason: 'outage' }).catch(() => {});
      this.net.live.delete(entry);
    }
  }

  netUp() {
    if (this.net) this.net.down = null;
  }

  attach(page) {
    page.on('pageerror', (err) => {
      this.jsErrors.push(err.message);
      if (!isErrorIgnorable(err.message)) {
        console.log(`  [JS ERROR ${this.name}]`, err.message.substring(0, 200));
      }
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        this.jsErrors.push(text);
        if (!isErrorIgnorable(text)) {
          console.log(`  [console.error ${this.name}]`, text.substring(0, 200));
        }
      }
    });
  }

  async screenshot(label) {
    this.stepNum++;
    const path = join(this.screenshotDir, `${this.name}-${this.stepNum}-${label}.png`);
    await this.page.screenshot({ path, fullPage: true });
    return path;
  }

  async bodyText() {
    return (await this.page.textContent('body')) || '';
  }

  getCriticalErrors() {
    return this.jsErrors.filter((e) => !isErrorIgnorable(e));
  }

  async close() {
    if (this.context) await this.context.close().catch(() => {});
  }
}

export async function waitForBody(page, predicate, arg, timeout = 30000) {
  await page.waitForFunction(predicate, arg, { timeout });
}

export async function waitForText(page, texts, timeout = 30000) {
  const list = Array.isArray(texts) ? texts : [texts];
  await page.waitForFunction(
    (l) => {
      const body = document.body.textContent || '';
      return l.some((t) => body.includes(t));
    },
    list,
    { timeout },
  );
}

// ============ Helpers ============

// Anonymous login: choose a name; the browser creates its device key pair (§11.3).
export async function login(player) {
  console.log(`  Logging in ${player.name}...`);
  await player.page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForText(player.page, 'The Resistance Online', 30000);

  await player.page.click('[data-testid="anonymous-tab"]');
  const loginName = player.page.locator('[data-testid="login-name"] input');
  await loginName.fill(player.name);
  await player.page.locator('[data-testid="login-button"]').click();

  await waitForText(player.page, ['Your Name', 'Create Lobby', 'Logout'], 20000);
  await player.page.waitForTimeout(300);

  // The lobby screen is prefilled with the chosen name; type it again to be sure.
  const nameInput = player.page.locator('input').first();
  await nameInput.fill(player.name);
  await player.page.waitForTimeout(200);

  console.log(`  ${player.name} logged in`);
}

export async function lobbyCode(player) {
  const text = await player.page.locator('span.font-weight-bold.text-cyan-lighten-5').textContent();
  return text.trim();
}

export async function createLobby(player) {
  console.log(`  ${player.name} creating lobby...`);
  await player.page.click('button:has-text("Create Lobby")');
  await waitForText(player.page, ['Quit', 'Players'], 20000);
  await player.page.waitForTimeout(500);
  const code = await lobbyCode(player);
  if (!/^[ABCDEFGHJKLMNPQRSTVWXYZ]{4}$/.test(code)) {
    throw new Error(`Unexpected lobby code "${code}" (want 4 letters, §4.1)`);
  }
  console.log(`  Lobby created: ${code}`);
  return code;
}

// Join by code: discovery (up to 3 s), then the join request waits for the admin, who admits it by
// hand (a join without the invite link's ticket is never admitted automatically, §4.3).
export async function joinLobby(player, code, admin) {
  console.log(`  ${player.name} joining lobby ${code}...`);
  await player.page.click('button:has-text("Join Lobby")');
  const codeInput = player.page.locator('[data-testid="lobby-code"] input');
  await codeInput.waitFor({ state: 'visible', timeout: 5000 });
  await codeInput.fill(code);
  await player.page.click('button:has-text("Join Lobby")');
  if (admin) {
    await player.page.waitForSelector('[data-testid="waiting-for-admin"]', { timeout: 15000 });
    const admit = admin.page.locator(`[data-testid="admit-${player.name}"]`);
    await admit.waitFor({ state: 'visible', timeout: 30000 });
    await admit.click();
    console.log(`  ${admin.name} admitted ${player.name}`);
  }
  await waitForText(player.page, ['Quit', 'Players'], 30000);
  await player.page.waitForTimeout(300);
  console.log(`  ${player.name} joined lobby`);
}

/** The admin's invite link (§4.1), from the "Copy invite link" toast. */
export async function inviteLink(admin) {
  await admin.page.click('[data-testid="copy-invite"]');
  const toast = admin.page.locator('.Vue-Toastification__toast', { hasText: '?lobby=' }).last();
  await toast.waitFor({ state: 'visible', timeout: 10000 });
  const text = (await toast.textContent()) || '';
  const m = /(https?:\/\/\S+)/.exec(text);
  if (!m || !m[1].includes('&k=')) throw new Error(`no invite link with a key in "${text}"`);
  return m[1];
}

/** Join through the invite link: the ticket it carries makes the admin's device admit automatically. */
export async function joinViaInvite(player, link) {
  console.log(`  ${player.name} opening the invite link...`);
  await player.page.goto(link);
  const joinBtn = player.page.locator('button:has-text("Join Lobby")');
  await joinBtn.waitFor({ state: 'visible', timeout: 20000 });
  await joinBtn.click();
  await waitForText(player.page, ['Quit', 'Players'], 30000);
  await player.page.waitForTimeout(300);
  console.log(`  ${player.name} joined lobby via the invite link`);
}

export async function waitForAllInLobby(admin, names) {
  await waitForBody(
    admin.page,
    (n) => {
      const body = document.body.textContent || '';
      return n.every((x) => body.includes(x)) && body.includes(`${n.length} players`);
    },
    names,
    30000,
  );
}

// Start the game and wait until every seat finished the setup (keys, shuffles, deal, sight exchange).
export async function startGame(admin, players, setupTimeoutMs = 90000) {
  console.log(`  ${admin.name} starting game...`);
  const startBtn = admin.page.locator('button:has-text("Start Game")');
  await startBtn.waitFor({ state: 'visible', timeout: 15000 });
  await admin.page.waitForTimeout(300);
  const t0 = Date.now();
  await startBtn.click();

  // the setup progress shows while the devices shuffle and deal
  try {
    await admin.page.waitForSelector('[data-testid="setup-progress"]', { timeout: 10000 });
    console.log('  Setup:', (await admin.page.locator('[data-testid="setup-progress-text"]').textContent().catch(() => '')).trim());
  } catch {
    // setup may already be done
  }

  await Promise.all(players.map((p) => waitForText(p.page, ['Game Started', 'Team Proposal'], setupTimeoutMs)));
  const setupMs = Date.now() - t0;
  console.log(`  Game started on all ${players.length} devices after ${(setupMs / 1000).toFixed(1)} s`);
  return setupMs;
}

export async function dismissOverlays(player) {
  // Dismiss "Game Started" dialog if present (persistent, must click "View Role")
  const viewRoleBtn = player.page.locator('button:has-text("View Role")');
  if ((await viewRoleBtn.count()) > 0 && (await viewRoleBtn.isVisible().catch(() => false))) {
    await viewRoleBtn.click();
    await player.page.waitForTimeout(500);
  }

  // Dismiss any non-persistent dialogs and bottom sheets by pressing Escape repeatedly
  for (let i = 0; i < 4; i++) {
    const overlay = player.page.locator('.v-overlay--active');
    if ((await overlay.count()) > 0) {
      await player.page.keyboard.press('Escape');
      await player.page.waitForTimeout(400);
    } else {
      break;
    }
  }
}

export async function dismissAllOverlays(players) {
  for (const player of players) {
    await dismissOverlays(player);
  }
}

export async function readRole(player) {
  const viewRoleBtn = player.page.locator('button:has-text("View Role")');
  if ((await viewRoleBtn.count()) > 0 && (await viewRoleBtn.isVisible().catch(() => false))) {
    await viewRoleBtn.click();
  } else {
    await player.page.locator('button.role-btn').click({ force: true });
  }
  await waitForText(player.page, 'Your role is', 10000);
  await player.page.waitForTimeout(300);
  const bodyText = await player.bodyText();
  const roleMatch = bodyText.match(/Your role is ([A-Z ]+)\./);
  const role = roleMatch ? roleMatch[1].trim() : null;
  const isAssassin = bodyText.includes('You are also the ASSASSIN');
  const isEvil = EVIL_ROLES.includes(role) || bodyText.includes('evil team');
  await player.page.keyboard.press('Escape');
  await player.page.waitForTimeout(400);
  return { role, isAssassin, isEvil };
}

export async function discoverRoles(players) {
  console.log('  Discovering roles...');
  for (const player of players) {
    const info = await readRole(player);
    Object.assign(player, info);
    console.log(`  ${player.name}: ${player.role}${player.isAssassin ? ' (ASSASSIN)' : ''}${player.isEvil ? ' [evil]' : ' [good]'}`);
  }
}

export function detectPhase(bodyText) {
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

export async function waitForPhase(players, expectedPhases, timeoutMs = 45000) {
  if (typeof expectedPhases === 'string') expectedPhases = [expectedPhases];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let allReady = true;
    for (const player of players) {
      const phase = detectPhase(await player.bodyText());
      if (!expectedPhases.includes(phase)) {
        allReady = false;
        break;
      }
    }
    if (allReady) return;
    await players[0].page.waitForTimeout(500);
  }

  for (const player of players) {
    const phase = detectPhase(await player.bodyText());
    console.log(`  TIMEOUT: ${player.name} sees phase=${phase}`);
  }
  throw new Error(`Timed out waiting for phase(s): ${expectedPhases.join(', ')}`);
}

export async function findProposer(players) {
  for (const player of players) {
    const text = await player.bodyText();
    if (text.includes('Propose a team of')) {
      return player;
    }
  }
  return null;
}

// Fisher-Yates shuffle using the seeded PRNG for deterministic permutations
export function shuffleArray(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function extractTeamSize(bodyText) {
  const match = bodyText.match(/(?:Propose a|propose a) team of (\d+)/);
  return match ? parseInt(match[1]) : null;
}

export async function selectPlayer(page, name) {
  const listItem = page.locator('.v-list-item', { hasText: name }).first();
  const checkbox = listItem.locator('.v-selection-control__input').first();
  await checkbox.click({ force: true });
  await page.waitForTimeout(200);
}

export async function proposeTeam(proposer, teamSize, allPlayers) {
  const team = shuffleArray(allPlayers).slice(0, teamSize);
  const teamNames = team.map((p) => p.name);
  console.log(`  ${proposer.name} proposing team: ${teamNames.join(', ')}`);
  for (const name of teamNames) {
    await selectPlayer(proposer.page, name);
  }
  const proposeBtn = proposer.page.locator('button:has-text("Propose Team")');
  await proposeBtn.waitFor({ state: 'visible', timeout: 5000 });
  await proposeBtn.click({ timeout: 10000 });
  await proposer.page.waitForTimeout(300);
  return teamNames;
}

export async function voteOnProposal(players, approveRate = 0.7) {
  let approves = 0;
  let rejects = 0;

  for (const player of players) {
    const text = await player.bodyText();
    if (!text.includes('Team Proposal Vote')) continue;
    const approveBtn = player.page.locator('button:has-text("Approve")');
    if (await approveBtn.isDisabled().catch(() => true)) continue;   // already voted (e.g. after a reload)

    const approve = random() < approveRate;
    if (approve) {
      await approveBtn.click();
      approves++;
    } else {
      await player.page.locator('button:has-text("Reject")').click();
      rejects++;
    }
    await player.page.waitForTimeout(150);
  }

  console.log(`  Votes: ${approves} approve, ${rejects} reject`);
  return approves > rejects;
}

export async function doMission(players, teamNames) {
  let successes = 0;
  let fails = 0;

  for (const player of players) {
    if (teamNames && !teamNames.includes(player.name)) continue;
    const successBtn = player.page.locator('button:has-text("SUCCESS")');
    try {
      await successBtn.waitFor({ state: 'visible', timeout: teamNames ? 10000 : 1000 });
    } catch {
      continue;   // not on the team, or already voted
    }

    // Evil players randomly fail (EVIL_FAIL_RATE, default 50%), good always succeed
    const voteFail = player.isEvil && random() < EVIL_FAIL_RATE;
    if (voteFail) {
      await player.page.locator('button:has-text("FAIL")').click();
      fails++;
    } else {
      await successBtn.click();
      successes++;
    }
    await player.page.waitForTimeout(150);
  }

  console.log(`  Mission votes: ${successes} success, ${fails} fail`);
}

export async function doAssassination(players) {
  const assassin = players.find((p) => p.isAssassin);
  if (!assassin) {
    console.log('  No assassin found, waiting for game end...');
    return;
  }

  console.log(`  ${assassin.name} (assassin) selecting target...`);
  await waitForText(assassin.page, 'Assassination Attempt', 15000);
  await assassin.page.waitForTimeout(500);
  await dismissOverlays(assassin);

  const goodPlayers = players.filter((p) => !p.isEvil);
  const target = goodPlayers[Math.floor(random() * goodPlayers.length)];
  console.log(`  Assassinating ${target.name}...`);

  await selectPlayer(assassin.page, target.name);
  const assassinateBtn = assassin.page.locator(`button:has-text("Assassinate ${target.name}")`);
  await assassinateBtn.waitFor({ state: 'visible', timeout: 10000 });
  await assassinateBtn.click();
  await assassin.page.waitForTimeout(500);
  console.log(`  ${target.name} was assassinated`);
}

// One game-loop iteration from the current phase. Returns true when the game ended.
export async function playRound(players) {
  const phase = detectPhase(await players[0].bodyText());
  await dismissAllOverlays(players);

  switch (phase) {
    case 'TEAM_PROPOSAL': {
      const proposer = await findProposer(players);
      if (!proposer) throw new Error('No proposer found in TEAM_PROPOSAL phase');
      const teamSize = extractTeamSize(await proposer.bodyText());
      if (!teamSize) throw new Error('Could not extract team size from the proposer page');
      const teamNames = await proposeTeam(proposer, teamSize, players);
      await waitForPhase(players, ['PROPOSAL_VOTE', 'GAME_ENDED']);
      if (detectPhase(await players[0].bodyText()) === 'GAME_ENDED') return true;

      const approved = await voteOnProposal(players);
      console.log(`  Proposal ${approved ? 'APPROVED' : 'REJECTED'} (expected)`);
      await waitForPhase(players, ['MISSION_VOTE', 'TEAM_PROPOSAL', 'GAME_ENDED']);
      const next = detectPhase(await players[0].bodyText());
      if (next === 'GAME_ENDED') return true;
      if (next === 'MISSION_VOTE') {
        await doMission(players, teamNames);
        await waitForPhase(players, ['TEAM_PROPOSAL', 'ASSASSINATION', 'GAME_ENDED']);
        const after = detectPhase(await players[0].bodyText());
        if (after === 'GAME_ENDED') return true;
        if (after === 'ASSASSINATION') {
          await doAssassination(players);
          await waitForPhase(players, 'GAME_ENDED', 60000);
          return true;
        }
      }
      return false;
    }
    case 'PROPOSAL_VOTE':
      await voteOnProposal(players);
      await waitForPhase(players, ['MISSION_VOTE', 'TEAM_PROPOSAL', 'GAME_ENDED']);
      return false;
    case 'MISSION_VOTE':
      await doMission(players, null);
      await waitForPhase(players, ['TEAM_PROPOSAL', 'ASSASSINATION', 'GAME_ENDED']);
      return false;
    case 'ASSASSINATION':
      await doAssassination(players);
      await waitForPhase(players, 'GAME_ENDED', 60000);
      return true;
    case 'GAME_ENDED':
      return true;
    default:
      await players[0].page.waitForTimeout(1000);
      return false;
  }
}

export async function playUntilEnd(players, maxIterations = 60) {
  for (let i = 1; i <= maxIterations; i++) {
    console.log(`\n  --- Iteration ${i}, Phase: ${detectPhase(await players[0].bodyText())} ---`);
    if (await playRound(players)) return;
  }
  throw new Error(`Game did not end after ${maxIterations} iterations`);
}

export function endResult(text) {
  if (text.includes('Good wins!')) return 'Good wins!';
  if (text.includes('Evil wins!')) return 'Evil wins!';
  if (text.includes('Game Canceled')) return 'Game Canceled';
  return null;
}

/** The end-of-game table of `viewer` lists every player of `players` with the role they saw at the start. */
export async function assertEndTableRoles(viewer, players) {
  for (const player of players) {
    if (!player.role) continue;
    const row = viewer.page.locator('.v-overlay--active table tr', { hasText: player.name }).first();
    const rowText = (await row.textContent({ timeout: 10000 })) || '';
    if (!rowText.includes(player.role)) {
      throw new Error(`${viewer.name}'s end table shows "${rowText.trim()}" for ${player.name}, expected role ${player.role}`);
    }
  }
}

export async function quitLobby(player) {
  try {
    const body = await player.bodyText();
    if (body.includes('Your Name') || body.includes('Create Lobby')) {
      return;
    }

    const closeBtn = player.page.locator('button:has-text("Close")');
    if ((await closeBtn.count()) > 0 && (await closeBtn.isVisible().catch(() => false))) {
      await closeBtn.click();
      await player.page.waitForTimeout(500);
    }
    await dismissOverlays(player);

    const quitBtn = player.page.locator('button:has-text("Quit"), button:has(.mdi-exit-to-app)').first();
    if ((await quitBtn.count()) > 0 && (await quitBtn.isVisible().catch(() => false))) {
      await quitBtn.click();
      await player.page.waitForTimeout(500);

      const leaveBtn = player.page.locator('button:has-text("Leave Lobby")');
      const cancelBtn = player.page.locator('button:has-text("Cancel Game")');
      if ((await leaveBtn.count()) > 0 && (await leaveBtn.isVisible().catch(() => false))) {
        await leaveBtn.click();
      } else if ((await cancelBtn.count()) > 0 && (await cancelBtn.isVisible().catch(() => false))) {
        await cancelBtn.click();
      }

      await waitForText(player.page, ['Your Name', 'Create Lobby'], 15000);
    }

    console.log(`  ${player.name} left lobby`);
  } catch (err) {
    console.log(`  ${player.name} quit failed: ${err.message.substring(0, 100)}`);
  }
}

export async function quitAllPlayers(players) {
  for (const player of players) {
    await quitLobby(player);
  }
}

export function reportErrors(players) {
  let hasCritical = false;
  for (const player of players) {
    const critical = player.getCriticalErrors();
    if (critical.length > 0) {
      console.log(`  ${player.name} critical JS errors:`);
      critical.forEach((e) => console.log(`    - ${e}`));
      hasCritical = true;
    }
  }
  return hasCritical;
}

/**
 * The admin starts another game in the same lobby while the others still look at the end screen: the
 * new config must become current on every device (§4.6.4), and the end dialogs must close as soon as
 * the setup begins (the persistent overlay must not block the setup). The game is then canceled.
 */
export async function secondGame(players) {
  const admin = players[0];
  const closeBtn = admin.page.locator('button:has-text("Close")');
  if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click();
  await admin.page.waitForTimeout(500);
  const watcher = players[1];
  const endDialogOpen = () => watcher.page.locator('.v-dialog--fullscreen').isVisible().catch(() => false);
  if (!(await endDialogOpen())) throw new Error(`${watcher.name}'s end screen should still be open`);
  const startBtn = admin.page.locator('button:has-text("Start Game")');
  await startBtn.waitFor({ state: 'visible', timeout: 15000 });
  await startBtn.click();
  let sawSetup = false;
  try {
    await watcher.page.waitForSelector('[data-testid="setup-progress"]', { timeout: 15000 });
    sawSetup = true;
  } catch {
    // the setup may already be over
  }
  if (sawSetup) {
    // The dialog closes when the game leaves ENDED (its fade-out takes a moment); before the fix it
    // stayed up, empty, until the new game was ACTIVE.
    const closedDuringSetup = await watcher.page.waitForFunction(() => {
      const dialog = document.querySelector('.v-dialog--fullscreen');
      return !dialog && !!document.querySelector('[data-testid="setup-progress"]');
    }, null, { timeout: 5000 }).then(() => true, () => false);
    const stillSetup = (await watcher.page.locator('[data-testid="setup-progress"]').count()) > 0;
    if (!closedDuringSetup && stillSetup) throw new Error(`${watcher.name}'s end screen still covers the setup of the next game`);
  }
  await Promise.all(players.map((p) => waitForText(p.page, ['Game Started', 'Team Proposal'], 90000)));
  console.log(`  PASS: the second game started on all ${players.length} devices${sawSetup ? ' (end screens closed during the setup)' : ''}`);
  await dismissAllOverlays(players);
  await waitForPhase(players, 'TEAM_PROPOSAL');
  await admin.page.click('button:has-text("Quit")');
  await admin.page.getByRole('button', { name: 'Cancel Game', exact: true }).click();
  for (const player of players) await waitForText(player.page, 'Game Canceled', 60000);
  console.log('  PASS: the second game was canceled everywhere');
}

/**
 * Log in `count` players, create a lobby with the first, join the others (the second through the
 * invite link, the rest by code with the admin's approval), start a game.
 */
export async function setUpGame(browser, count, screenshotDir, o = {}) {
  const players = [];
  for (const name of PLAYER_NAMES.slice(0, count)) {
    const player = new PlayerContext(name, browser, screenshotDir);
    await player.init(null, o);
    players.push(player);
  }
  for (const player of players) await login(player);
  const code = await createLobby(players[0]);
  await joinViaInvite(players[1], await inviteLink(players[0]));
  for (const player of players.slice(2)) await joinLobby(player, code, players[0]);
  await waitForAllInLobby(players[0], players.map((p) => p.name));
  console.log(`  All ${count} players in lobby ${code}`);
  const setupMs = await startGame(players[0], players);
  return { players, code, setupMs };
}

// ============ Main Test ============

async function testFullGame() {
  const count = Number(process.env.PLAYERS || '5');
  if (!Number.isInteger(count) || count < 5 || count > 10) {
    throw new Error(`PLAYERS must be 5..10, got ${process.env.PLAYERS}`);
  }
  console.log(`\n=== Full Game E2E Test (${count} players) ===\n`);
  console.log(`RNG_SEED=${rngSeed} (replay with: RNG_SEED=${rngSeed} PLAYERS=${count} node tests/e2e-full-game.mjs)`);

  const screenshotDir = screenshotDirFor(`full-game-${count}`);
  const browser = await launchBrowser(process.env.BROWSER || (count <= 5 ? 'firefox' : 'chromium'));
  let players = [];

  try {
    console.log('=== Step 1-4: log in, create and join the lobby, start the game ===');
    const setUp = await setUpGame(browser, count, screenshotDir);
    players = setUp.players;
    const budget = Number(process.env.SETUP_BUDGET_MS || '15000');
    if (setUp.setupMs > budget) {
      const msg = `setup took ${setUp.setupMs} ms, budget ${budget} ms (§12 performance acceptance)`;
      if (process.env.ENFORCE_PERF === '1') throw new Error(msg);
      console.log(`  WARNING: ${msg}`);
    }
    for (const player of players) await player.screenshot('game-started');

    console.log('\n=== Step 5: Discover roles ===');
    await discoverRoles(players);
    const assassins = players.filter((p) => p.isAssassin).length;
    const evil = players.filter((p) => p.isEvil).length;
    const expectedEvil = { 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4 }[count];
    if (evil !== expectedEvil) throw new Error(`expected ${expectedEvil} evil players, roles say ${evil}`);
    if (assassins > 1) throw new Error(`${assassins} players think they are the assassin`);
    await dismissAllOverlays(players);

    console.log('\n=== Step 6: Play game loop ===');
    await playUntilEnd(players);

    console.log('\n=== Step 7: Game ended ===');
    await players[0].page.waitForTimeout(1000);
    const results = [];
    for (const player of players) {
      await waitForText(player.page, ['Good wins!', 'Evil wins!', 'Game Canceled'], 60000);
      results.push(endResult(await player.bodyText()));
      await player.screenshot('game-ended');
    }
    console.log(`  Result: ${results[0]}`);
    if (new Set(results).size !== 1) throw new Error(`players disagree on the outcome: ${results.join(', ')}`);
    if (results[0] === 'Game Canceled') throw new Error('an honest game must not end canceled');

    // every role is revealed at the end (§5.12): the end table shows each player's real role
    await assertEndTableRoles(players[0], players);

    console.log('\n=== Step 8: a second game in the same lobby (unchanged roster) ===');
    await secondGame(players);

    console.log('\n=== Step 9: All players quit lobby ===');
    await quitAllPlayers(players);
    for (const player of players) {
      const text = await player.bodyText();
      if (!text.includes('Your Name') && !text.includes('Create Lobby')) {
        throw new Error(`${player.name} did not return to lobby select screen`);
      }
    }
    console.log('  All players back on lobby select screen');

    console.log('\n=== Final Results ===');
    if (reportErrors(players)) {
      console.log('\nFAIL: Critical JavaScript errors detected');
      process.exitCode = 1;
    } else {
      console.log('\nPASS: Full game completed');
    }
  } catch (err) {
    console.error('\nFAIL:', err.message);
    process.exitCode = 1;
    for (const player of players) {
      try {
        await player.screenshot('error');
      } catch {
        // ignore screenshot errors
      }
    }
    console.log('\n=== Cleanup: All players quitting lobby ===');
    await quitAllPlayers(players);
  } finally {
    for (const player of players) {
      await player.close();
    }
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  testFullGame().catch((err) => {
    console.error('\nFAIL:', err.message);
    process.exit(1);
  });
}
