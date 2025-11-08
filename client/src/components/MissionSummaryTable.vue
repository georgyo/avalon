<template>
  <table>
    <tr
      v-for="player in players"
      :key="player"
    >
      <td class="player-name">
        <span class="font-weight-medium">{{ player }}</span>
      </td>
      <td
        v-if="roles"
        class="role"
      >
        {{ roles.find(r => r.name == player).role }}
      </td>
      <template v-for="mission in missions">
        <td
          v-for="proposal in mission.proposals.filter(p => p.team.length > 0)"
          :key="player + &quot;_proposal&quot; + missions.indexOf(mission) + &quot;_&quot; + mission.proposals.indexOf(proposal)"
        >
          <font-awesome-layers>
            <font-awesome-icon
              v-if="proposal.proposer == player"
              color="yellow"
              transform="grow-13"
              :icon="[&quot;fas&quot;, &quot;circle&quot;]"
            />
            <font-awesome-icon
              v-if="proposal.team.includes(player)"
              color="#629ec1"
              transform="grow-13"
              :icon="[&quot;far&quot;, &quot;circle&quot;]"
            />
            <template v-if="proposal.state != &quot;PENDING&quot;">
              <font-awesome-icon
                v-if="proposal.votes.includes(player)"
                transform="right-1"
                color="green"
                :icon="[&quot;far&quot;, &quot;thumbs-up&quot;]"
              />
              <font-awesome-icon
                v-else
                transform="right-1"
                color="#ed1515"
                :icon="[&quot;far&quot;, &quot;thumbs-down&quot;]"
              />
            </template>
          </font-awesome-layers>
        </td>
        <td
          v-if="missionVotes"
          :key="player + &quot;_mission&quot; + missions.indexOf(mission)"
          class="mission-result"
        >
          <template v-if="mission.team.includes(player)">
            <v-icon
              v-if="missionVotes[missions.indexOf(mission)][player]"
              size="small"
              color="green"
              icon="fa:fas fa-check-circle"
            />
            <v-icon
              v-else
              size="small"
              color="red"
              icon="fa:fas fa-times-circle"
            />
          </template>
        </td>
      </template>
    </tr>
  </table>
</template>

<script setup lang="ts">
interface Proposal {
  proposer: string
  team: string[]
  state: string
  votes: string[]
}

interface Mission {
  proposals: Proposal[]
  team: string[]
  state: string
}

interface Role {
  name: string
  role: string
}

interface MissionVotes {
  [player: string]: boolean
}

defineProps<{
  players: string[]
  missions: Mission[]
  roles: Role[]
  missionVotes: MissionVotes[]
}>()
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
  }

  td.mission-result {
    border-right: 2px solid;  
  }

  .endGameTitle {
      padding-left: 30px;
      text-align: center;
  }
</style>
