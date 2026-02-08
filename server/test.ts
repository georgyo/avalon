import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import serviceAccount from './firebaseKey.js';
import _ from 'lodash';
import * as avalon from './avalon-server.js';
import type { Game, Mission, Proposal, PlayerRole } from './types.js';

initializeApp({
  credential: cert(serviceAccount as Parameters<typeof cert>[0])
});

const db = getFirestore();
const SECRET_STATE_DOC_NAME = 'SECRET_STATE_ARCHIVES__';

let lobby = '';
let roles: Record<string, PlayerRole> = {};

interface TestGame extends Game {
  currentMissionIdx: number;
  currentMission: Mission;
  currentProposalIdx: number;
  currentProposal: Proposal;
}

function randomAction(game: TestGame): Promise<unknown> | undefined {
  game.currentMissionIdx = game.missions.findIndex(m => m.state == 'PENDING');
  if (game.currentMissionIdx >= 0) {
    game.currentMission = game.missions[game.currentMissionIdx];

    game.currentProposalIdx = game.currentMission.proposals.findIndex(p => p.state == 'APPROVED');
    if (game.currentProposalIdx < 0) {
      game.currentProposalIdx = game.currentMission.proposals.findIndex(p => p.state == 'PENDING');
    }
    game.currentProposal = game.currentMission.proposals[game.currentProposalIdx];
  }

  switch (game.phase) {
    case 'TEAM_PROPOSAL': return proposeTeam(game);
    case 'PROPOSAL_VOTE': return voteProposal(game);
    case 'MISSION_VOTE': return missionVote(game);
    case 'ASSASSINATION': return assassinate(game);
  }
}

function randomActionLoop(): Promise<TestGame> {
  return db.collection('lobbies').doc(lobby).get().then(lobbyDoc => {
    const game = lobbyDoc.data()!.game as TestGame;

    if (game.state == 'ENDED') {
      return game;
    }

    return randomAction(game)!.then(
      () => randomActionLoop()
    );
  });
}

function pickPlayersAtRandom(game: TestGame, n: number): string[] {
  return _.shuffle(game.players).slice(0, n);
}

function proposeTeam(game: TestGame): Promise<void> {
  return avalon.proposeTeam({
    lobby,
    mission: game.currentMissionIdx,
    proposal: game.currentProposalIdx,
    team: pickPlayersAtRandom(game, game.currentMission.teamSize),
  }, game.currentProposal.proposer);
}

function voteProposal(game: TestGame): Promise<boolean> {
  return _.reduce(['JIMMY', 'USERONE', 'USERTWO', 'USERTHREE', 'USERFOUR', 'USERFIVE'], (promise: Promise<boolean>, name: string) =>
    promise.then(() => avalon.voteTeam({
      lobby,
      mission: game.currentMissionIdx,
      proposal: game.currentProposalIdx,
      name,
      vote: (game.currentProposalIdx == 4) || _.random(1) == 1
    }, name).then(() => true)),
    Promise.resolve(true)
  )!;
}

function missionVote(game: TestGame): Promise<void[]> {
  return Promise.all(game.currentProposal.team.map(name =>
    avalon.doMission({
      lobby,
      mission: game.currentMissionIdx,
      proposal: game.currentProposalIdx,
      name,
      vote: _.random(1) == 1
    }, name)
  ));
}

function assassinate(game: TestGame): Promise<boolean> {
  const target = pickPlayersAtRandom(game, 1)[0];
  const name = Object.values(roles).find(r => r.assassin)!.name;

  return avalon.assassinate({ lobby, name, target }, name);
}

avalon.createLobby({name: 'JIMMY'}, 'JIMMY').then(r => {
  lobby = r.lobby;

  return Promise.all([
    avalon.joinLobby({ name: 'USERONE', lobby}, 'USERONE'),
    avalon.joinLobby({ name: 'USERTWO', lobby}, 'USERTWO'),
    avalon.joinLobby({ name: 'USERTHREE', lobby}, 'USERTHREE'),
    avalon.joinLobby({ name: 'USERFOUR', lobby}, 'USERFOUR'),
    avalon.joinLobby({ name: 'USERFIVE', lobby}, 'USERFIVE'),
  ]);
}).then(() => {
  return avalon.cancelGame({ lobby, name: 'JIMMY' }, 'JIMMY');
}).catch(_err => /* ignore */ false)
.then(() => {
  return avalon.startGame(
    { playerList: ['JIMMY', 'USERONE', 'USERTWO', 'USERTHREE', 'USERFOUR', 'USERFIVE'],
      roles: ['MERLIN', 'MORGANA', 'PERCIVAL'],
      lobby}, 'JIMMY');
  }).then(() => db.collection('lobbies').doc(lobby).collection('roles').doc(SECRET_STATE_DOC_NAME).get())
  .then((roleDoc) => {
    roles = roleDoc.data()!.roles;
  })
.then(() => {
  return db.collection('lobbies').doc(lobby).get();
}).then(lobbyDoc => {
  const game = lobbyDoc.data()!.game as TestGame;
  game.missions[0].proposals[0].proposer = 'JIMMY';
  return db.collection('lobbies').doc(lobby).update('game', game);
}).then(() => randomActionLoop()).then(game => {
  console.log(game.outcome);
});
