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
        <v-container v-if='!avalon.isLoggedIn' class="d-flex justify-center align-start pt-8">
          <UserLogin :avalon='avalon' />
        </v-container>
        <template v-else>
          <GameToolbar :avalon='avalon'></GameToolbar>
            <v-container>
              <v-row align="center" justify="center" class="flex-column fill-height">
                <LobbySelect
                  :avalon='avalon'
                  v-if="!avalon.isInLobby"
                />
                <GameLobby
                  v-bind:avalon='avalon'
                  v-else-if='!avalon.isGameInProgress' />
                <GameBoard :avalon='avalon' v-else />
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
import GameToolbar from './components/GameToolbar.vue'
import EventHandler from './components/EventHandler.vue'
import LobbySelect from './components/LobbySelect.vue'
import GameLobby from './components/GameLobby.vue'
import GameBoard from './components/GameBoard.vue'
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
    LobbySelect,
    GameLobby,
    GameToolbar,
    EventHandler,
    GameBoard,
    UserLogin
  },
  methods: {
    eventCallback(event: string, data?: string) {
      console.debug('event callback', event, data);
      EventBus.emit(event, data);
    },
  },
})
</script>
<style>

/* don't capitalize button text */
*{ text-transform: none !important; }

/* Mobile responsive adjustments */
@media (max-width: 599px) {
  .v-main > .v-container {
    padding: 8px;
  }

  .v-card-title {
    white-space: normal;
    word-wrap: break-word;
  }
}

</style>
