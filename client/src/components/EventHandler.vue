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
  data() {
    return {
      handlers: {} as Record<string, (data: unknown) => void>
    }
  },
  mounted() {
    this.handlers = {
      LOBBY_CONNECTED: () => {
        document.title = `Avalon - ${this.avalon.lobby.name} - ${this.avalon.user.name}`;
      },
      LOBBY_NEW_ADMIN: () => {
        if (this.avalon.isAdmin) {
          this.toast("You are now lobby administrator");
        } else {
          this.toast(`${this.avalon.lobby.admin.name} became lobby administrator`);
        }
      },
      PROPOSAL_REJECTED: () => {
        this.toast(`${this.avalon.lobby.game.lastProposal.proposer}'s team rejected`);
      },
      PROPOSAL_APPROVED: () => {
        this.toast(`${this.avalon.lobby.game.currentProposal.proposer}'s team approved`);
      },
      TEAM_PROPOSED: () => {
        this.toast(`${this.avalon.lobby.game.currentProposal.proposer} has proposed a team`);
      },
      PLAYER_LEFT: (name: unknown) => {
        this.toast(`${String(name)} left the lobby`);
      },
      PLAYER_JOINED: (name: unknown) => {
        this.toast(`${String(name)} joined the lobby`);
      },
      DISCONNECTED_FROM_LOBBY: (lobby: unknown) => {
        this.toast(`You've been disconnected from ${String(lobby)}`);
      }
    };
    for (const [event, handler] of Object.entries(this.handlers)) {
      EventBus.on(event, handler);
    }
  },
  beforeUnmount() {
    for (const [event, handler] of Object.entries(this.handlers)) {
      EventBus.off(event, handler);
    }
  }
})
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
