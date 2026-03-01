import _ from 'lodash';
import { RecordId } from 'surrealdb';
import { ROLES, getNumEvilForGameSize } from '@avalon/common';
import type { Role } from '@avalon/common';
import { db } from './surrealdb';
import { computeAndCombineStats } from './stats';
import {
  AvalonError,
  type Game,
  type Mission,
  type Proposal,
  type PlayerRole,
  type SecretVotes,
  type LobbyData,
  type SecretStateData,
  type LoginData,
  type JoinLobbyData,
  type LobbyActionData,
  type StartGameData,
  type TeamProposalData,
  type VoteData,
  type AssassinateData,
  type UserData,
} from './types';

// Per-lobby mutex to serialize operations and prevent race conditions
// (e.g., concurrent vote requests overwriting each other)
const lobbyLocks = new Map<string, Promise<void>>();

async function withLobbyLock<T>(lobby: string, fn: () => Promise<T>): Promise<T> {
  const existing = lobbyLocks.get(lobby) ?? Promise.resolve();

  let resolve!: () => void;
  const newLock = new Promise<void>(r => { resolve = r; });
  lobbyLocks.set(lobby, newLock);

  await existing;
  try {
    return await fn();
  } finally {
    resolve();
    if (lobbyLocks.get(lobby) === newLock) {
      lobbyLocks.delete(lobby);
    }
  }
}

function proposalTemplate(currentProposer: string, playerList: string[]): Proposal {
  const currentProposerIdx = playerList.indexOf(currentProposer);

  return {
    proposer: playerList[(currentProposerIdx + 1) % playerList.length],
    state: 'PENDING',
    team: [],
    votes: []
  };
}

function validateSafeName(name: string): void {
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
    throw new AvalonError(400, 'Invalid player name');
  }
}

function validateName(userName: string): void {
  validateSafeName(userName);
  if ((typeof userName != 'string') ||
      (!userName.match(/^[A-Z]+$/)) ||
      (userName.trim() != userName) ||
      (userName.length == 0) ||
      (ROLES.map(r => r.name).includes(userName))) {
    throw new AvalonError(400, 'Invalid username "' + userName + '"');
  }
}

function validateValue(value: unknown, desired: unknown, errMsg: string): void {
  if (desired != value) {
    throw new AvalonError(400, `${errMsg} should be ${desired} but was ${value}`);
  }
}

// Helper to get a lobby record, throws if not found
async function getLobby(lobbyName: string): Promise<LobbyData & { id: RecordId }> {
  const result = await db.query<[(LobbyData & { id: RecordId })[]]>(
    'SELECT * FROM lobby WHERE id = $id',
    { id: new RecordId('lobby', lobbyName) }
  );
  const lobby = result[0]?.[0];
  if (!lobby) throw new AvalonError(404, 'Lobby ' + lobbyName + ' does not exist');
  return lobby;
}

// Helper to get a user record, throws if not found
async function getUser(uid: string): Promise<UserData & { id: RecordId }> {
  const result = await db.query<[(UserData & { id: RecordId })[]]>(
    'SELECT * FROM user WHERE id = $id',
    { id: new RecordId('user', uid) }
  );
  const user = result[0]?.[0];
  if (!user) throw new AvalonError(404, 'User ' + uid + ' does not exist');
  return user;
}

// Helper to get secret state for a lobby
async function getSecretState(lobbyName: string): Promise<(SecretStateData & { id: RecordId }) | null> {
  const result = await db.query<[(SecretStateData & { id: RecordId })[]]>(
    'SELECT * FROM secret_state WHERE lobby = $lobby',
    { lobby: new RecordId('lobby', lobbyName) }
  );
  return result[0]?.[0] ?? null;
}

