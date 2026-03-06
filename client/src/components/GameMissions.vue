<template>
    <v-tabs grow v-model="activeMissionTab">
      <v-tab
       v-for="(mission, idx) in avalon.game.missions"
       :key="'missionTab' + idx"
       :value="idx"
       class="bg-light-blue-lighten-4">
        <font-awesome-layers class="mission-icon">
          <template v-if='mission.state == "PENDING"'>
            <font-awesome-icon :icon='["far", "circle"]' :color='isFutureMission(mission, Number(idx)) ? "gray" : "black"' />
            <font-awesome-layers-text class="gray8" style="font-size: 0.5em" :value="mission.teamSize" />
          </template>
          <font-awesome-icon v-else-if='mission.state == "FAIL"' color="red" :icon='["far", "times-circle"]' />
          <font-awesome-icon v-else-if='mission.state == "SUCCESS"' color="green" :icon='["far", "check-circle"]' />
          <font-awesome-icon v-if='mission.failsRequired > 1' color="red" :icon='["fas", "circle"]' transform="shrink-10 right-9 up-7" />
        </font-awesome-layers>
      </v-tab>
    </v-tabs>
    <v-window v-model="activeMissionTab">
      <v-window-item v-for="(mission, idx) in avalon.game.missions" :key="'missionItem' + idx" :value="idx">
        <v-card flat :class='classForMission(mission)'>
          <v-card-text class="text-caption">
            <div>Mission {{ Number(idx) + 1 }}:
              {{ (Number(idx) == avalon.game.currentMissionIdx) && (avalon.game.phase != 'ASSASSINATION') ? 'CURRENT' : mission.state }}
              <span v-if="mission.numFails > 0">({{ mission.numFails }} {{ mission.numFails > 1 ? 'fails' : 'fail'}})</span>
            </div>
            <div v-if='mission.state == "PENDING"'>
              Team Size: {{ mission.teamSize }}
                <span v-if="mission.failsRequired > 1">
                  ({{ mission.failsRequired }} fails required)
                </span>
            </div>
            <div v-else>
              <div>Team: {{ mission.team.joinWithAnd() }}</div>
              <div></div>
            </div>
            <MissionSummaryTable
             v-if='avalon.game.options && avalon.game.options.inGameLog'
             :players='avalon.game.players'
             :missions='[ mission ]'
             :roles='null'
             :missionVotes='null' />
          </v-card-text>
        </v-card>
      </v-window-item>
    </v-window>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import MissionSummaryTable from './MissionSummaryTable.vue'

export default defineComponent({
  name: 'GameMissions',
  components: {
      MissionSummaryTable
  },
  props: [ 'avalon' ],
  data() {
    return {
      activeMissionTab: 0
    }
  },
  methods: {
    isFutureMission: function(_mission: {state: string}, idx: number) {
      return (idx > 0) && (this.avalon.game.missions[idx - 1].state == 'PENDING');
    },
    classForMission: function(mission: {state: string}) {
      if (mission.state == 'FAIL') return 'bg-red-lighten-4';
      if (mission.state == 'SUCCESS') return 'bg-green-lighten-4';
      return 'bg-blue-grey-lighten-4';
    }
  },
  watch: {
    'avalon.lobby.game.currentMissionIdx'(val: number) {
      if ((val >= 0) && (val < 5)) {
        this.activeMissionTab = val;
      }
    }
  }
})
</script>
<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>
.mission-icon {
  font-size: 1.8em;
}

@media (min-width: 600px) {
  .mission-icon {
    font-size: 2.5em;
  }
}
</style>
