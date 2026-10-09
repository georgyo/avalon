<template>
  <v-container fluid>
  <v-row align="start" justify="center" class="flex-wrap">
  <v-col cols="12" sm="6">
    <p class="text-cyan-lighten-4">Players</p>
    <LobbyPlayerList v-bind:avalon='avalon' />
    <p v-if='avalon.isAdmin && !avalon.isGameRunning && avalon.config.playerList.length > 2'
      class="text-cyan-lighten-4 text-caption">Drag names to specify seating order</p>
  </v-col>
   <v-col v-show='validTeamSize' cols="12" sm="6">
      <p class="text-cyan-lighten-4">Special Roles Available</p>
      <RoleList
        v-bind:roles='avalon.config.selectableRoles'
        v-bind:allowSelect='avalon.isAdmin && !avalon.isGameRunning' />
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
  <div v-if='avalon.isGameRunning || avalon.isEnding' class="d-flex flex-column align-center justify-center pt-2">
    <StallNotice :avalon='avalon' />
    <SetupProgressCard v-if='avalon.setupProgress' :avalon='avalon' />
    <v-card v-else-if='avalon.isEnding' class="bg-blue-grey-lighten-4" data-testid="ending-notice">
      <v-card-text class="text-center">
        Game over - waiting for every device to reveal its keys
        <span v-if='avalon.endingProgress'>({{ avalon.endingProgress.revealed }}/{{ avalon.endingProgress.total }})</span>
      </v-card-text>
    </v-card>
    <v-card v-else class="bg-blue-grey-lighten-4">
      <v-card-text class="text-center">A game is in progress.</v-card-text>
    </v-card>
  </div>
  <div v-else class="d-flex align-center justify-center pt-2">
    <v-btn
     v-if='canStartGame'
     :loading='startingGame'
     @click='startGame()'
    >
        <v-icon start>
          $play
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
      <v-icon start size="small" icon="fa:fas fa-envelope-square" />
       <span>Send feedback</span>
    </v-btn>
  </div>
</div>
  </v-container>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import * as avalonLib from '@avalon/common/avalonlib'
import { useToast } from 'vue-toastification'
import LobbyPlayerList from './LobbyPlayerList.vue'
import RoleList from './RoleList.vue'
import SetupProgressCard from './SetupProgressCard.vue'
import StallNotice from './StallNotice.vue'

export default defineComponent({
  name: 'GameLobby',
  components: {
    LobbyPlayerList,
    RoleList,
    SetupProgressCard,
    StallNotice
  },
  props: [ 'avalon' ],
  setup() {
    const toast = useToast()
    return { toast }
  },
  data() {
    return {
      options: {
        inGameLog: false
      },
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
      // undefined outside 5..10 players (the count is shown only for a valid team size)
      return avalonLib.getNumEvilForGameSize(this.avalon.config.playerList.length) ?? 0;
    }
  },
  methods: {
    startGame: function() {
      this.startingGame = true;
      this.avalon.startGame(this.options).catch((err: Error) => this.toast.error(err.message)).finally(() => {
        this.startingGame = false;
      });
    }
  }
 })
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>
@media (max-width: 599px) {
  .v-container {
    padding: 8px;
  }
}
</style>