export async function loginUser(data: LoginData, uid: string): Promise<void> {
  const emailAddr = data.email;

  const result = await db.query<[(UserData & { id: RecordId })[]]>(
    'SELECT * FROM user WHERE id = $id',
    { id: new RecordId('user', uid) }
  );
  const userDoc = result[0]?.[0];

  if (userDoc) {
    if (userDoc.email != emailAddr) {
      throw new AvalonError(429, 'Mismatched emails: ' + userDoc.email + ' and ' + emailAddr);
    }

    if (userDoc.lobby) {
      // Check if the lobby still exists
      const lobbyResult = await db.query<[{ id: RecordId }[]]>(
        'SELECT id FROM lobby WHERE id = $id',
        { id: new RecordId('lobby', userDoc.lobby) }
      );
      if (!lobbyResult[0]?.[0]) {
        await db.query(
          'UPDATE user SET lobby = NONE WHERE id = $id',
          { id: new RecordId('user', uid) }
        );
      }
    }

    await db.query(
      'UPDATE user SET lastActive = time::now() WHERE id = $id',
      { id: new RecordId('user', uid) }
    );
  } else {
    console.log("Creating record for user", uid, 'with email', emailAddr);
    await db.query(
      `CREATE user SET
        id = $id,
        email = $email,
        created = time::now(),
        lastActive = time::now()`,
      { id: new RecordId('user', uid), email: emailAddr }
    );
  }
}

export async function joinLobby(data: JoinLobbyData, uid: string): Promise<{ lobby: string; name: string }> {
  validateName(data.name);
  return withLobbyLock(data.lobby, async () => {
    const userDoc = await getUser(uid);

    if (userDoc.lobby != null) {
      if (userDoc.lobby != data.lobby) {
        console.log('%s currently in %s tried to join %s', uid, userDoc.lobby, data.lobby);
      }
      return {
        lobby: userDoc.lobby,
        name: userDoc.name!,
      };
    }

    const lobbyDoc = await getLobby(data.lobby);

    if (lobbyDoc.users[data.name]) {
      throw new AvalonError(429, 'Name taken');
    }

    if (lobbyDoc.game.state == 'ACTIVE') {
      throw new AvalonError(429, "Cannot join while game is in progress");
    }

    // Update lobby users
    const updatedUsers = { ...lobbyDoc.users, [data.name]: { name: data.name, uid } };
    await db.query(
      'UPDATE lobby SET users = $users WHERE id = $id',
      { id: new RecordId('lobby', data.lobby), users: updatedUsers }
    );

    // Update user
    await db.query(
      'UPDATE user SET name = $name, lobby = $lobby, lastActive = time::now() WHERE id = $id',
      { id: new RecordId('user', uid), name: data.name, lobby: data.lobby }
    );

    return {
      lobby: data.lobby,
      name: data.name
    };
  });
}

export async function leaveLobby(data: LobbyActionData, uid: string): Promise<boolean> {
  return withLobbyLock(data.lobby, async () => {
    const userDoc = await getUser(uid);
    const lobbyDoc = await getLobby(data.lobby);
    const secretDoc = await getSecretState(data.lobby);

    const myName = userDoc.name!;

    if (lobbyDoc.game.state == 'ACTIVE') {
      await endGameTxn(data.lobby, lobbyDoc, secretDoc, 'CANCELED', myName + ' left the game');
    }

    // Remove user from lobby
    const updatedUsers = { ...lobbyDoc.users };
    delete updatedUsers[myName];
    await db.query(
      'UPDATE lobby SET users = $users WHERE id = $id',
      { id: new RecordId('lobby', data.lobby), users: updatedUsers }
    );

    // Clear user's lobby
    await db.query(
      'UPDATE user SET lobby = NONE, lastActive = time::now() WHERE id = $id',
      { id: new RecordId('user', uid) }
    );

    if (lobbyDoc.admin.uid == uid) {
      console.log("Need to swap admin");

      const eligibleUsers = Object.keys(lobbyDoc.users).filter(u => u != myName);

      if (eligibleUsers.length == 0) {
        console.log('No more users, will delete lobby', data.lobby);
        await db.query('DELETE lobby WHERE id = $id', { id: new RecordId('lobby', data.lobby) });
      } else {
        const users = lobbyDoc.users;
        console.log('Making new admin', data.lobby, users[eligibleUsers[0]]);
        await db.query(
          'UPDATE lobby SET admin = $admin WHERE id = $id',
          {
            id: new RecordId('lobby', data.lobby),
            admin: {
              uid: users[eligibleUsers[0]].uid,
              name: users[eligibleUsers[0]].name
            }
          }
        );
      }
    }
    return true;
  });
}

