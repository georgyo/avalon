<template>
<div>
 <v-container>
  <Missions></Missions>
 </v-container>
 <v-container>
  <GameParticipants v-on:selected-players='updateSelectedPlayers($event)'></GameParticipants>
 </v-container>
 <v-container>
  <ActionPane :selectedPlayers='selectedPlayers'></ActionPane>
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
