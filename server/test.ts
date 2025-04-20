import firebaseAdmin from 'firebase-admin';
const serviceAccount: any = require('./firebaseKey');
import _ from 'lodash';

firebaseAdmin.initializeApp({
  credential: firebaseAdmin.credential.cert(serviceAccount),
  databaseURL: "https://georgyo-avalon-default-rtdb.firebaseio.com"
});
const avalon: any = require('./avalon-server');

const db = firebaseAdmin.firestore();
const SECRET_STATE_DOC_NAME = 'SECRET_STATE_ARCHIVES__';

let lobby: string = '';
let roles: any = {};
let game: any;

function randomAction(game: any): Promise<any> {
  game.currentMissionIdx = game.missions.findIndex((m: any) => m.state == 'PENDING');
  if (game.currentMissionIdx >= 0) {
    game.currentMission = game.missions[game.currentMissionIdx];

    game.currentProposalIdx = game.currentMission.proposals.findIndex((p: any) => p.state == 'APPROVED');
    if (game.currentProposalIdx < 0) {
      game.currentProposalIdx = game.currentMission.proposals.findIndex((p: any) => p.state == 'PENDING');
    }
    game.currentProposal = game.currentMission.proposals[game.currentProposalIdx];
  }

  switch (game.phase) {
    case 'TEAM_PROPOSAL':
      return proposeTeam(game);
    case 'PROPOSAL_VOTE':
      return voteProposal(game);
    case 'MISSION_VOTE':
      return missionVote(game);
    case 'ASSASSINATION':
      return assassinate(game);
    default:
      return Promise.resolve(game);
  }
}

function randomActionLoop(): Promise<any> {
  return db.collection('lobbies').doc(lobby).get().then((lobbyDoc: any) => {
    const gameData = lobbyDoc.data().game;
    if (gameData.state == 'ENDED') {
      return gameData;
    }
    return randomAction(gameData).then(() => randomActionLoop());
  });
}

function pickPlayersAtRandom(game: any, n: number): string[] {
  return _.shuffle(game.players).slice(0, n);
}

function proposeTeam(game: any): Promise<any> {
  return avalon.proposeTeam(
    {
      lobby,
      mission: game.currentMissionIdx,
      proposal: game.currentProposalIdx,
      team: pickPlayersAtRandom(game, game.currentMission.teamSize),
    },
    game.currentProposal.proposer
  );
}

function voteProposal(game: any): Promise<any> {
  return _.reduce(
    ['JIMMY', 'USERONE', 'USERTWO', 'USERTHREE', 'USERFOUR', 'USERFIVE'],
    (promise: Promise<any>, name: string) =>
      promise.then(() =>
        avalon.voteTeam(
          {
            lobby,
            mission: game.currentMissionIdx,
            proposal: game.currentProposalIdx,
            name,
            vote: game.currentProposalIdx === 4 || _.random(1) === 1,
          },
          name
        )
      ),
    Promise.resolve(true)
  );
}

function missionVote(game: any): Promise<any[]> {
  return Promise.all(
    game.currentProposal.team.map((name: string) =>
      avalon.doMission(
        {
          lobby,
          mission: game.currentMissionIdx,
          proposal: game.currentProposalIdx,
          name,
          vote: _.random(1) === 1,
        },
        name
      )
    )
  );
}

function assassinate(game: any): Promise<any> {
  const target: string = pickPlayersAtRandom(game, 1)[0];
  const assassin: any = Object.values(roles).find((r: any) => r.assassin);
  const name: any = assassin.name;
  return avalon.assassinate({ lobby, name, target }, name);
}

// Sequence of test actions
avalon
  .createLobby({ name: 'JIMMY' }, 'JIMMY')
  .then((r: any) => {
    lobby = r.lobby;
    return Promise.all([
      avalon.joinLobby({ name: 'USERONE', lobby }, 'USERONE'),
      avalon.joinLobby({ name: 'USERTWO', lobby }, 'USERTWO'),
      avalon.joinLobby({ name: 'USERTHREE', lobby }, 'USERTHREE'),
      avalon.joinLobby({ name: 'USERFOUR', lobby }, 'USERFOUR'),
      avalon.joinLobby({ name: 'USERFIVE', lobby }, 'USERFIVE'),
    ]);
  })
  .then(() => avalon.cancelGame({ lobby, name: 'JIMMY' }, 'JIMMY'))
  .catch(() => false)
  .then(() =>
    avalon.startGame(
      {
        playerList: ['JIMMY', 'USERONE', 'USERTWO', 'USERTHREE', 'USERFOUR', 'USERFIVE'],
        roles: ['MERLIN', 'MORGANA', 'PERCIVAL'],
        lobby,
      },
      'JIMMY'
    )
  )
  .then(() => db.collection('lobbies').doc(lobby).collection('roles').doc(SECRET_STATE_DOC_NAME).get())
  .then((roleDoc: any) => {
    roles = roleDoc.data().roles;
  })
  .then(() => db.collection('lobbies').doc(lobby).get())
  .then((lobbyDoc: any) => {
    game = lobbyDoc.data().game;
    game.missions[0].proposals[0].proposer = 'JIMMY';
    return db.collection('lobbies').doc(lobby).update('game', game);
  })
  .then(() => randomActionLoop())
  .then((result: any) => {
    console.log(result.outcome);
  });
