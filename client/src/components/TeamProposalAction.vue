<template>
  <v-card class="bg-blue-grey-lighten-4">
    <v-card-title class="bg-light-blue-lighten-4">
      Team Proposal ({{ this.avalon.game.currentProposalIdx + 1}}/5)
    </v-card-title>
    <v-card-text>
      <div class="d-flex flex-column align-center justify-center fill-height">
     <div v-if='avalon.game.currentProposer == avalon.user.name'>
        <v-col cols="12">
        <div class="text-center">Propose a team of {{ this.avalon.game.currentMission.teamSize }}</div>
        </v-col>
        <v-col cols="12">
      <v-btn
        v-bind:disabled='!isValidSelection'
        v-bind:loading='isProposing'
        v-on:click='proposeTeam()'>Propose Team</v-btn>
        </v-col>
     </div>
     <div v-else class="text-center">
       Waiting for {{ avalon.game.currentProposer }} to propose a team of {{ this.avalon.game.currentMission.teamSize }}
     </div>
      </div>
    </v-card-text>
  </v-card>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useAvalonStore } from '../stores/avalon'

const props = defineProps({
  playerList: Array
})

const avalonStore = useAvalonStore()
const avalon = computed(() => avalonStore.getAvalon())

const isProposing = ref(false)

const isValidSelection = computed(() => {
  return props.playerList.length == avalon.value.game.currentMission.teamSize
})

function proposeTeam() {
  isProposing.value = true
  avalon.value.proposeTeam(props.playerList)
}
</script>
<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>