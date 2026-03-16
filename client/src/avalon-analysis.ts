import { keyBy, invert, mapValues, tail, initial, difference, isEqual, sortBy } from 'lodash-es'
import type { Role, GameData, Mission, RoleAssignment, ProposerStats } from './types';

interface Badge {
  title: string;
  body: string;
}

export default class GameAnalysis {
  game: GameData;
  rolesByName: Record<string, RoleAssignment>;
  namesByRole: Record<string, string>;
  evilPlayers: string[];
  goodPlayers: string[];
  missions: (Mission & { evilOnTeam: string[] })[];

  constructor(game: GameData, roleMap: Record<string, Role>) {
    this.game = game;
    this.rolesByName = keyBy(game.outcome!.roles, 'name');
    this.namesByRole = invert(mapValues(this.rolesByName, r => r.role)); // this is lossy for non-unique roles!
    this.evilPlayers = game.outcome!.roles.filter(r => roleMap[r.role].team == 'evil').map(r => r.name);
    this.goodPlayers = game.outcome!.roles.filter(r => roleMap[r.role].team == 'good').map(r => r.name);
    this.missions = game.missions.map(m => {
      return { ...m, evilOnTeam: m.team.filter((n: string) => this.evilPlayers.includes(n)) };
    });
  }

  roleProposesRole(proposerRole: string, roleProposed: string): boolean | undefined {
    if (!this.namesByRole[proposerRole] || !this.namesByRole[roleProposed]) return false;

    for (const mission of this.missions) {
      for (const proposal of mission.proposals) {
        if ((proposal.proposer == this.namesByRole[proposerRole]) &&
            proposal.team.includes(this.namesByRole[roleProposed])) {
          return true;
        }
      }
    }
  }

  roleApprovesRole(approverRole: string, roleProposed: string): boolean {
    if (!this.namesByRole[approverRole] || !this.namesByRole[roleProposed]) return false;

    for (const mission of this.missions) {
      for (const [proposalIdx, proposal] of mission.proposals.entries()) {
        if ((proposalIdx != 4) && // hammer approvals don't count
            proposal.team.includes(this.namesByRole[roleProposed]) &&
            proposal.votes.includes(this.namesByRole[approverRole])) {
          return true;
        }
      }
    }
    return false;
  }

  roleTrustsRole(sourceRole: string, destRole: string, badgeGenerator: (msg: string) => Badge): Badge | false {
    const proposed = this.roleProposesRole(sourceRole, destRole);
    const approved = this.roleApprovesRole(sourceRole, destRole);
    if (proposed || approved) {
      let msg;
      if (proposed && approved) {
        msg = 'both proposed and approved teams';
      } else if (proposed) {
        msg = 'proposed a team';
      } else {
        msg = 'approved a team';
      }
      return badgeGenerator(msg);
    }
    return false;
  }