export async function kickPlayer(data: LobbyActionData, uid: string): Promise<boolean> {
  return withLobbyLock(data.lobby, async () => {
    const lobbyDoc = await getLobby(data.lobby);

    if (lobbyDoc.admin.uid != uid) {
      throw new AvalonError(403, 'Not lobby admin');
    }

    if (lobbyDoc.game.state == 'ACTIVE') {
      throw new AvalonError(429, "Cancel game first");
    }

    const user = lobbyDoc.users[data.name];
    if (!user) {
      throw new AvalonError(404, 'No such user');
    }

    if (user.uid == uid) {
      throw new AvalonError(400, "Can't kick yourself");
    }

    // Clear kicked user's lobby
    await db.query(
      'UPDATE user SET lobby = NONE WHERE id = $id',
      { id: new RecordId('user', user.uid) }
    );

    // Remove user from lobby
    const updatedUsers = { ...lobbyDoc.users };
    delete updatedUsers[data.name];
    await db.query(
      'UPDATE lobby SET users = $users WHERE id = $id',
      { id: new RecordId('lobby', data.lobby), users: updatedUsers }
    );

    return true;
  });
}

export async function createLobby(data: { name: string }, uid: string): Promise<{ lobby: string; name: string }> {
  validateName(data.name);

  const encodingString = "ABCDEFGHJKLMNPQRSTVWXYZ";
  const lobbyStrLength = 3;
  const maxId = Math.pow(encodingString.length, lobbyStrLength);

  function encodeId(id: number): string {
    let encoding = '';
    id = Math.floor(id);

    while(encoding.length < lobbyStrLength) {
      const remainder = id % encodingString.length;
      id = Math.floor(id / encodingString.length);
      encoding += encodingString[remainder];
    }

    return encoding;
  }

  async function runCreateLobbyTransaction(userName: string, userUid: string): Promise<{ lobby: string; name: string }> {
    console.log("Creating lobby for " + userUid);

    const userDoc = await getUser(userUid);

    if (userDoc.lobby) {
      await db.query(
        'UPDATE user SET lastActive = time::now() WHERE id = $id',
        { id: new RecordId('user', userUid) }
      );
      return {
        lobby: userDoc.lobby,
        name: userDoc.name!,
      };
    }

    const lobbyName = encodeId(Math.floor(Math.random() * maxId));

    // Check if lobby already exists
    const existing = await db.query<[{ id: RecordId }[]]>(
      'SELECT id FROM lobby WHERE id = $id',
      { id: new RecordId('lobby', lobbyName) }
    );

    if (existing[0]?.[0]) {
      // Lobby already exists, retry
      return runCreateLobbyTransaction(userName, userUid);
    }

    // Update user
    await db.query(
      'UPDATE user SET lobby = $lobby, name = $name WHERE id = $id',
      { id: new RecordId('user', userUid), lobby: lobbyName, name: userName }
    );

    // Create lobby
    await db.query(
      `CREATE lobby SET
        id = $id,
        admin = $admin,
        timeCreated = time::now(),
        users = $users,
        game = $game`,
      {
        id: new RecordId('lobby', lobbyName),
        admin: { uid: userUid, name: userName },
        users: { [userName]: { name: userName, uid: userUid } },
        game: { state: 'INIT' }
      }
    );

    return {
      lobby: lobbyName,
      name: userName,
    };
  }

  return runCreateLobbyTransaction(data.name, uid);
}

export async function cancelGame(data: LobbyActionData, uid: string): Promise<void> {
  return withLobbyLock(data.lobby, async () => {
    const lobbyDoc = await getLobby(data.lobby);
    const secretDoc = await getSecretState(data.lobby);

    validateValue(lobbyDoc.game.state, 'ACTIVE', 'Game state not active');
    if (lobbyDoc.users[data.name].uid != uid) {
      throw new AvalonError(404, 'You are not who you say you are');
    }
    await endGameTxn(data.lobby, lobbyDoc, secretDoc, 'CANCELED', 'Canceled by ' + data.name);
  });
}

