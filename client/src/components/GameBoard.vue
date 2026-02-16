<template>
<div class="game-board">
 <v-container class="game-section">
  <GameMissions :avalon='avalon'></GameMissions>
 </v-container>
 <v-container class="game-section">
  <GameParticipants v-on:selected-players='updateSelectedPlayers($event)' :avalon='avalon'></GameParticipants>
 </v-container>
 <v-container class="game-section">
  <ActionPane :avalon='avalon' :selectedPlayers='selectedPlayers'></ActionPane>
  </v-container>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import GameMissions from './GameMissions.vue'
import GameParticipants from './GameParticipants.vue'
import ActionPane from './ActionPane.vue'

export default defineComponent({
  name: 'GameBoard',
  components: {
    GameMissions,
    GameParticipants,
    ActionPane,
  },
  props: [ 'avalon'],
  data() {
    return {
      selectedPlayers: [] as string[]
    };
  },
  methods: {
    updateSelectedPlayers(newList: string[]) {
      this.selectedPlayers = newList;
    },
  },
})
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>
.game-board {
  width: 100%;
}

@media (max-width: 599px) {
  .game-section {
    padding: 4px 0;
  }
}
</style>
