<template>
  <div id="app">
    <v-app>
      <EventHandler :avalon='avalon'></EventHandler>
      <v-container v-if='!avalon.initialized' class="fill-height d-flex justify-center align-center">
        <v-progress-circular
               indeterminate
               :size="150"
               color="yellow"></v-progress-circular>
      </v-container>
      <template v-else>
        <v-main>
        <v-container v-if='!avalon.isLoggedIn' class="fill-height d-flex justify-center align-center">
          <UserLogin :avalon='avalon' />
        </v-container>
        <template v-else>
          <Toolbar :avalon='avalon'></Toolbar>
            <v-container>
              <v-row class="fill-height align-center justify-center">
                <v-col cols="12" class="d-flex flex-column align-center">
                  <Login
                    :avalon='avalon'
                    v-if="!avalon.isInLobby"
                  />
                  <Lobby
                    v-bind:avalon='avalon'
                    v-else-if='!avalon.isGameInProgress' />
                  <Game :avalon='avalon' v-else />
                </v-col>
              </v-row>
            </v-container>
        </template>
        </v-main>
      </template>
    </v-app>
  </div>
</template>

<script>
import AvalonGame from './avalon.js'
import { eventBus } from './main.js'
import Toolbar from './components/Toolbar.vue'
import EventHandler from './components/EventHandler.vue'
import Login from './components/Login.vue'
import Lobby from './components/Lobby.vue'
import Game from './components/Game.vue'
import UserLogin from './components/UserLogin.vue'

export default {
  name: 'app',
  inject: ['eventBus'],
  data() {
    return {
      avalon: new AvalonGame(this.eventCallback.bind(this)),
    }
  },
  created() {
    this.avalon.init();
  },
  components: {
    Login,
    Lobby,
    Toolbar,
    EventHandler,
    Game,
    UserLogin
  },
  methods: {
    eventCallback() {
      console.debug('event callback', ...arguments);
      this.eventBus.emit(...arguments);
    },
  },
}
</script>
<style>

/* don't capitalize button text */
*{ text-transform: none !important; } 

</style>
