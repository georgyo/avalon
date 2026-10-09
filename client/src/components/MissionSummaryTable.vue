<template>
  <table>
    <tr v-for="player in players" :key="player">
      <td class='player-name'>
        <span class='font-weight-medium'>{{ player }}</span>
      </td>
      <td v-if='roles' class='role' :class='{ "role-unknown": roleOf(player) == "UNKNOWN" }'>
        {{ roleOf(player) == 'UNKNOWN' ? '?' : roleOf(player) }}
      </td>
      <template v-for='mission in missions'>
        <td v-for='proposal in mission.proposals.filter(p => p.team.length > 0)'
         :key='player + "_proposal" + missions.indexOf(mission) + "_" + mission.proposals.indexOf(proposal)'>
        <font-awesome-layers>
          <font-awesome-icon v-if='proposal.proposer == player'
           color="yellow" transform="grow-13" :icon='["fas", "circle"]' />
          <font-awesome-icon v-if='proposal.team.includes(player)'
           color="#629ec1" transform="grow-13" :icon='["far", "circle"]' />
          <template v-if='proposal.state != "PENDING"'>
          <font-awesome-icon v-if='proposal.votes.includes(player)'
           transform="right-1" color='green' :icon='["far", "thumbs-up"]' />
          <font-awesome-icon transform="right-1" v-else
           color='#ed1515' :icon='["far", "thumbs-down"]' />
          </template>
        </font-awesome-layers>
      </td>
      <td v-if='missionVotes' :key='player + "_mission" + missions.indexOf(mission)' class='mission-result'>
        <template v-if='mission.team.includes(player)'>
          <span v-if='missionVote(mission, player) === undefined' class='vote-unknown' title='Vote unknown (not revealed)'>?</span>
          <v-icon size="small" v-else-if='missionVote(mission, player)'
            color='green' icon="fa:fas fa-check-circle" />
          <v-icon size="small" v-else color="red" icon="fa:fas fa-times-circle" />
        </template>
      </td>
      </template>
    </tr>
  </table>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

export default defineComponent({
  name: 'MissionSummaryTable',
  props: [ 'players', 'missions', 'roles', 'missionVotes' ],
  methods: {
      // a role is 'UNKNOWN' (or missing) when the player never revealed (§5.12)
      roleOf(player: string): string {
          const assignment = (this.roles as { name: string; role: string }[]).find(r => r.name == player);
          return assignment ? assignment.role : 'UNKNOWN';
      },
      // undefined when the vote is unknown: votes[m][name] is absent then (§5.13)
      missionVote(mission: object, player: string): boolean | undefined {
          const votes = this.missionVotes as Record<string, boolean>[];
          const idx = (this.missions as object[]).indexOf(mission);
          return votes[idx] ? votes[idx][player] : undefined;
      }
  }
})
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

 table {
    border-collapse: collapse;
 }

 tr {
    height: 2.3em;
 }

 td {
     width: 1.7em;
     padding-left: 6px;
     padding-right: 4px;
 }

  tr:nth-child(even) {
     background-color: Gainsboro;
  }

  tr:nth-child(odd) {
      background-color: bisque;
  }

  td.role {
    border-right: 2px solid;
    white-space: nowrap;
  }

  td.player-name {
      border-left: 2px solid;
      white-space: nowrap;
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
  }

  @media (max-width: 599px) {
    td {
      padding-left: 3px;
      padding-right: 2px;
      width: 1.5em;
    }
    td.player-name {
      max-width: 80px;
      font-size: 0.85em;
    }
  }

  td.mission-result {
    border-right: 2px solid;
  }

  td.role-unknown, .vote-unknown {
    font-style: italic;
    color: #616161;
  }

  .endGameTitle {
      padding-left: 30px;
      text-align: center;
  }
</style>
