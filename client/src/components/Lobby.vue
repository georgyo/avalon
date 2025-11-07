<template>
  <v-container class="d-flex justify-center">

      <v-card class="bg-cyan-lighten-4" v-if='false && (avalon.user.stats.games >= 3)'>
        <v-card-title class="bg-cyan-lighten-2">
          <h3>Server Shutdown</h3>
        </v-card-title>
        <v-card-text>
          Due to mounting costs, we're asking for your donations to keep the server running.
          Please pitch in if you enjoy playing here. Every little bit helps.
        </v-card-text>
        <v-divider></v-divider>
      </v-card>

  <v-row class="align-start justify-center">
    <v-col cols="12" sm="6">
      <v-container>
      <p class="text-cyan-lighten-4">Players</p>
      <LobbyPlayerList />
      <p v-if='avalon.isAdmin && avalon.config.playerList.length > 2'
        class="text-cyan-lighten-4 text-caption">Drag names to specify seating order</p>
      </v-container>
    </v-col>
    <v-col v-show='validTeamSize' cols="12" sm="6">
      <v-container>
        <p class="text-cyan-lighten-4">Special Roles Available</p>
        <RoleList
          v-bind:roles='avalon.config.selectableRoles'
          v-bind:allowSelect='avalon.isAdmin' />
      </v-container>
    </v-col>
  </v-row>
  <v-row class="align-center justify-center">
    <v-col cols="12" v-if='validTeamSize'>
      <div class="d-flex align-center justify-center fill-height">
        <p class="text-cyan-lighten-4 text-h6">
        {{ avalon.config.playerList.length }} players:
        {{ avalon.config.playerList.length - numEvilPlayers }} good, {{ numEvilPlayers }} evil
      </p>
      </div>
    </v-col>
  </v-row>
  <!--                IN-GAME LOG CODE. DISABLED FOR NOW    --
  <v-layout align-center justify-center column>
    <v-flex xs12 sm6 v-if='canStartGame'>
      <v-container>
    <v-dialog v-model="showOptionGameLog" max-width='450'>
      <v-card class="cyan lighten-4">
        <v-card-title class="cyan lighten-2">
          <h3>Enable in-game log display</h3>
        </v-card-title>
        <v-card-text>
          Display the voting record of all players during the game.
          This may make the game less social and more analytical. It will also make
          it harder to hide as Merlin! Use at your own risk.
        </v-card-text>
      </v-card>
    </v-dialog>
 <v-list class="blue-grey lighten-4">
    <v-list-tile>
    <v-flex xs1>
      <v-checkbox v-model='options.inGameLog' color="black"></v-checkbox>
    </v-flex>
    <v-flex xs9 pl-2>
      Enable in-game log display
    </v-flex>
    <v-flex xs2>
      <v-btn icon @click='showOptionGameLog = true'><v-icon>info</v-icon>
      </v-btn>
    </v-flex>
  </v-list-tile> 
  </v-list>
  </v-container>
  </v-flex>
  </v-layout>

                     END IN-GAME LOG CODE SELECTION -->
  <v-row class="align-center justify-center pt-2">
    <v-btn
     v-if='canStartGame'
     :loading='startingGame'
     @click='startGame()'
    >
        <v-icon start>
          play_arrow
        </v-icon>
      Start Game
    </v-btn>
    <v-card v-else class="bg-blue-grey-lighten-4" style="max-width: 400px;">
      <v-card-text class="text-center">
        {{ reasonToNotStartGame }}
      </v-card-text>
    </v-card>
  </v-row>
  <v-row class="pt-12">
    <v-col cols="12" class="d-flex justify-end">
      <v-btn size="small" block href='mailto:avalon@shamm.as' target="_blank" color='grey-lighten-1'>
        <v-icon start size="small">
          fas fa-envelope-square
        </v-icon>
         <span>Send feedback</span>
      </v-btn>
    </v-col>
  </v-row>
  </v-container>
</template>

<script setup>
import { ref, computed, inject, onMounted, onBeforeUnmount } from 'vue'
import { useAvalonStore } from '@/stores/avalon'
import avalonLib from '@/../../server/common/avalonlib.cjs'
import LobbyPlayerList from './LobbyPlayerList.vue'
import RoleList from './RoleList.vue'

const avalonStore = useAvalonStore()
const avalon = computed(() => avalonStore.getAvalon())
const eventBus = inject('eventBus')

const options = ref({
  inGameLog: false
})
const showOptionGameLog = ref(false)
const startingGame = ref(false)

const reasonToNotStartGame = computed(() => {
  if (avalon.value.config.playerList.length < 5) {
    return 'Need at least 5 players! Invite your friends to lobby ' + avalon.value.lobby.name
  }
  if (avalon.value.config.playerList.length > 10) {
    return 'Cannot start game with more than 10 players'
  }
  if (!avalon.value.isAdmin) {
    return 'Waiting for ' + avalon.value.lobby.admin.name + ' to start game...'
  }

  return null
})

const canStartGame = computed(() => {
  return reasonToNotStartGame.value == null
})

const validTeamSize = computed(() => {
  return (avalon.value.config.playerList.length >= 5) && (avalon.value.config.playerList.length <= 10)
})

const numEvilPlayers = computed(() => {
  return avalonLib.getNumEvilForGameSize(avalon.value.config.playerList.length)
})

function startGame() {
  startingGame.value = true
  avalon.value.startGame(options.value)
}

onMounted(() => {
  eventBus.on('evt', () => console.log("event in lobby", ...arguments))
})

onBeforeUnmount(() => {
  // Clean up is handled by parent EventHandler
})
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
