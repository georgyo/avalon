<template>
  <div>
    <TeamProposalAction
      v-if="teamProposal"
      :player-list="selectedPlayers"
    />
    <TeamVoteAction v-if="teamVote" />
    <MissionAction v-if="missionAction" />
    <AssassinationAction
      v-if="assassinationPhase"
      :player-list="selectedPlayers"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useAvalonStore } from '../stores/avalon'
import TeamProposalAction from './TeamProposalAction.vue'
import TeamVoteAction from './TeamVoteAction.vue'
import MissionAction from './MissionAction.vue'
import AssassinationAction from './AssassinationAction.vue'

// Props used in template
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const props = defineProps({
  selectedPlayers: {
    type: Array,
    default: () => []
  }
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
