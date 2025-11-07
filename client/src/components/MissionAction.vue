<template>
  <v-card class="bg-blue-grey-lighten-4">
    <v-card-title class="bg-light-blue-lighten-4">
      Mission in Progress
    </v-card-title>
    <v-card-text>
      <div v-if="needsToVote">
        <div class="d-flex align-center justify-space-between fill-height">
          <v-btn @click="missionVote(true)">
            <v-icon
              start
              color="green"
              icon="fa:fas fa-check-circle"
            />
            SUCCESS
          </v-btn>
          <v-btn @click="missionVote(false)">
            <v-icon
              start
              color="red"
              icon="fa:fas fa-times-circle"
            />
            FAIL
          </v-btn>
        </div>
      </div>
      <div v-else>
        <!-- need to make a more dramatic reveal at the end! -->
        {{ waitingForText }}
      </div>
    </v-card-text>
  </v-card>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useAvalonStore } from '../stores/avalon'
import _ from 'lodash'

const avalonStore = useAvalonStore()
const avalon = computed(() => avalonStore.getAvalon())

const needsToVote = ref(avalon.value.game.currentProposal.team.includes(avalon.value.user.name))

function missionVote(vote) {
  // no loading state, we want to hide the results as fast as possible
  needsToVote.value = false
  avalon.value.doMission(vote)
}

const stillWaitingFor = computed(() => {
  return _.difference(avalon.value.game.currentProposal.team,
                      avalon.value.game.currentMission.team).filter(
                        n => n != avalon.value.user.name)
})

const waitingForText = computed(() => {
  if (stillWaitingFor.value.length > 0) {
    return 'Waiting for ' + stillWaitingFor.value.joinWithAnd()
  } else {
    return 'Waiting for results...'
  }
})
</script>
<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>