function makeMissions(playerList: string[]): Mission[] {
  const missionSizes = new Map<number, number[]>()
    .set(5,  [2, 3, 2, 3, 3])
    .set(6,  [2, 3, 4, 3, 4])
    .set(7,  [2, 3, 3, 4, 4])
    .set(8,  [3, 4, 4, 5, 5])
    .set(9,  [3, 4, 4, 5, 5])
    .set(10, [3, 4, 4, 5, 5])
    .get(playerList.length)!;

  const missionConfig: Mission[] = missionSizes.map(teamSize => {
    return { state: 'PENDING' as const,
             teamSize,
             failsRequired: 1,
             team: [],
             proposals: []
            };
           });

  if (playerList.length >= 7) {
    missionConfig[3].failsRequired = 2;
  }

  missionConfig[0].proposals[0] = proposalTemplate(
      playerList[Math.floor(Math.random() * playerList.length)],
      playerList);

  return missionConfig;
}

interface RoleAssignment {
  name: string;
  role: Role & { assassin?: boolean };
  sees?: string[];
}

function assignRoles(playerList: string[], roles: string[] = []): Record<string, PlayerRole> {

  const makeTeam = function(teamList: string[], team: 'good' | 'evil'): RoleAssignment[] {
    const teamRoles = ROLES.filter(r => r.team == team);
    const specialRoles = teamRoles.filter(r => roles.includes(r.name)).slice(0, teamList.length);
    const fillerRole = teamRoles.find(r => r.filler)!;
    return _.zip(teamList, specialRoles).map(
      ([name, role]) => {
        return { name: name!, role: Object.assign({}, role ?? fillerRole) };
    });
  };

  const assignRolesImpl = function(playerList: string[], roles: string[]): Record<string, PlayerRole> {
    playerList = _.shuffle(playerList);

    const numEvil = getNumEvilForGameSize(playerList.length)!;
    const evilPlayers = playerList.slice(0, numEvil);
    const goodPlayers = playerList.slice(numEvil);

    const evilAssignments = makeTeam(evilPlayers, 'evil');
    if (roles.includes('MERLIN')) {
      _.maxBy(evilAssignments, p => p.role.assassinationPriority)!.role.assassin = true;
    }

    const assignments = evilAssignments.concat(makeTeam(goodPlayers, 'good'));

    assignments.forEach(r => {
      r.sees =
          _.shuffle(
            _.flatten(
              r.role.sees.map(
                seenRole => assignments.filter(
                  r2 => r2.role.name == seenRole &&
                  r2.name != r.name).map(r2 => r2.name))));
    });
    return _.keyBy(assignments.map(player => {
      return { name : player.name,
               role: player.role.name,
               assassin: player.role.assassin ? player.role.assassin : false,
               team: player.role.team,
               sees: player.sees! };
      }), (p) => p.name);
  };

  return assignRolesImpl(playerList, roles);
}

interface EndGameOptions {
  assassinated?: string | null;
  game?: Game;
  votes?: Record<string, boolean>[];
}

