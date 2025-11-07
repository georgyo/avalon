<template>
     <v-dialog v-model="endGameDialog" fullscreen persistent>
      <v-card v-if='endGameDialog && avalon.game && avalon.game.outcome' class="bg-cyan-lighten-4">
        <v-card-title class="bg-cyan-lighten-2 endGameTitle">
            <div class="d-flex align-center justify-center fill-height">
                <span class='text-h4 font-weight-bold'>{{title}}</span>
            </div>
        </v-card-title>
        <v-card-text>
            <div class="d-flex flex-column align-center justify-center">
            <div class='text-h5 font-weight-bold'> {{ avalon.game.outcome.message }}</div>
            <p v-if='avalon.game.outcome.assassinated'>
                {{ avalon.game.outcome.assassinated}} was assassinated by
                {{ avalon.game.outcome.roles.find(r => r.assassin ).name }}
            </p>
            <v-container style='overflow-x: auto; width: 100%;'>
              <MissionSummaryTable
               :players='avalon.game.players'
               :missions='missions'
               :roles='roleAssignments'
               :missionVotes='avalon.game.outcome.votes' />
            </v-container>
            <Achievements />
            </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer></v-spacer>
          <v-btn @click="endGameDialogClosed()">Close</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
</template>

<script setup>
import { ref, computed, onMounted, inject } from 'vue'
import { useAvalonStore } from '../stores/avalon'
import Achievements from './Achievements.vue'
import MissionSummaryTable from './MissionSummaryTable.vue'

const eventBus = inject('eventBus')
const avalonStore = useAvalonStore()
const endGameDialog = ref(false)

const avalon = computed(() => avalonStore.getAvalon())

const title = computed(() => {
  if (!avalon.value?.game?.outcome) return ''

  switch (avalon.value.game.outcome.state) {
    case 'GOOD_WIN': return 'Good wins!'
    case 'EVIL_WIN': return 'Evil wins!'
    case 'CANCELED': return 'Game Canceled'
    default: return avalon.value.game.outcome.state
  }
})

const roleAssignments = computed(() => {
  if (!avalon.value?.game?.outcome?.roles || !avalon.value?.config?.roles) return []

  return avalon.value.game.outcome.roles.slice(0).sort((a, b) => {
    const roleIndexOf = (name) => avalon.value.config.roles.findIndex(r => r.name == name)
    return roleIndexOf(a.role) - roleIndexOf(b.role)
  })
})

const missions = computed(() => {
  if (!avalon.value?.game?.missions) return []

  return avalon.value.game.missions.filter(m =>
    m.proposals.filter(p => p.state != 'PENDING').length > 0
  )
})

const endGameDialogClosed = () => {
  endGameDialog.value = false
}

onMounted(() => {
  eventBus.on('GAME_ENDED', () => {
    endGameDialog.value = true
  })

  eventBus.on('GAME_STARTED', () => {
    endGameDialog.value = false
  })
})
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

 table { 
    border-collapse: collapse;
 }

 tr {
    height: 2.3em;
 }

 td {
     width: 1.7em;     
     padding-left: 6px;
     padding-right: 4px;
 }

  tr:nth-child(even) { 
     background-color: Gainsboro;
  } 

  tr:nth-child(odd) {
      background-color: bisque;
  }

  td.role {
    border-right: 2px solid;
    white-space: nowrap;
  }

  td.player-name {
      border-left: 2px solid;
  }

  td.mission-result {
    border-right: 2px solid;  
  }

  .endGameTitle {
      padding-left: 30px;
      text-align: center;
  }
</style>
