<template>
     <v-dialog v-model="missionDialog" max-width='450px'>
      <v-card v-if='missionDialog' class="bg-cyan-lighten-4">
        <v-card-title class="bg-cyan-lighten-2">
            <div class='text-h5'>
                <span v-if="mission.state == 'SUCCESS'">
                    <v-icon start color="green">fas fa-check-circle</v-icon>
                    Mission Succeeded!
                </span>
                <span v-else>
                    <v-icon start color="red">fas fa-times-circle</v-icon>
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

<script lang="ts">
import { defineComponent } from 'vue'
import { EventBus } from '@/eventBus'

export default defineComponent({
  name: 'MissionResultEventHandler',
  props: [ 'avalon' ],
  data() {
      return {
          missionDialog: false
      }
  },
  computed: {
      mission() {
        const curMissionIdx = (this.avalon.lobby.game.currentMissionIdx < 0) ?
            this.avalon.lobby.game.missions.length : this.avalon.lobby.game.currentMissionIdx;
          return this.avalon.lobby.game.missions[curMissionIdx - 1];
      },
      numFails() {
          return this.mission.numFails;
      }
  },
  mounted() {
      this._onGameStarted = () => { this.missionDialog = false; };
      this._onGameEnded = () => { this.missionDialog = false; };
      this._onMissionResult = () => { this.missionDialog = true; };
      EventBus.on('GAME_STARTED', this._onGameStarted);
      EventBus.on('GAME_ENDED', this._onGameEnded);
      EventBus.on('MISSION_RESULT', this._onMissionResult);
  },
  beforeUnmount() {
      EventBus.off('GAME_STARTED', this._onGameStarted);
      EventBus.off('GAME_ENDED', this._onGameEnded);
      EventBus.off('MISSION_RESULT', this._onMissionResult);
  }
})
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