async function endGameTxn(
  lobbyName: string,
  lobbyDoc: LobbyData,
  secretDoc: SecretStateData | null,
  state: string,
  message: string,
  {
    assassinated = null,
    game = lobbyDoc.game,
    votes = (secretDoc?.votes?.mission ?? []) as Record<string, boolean>[]
  }: EndGameOptions = {}
): Promise<void> {

  validateValue(game.state, 'ACTIVE', 'Game state not active');
  game.state = 'ENDED';
  game.outcome = {
    state: state as 'GOOD_WIN' | 'EVIL_WIN' | 'CANCELED',
    message,
    assassinated: assassinated ?? null,
    roles: secretDoc ? Object.values(secretDoc.roles).map(
      r => _.pick(r, ['name', 'role', 'assassin'])) : [],
    votes,
  };

  const users = lobbyDoc.users;
  const uids = game.players.map(name => users[name].uid);

  // Delete player_role records for this lobby
  await db.query('DELETE player_role WHERE lobby = $lobby', { lobby: new RecordId('lobby', lobbyName) });

  // Delete secret_state for this lobby
  await db.query('DELETE secret_state WHERE lobby = $lobby', { lobby: new RecordId('lobby', lobbyName) });

  if (state != 'CANCELED') {
    const logName = (game.timeCreated || new Date().toISOString()) + '_' + lobbyName;
    const gameObj = {
      missions: game.missions,
      outcome: game.outcome,
      players: game.players.map(name => {
        return {
          name,
          uid: users[name].uid
        };
      }),
      options: game.options,
      timeCreated: game.timeCreated,
      timeFinished: new Date().toISOString()
    };
    await db.query(
      'CREATE game_log SET id = $id, missions = $missions, outcome = $outcome, players = $players, options = $options, timeCreated = $timeCreated, timeFinished = time::now()',
      {
        id: new RecordId('game_log', logName),
        missions: gameObj.missions,
        outcome: gameObj.outcome,
        players: gameObj.players,
        options: gameObj.options,
        timeCreated: gameObj.timeCreated,
      }
    );

    // Update user logs
    for (const uid of uids) {
      await db.query(
        'UPDATE user SET logs = array::union(logs ?? [], [$logName]) WHERE id = $id',
        { id: new RecordId('user', uid), logName }
      );
    }

    // Compute and store stats inline
    try {
      await computeAndCombineStats(gameObj);
    } catch (err) {
      console.error('Failed to compute stats:', err);
    }
  }

  // Update lobby game state
  await db.query(
    'UPDATE lobby SET game = $game WHERE id = $id',
    { id: new RecordId('lobby', lobbyName), game }
  );
}

export async function startGame(data: StartGameData, uid: string): Promise<boolean> {

  if (!Array.isArray(data.playerList) ||
    data.playerList.length < 5  ||
    data.playerList.length > 10 ||
    !data.playerList.every(p => typeof p === 'string')) {
    throw new AvalonError(400, 'Bad player list ' + data.playerList);
  }

  if (!Array.isArray(data.roles) || !data.roles.every(role => ROLES.find(r => r.name == role))) {
    throw new AvalonError(400, 'Bad roles ' + data.roles);
  }

  return withLobbyLock(data.lobby, async () => {
    const lobbyDoc = await getLobby(data.lobby);

    if (lobbyDoc.admin.uid != uid) {
      throw new AvalonError(403, 'Not lobby admin');
    }

    if (lobbyDoc.game.state == 'ACTIVE') {
      throw new AvalonError(429, 'Game already in progress');
    }

    const lobbyUsers = lobbyDoc.users;

    if ((data.playerList.length != Object.keys(lobbyUsers).length) ||
        !data.playerList.every(name => lobbyUsers[name])) {
      throw new AvalonError(400, 'Bad player list: ' + data.playerList.sort() +
        '. In lobby: ' + Object.keys(lobbyUsers).sort());
    }

    const roles = assignRoles(data.playerList, data.roles);
    const now = new Date().toISOString();

    // Update lobby with game state
    await db.query(
      'UPDATE lobby SET game = $game WHERE id = $id',
      {
        id: new RecordId('lobby', data.lobby),
        game: {
          state: 'ACTIVE',
          phase: 'TEAM_PROPOSAL',
          timeCreated: now,
          missions: makeMissions(data.playerList),
          players: data.playerList,
          roles: Object.values(roles).map(r => r.role),
          options: data.options
        }
      }
    );

    // Create secret state
    await db.query(
      'CREATE secret_state SET lobby = $lobby, roles = $roles, votes = $votes',
      {
        lobby: new RecordId('lobby', data.lobby),
        roles,
        votes: { mission: [], proposal: {} }
      }
    );

    // Create player role docs
    for (const role of Object.values(roles)) {
      const player = lobbyUsers[role.name];
      await db.query(
        `CREATE player_role SET
          lobby = $lobby,
          user = $user,
          uid = $uid,
          name = $name,
          role = $role,
          assassin = $assassin,
          sees = $sees`,
        {
          lobby: new RecordId('lobby', data.lobby),
          user: new RecordId('user', player.uid),
          uid: player.uid,
          name: player.name,
          role: role.role,
          assassin: role.assassin,
          sees: role.sees,
        }
      );
    }

    console.log('started game', data.lobby);
    return true;
  });
}

