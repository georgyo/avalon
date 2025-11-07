<template>
  <div>
      <StartGameEventHandler :avalon='avalon'></StartGameEventHandler>
      <MissionResultEventHandler :avalon='avalon'></MissionResultEventHandler>
      <EndGameEventHandler :avalon='avalon'></EndGameEventHandler>
  </div>
</template>

<script>
import { useToast } from 'vue-toastification'
import StartGameEventHandler from './StartGameEventHandler.vue'
import EndGameEventHandler from './EndGameEventHandler.vue'
import MissionResultEventHandler from './MissionResultEventHandler.vue'

export default {
  name: 'EventHandler',
  inject: ['eventBus'],
  props: [ 'avalon' ],
  components: {
      StartGameEventHandler,
      EndGameEventHandler,
      MissionResultEventHandler,
  },
  setup() {
    const toast = useToast()
    return { toast }
  },
  mounted() {
    this.eventBus.on('LOBBY_CONNECTED', () => {
      document.title = `Avalon - ${this.avalon.lobby.name} - ${this.avalon.user.name}`;
    });
    this.eventBus.on('LOBBY_NEW_ADMIN', () => {
      if (this.avalon.isAdmin) {
        this.toast("You are now lobby administrator");
      } else {
        this.toast(`${this.avalon.lobby.admin.name} became lobby administrator`);
      }
    });
    this.eventBus.on('PROPOSAL_REJECTED', () => {
      this.toast(`${this.avalon.lobby.game.lastProposal.proposer}'s team rejected`);
    });
    this.eventBus.on('PROPOSAL_APPROVED', () => {
      this.toast(`${this.avalon.lobby.game.currentProposal.proposer}'s team approved`);
    });
    this.eventBus.on('TEAM_PROPOSED', () => {
      this.toast(`${this.avalon.lobby.game.currentProposal.proposer} has proposed a team`);
    });
    this.eventBus.on('PLAYER_LEFT', (name) => {
      this.toast(`${name} left the lobby`);
    });
    this.eventBus.on('PLAYER_JOINED', (name) => {
      this.toast(`${name} joined the lobby`);
    });
    this.eventBus.on('DISCONNECTED_FROM_LOBBY', (lobby) => {
      this.toast(`You've been disconnected from ${lobby}`);
    });
  },
  beforeUnmount() {
    // Clean up event listeners
    this.eventBus.all.clear()
  }
}
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
