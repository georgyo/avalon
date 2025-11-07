<template>
    <div>
    <TeamProposalAction v-if='teamProposal' :playerList='selectedPlayers'></TeamProposalAction>
    <TeamVoteAction v-if='teamVote'></TeamVoteAction>
    <MissionAction v-if='missionAction'></MissionAction>
    <AssassinationAction v-if='assassinationPhase' :playerList='selectedPlayers'></AssassinationAction>
    </div>
</template>

<script setup>
import { computed } from 'vue'
import { useAvalonStore } from '../stores/avalon.js'
import TeamProposalAction from './TeamProposalAction.vue'
import TeamVoteAction from './TeamVoteAction.vue'
import MissionAction from './MissionAction.vue'
import AssassinationAction from './AssassinationAction.vue'

const props = defineProps({
  selectedPlayers: Array
})

const avalonStore = useAvalonStore()
const avalon = computed(() => avalonStore.getAvalon())

const teamProposal = computed(() => {
  return avalon.value.game.phase == 'TEAM_PROPOSAL'
})

const teamVote = computed(() => {
  return avalon.value.game.phase == 'PROPOSAL_VOTE'
})

const missionAction = computed(() => {
  return avalon.value.game.phase == 'MISSION_VOTE'
})

const assassinationPhase = computed(() => {
  return avalon.value.game.phase == 'ASSASSINATION'
})
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