export async function proposeTeam(data: TeamProposalData, uid: string): Promise<void> {
  if (!Array.isArray(data.team)) {
    throw new AvalonError(400, 'Bad team: must be an array');
  }
  data.team = _.uniq(data.team);

  const missionIndex = Number(data.mission);
  const proposalIndex = Number(data.proposal);
  if (!Number.isInteger(missionIndex) || missionIndex < 0) {
    throw new AvalonError(400, `Invalid mission index: ${data.mission}`);
  }
  if (!Number.isInteger(proposalIndex) || proposalIndex < 0) {
    throw new AvalonError(400, `Invalid proposal index: ${data.proposal}`);
  }

  return withLobbyLock(data.lobby, async () => {
    const lobbyDoc = await getLobby(data.lobby);
    const game = lobbyDoc.game;

    validateValue(game.state, 'ACTIVE', 'Game state not active');
    validateValue(game.phase, 'TEAM_PROPOSAL', 'Game phase');

    if (!game || !Array.isArray(game.missions) || missionIndex >= game.missions.length) {
      throw new AvalonError(400, 'Mission not found');
    }
    const mission = game.missions[missionIndex];
    if (!Array.isArray(mission.proposals) || proposalIndex >= mission.proposals.length) {
      throw new AvalonError(400, 'Proposal not found');
    }
    const proposal = mission.proposals[proposalIndex];

    validateValue(mission.state, 'PENDING', "Mission state");
    validateValue(proposal.state, 'PENDING', 'Proposal state');

    const users = lobbyDoc.users;
    const proposerUid = users[proposal.proposer].uid;

    if (uid != proposerUid) {
      throw new AvalonError(404, 'You are not the proposer');
    }

    if (data.team.length != mission.teamSize) {
      throw new AvalonError(400, 'Bad team size. Need ' + mission.teamSize);
    }

    if (!data.team.every(p => game.players.includes(p))) {
      throw new AvalonError(400, 'Bad team: ' + data.team);
    }

    proposal.team = data.team;
    game.phase = 'PROPOSAL_VOTE';

    await db.query(
      'UPDATE lobby SET game = $game WHERE id = $id',
      { id: new RecordId('lobby', data.lobby), game }
    );
  });
}

async function recordVote(
  name: string,
  requestUid: string,
  lobby: string,
  missionIdx: number,
  proposalIdx: number,
  vote: boolean,
  gamePhase: string,
  proposalState: string,
  publicVotesListGetter: (game: Game, mission: Mission, proposal: Proposal) => string[],
  secretVotesListGetter: (secretVotes: SecretVotes) => Record<string, boolean>,
  voteValidator?: (name: string, vote: boolean, secretData: SecretStateData) => boolean
): Promise<void> {

  const lobbyDoc = await getLobby(lobby);
  const secretDoc = await getSecretState(lobby);
  if (!secretDoc) throw new AvalonError(500, 'Secret state not found');

  const game = lobbyDoc.game;

  validateValue(game.state, 'ACTIVE', 'Game state not active');
  validateValue(game.phase, gamePhase, 'Game phase');

  if (!game || !Array.isArray(game.missions) || missionIdx >= game.missions.length) {
    throw new AvalonError(400, 'Mission not found');
  }
  const mission = game.missions[missionIdx];
  if (!Array.isArray(mission.proposals) || proposalIdx >= mission.proposals.length) {
    throw new AvalonError(400, 'Proposal not found');
  }
  const proposal = mission.proposals[proposalIdx];

  validateValue(mission.state, 'PENDING', "Mission state");
  validateValue(proposal.state, proposalState, 'Proposal state');

  const users = lobbyDoc.users;
  const uid = users[name].uid;

  if (requestUid != uid) {
    console.log('%s is %s but request came from %s', name, uid, requestUid);
    throw new AvalonError(403, 'You are not who you say you are');
  }

  const publicVotes = publicVotesListGetter(game, mission, proposal);

  if (!publicVotes.includes(name)) {
    publicVotes.push(name);
  }

  if (voteValidator && !voteValidator(name, vote, secretDoc)) {
    console.log('%s is not allowed to vote %s, switching to %s', name, vote, !vote);
    vote = !vote;
  }

  const votes = secretDoc.votes;
  validateSafeName(name);
  secretVotesListGetter(votes)[name] = vote;

  await db.query(
    'UPDATE lobby SET game = $game WHERE id = $id',
    { id: new RecordId('lobby', lobby), game }
  );
  await db.query(
    'UPDATE secret_state SET votes = $votes WHERE id = $id',
    { id: secretDoc.id, votes }
  );
}

