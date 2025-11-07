<template>
  <v-list class="bg-blue-grey-lighten-4">
    <v-list-item
     v-for="(playerName) in avalon.game.players"
      :key="playerName">
    <v-col cols="2">
      <v-checkbox
       color="indigo-darken-2"
       v-if="enableCheckboxes(playerName)"
       v-model="selectedPlayers" :value='playerName'></v-checkbox>
       <v-checkbox
        v-if="selectedForMission(playerName)"
        v-bind:input-value="true"
        v-bind:ripple='false'
        color="indigo-lighten-1"
        readonly></v-checkbox>
    </v-col>
    <v-col cols="2">
      <template v-if='avalon.game.currentProposer == playerName'>
        <v-tooltip bottom>
          <template v-slot:activator="{ props }">
            <font-awesome-layers  v-bind="props" style="font-size: 1.8em">
              <font-awesome-icon :color='crownColor' :icon='["fas", "crown"]'></font-awesome-icon>
              <font-awesome-layers-text style="font-size: 0.5em"
              :value="avalon.game.currentProposalIdx + 1" transform="down-4 right-4"></font-awesome-layers-text>
            </font-awesome-layers>
          </template>
          <span>{{ playerName }} is proposing the next team</span>
        </v-tooltip>
      </template>
      <template v-else-if='playerName == avalon.game.hammer'>
        <div class="d-flex align-center justify-center fill-height">
        <v-icon small start>
          fas fa-hammer
        </v-icon>
        </div>
        <!-- commenting this out because I can't figure out how to get this to work reliably
             it works after refresh, but the entire element within the v-tooltip disappears after
             a mission gets sent. i cannot figure out why.
          <v-tooltip bottom>
          <template v-slot:activator="{ on }">
            <v-icon v-on="on">
              fas fa-hammer
            </v-icon>
          </template>
          <span>{{ playerName }} will be the last chance to send a team this round</span>
        </v-tooltip>         -->
      </template>
    </v-col>
      <v-col cols="7">
        {{playerName}}
      </v-col>
    <v-col cols="1">
        <div>
        <v-tooltip bottom v-if='tooltipText(playerName)'>
         <template v-slot:activator="{ props }">
          <font-awesome-layers style="font-size: 1.4em" v-bind="props">
            <font-awesome-icon
             v-if="wasOnLastTeamProposed(playerName)"
             color="#629ec1"
             transform="grow-13"
             :icon='["far", "circle"]'></font-awesome-icon>
            <font-awesome-icon color="#4c4c4c" v-if='waitingOnVote(playerName)' :icon='["fas", "ellipsis-h"]'></font-awesome-icon>
            <font-awesome-icon color="#4c4c4c" v-else-if='hasVoted(playerName)'
             transform="left-2 up-1"
             :icon='["fas", "vote-yea"]'></font-awesome-icon>
            <font-awesome-icon v-else-if='approvedProposal(playerName)' transform="right-1"
             color='green' :icon='["far", "thumbs-up"]'>
            </font-awesome-icon>
            <font-awesome-icon v-else-if='rejectedProposal(playerName)' transform="right-1"
            color='#ed1515' :icon='["far", "thumbs-down"]'></font-awesome-icon>
          </font-awesome-layers>
         </template>
        <span>{{ tooltipText(playerName) }}</span>
        </v-tooltip>
        </div>
    </v-col>
  </v-list-item>
  </v-list>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useAvalonStore } from '../stores/avalon'

const emit = defineEmits(['selected-players'])

const avalonStore = useAvalonStore()
const avalon = computed(() => avalonStore.getAvalon())

const selectedPlayers = ref([])
const allowSelect = ref(true)

const crownColor = computed(() => {
  return (avalon.value.game.currentProposalIdx < 4) ? '#fcfc00' : '#cc0808'
})

function enableCheckboxes(name) {
  return (avalon.value.game.phase == 'TEAM_PROPOSAL' && avalon.value.game.currentProposer == avalon.value.user.name) ||
         (avalon.value.game.phase == 'ASSASSINATION' && avalon.value.lobby.role.assassin && (name != avalon.value.user.name))
}

function selectedForMission(name) {
  return (avalon.value.game.phase == 'PROPOSAL_VOTE' || avalon.value.game.phase == 'MISSION_VOTE') &&
    avalon.value.game.currentProposal.team.includes(name)
}

function hasVoted(name) {
  return (avalon.value.game.phase == "PROPOSAL_VOTE") &&
         (avalon.value.game.currentProposal.votes.includes(name))
}

function waitingOnVote(name) {
  return (avalon.value.game.phase == "PROPOSAL_VOTE") &&
         (!avalon.value.game.currentProposal.votes.includes(name))
}

function wasOnLastTeamProposed(name) {
  switch (avalon.value.game.phase) {
    case "TEAM_PROPOSAL":
    case "ASSASSINATION":
      return avalon.value.game.lastProposal && avalon.value.game.lastProposal.team.includes(name)
    case "PROPOSAL_VOTE":
    case "MISSION_VOTE":
      return avalon.value.game.currentProposal.team.includes(name)
    default:
      console.err("Unhandled game phase", avalon.value.game.phase)
      return false
  }
}

function approvedProposal(name) {
  if (avalon.value.game.phase == "TEAM_PROPOSAL" || avalon.value.game.phase == 'ASSASSINATION') {
    return avalon.value.game.lastProposal && avalon.value.game.lastProposal.votes.includes(name)
  } else if (avalon.value.game.phase == "MISSION_VOTE") {
    return avalon.value.game.currentProposal.votes.includes(name)
  }
}

function rejectedProposal(name) {
  if (avalon.value.game.phase == "TEAM_PROPOSAL" || avalon.value.game.phase == 'ASSASSINATION') {
    return avalon.value.game.lastProposal && !avalon.value.game.lastProposal.votes.includes(name)
  } else if (avalon.value.game.phase == "MISSION_VOTE") {
    return !avalon.value.game.currentProposal.votes.includes(name)
  }
}

function tooltipText(name) {
  const states = []
  if (wasOnLastTeamProposed(name)) {
    states.push('was on the last proposed team')
  }

  if (waitingOnVote(name)) {
    states.push('is currently voting on the proposal')
  } else if (hasVoted(name)) {
    states.push('has submitted a vote for the proposed team')
  } else if (approvedProposal(name)) {
    states.push('approved the last team')
  } else if (rejectedProposal(name)) {
    states.push('rejected the last team')
  }

  if (states.length == 0) return null

  return name + ' ' + states.joinWithAnd()
}

watch(selectedPlayers, () => {
  let maxSelected = 1
  if (avalon.value.game.phase == 'TEAM_PROPOSAL') {
    maxSelected = avalon.value.game.currentMission.teamSize
  }

  if (selectedPlayers.value.length > maxSelected) {
    selectedPlayers.value.shift()
  }
  emit('selected-players', selectedPlayers.value)
})

watch(() => avalon.value.game.phase, () => {
  // clear selected players from phase to phase
  selectedPlayers.value.splice(0)
})
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
