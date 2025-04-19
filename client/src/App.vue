<template>
  <div id="app">
    <v-app class="indigo darken-2">
      <EventHandler :avalon="avalon" />
      <v-container
        v-if="!avalon.initialized"
        fill-height
        justify-center
      >
        <v-progress-circular
          indeterminate
          :size="150"
          color="yellow"
        />
      </v-container>
      <template v-else>
        <v-main class="indigo darken-2">
          <v-container
            v-if="!avalon.isLoggedIn"
            fill-height
            justify-center
          >
            <UserLogin :avalon="avalon" />
          </v-container>
          <template v-else>
            <Toolbar :avalon="avalon" />
            <v-container>          
              <v-layout
                align-center
                justify-center
                column
                fill-height
              >
                <Login
                  v-if="!avalon.isInLobby"
                  :avalon="avalon"
                />
                <Lobby
                  v-else-if="!avalon.isGameInProgress"
                  :avalon="avalon"
                />
                <Game
                  v-else
                  :avalon="avalon"
                />
              </v-layout>
            </v-container>
          </template>
        </v-main>
      </template>
    </v-app>
  </div>
</template>

<script>
import AvalonGame from './avalon.js'
import { EventBus } from './main.js'
import Toolbar from './components/Toolbar.vue'
import EventHandler from './components/EventHandler.vue'
import Login from './components/Login.vue'
import Lobby from './components/Lobby.vue'
import Game from './components/Game.vue'
import UserLogin from './components/UserLogin.vue'

export default {
  name: 'App',
  components: {
    Login,
    Lobby,
    Toolbar,
    EventHandler,
    Game,
    UserLogin
  },
  data() {
    return {
      avalon: new AvalonGame(this.eventCallback.bind(this)),
    }
  },
  created: function() {
    this.avalon.init();
  },
  methods: {
    eventCallback() {
      console.debug('event callback', ...arguments);
      EventBus.$emit(...arguments);
    },
  },
}
</script>
<style>

/* don't capitalize button text */
*{ text-transform: none !important; } 

</style>