export async function voteTeam(data: VoteData, uid: string): Promise<void> {
  const missionIndex = Number(data.mission);
  const proposalIndex = Number(data.proposal);
  if (!Number.isInteger(missionIndex) || missionIndex < 0) {
    throw new AvalonError(400, `Invalid mission index: ${data.mission}`);
  }
  if (!Number.isInteger(proposalIndex) || proposalIndex < 0) {
    throw new AvalonError(400, `Invalid proposal index: ${data.proposal}`);
  }

  return withLobbyLock(data.lobby, async () => {
    await recordVote(data.name, uid, data.lobby, missionIndex,
      proposalIndex, data.vote, 'PROPOSAL_VOTE', 'PENDING',
      (_game, _mission, proposal) => proposal.votes,
      (secretVotes) => secretVotes.proposal);

    // Check/resolve proposal (now safe since we hold the lock)
    const lobbyDoc = await getLobby(data.lobby);
    const secretDoc = await getSecretState(data.lobby);
    if (!secretDoc) return;

    const game = lobbyDoc.game;
    if (!game || !Array.isArray(game.missions) || missionIndex >= game.missions.length) {
      throw new AvalonError(400, 'Mission not found');
    }
    const mission = game.missions[missionIndex];
    if (!Array.isArray(mission.proposals) || proposalIndex >= mission.proposals.length) {
      throw new AvalonError(400, 'Proposal not found');
    }
    const proposal = mission.proposals[proposalIndex];
    const votes = secretDoc.votes;

    if (proposal.state != 'PENDING') {
      return;
    }

    if (Object.keys(votes.proposal).length != game.players.length) {
      return;
    }

    proposal.votes = Object.entries(votes.proposal).filter(([_n, vote]) => vote).map(([name, _v]) => name);
    console.log('approvers are', proposal.votes);

    if (proposal.votes.length < Math.floor(game.players.length / 2) + 1) {
      proposal.state = 'REJECTED';

      if (proposalIndex == 4) {
        return endGameTxn(data.lobby, lobbyDoc, secretDoc, 'EVIL_WIN', "Five team proposals in a row rejected", { game });
      } else {
        game.phase = 'TEAM_PROPOSAL';
        mission.proposals.push(proposalTemplate(proposal.proposer, game.players));
      }
    } else {
      proposal.state = 'APPROVED';
      game.phase = 'MISSION_VOTE';
      votes.mission.push({});
    }

    votes.proposal = {};
    await db.query(
      'UPDATE lobby SET game = $game WHERE id = $id',
      { id: new RecordId('lobby', data.lobby), game }
    );
    await db.query(
      'UPDATE secret_state SET votes = $votes WHERE id = $id',
      { id: secretDoc.id, votes }
    );
  });
}

