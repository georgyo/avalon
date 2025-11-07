<template>
  <div id="app">
    <v-app>
      <EventHandler />
      <v-container v-if='!avalonStore.initialized' class="fill-height d-flex justify-center align-center">
        <v-progress-circular
               indeterminate
               :size="150"
               color="yellow"></v-progress-circular>
      </v-container>
      <template v-else>
        <v-main>
        <v-container v-if='!avalonStore.isLoggedIn' class="fill-height d-flex justify-center align-center">
          <UserLogin />
        </v-container>
        <template v-else>
          <Toolbar />
            <v-container>
              <v-row class="fill-height align-center justify-center">
                <v-col cols="12" class="d-flex flex-column align-center">
                  <Login v-if="!avalonStore.isInLobby" />
                  <Lobby v-else-if='!avalonStore.isGameInProgress' />
                  <Game v-else />
                </v-col>
              </v-row>
            </v-container>
        </template>
        </v-main>
      </template>
    </v-app>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useAvalonStore } from './stores/avalon'
import Toolbar from './components/Toolbar.vue'
import EventHandler from './components/EventHandler.vue'
import Login from './components/Login.vue'
import Lobby from './components/Lobby.vue'
import Game from './components/Game.vue'
import UserLogin from './components/UserLogin.vue'

const avalonStore = useAvalonStore()

onMounted(() => {
  avalonStore.init()
})
</script>
<style>

/* don't capitalize button text */
*{ text-transform: none !important; } 

</style>
