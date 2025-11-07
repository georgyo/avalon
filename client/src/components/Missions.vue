<template>
  <v-tabs
    v-model="activeMissionTab"
    grow
    centered
    height="100px"
  >
    <v-tab
      v-for="(mission, idx) in avalon.game.missions"
      :key="'missionTab' + idx"
      class="light-blue-lighten-4"
      active-class="blue-lighten-2"
    >
      <font-awesome-layers style="font-size: 2.5em">
        <template v-if="mission.state == &quot;PENDING&quot;">
          <font-awesome-icon
            :icon="[&quot;far&quot;, &quot;circle&quot;]"
            :color="isFutureMission(mission, idx) ? &quot;gray&quot; : &quot;black&quot;"
          />
          <font-awesome-layers-text
            class="gray8"
            style="font-size: 0.5em"
            :value="mission.teamSize"
          />
        </template>
        <font-awesome-icon
          v-else-if="mission.state == &quot;FAIL&quot;"
          color="red"
          :icon="[&quot;far&quot;, &quot;times-circle&quot;]"
        />
        <font-awesome-icon
          v-else-if="mission.state == &quot;SUCCESS&quot;"
          color="green"
          :icon="[&quot;far&quot;, &quot;check-circle&quot;]"
        />
        <font-awesome-icon
          v-if="mission.failsRequired > 1"
          color="red"
          :icon="[&quot;fas&quot;, &quot;circle&quot;]"
          transform="shrink-10 right-9 up-7"
        />
      </font-awesome-layers> 
    </v-tab>
    <v-tab-item
      v-for="(mission, idx) in avalon.game.missions"
      :key="'missionItem' + idx"
    >
      <v-card
        flat
        :class="classForMission(mission)"
      >
        <v-card-text class="text-caption">
          <div>
            Mission {{ idx + 1 }}:
            {{ (idx == avalon.game.currentMissionIdx) && (avalon.game.phase != 'ASSASSINATION') ? 'CURRENT' : mission.state }}
            <span v-if="mission.numFails > 0">({{ mission.numFails }} {{ mission.numFails > 1 ? 'fails' : 'fail' }})</span>
          </div>
          <div v-if="mission.state == &quot;PENDING&quot;">
            Team Size: {{ mission.teamSize }}
            <span v-if="mission.failsRequired > 1">
              ({{ mission.failsRequired }} fails required)
            </span>
          </div>
          <div v-else>
            <div>Team: {{ mission.team.joinWithAnd() }}</div>
            <div />
          </div>
          <MissionSummaryTable
            v-if="avalon.game.options && avalon.game.options.inGameLog"
            :players="avalon.game.players"
            :missions="[ mission ]"
            :roles="null"
            :mission-votes="null"
          />
        </v-card-text>
      </v-card>
    </v-tab-item>    
  </v-tabs>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useAvalonStore } from '../stores/avalon'
import MissionSummaryTable from './MissionSummaryTable.vue'

const avalonStore = useAvalonStore()
const avalon = computed(() => avalonStore.getAvalon())

const activeMissionTab = ref(0)

function isFutureMission(mission, idx) {
  return (idx > 0) && (avalon.value.game.missions[idx - 1].state == 'PENDING')
}

function classForMission(mission) {
  if (mission.state == 'FAIL') return 'red-lighten-4'
  if (mission.state == 'SUCCESS') return 'green-lighten-4'
  return 'blue-grey-lighten-4'
}

watch(() => avalon.value.lobby.game.currentMissionIdx, (val) => {
  if ((val >= 0) && (val < 5)) {
    activeMissionTab.value = val
  }
})
</script>
<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>
</style>