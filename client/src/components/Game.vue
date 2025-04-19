<template>
  <div>
    <v-container>
      <Missions :avalon="avalon" />
    </v-container>
    <v-container>
      <GameParticipants
        :avalon="avalon"
        @selected-players="updateSelectedPlayers($event)"
      />
    </v-container>
    <v-container>
      <ActionPane
        :avalon="avalon"
        :selected-players="selectedPlayers"
      />  
    </v-container>
  </div>
</template>

<script>
import Missions from './Missions.vue'
import GameParticipants from './GameParticipants.vue'
import ActionPane from './ActionPane.vue'

export default {
  name: 'AvalonGame',
  components: {
    Missions,
    GameParticipants,
    ActionPane,
  },
  props: [ 'avalon'],
  data() {
    return {
      selectedPlayers: []
    };
  },
  methods: {
    updateSelectedPlayers(newList) {
      this.selectedPlayers = newList;
    },
  },
}
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