  badges: Record<string, () => Badge | false | undefined> = {
    merlinSendsEvilTeam() {
      if (!this.namesByRole['MERLIN']) return false;

      for (const mission of this.missions) {
        const approvedProposal = mission.proposals.find(p => p.state == 'APPROVED');
        if (approvedProposal &&
            (this.namesByRole['MERLIN'] == approvedProposal.proposer) &&
            (mission.evilOnTeam.length >= mission.failsRequired)) {
          return {
            title: 'Traitor Merlin',
            body: `Merlin sent an evil team with ${mission.evilOnTeam.joinWithAnd()}`
          }
        }
      }
    },
    merlinProposesEvilTeam() {
      if (!this.namesByRole['MERLIN']) return false;

      for (const mission of this.missions) {
        for (const proposal of mission.proposals) {
          if ((proposal.proposer == this.namesByRole['MERLIN']) &&
               proposal.votes.includes(this.namesByRole['MERLIN']) &&
               proposal.team.filter((p: string) => this.evilPlayers.includes(p) && this.rolesByName[p].role != 'MORDRED').length > mission.failsRequired) {
            return {
              title: 'Advanced Merlin',
              body: `Merlin proposed and approved a team with ${mission.evilOnTeam.joinWithAnd()}`
            }
          }
        }
      }
    },
    runningScared() {
      for (const [missionIdx, mission] of this.missions.entries()) {
        if ((mission.evilOnTeam.length > 1) && (mission.numFails == 0)) {
          return {
            title: 'No, you do it',
            body: `${mission.evilOnTeam.joinWithAnd()} went on mission ${missionIdx + 1} together and nobody failed`
          }
        }
      }
    },
    failureToCoordinate() {
      for (const [missionIdx, mission] of this.missions.entries()) {
        if ((mission.numFails > mission.failsRequired) &&
            (missionIdx < this.missions.length - 1) &&
            (this.missions[missionIdx + 1].state != 'PENDING')) { // on last mission, it doesn't matter
          return {
            title: 'Failure to coordinate',
            body: `${mission.evilOnTeam.joinWithAnd()} had ${mission.numFails} failure votes on mission ${missionIdx+1}`
          }
        }
      }
    },
    perfectCoordination() {
      for (const [missionIdx, mission] of this.missions.entries()) {
        if ((mission.evilOnTeam.length > mission.numFails) && (mission.numFails == mission.failsRequired)) {
          return {
            title: 'Same wavelength',
            body: `${mission.evilOnTeam.joinWithAnd()} had perfect coordination on mission ${missionIdx + 1}`
          }
        }
      }
    },
    forcesOfEvil() {
      if (this.evilPlayers.length <= 2) return false;

      for (const [missionIdx, mission] of this.missions.entries()) {
        if (mission.evilOnTeam.length == this.evilPlayers.length) {
          return {
            title: 'With our powers combined',
            body: `All evil players went on mission ${missionIdx + 1} together`
          };
        }
      }
    },
    noEvilPlayersOnMissions() {
      if (tail(this.missions).every(m => m.evilOnTeam.length == 0)) {
        return {
          title: 'Lockdown',
          body: 'No evil players went on any missions' +
            (this.missions[0].evilOnTeam.length ? ' after mission 1' : '')
        }
      }
    },
    cleanSweep() {
      if ((this.missions[0].state == this.missions[1].state) &&
          (this.missions[1].state == this.missions[2].state)) {
        if (this.missions[0].state == 'FAIL') {
          return {
            title: 'Nasty, brutish, and short',
            body: 'Evil team dominated the game'
          }
        } else {
          if (this.game.outcome.state == 'EVIL_WIN') {
            return {
              title: "Look, ma, no hands",
              body: 'Evil team won despite not failing any missions'
            }
          } else {
            return {
              title: 'Clean sweep',
              body: 'Good team dominated the game'
            }
          }
        }
      }
    },
    trustYou() {
      for (const mission of this.missions) {
        for (const proposal of mission.proposals) {
          if (proposal.team.length && !proposal.team.includes(proposal.proposer)) {
            return {
              title: 'I trust you guys',
              body: `${proposal.proposer} proposed a team that did not include themselves`
            }
          }
        }
      }
    },
    trustingBunch() {
      const approvedIdx = this.missions[0].proposals.findIndex(p => p.state == 'APPROVED');
      if ((approvedIdx >= 0) && (approvedIdx < 4)) {
        return {
          title: 'What a trusting bunch',
          body: `First mission got approved within ${approvedIdx + 1} ${approvedIdx == 0 ? 'try' : 'tries'}`
        }
      }
    },
    playingTheLongCon() {
      for(const [missionIdx, mission] of tail(this.missions).entries()) {
        if ((mission.evilOnTeam.length == 1) &&
            (mission.failsRequired < 2) &&
            (mission.numFails == 0)) {
          return {
            title: 'Playing the long con',
            body: `${mission.evilOnTeam[0]} stayed undercover instead of failing mission ${missionIdx + 2}`
          }
        }
      }
    },
    universalAcclaim() {
      for(const [missionIdx, mission] of this.missions.entries()) {
        for(const proposal of initial(mission.proposals)) {
          if (proposal.votes.length == this.game.players.length) {
            return {
              title: 'Universal acclaim',
              body: `Everyone voted for ${proposal.proposer}'s proposal on mission ${missionIdx + 1}`
            }
          }
        }
      }
    },
    stillWaiting() {
      // evil player only went on good missions
      let evilPlayersOnGoodMissions: string[] = [];
      let evilPlayersOnBadMissions: string[] = [];
      for(const mission of this.missions) {
        if (mission.state == 'SUCCESS') {
          evilPlayersOnGoodMissions = evilPlayersOnGoodMissions.concat(mission.evilOnTeam);
        } else if (mission.state == 'FAIL') {
          evilPlayersOnBadMissions = evilPlayersOnBadMissions.concat(mission.evilOnTeam);
        }
      }
      const candidates = difference(evilPlayersOnGoodMissions, evilPlayersOnBadMissions);
      if (candidates.length) {
        return {
          title: 'Biding my time',
          body: `${candidates[0]} was evil, but only went on successful missions`
        }
      }
    },
    assassinationAnalysis() {
      if (this.game.outcome.assassinated) {
        if (this.evilPlayers.includes(this.game.outcome.assassinated)) {
          return {
            title: 'Stabbed in the back',
            body: 'Evil player got assassinated'
          }
        }
        if (this.rolesByName[this.game.outcome.assassinated].role == 'PERCIVAL') {
          return {
            title: 'Taking a bullet for you',
            body: 'Percival got assassinated'
          };
        }
      }
    },
    reversalOfFortune() {
      //pulled it out in the end: one side wins first 2, other side wins the game
      if ((this.missions[0].state == this.missions[1].state) &&
          (this.missions[1].state != this.missions[2].state) &&
          (this.missions[2].state == this.missions[3].state) &&
          (this.missions[3].state == this.missions[4].state)) {
        if ((this.missions[0].state == 'FAIL') &&
            (this.game.outcome.state == 'GOOD_WIN')) {
          return {
            title: 'Reversal of fortune',
            body: 'Good won the game despite losing first two missions'
          };
        } else if (this.missions[0].state == 'SUCCESS') {
          return {
            title: 'Stunning comeback',
            body: 'Evil won the game despite losing first two missions'
          }
        }
      }
    },
    sameTeam() {
      let lastTeam: string[] = [];
      let teamProposalCount = 0;
      outer: for (const mission of this.missions) {
        for(const proposal of mission.proposals) {
          if (isEqual(sortBy(lastTeam), sortBy(proposal.team))) {
            teamProposalCount = teamProposalCount + 1;
          } else {
            if (teamProposalCount >= 3) break outer;
            lastTeam = proposal.team;
            teamProposalCount = 1;
          }
        }
      }
      if (teamProposalCount >= 3) {
        return {
          title: 'We made up our minds',
          body: `The team of ${lastTeam.joinWithAnd()} got proposed ${teamProposalCount} times in a row`
        };
      }
    },
    playerDoesntGoOnMissions() {
      let players = this.game.players.slice(0);
      const completedMissions = this.missions.filter(m => m.state != 'PENDING');
      if (completedMissions.length == 0) return false;
      for(const mission of initial(completedMissions)) {
        players = difference(players, mission.team);
        if (players.length == 0) break;
      }
      if (players.length > 0) {
        const player = players[0];
        if (completedMissions[completedMissions.length - 1].team.includes(player)) {
          return {
            title: 'Here to save the day',
            body: `${player} did not go on any mission except the last one`
          };
        } else {
          return {
            title: 'Put me in, coach!',
            body: `${player} did not go on a single mission`
          };
        }
      }
    },
    almostLost() {
      if (this.game.outcome.state != 'GOOD_WIN') return false;
      let numFails = 0;
      for(const [missionIdx, mission] of this.missions.entries()) {
        if ((numFails == 2) && (mission.proposals.length < 5)) {
          const numPlayersBehind = 5 - mission.proposals.length;
          const playersBehind: string[] = [];
          let proposer = mission.proposals[mission.proposals.length - 1].proposer;
          for (let idx = 0; idx < numPlayersBehind; idx++) {
            const proposerIdx = this.game.players.indexOf(proposer);
            proposer = this.game.players[(proposerIdx + 1) % this.game.players.length];
            playersBehind.push(proposer);
          }
          if (!playersBehind.every((p: string) => this.evilPlayers.includes(p))) {
            return {
              title: 'By the skin of our teeth',
              body: `Good came close to losing on mission ${missionIdx + 1} when evil team had hammer`
            }
          }
        }
        if (mission.state == 'FAIL') {
          numFails++;
        }
      }
    },
    psychicPowers() {
      const players = keyBy(this.game.players.map((name: string) => ({
          name,
          goodProposals: 0,
          badProposals: 0
        })), 'name');
      for (const mission of this.missions) {
        for(const proposal of mission.proposals) {
          if (players[proposal.proposer]) {
            if (proposal.team.filter((n: string) => this.evilPlayers.includes(n)).length < mission.failsRequired) {
              players[proposal.proposer].goodProposals += 1;
            } else {
              players[proposal.proposer].badProposals += 1;
            }
          }
        }
      }
      const perfectProposers = Object.values(players).filter((p: ProposerStats) => p.badProposals == 0 && p.goodProposals >= 2);
      perfectProposers.sort((a: ProposerStats, b: ProposerStats) => b.goodProposals - a.goodProposals);
      if (perfectProposers.length > 0) {
        return {
          title: 'Actual Merlin',
          body: `${perfectProposers[0].name} proposed ${perfectProposers[0].goodProposals} perfect teams and no bad teams`
        }
      }
    },
    morganaTrustsMerlin() {
      return this.roleTrustsRole('MORGANA', 'MERLIN', (msg: string) => ({
        title: 'Cover blown',
        body: `Morgana ${msg} with Merlin`
      }));
    },
    merlinTrustsMorgana() {
      return this.roleTrustsRole('MERLIN', 'MORGANA', (msg: string) => ({
        title: 'Good luck, Percival',
        body: `Merlin ${msg} with Morgana`
        })
      );
    },
    percivalTrustsMorgana() {
      return this.roleTrustsRole('PERCIVAL', 'MORGANA', (msg: string) => ({
        title: 'Got you fooled',
        body: `Percival ${msg} with Morgana`
        })
      );
    },
    unanimousRejection() {
      for (const [missionIdx, mission] of this.missions.entries()) {
        for (const proposal of mission.proposals) {
          if (proposal.state == 'REJECTED' && proposal.votes.length == 0) {
            return {
              title: 'Hard pass',
              body: `${proposal.proposer}'s proposal on mission ${missionIdx + 1} was rejected by everyone`
            };
          }
        }
      }
    },
    loneWolf() {
      for (const [missionIdx, mission] of this.missions.entries()) {
        if (mission.evilOnTeam.length == 1 && mission.numFails == 1 && mission.state == 'FAIL') {
          return {
            title: 'Lone wolf',
            body: `${mission.evilOnTeam[0]} single-handedly failed mission ${missionIdx + 1}`
          };
        }
      }
    },
    hammerTime() {
      for (const [missionIdx, mission] of this.missions.entries()) {
        if (mission.proposals.length == 5 && mission.proposals[4].state == 'APPROVED') {
          return {
            title: 'Hammer time',
            body: `Mission ${missionIdx + 1} went to the 5th proposal (hammer)`
          };
        }
      }
    },
    oberonGambit() {
      if (!this.namesByRole['OBERON']) return false;
      const oberon = this.namesByRole['OBERON'];

      for (const [missionIdx, mission] of this.missions.entries()) {
        if (mission.evilOnTeam.includes(oberon) &&
            mission.evilOnTeam.some(p => p != oberon)) {
          return {
            title: "Oberon's gambit",
            body: `Oberon went on mission ${missionIdx + 1} with evil allies who couldn't see them`
          };
        }
      }
    },
    evilEverywhere() {
      const completedMissions = this.missions.filter(m => m.state != 'PENDING');
      if (completedMissions.length >= 3 && completedMissions.every(m => m.evilOnTeam.length > 0)) {
        return {
          title: 'Omnipresent evil',
          body: 'Every mission had at least one evil player'
        };
      }
    },
    loyalToAFault() {
      const nonHammerProposals: typeof this.missions[0]['proposals'] = [];
      for (const mission of this.missions) {
        for (const [proposalIdx, proposal] of mission.proposals.entries()) {
          if (proposalIdx < 4 && proposal.state != 'PENDING') {
            nonHammerProposals.push(proposal);
          }
        }
      }
      if (nonHammerProposals.length < 3) return false;
      for (const player of this.game.players) {
        if (nonHammerProposals.every(p => p.votes.includes(player))) {
          return {
            title: 'Yes-man',
            body: `${player} approved every single proposal`
          };
        }
      }
    },
    contrarian() {
      const approvedNonHammer: typeof this.missions[0]['proposals'] = [];
      for (const mission of this.missions) {
        for (const [proposalIdx, proposal] of mission.proposals.entries()) {
          if (proposalIdx < 4 && proposal.state == 'APPROVED') {
            approvedNonHammer.push(proposal);
          }
        }
      }
      if (approvedNonHammer.length < 2) return false;
      for (const player of this.game.players) {
        if (approvedNonHammer.every(p => !p.votes.includes(player))) {
          return {
            title: 'Contrarian',
            body: `${player} rejected every proposal that got approved`
          };
        }
      }
    },
    oneManArmy() {
      const failedMissions = this.missions.filter(m => m.state == 'FAIL');
      if (failedMissions.length < 2) return false;

      const evilOnAllFailed = failedMissions[0].evilOnTeam.filter(p =>
        failedMissions.every(m => m.evilOnTeam.includes(p))
      );
      if (evilOnAllFailed.length == 1 &&
          failedMissions.every(m => m.evilOnTeam.length == 1)) {
        return {
          title: 'One-man army',
          body: `${evilOnAllFailed[0]} was the only evil player on every failed mission`
        };
      }
    },
    evilGhost() {
      const completedMissions = this.missions.filter(m => m.state != 'PENDING');
      if (completedMissions.length < 3) return false;

      for (const player of this.evilPlayers) {
        if (completedMissions.every(m => !m.team.includes(player))) {
          return {
            title: 'Ghost',
            body: `${player} was evil but never went on a single mission`
          };
        }
      }
    },
    trojanHorse() {
      for (const [missionIdx, mission] of this.missions.entries()) {
        if (mission.evilOnTeam.length > 0 &&
            mission.evilOnTeam.length > mission.team.length / 2) {
          return {
            title: 'Trojan horse',
            body: `Mission ${missionIdx + 1} had a majority evil team (${mission.evilOnTeam.length} of ${mission.team.length})`
          };
        }
      }
    },
    closeCall() {
      for (const [missionIdx, mission] of this.missions.entries()) {
        if (mission.state == 'SUCCESS' && mission.evilOnTeam.length > 0 && mission.numFails == 0) {
          return {
            title: 'Dodged a bullet',
            body: `Mission ${missionIdx + 1} succeeded despite ${mission.evilOnTeam.joinWithAnd()} being on the team`
          };
        }
      }
    },
    rejectionStreak() {
      let maxStreak = 0;
      let streak = 0;
      for (const mission of this.missions) {
        for (const proposal of mission.proposals) {
          if (proposal.state == 'REJECTED') {
            streak++;
            maxStreak = Math.max(maxStreak, streak);
          } else if (proposal.state == 'APPROVED') {
            streak = 0;
          }
        }
      }
      if (maxStreak >= 4) {
        return {
          title: 'Nobody likes anyone',
          body: `${maxStreak} proposals were rejected in a row`
        };
      }
    },
    bigTeamBetrayal() {
      const completedMissions = this.missions.filter(m => m.state != 'PENDING');
      if (completedMissions.length < 3) return false;

      const maxTeamSize = Math.max(...completedMissions.map(m => m.teamSize));
      const bigMission = this.missions.find(m => m.teamSize == maxTeamSize && m.state == 'FAIL');
      if (bigMission) {
        const missionIdx = this.missions.indexOf(bigMission);
        return {
          title: 'Et tu, Brute?',
          body: `The largest mission (${bigMission.teamSize} players) on mission ${missionIdx + 1} was failed`
        };
      }
    },
    proposerCurse() {
      const rejectionCounts: Record<string, number> = {};
      for (const mission of this.missions) {
        for (const proposal of mission.proposals) {
          if (proposal.state == 'REJECTED') {
            rejectionCounts[proposal.proposer] = (rejectionCounts[proposal.proposer] || 0) + 1;
          }
        }
      }
      const [cursedPlayer, count] = Object.entries(rejectionCounts)
        .sort(([, a], [, b]) => b - a)[0] || ['', 0];
      if (count >= 3) {
        return {
          title: 'Cursed proposer',
          body: `${cursedPlayer} had ${count} proposals rejected`
        };
      }
    },
    lastStand() {
      const states = this.missions.map(m => m.state);
      if (states[4] == 'PENDING') return false;

      const successesBefore = states.slice(0, 4).filter(s => s == 'SUCCESS').length;
      const failsBefore = states.slice(0, 4).filter(s => s == 'FAIL').length;
      if (successesBefore == 2 && failsBefore == 2) {
        return {
          title: 'Last stand',
          body: `The score was 2-2 going into the final mission`
        };
      }
    },
    perfectAssassin() {
      if (this.game.outcome.state == 'EVIL_WIN' &&
          this.game.outcome.assassinated &&
          this.rolesByName[this.game.outcome.assassinated]?.role == 'MERLIN') {
        return {
          title: 'Bullseye',
          body: 'The assassin correctly identified and killed Merlin'
        };
      }
    },
    oberonSaboteur() {
      if (!this.namesByRole['OBERON']) return false;
      const oberon = this.namesByRole['OBERON'];

      for (const [missionIdx, mission] of this.missions.entries()) {
        if (mission.state == 'FAIL' &&
            mission.evilOnTeam.includes(oberon) &&
            mission.evilOnTeam.length > 1) {
          return {
            title: 'Who did that?',
            body: `Oberon failed mission ${missionIdx + 1} alongside evil allies who didn't know they were there`
          };
        }
      }
    },
    allAboard() {
      const completedMissions = this.missions.filter(m => m.state != 'PENDING');
      if (completedMissions.length < 3) return false;

      const playersOnMissions = new Set(completedMissions.flatMap(m => m.team));
      if (playersOnMissions.size == this.game.players.length) {
        return {
          title: 'All aboard',
          body: 'Every player went on at least one mission'
        };
      }
    },
    flipFlopper() {
      for (const mission of this.missions) {
        for (let i = 1; i < mission.proposals.length; i++) {
          const current = mission.proposals[i];
          for (let j = 0; j < i; j++) {
            const previous = mission.proposals[j];
            if (previous.state == 'REJECTED' && current.state == 'APPROVED' && isEqual(sortBy(current.team), sortBy(previous.team))) {
              // Same team rejected then approved - find someone who flipped
              const flippers = current.votes.filter(v => !previous.votes.includes(v));
              if (flippers.length > 0) {
                return {
                  title: 'Flip-flopper',
                  body: `${flippers[0]} rejected then approved the same team on mission ${this.missions.indexOf(mission) + 1}`
                };
              }
            }
          }
        }
      }
    },
  }

  getBadges(): Badge[] {
    return Object.values(this.badges).map(func => {
      return func.bind(this)();
    }).filter((badge): badge is Badge => !!badge);
  }
}
