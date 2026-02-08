<template>
  <div id="app">
    <v-app class="bg-indigo-darken-2">
      <EventHandler :avalon='avalon'></EventHandler>
      <v-container class="fill-height d-flex justify-center" v-if='!avalon.initialized'>
        <v-progress-circular
               indeterminate
               :size="150"
               color="yellow"></v-progress-circular>
      </v-container>
      <template v-else>
        <v-main class="bg-indigo-darken-2">
        <v-container v-if='!avalon.isLoggedIn' class="fill-height d-flex justify-center">
          <UserLogin :avalon='avalon' />
        </v-container>
        <template v-else>
          <Toolbar :avalon='avalon'></Toolbar>
            <v-container>
              <v-row align="center" justify="center" class="flex-column fill-height">
                <Login
                  :avalon='avalon'
                  v-if="!avalon.isInLobby"
                />
                <Lobby
                  v-bind:avalon='avalon'
                  v-else-if='!avalon.isGameInProgress' />
                <Game :avalon='avalon' v-else />
              </v-row>
            </v-container>
        </template>
        </v-main>
      </template>
    </v-app>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import AvalonGame from './avalon'
import { EventBus } from './eventBus'
import Toolbar from './components/Toolbar.vue'
import EventHandler from './components/EventHandler.vue'
import Login from './components/Login.vue'
import Lobby from './components/Lobby.vue'
import Game from './components/Game.vue'
import UserLogin from './components/UserLogin.vue'

export default defineComponent({
  name: 'app',
  data() {
    return {
      avalon: new AvalonGame(this.eventCallback.bind(this)),
    }
  },
  created: function() {
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
    eventCallback(...args: any[]) {
      console.debug('event callback', ...args);
      EventBus.emit(args[0], args[1]);
    },
  },
})
</script>
<style>

/* don't capitalize button text */
*{ text-transform: none !important; }

</style>
