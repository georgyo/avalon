<template>
  <div>
    <v-container>
      <Missions />
    </v-container>
    <v-container>
      <GameParticipants @selected-players="updateSelectedPlayers($event)" />
    </v-container>
    <v-container>
      <ActionPane :selected-players="selectedPlayers" />
    </v-container>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import Missions from './Missions.vue'
import GameParticipants from './GameParticipants.vue'
import ActionPane from './ActionPane.vue'

const selectedPlayers = ref<string[]>([])

function updateSelectedPlayers(newList: string[]): void {
  selectedPlayers.value = newList
}
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
