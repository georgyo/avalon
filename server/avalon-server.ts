import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import type { firestore } from 'firebase-admin';
import _ from 'lodash';
import { ROLES, getNumEvilForGameSize } from '@avalon/common';
import type { Role } from '@avalon/common';
import {
  AvalonError,
  type Game,
  type Mission,
  type Proposal,
  type PlayerRole,
  type SecretVotes,
  type LoginData,
  type JoinLobbyData,
  type LobbyActionData,
  type StartGameData,
  type TeamProposalData,
  type VoteData,
  type AssassinateData,
} from './types';

const db = getFirestore();

const SECRET_STATE_DOC_NAME = 'SECRET_STATE_ARCHIVES__';

function proposalTemplate(currentProposer: string, playerList: string[]): Proposal {
  const currentProposerIdx = playerList.indexOf(currentProposer);

  return {
    proposer: playerList[(currentProposerIdx + 1) % playerList.length],
    state: 'PENDING',
    team: [],
    votes: []
  };
}

function validateName(userName: string): void {
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

function validateField(doc: firestore.DocumentSnapshot, field: string, value: unknown): void {
  validateValue(doc.get(field), value, field);
}

export function loginUser(data: LoginData, uid: string): Promise<void> {
  const userDocRef = db.collection('users').doc(uid);
  const emailAddr = data.email;

  return db.runTransaction(function(txn) {
    return txn.get(userDocRef).then(function(userDoc) {
      if (userDoc.exists) {
        if (userDoc.get('email') != emailAddr) {
          throw new AvalonError(429, 'Mismatched emails: ' + userDoc.get('emails') + ' and ' + emailAddr);
        }
        const lobbyName = userDoc.get('lobby') as string | undefined;
        if (lobbyName) {
          const lobbyDocRef = db.collection('lobbies').doc(lobbyName);
          return txn.get(lobbyDocRef).then(function (lobbyDoc) {
            if (!lobbyDoc.exists) {
              txn.update(userDocRef, {
                lobby: FieldValue.delete()
              });
            }
            txn.update(userDocRef, {
                lastActive: FieldValue.serverTimestamp()
            });
          });
        }
      } else {
        console.log("Creating record for user", uid, 'with email', emailAddr);
        txn.set(db.collection('users').doc(uid), {
          uid,
          email: emailAddr,
          created: FieldValue.serverTimestamp(),
          lastActive: FieldValue.serverTimestamp()
        });
      }
   });
  });
}

export function joinLobby(data: JoinLobbyData, uid: string): Promise<{ lobby: string; name: string }> {
  validateName(data.name);

  const userDocRef = db.collection('users').doc(uid);
  const lobbyDocRef = db.collection('lobbies').doc(data.lobby);

  return db.runTransaction(function(transaction) {
    return Promise.all([
      transaction.get(userDocRef),
      transaction.get(lobbyDocRef),
    ]).then(function([userDoc, lobbyDoc]) {
      if (!userDoc.exists) {
        throw new AvalonError(404, 'User ' + uid + ' does not exist');
      }

      const currentLobby = userDoc.get('lobby') as string | undefined;
      if (currentLobby != null) {
        if (currentLobby != data.lobby) {
          console.log(uid, 'currently in', userDoc.get('lobby'), 'tried to join', data.lobby);
        }
        return {
          lobby: userDoc.get('lobby') as string,
          name: userDoc.get('name') as string,
        };
      }

      if (!lobbyDoc.exists) {
        throw new AvalonError(404, 'Lobby ' + data.lobby + ' does not exist');
      }

      if ((lobbyDoc.get('users') as Record<string, unknown>)[data.name]) {
        throw new AvalonError(429, 'Name taken');
      }

      if (lobbyDoc.get('game.state') == 'ACTIVE') {
        throw new AvalonError(429, "Cannot join while game is in progress");
      }

      transaction.update(lobbyDocRef, {
        ["users." + data.name]: {
          name: data.name,
          uid
        }
      }).update(userDocRef, {
        name: data.name,
        lobby: data.lobby,
        lastActive: FieldValue.serverTimestamp()
      });

      return {
        lobby: data.lobby,
        name: data.name
      };
    });
  });
}

export function leaveLobby(data: LobbyActionData, uid: string): Promise<boolean> {
  const userDocRef = db.collection('users').doc(uid);
  const lobbyDocRef = db.collection('lobbies').doc(data.lobby);
  const secretDocRef = lobbyDocRef.collection('roles').doc(SECRET_STATE_DOC_NAME);

  return db.runTransaction(function(txn) {
    return Promise.all([
      txn.get(userDocRef),
      txn.get(lobbyDocRef),
      txn.get(secretDocRef),
    ]).then(function([userDoc, lobbyDoc, secretDoc]) {
      if (!userDoc.exists || !lobbyDoc.exists) {
        throw new AvalonError(404, 'You are not in that lobby');
      }

      const myName = userDoc.get('name') as string;

      if (lobbyDoc.get('game.state') == 'ACTIVE') {
        endGameTxn(txn, lobbyDoc, secretDoc, 'CANCELED', myName + ' left the game');
      }

      txn.update(lobbyDocRef, 'users.' + myName, FieldValue.delete());
      txn.update(userDocRef, {
        lobby: FieldValue.delete(),
        lastActive: FieldValue.serverTimestamp()
      });

      if (lobbyDoc.get('admin.uid') == uid) {
        console.log("Need to swap admin");

        const eligibleUsers = Object.keys(lobbyDoc.get('users') as Record<string, unknown>).filter(u => u != myName);

        if (eligibleUsers.length == 0) {
          console.log('No more users, will delete lobby', data.lobby);
          txn.delete(lobbyDocRef);
        } else {
          const users = lobbyDoc.get('users') as Record<string, { uid: string; name: string }>;
          console.log('Making new admin', data.lobby, users[eligibleUsers[0]]);
          txn.update(lobbyDocRef, {
            admin: {
              uid: users[eligibleUsers[0]].uid,
              name: users[eligibleUsers[0]].name
            }
          });
        }
      }
      return true;
    });
  });
}

export function kickPlayer(data: LobbyActionData, uid: string): Promise<boolean> {
  const lobbyDocRef = db.collection('lobbies').doc(data.lobby);

  return db.runTransaction(function(txn) {
    return lobbyDocRef.get().then(function(lobbyDoc) {

      if (lobbyDoc.get('admin.uid') != uid) {
        throw new AvalonError(403, 'Not lobby admin');
      }

      if (lobbyDoc.get('game.state') == 'ACTIVE') {
        throw new AvalonError(429, "Cancel game first");
      }

      const user = (lobbyDoc.get('users') as Record<string, { uid: string; name: string }>)[data.name];
      if (!user) {
        throw new AvalonError(404, 'No such user');
      }

      if (user.uid == uid) {
        throw new AvalonError(400, "Can't kick yourself");
      }

      txn.update(db.collection('users').doc(user.uid), {
        lobby: FieldValue.delete()
      });
      txn.update(lobbyDocRef, { ['users.' + user.name] : FieldValue.delete() } );

      return true;
    });
  });
}

export function createLobby(data: { name: string }, uid: string): Promise<{ lobby: string; name: string }> {
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

  class LobbyAlreadyExists extends Error {
    constructor(lobbyName: string) {
      super("Lobby " + lobbyName + " already exists");
      this.name = "LobbyAlreadyExists";
    }
  }

  function runCreateLobbyTransaction(userName: string, userUid: string): Promise<{ lobby: string; name: string }> {
    console.log("Creating lobby for " + userUid);

    const userDocRef = db.collection('users').doc(userUid);

    return db.runTransaction(function(transaction) {
      const lobbyName = encodeId(Math.floor(Math.random() * maxId));
      const lobbyDocRef = db.collection('lobbies').doc(lobbyName);

      return Promise.all([
        transaction.get(lobbyDocRef),
        transaction.get(userDocRef)
      ]).then(function([lobbyDoc, userDoc]) {
        if (!userDoc.exists) {
          throw new AvalonError(404, 'No such user');
        }

        if (userDoc.get('lobby')) {
          transaction.update(userDocRef, { lastActive: FieldValue.serverTimestamp()});
          return {
            lobby: userDoc.get('lobby') as string,
            name: userDoc.get('name') as string,
          };
        }

        if (lobbyDoc.exists) {
          throw new LobbyAlreadyExists(lobbyName);
        }

        transaction.update(userDocRef, {
          lobby: lobbyName,
          name: userName
        }).set(lobbyDocRef, {
          admin: {
            uid: userUid,
            name: userName
          },
          timeCreated: FieldValue.serverTimestamp(),
          users: {
            [userName]: {
              name: userName,
              uid: userUid
            }
          },
          game: { state: 'INIT' }
        });

        return {
          lobby: lobbyName,
          name: userName,
        };
      });
    }).catch(function(err: unknown) {
      if (err instanceof LobbyAlreadyExists) {
        return runCreateLobbyTransaction(userName, userUid);
      } else {
        throw err;
      }
    });
  }

  return runCreateLobbyTransaction(data.name, uid);
}

export function cancelGame(data: LobbyActionData, uid: string): Promise<void> {
  const lobbyDocRef = db.collection('lobbies').doc(data.lobby);
  const secretDocRef = lobbyDocRef.collection('roles').doc(SECRET_STATE_DOC_NAME);

  return db.runTransaction(function(txn) {
    return Promise.all([
      txn.get(lobbyDocRef),
      txn.get(secretDocRef),
    ]).then(function([lobbyDoc, secretDoc]) {
      validateField(lobbyDoc, 'game.state', 'ACTIVE');
      const users = lobbyDoc.get('users') as Record<string, { uid: string }>;
      if (users[data.name].uid != uid) {
        throw new AvalonError(404, 'You are not who you say you are');
      }
      endGameTxn(txn, lobbyDoc, secretDoc, 'CANCELED', 'Canceled by ' + data.name);
    });
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

function assignRoles(playerList: string[], roles: string[] = [], _oldRoles?: unknown): Record<string, PlayerRole> {

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

function endGameTxn(
  txn: firestore.Transaction,
  lobbyDoc: firestore.DocumentSnapshot,
  secretDoc: firestore.DocumentSnapshot,
  state: string,
  message: string,
  {
    assassinated = null,
    game = lobbyDoc.get('game') as Game,
    votes = (secretDoc.get('votes.mission') ?? []) as Record<string, boolean>[]
  }: EndGameOptions = {}
): void {

  validateValue(game.state, 'ACTIVE', 'Game state not active');
  game.state = 'ENDED';
  game.outcome = {
    state: state as 'GOOD_WIN' | 'EVIL_WIN' | 'CANCELED',
    message,
    assassinated: assassinated ?? null,
    roles: Object.values(secretDoc.get('roles') as Record<string, PlayerRole>).map(
      r => _.pick(r, ['name', 'role', 'assassin'])),
    votes,
  };

  const users = lobbyDoc.get('users') as Record<string, { uid: string }>;
  const uids = game.players.map(name => users[name].uid);

  uids.forEach(uid => txn.delete(lobbyDoc.ref.collection('roles').doc(uid)));
  txn.delete(lobbyDoc.ref.collection('roles').doc(SECRET_STATE_DOC_NAME));

  if (state != 'CANCELED') {
    const logName = game.timeCreated!.toDate().toISOString() + '_' + lobbyDoc.id;
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
      timeCreated: lobbyDoc.get('game.timeCreated'),
      timeFinished: FieldValue.serverTimestamp()
    };
    txn.set(db.collection('logs').doc(logName), gameObj);
    uids.forEach(uid => txn.update(db.collection('users').doc(uid), "logs", FieldValue.arrayUnion(logName)));
  }
  txn.update(lobbyDoc.ref, "game", game);
}

export function startGame(data: StartGameData, uid: string): Promise<boolean> {

  if (!data.playerList ||
    data.playerList.length < 5  ||
    data.playerList.length > 10) {
    throw new AvalonError(400, 'Bad player list length' + data.playerList);
  }

  if (!data.roles || !data.roles.every(role => ROLES.find(r => r.name == role))) {
    throw new AvalonError(400, 'Bad roles ' + data.roles);
  }

  const lobbyDocRef = db.collection('lobbies').doc(data.lobby);

  return db.runTransaction(function(txn) {
    return lobbyDocRef.get().then(function(lobbyDoc) {

      if (!lobbyDoc.exists) {
        throw new AvalonError(404, 'No such lobby: ' + data.lobby);
      }

      if (lobbyDoc.get('admin.uid') != uid) {
        throw new AvalonError(403, 'Not lobby admin');
      }

      const curGameState = lobbyDoc.get('game.state');

      if (curGameState == 'ACTIVE') {
        throw new AvalonError(429, 'Game already in progress');
      }

      const lobbyUsers = lobbyDoc.get('users') as Record<string, { uid: string; name: string }>;

      if ((data.playerList.length != Object.keys(lobbyUsers).length) ||
          !data.playerList.every(name => lobbyUsers[name])) {
        throw new AvalonError(400, 'Bad player list: ' + data.playerList.sort() +
          '. In lobby: ' + Object.keys(lobbyUsers).sort());
      }

      const roles = assignRoles(data.playerList, data.roles, lobbyDoc.get('game.outcome.roles'));

      txn.update(lobbyDocRef, {
        game : {
          state: 'ACTIVE',
          phase: 'TEAM_PROPOSAL',
          timeCreated: FieldValue.serverTimestamp(),
          missions: makeMissions(data.playerList),
          players: data.playerList,
          roles: Object.values(roles).map(r => r.role),
          options: data.options
        }});
      txn.set(lobbyDocRef.collection('roles').doc(SECRET_STATE_DOC_NAME), {
        roles,
        votes: { mission: [], proposal: {} }
      });

      Object.values(roles).forEach(role => {
        const player = lobbyUsers[role.name];
        txn.set(lobbyDocRef.collection('roles').doc(player.uid), {
          uid: player.uid,
          name: player.name,
          assassin: role.assassin,
          role: role.role,
          sees: role.sees,
        });
      });
      console.log('started game', data.lobby);
      return true;
    });
  });
}

export function proposeTeam(data: TeamProposalData, uid: string): Promise<void> {
  data.team = _.uniq(data.team);

  const lobbyDocRef = db.collection('lobbies').doc(data.lobby);

  return db.runTransaction(function(txn) {
    return lobbyDocRef.get().then(function(lobbyDoc) {
      validateField(lobbyDoc, 'game.state', 'ACTIVE');
      validateField(lobbyDoc, 'game.phase', 'TEAM_PROPOSAL');

      const game = lobbyDoc.get('game') as Game;
      const mission = game.missions[data.mission];
      const proposal = mission.proposals[data.proposal];

      validateValue(mission.state, 'PENDING', "Mission state");
      validateValue(proposal.state, 'PENDING', 'Proposal state');

      const users = lobbyDoc.get('users') as Record<string, { uid: string }>;
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

      txn.update(lobbyDocRef, 'game', game);
    });
  });
}

function recordVote(
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
  voteValidator?: (name: string, vote: boolean, secretDoc: firestore.DocumentSnapshot) => boolean
): Promise<void> {

  const lobbyDocRef = db.collection('lobbies').doc(lobby);
  const secretDocRef = lobbyDocRef.collection('roles').doc(SECRET_STATE_DOC_NAME);

  return db.runTransaction(function(txn) {
    return Promise.all([
      txn.get(lobbyDocRef),
      txn.get(secretDocRef)]).then(function([lobbyDoc, secretDoc]) {
      validateField(lobbyDoc, 'game.state', 'ACTIVE');
      validateField(lobbyDoc, 'game.phase', gamePhase);

      const game = lobbyDoc.get('game') as Game;
      const mission = game.missions[missionIdx];
      const proposal = mission.proposals[proposalIdx];

      validateValue(mission.state, 'PENDING', "Mission state");
      validateValue(proposal.state, proposalState, 'Proposal state');

      const users = lobbyDoc.get('users') as Record<string, { uid: string }>;
      const uid = users[name].uid;

      if (requestUid != uid) {
        console.log(name, 'is', uid, 'but request came from', requestUid);
        throw new AvalonError(403, 'You are not who you say you are');
      }

      const publicVotes = publicVotesListGetter(game, mission, proposal);

      if (!publicVotes.includes(name)) {
        publicVotes.push(name);
      }

      if (voteValidator && !voteValidator(name, vote, secretDoc)) {
        console.log(name, 'is not allowed to vote', vote, ', switching to ', !vote);
        vote = !vote;
      }

      const votes = secretDoc.get('votes') as SecretVotes;
      if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
        throw new AvalonError(400, 'Invalid player name');
      }
      secretVotesListGetter(votes)[name] = vote;

      txn.update(lobbyDocRef, "game", game);
      txn.update(secretDocRef, "votes", votes);
    });
  });
}

export function voteTeam(data: VoteData, uid: string): Promise<void> {
  const lobbyDocRef = db.collection('lobbies').doc(data.lobby);
  const secretDocRef = lobbyDocRef.collection('roles').doc(SECRET_STATE_DOC_NAME);

  return recordVote(data.name, uid, data.lobby, data.mission,
    data.proposal, data.vote, 'PROPOSAL_VOTE', 'PENDING',
    (_game, _mission, proposal) => proposal.votes,
    (secretVotes) => secretVotes.proposal).then(function() {
    return db.runTransaction(function(txn) {
      return Promise.all([
        txn.get(lobbyDocRef),
        txn.get(secretDocRef)]).then(function([lobbyDoc, secretDoc]) {
        const game = lobbyDoc.get('game') as Game;
        const mission = game.missions[data.mission];
        const proposal = mission.proposals[data.proposal];
        const votes = secretDoc.get('votes') as SecretVotes;

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

          if (data.proposal == 4) {
            return endGameTxn(txn, lobbyDoc, secretDoc, 'EVIL_WIN', "Five team proposals in a row rejected", { game });
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
        txn.update(lobbyDocRef, "game", game);
        txn.update(secretDocRef, "votes", votes);
      });
    });
  });
}

export function doMission(data: VoteData, uid: string): Promise<void> {
  const lobbyDocRef = db.collection('lobbies').doc(data.lobby);
  const secretDocRef = lobbyDocRef.collection('roles').doc(SECRET_STATE_DOC_NAME);

  return recordVote(data.name, uid, data.lobby, data.mission,
    data.proposal, data.vote, 'MISSION_VOTE', 'APPROVED',
    (_game, mission, _proposal) => mission.team,
    (secretVotes) => secretVotes.mission[data.mission],
    ((name, vote, secretDoc) => vote || (secretDoc.get('roles') as Record<string, PlayerRole>)[name].team == 'evil')
    ).then(function() {
    return db.runTransaction(function(txn) {
      return Promise.all([
        txn.get(lobbyDocRef),
        txn.get(secretDocRef)]).then(
          function([lobbyDoc, secretDoc]) {
      const game = lobbyDoc.get('game') as Game;
      const mission = game.missions[data.mission];
      const proposal = mission.proposals[data.proposal];
      const votes = secretDoc.get('votes') as SecretVotes;

      if (mission.state != 'PENDING') {
        return;
      }

      if (Object.keys(votes.mission[data.mission]).length != mission.teamSize) {
        return;
      }

      mission.team = proposal.team;

      mission.numFails = Object.values(votes.mission[data.mission]).filter(v => !v).length;

      if (mission.numFails < mission.failsRequired) {
        mission.state = 'SUCCESS';
      } else {
        mission.state = 'FAIL';
      }

      const failedMissions = game.missions.filter(m => m.state == 'FAIL').length;
      const succeededMissions = game.missions.filter(m => m.state == 'SUCCESS').length;

      if (failedMissions == 3) {
        endGameTxn(txn, lobbyDoc, secretDoc, 'EVIL_WIN', 'Three failed missions', { game });
      } else if (succeededMissions == 3) {
        if (game.roles.includes('MERLIN')) {
          game.phase = 'ASSASSINATION';
        } else {
          endGameTxn(txn, lobbyDoc, secretDoc, 'GOOD_WIN', 'Three missions succeeded', { game });
        }
      } else {
        game.phase = 'TEAM_PROPOSAL';
        game.missions[data.mission + 1].proposals.push(proposalTemplate(proposal.proposer, game.players));
      }
      txn.update(lobbyDocRef, 'game', game);
    });
  });
});
}

export function assassinate(data: AssassinateData, uid: string): Promise<boolean> {
  const lobbyDocRef = db.collection('lobbies').doc(data.lobby);
  const secretDocRef = lobbyDocRef.collection('roles').doc(SECRET_STATE_DOC_NAME);

  return db.runTransaction(function(txn) {
    return Promise.all([
      txn.get(lobbyDocRef),
      txn.get(secretDocRef)]).then(function([lobbyDoc, secretDoc]) {

      validateField(lobbyDoc, 'game.state', 'ACTIVE');
      validateField(lobbyDoc, 'game.phase', 'ASSASSINATION');

      const users = lobbyDoc.get('users') as Record<string, { uid: string }>;
      if (uid != users[data.name].uid) {
        console.warn('%s is %s but request came from %s', data.name, users[data.name].uid, uid);
        throw new AvalonError(403, 'You are not who you say you are');
      }

      const roles = secretDoc.get('roles') as Record<string, PlayerRole>;
      if (!roles[data.name].assassin) {
        console.warn(data.name, 'is', secretDoc.get('roles')[data.name]);
        throw new AvalonError(403, 'You are not the assassin');
      }

      if (roles[data.target].role == 'MERLIN') {
        endGameTxn(txn, lobbyDoc, secretDoc, 'EVIL_WIN', 'Merlin assassinated', { assassinated: data.target });
      } else {
        endGameTxn(txn, lobbyDoc, secretDoc, 'GOOD_WIN', 'Three successful missions', { assassinated: data.target });
      }
      return true;
    });
  });
}
