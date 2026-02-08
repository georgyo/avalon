<template>
  <div>
      <StartGameEventHandler :avalon='avalon'></StartGameEventHandler>
      <MissionResultEventHandler :avalon='avalon'></MissionResultEventHandler>
      <EndGameEventHandler :avalon='avalon'></EndGameEventHandler>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { useToast } from 'vue-toastification'
import { EventBus } from '@/eventBus'
import StartGameEventHandler from './StartGameEventHandler.vue'
import EndGameEventHandler from './EndGameEventHandler.vue'
import MissionResultEventHandler from './MissionResultEventHandler.vue'

export default defineComponent({
  name: 'EventHandler',
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
    EventBus.on('LOBBY_CONNECTED', () => {
      document.title = `Avalon - ${this.avalon.lobby.name} - ${this.avalon.user.name}`;
    });
    EventBus.on('LOBBY_NEW_ADMIN', () => {
      if (this.avalon.isAdmin) {
        this.toast("You are now lobby administrator");
      } else {
        this.toast(`${this.avalon.lobby.admin.name} became lobby administrator`);
      }
    });
    EventBus.on('PROPOSAL_REJECTED', () => {
      this.toast(`${this.avalon.lobby.game.lastProposal.proposer}'s team rejected`);
    });
    EventBus.on('PROPOSAL_APPROVED', () => {
      this.toast(`${this.avalon.lobby.game.currentProposal.proposer}'s team approved`);
    });
    EventBus.on('TEAM_PROPOSED', () => {
      this.toast(`${this.avalon.lobby.game.currentProposal.proposer} has proposed a team`);
    });
    EventBus.on('PLAYER_LEFT', (name) => {
      this.toast(`${name} left the lobby`);
    });
    EventBus.on('PLAYER_JOINED', (name) => {
      this.toast(`${name} joined the lobby`);
    });
    EventBus.on('DISCONNECTED_FROM_LOBBY', (lobby) => {
      this.toast(`You've been disconnected from ${lobby}`);
    });
  }
})
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
