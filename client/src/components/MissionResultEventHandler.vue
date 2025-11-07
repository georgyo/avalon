<template>
     <v-dialog v-model="missionDialog" max-width='450px'>
      <v-card class="cyan-lighten-4">
        <v-card-title class="cyan-lighten-2">
            <div class='text-h5'>
                <span v-if="mission.state == 'SUCCESS'">
                    <v-icon left color="green">fas fa-check-circle</v-icon>
                    Mission Succeeded!
                </span>
                <span v-else>
                    <v-icon left color="red">fas fa-times-circle</v-icon>
                    Mission Failed!
                </span>
            </div>
        </v-card-title>
        <v-card-text>
            {{ mission.team.joinWithAnd() }} had
            <span class='font-weight-bold'>
                {{ numFails > 0 ? numFails : "no" }}
            </span>
            failure
                {{ numFails == 1 ? "vote." : "votes." }}</v-card-text>
      </v-card>
    </v-dialog>
</template>

<script setup>
import { ref, computed, onMounted, inject } from 'vue'
import { useAvalonStore } from '../stores/avalon'

const eventBus = inject('eventBus')
const avalonStore = useAvalonStore()
const missionDialog = ref(false)

const mission = computed(() => {
  const avalon = avalonStore.getAvalon()
  if (!avalon?.lobby?.game) return null

  const curMissionIdx = (avalon.lobby.game.currentMissionIdx < 0) ?
    avalon.lobby.game.missions.length : avalon.lobby.game.currentMissionIdx
  return avalon.lobby.game.missions[curMissionIdx - 1]
})

const numFails = computed(() => {
  return mission.value?.numFails ?? 0
})

onMounted(() => {
  eventBus.on('GAME_STARTED', () => {
    missionDialog.value = false
  })

  eventBus.on('GAME_ENDED', () => {
    missionDialog.value = false
  })

  eventBus.on('MISSION_RESULT', () => {
    missionDialog.value = true
  })
})
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
