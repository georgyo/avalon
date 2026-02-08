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

  <v-row align="start" justify="center" class="flex-wrap">
  <v-col cols="12" sm="6">
    <v-container>
    <p class="text-cyan-lighten-4">Players</p>
    <LobbyPlayerList v-bind:avalon='avalon' />
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
  <v-row align="center" justify="center">
   <v-col cols="12" v-if='validTeamSize'>
     <div class="d-flex align-center justify-center fill-height">
      <p class="text-cyan-lighten-4 text-h6">
      {{ avalon.config.playerList.length }} players:
      {{ avalon.config.playerList.length - numEvilPlayers }} good, {{ numEvilPlayers }} evil
    </p>
     </div>
  </v-col>
  </v-row>
  <div class="d-flex align-center justify-center pt-2">
    <v-btn
     v-if='canStartGame'
     :loading='startingGame'
     @click='startGame()'
    >
        <v-icon start>
          mdi-play
        </v-icon>
      Start Game
    </v-btn>
    <v-card v-else class="bg-blue-grey-lighten-4">
      <v-card-text class="text-center">
        {{ reasonToNotStartGame }}
      </v-card-text>
    </v-card>
  </div>
<div class="d-flex flex-column align-end pt-12">
  <div>
    <v-btn size="small" block href='mailto:avalon@shamm.as' target="_blank" color='grey-lighten-1'>
      <v-icon start size="small">
        fas fa-envelope-square
      </v-icon>
       <span>Send feedback</span>
    </v-btn>
  </div>
</div>
  </v-container>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import * as avalonLib from '@avalon/common/avalonlib'
import LobbyPlayerList from './LobbyPlayerList.vue'
import RoleList from './RoleList.vue'

export default defineComponent({
  name: 'Lobby',
  components: {
    LobbyPlayerList,
    RoleList
  },
  props: [ 'avalon' ],
  data() {
    return {
      options: {
        inGameLog: false
      },
      showOptionGameLog: false,
      startingGame: false
    }
  },
  computed: {
    reasonToNotStartGame: function(): string | null {
      if (this.avalon.config.playerList.length < 5) {
        return 'Need at least 5 players! Invite your friends to lobby ' + this.avalon.lobby.name;
      }
      if (this.avalon.config.playerList.length > 10) {
        return 'Cannot start game with more than 10 players';
      }
      if (!this.avalon.isAdmin) {
        return 'Waiting for ' + this.avalon.lobby.admin.name + ' to start game...';
      }

      return null;
    },
    canStartGame: function(): boolean {
      return this.reasonToNotStartGame == null;
    },
    validTeamSize(): boolean {
      return (this.avalon.config.playerList.length >= 5) && (this.avalon.config.playerList.length <= 10);
    },
    numEvilPlayers(): number {
      return avalonLib.getNumEvilForGameSize(this.avalon.config.playerList.length);
    }
  },
  methods: {
    startGame: function() {
      this.startingGame = true;
      this.avalon.startGame(this.options);
    }
  }
 })
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