export async function doMission(data: VoteData, uid: string): Promise<void> {
  const missionIndex = Number(data.mission);
  const proposalIndex = Number(data.proposal);
  if (!Number.isInteger(missionIndex) || missionIndex < 0) {
    throw new AvalonError(400, `Invalid mission index: ${data.mission}`);
  }
  if (!Number.isInteger(proposalIndex) || proposalIndex < 0) {
    throw new AvalonError(400, `Invalid proposal index: ${data.proposal}`);
  }

  return withLobbyLock(data.lobby, async () => {
    await recordVote(data.name, uid, data.lobby, missionIndex,
      proposalIndex, data.vote, 'MISSION_VOTE', 'APPROVED',
      (_game, mission, _proposal) => mission.team,
      (secretVotes) => secretVotes.mission[missionIndex],
      ((name, vote, secretData) => vote || secretData.roles[name].team == 'evil')
    );

    // Check/resolve mission (now safe since we hold the lock)
    const lobbyDoc = await getLobby(data.lobby);
    const secretDoc = await getSecretState(data.lobby);
    if (!secretDoc) return;

    const game = lobbyDoc.game;
    if (!game || !Array.isArray(game.missions) || missionIndex >= game.missions.length) {
      throw new AvalonError(400, 'Mission not found');
    }
    const mission = game.missions[missionIndex];
    if (!Array.isArray(mission.proposals) || proposalIndex >= mission.proposals.length) {
      throw new AvalonError(400, 'Proposal not found');
    }
    const proposal = mission.proposals[proposalIndex];
    const votes = secretDoc.votes;

    if (mission.state != 'PENDING') {
      return;
    }

    if (!votes || !votes.mission || !votes.mission[missionIndex] ||
        Object.keys(votes.mission[missionIndex]).length != mission.teamSize) {
      return;
    }

    mission.team = proposal.team;

    mission.numFails = Object.values(votes.mission[missionIndex]).filter(v => !v).length;

    if (mission.numFails < mission.failsRequired) {
      mission.state = 'SUCCESS';
    } else {
      mission.state = 'FAIL';
    }

    const failedMissions = game.missions.filter(m => m.state == 'FAIL').length;
    const succeededMissions = game.missions.filter(m => m.state == 'SUCCESS').length;

    if (failedMissions == 3) {
      await endGameTxn(data.lobby, lobbyDoc, secretDoc, 'EVIL_WIN', 'Three failed missions', { game });
    } else if (succeededMissions == 3) {
      if (game.roles.includes('MERLIN')) {
        game.phase = 'ASSASSINATION';
        await db.query(
          'UPDATE lobby SET game = $game WHERE id = $id',
          { id: new RecordId('lobby', data.lobby), game }
        );
      } else {
        await endGameTxn(data.lobby, lobbyDoc, secretDoc, 'GOOD_WIN', 'Three missions succeeded', { game });
      }
    } else {
      game.phase = 'TEAM_PROPOSAL';
      const nextMissionIndex = missionIndex + 1;
      if (nextMissionIndex >= game.missions.length) {
        throw new AvalonError(500, 'Invariant violated: no next mission available for TEAM_PROPOSAL phase');
      }
      game.missions[nextMissionIndex].proposals.push(proposalTemplate(proposal.proposer, game.players));
      await db.query(
        'UPDATE lobby SET game = $game WHERE id = $id',
        { id: new RecordId('lobby', data.lobby), game }
      );
    }
  });
}

export async function assassinate(data: AssassinateData, uid: string): Promise<boolean> {
  return withLobbyLock(data.lobby, async () => {
    const lobbyDoc = await getLobby(data.lobby);
    const secretDoc = await getSecretState(data.lobby);
    if (!secretDoc) throw new AvalonError(500, 'Secret state not found');

    validateValue(lobbyDoc.game.state, 'ACTIVE', 'Game state not active');
    validateValue(lobbyDoc.game.phase, 'ASSASSINATION', 'Game phase');

    const users = lobbyDoc.users;
    if (uid != users[data.name].uid) {
      console.warn('%s is %s but request came from %s', data.name, users[data.name].uid, uid);
      throw new AvalonError(403, 'You are not who you say you are');
    }

    const roles = secretDoc.roles;
    if (!roles[data.name].assassin) {
      console.warn('%s is %o', data.name, roles[data.name]);
      throw new AvalonError(403, 'You are not the assassin');
    }

    if (roles[data.target].role == 'MERLIN') {
      await endGameTxn(data.lobby, lobbyDoc, secretDoc, 'EVIL_WIN', 'Merlin assassinated', { assassinated: data.target });
    } else {
      await endGameTxn(data.lobby, lobbyDoc, secretDoc, 'GOOD_WIN', 'Three successful missions', { assassinated: data.target });
    }
    return true;
  });
}
