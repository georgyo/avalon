<template>
  <v-bottom-sheet v-model="sheet">
    <template v-slot:activator="{ props }">
      <v-btn v-bind="props" variant="outlined" class="role-btn">
        <v-icon start>
          $account
        </v-icon>
        <span class="role-btn-text">{{ avalon.user.name }}</span>
      </v-btn>
    </template>
    <v-card v-if='!avalon.isGameInProgress' class="bg-cyan-lighten-4">
      <v-card-title>
        <div class="d-flex flex-column align-center justify-center">
          <div class="font-weight-bold">When the game starts, you will see your role here.</div>
        </div>
      </v-card-title>
      <v-card-text>
        <div class="d-flex flex-column align-center justify-center">
          <p class='text-subtitle-1'>Your Stats</p>
          <StatsDisplay :stats='avalon.user.stats' />
        </div>
      </v-card-text>
    </v-card>
    <v-card v-else class="bg-cyan-lighten-4">
      <v-card-title class="bg-cyan-lighten-2">
          <v-icon start v-if='avalon.lobby.role.role.team == "good"' icon="fa:fab fa-old-republic" />
          <v-icon start v-else color="red" icon="fa:fab fa-empire" />
          <span class='text-h5'>{{ avalon.lobby.role.role.name }}</span>
      </v-card-title>
      <v-card-text>
           <p>Your role is <span class='font-weight-medium'>{{ avalon.lobby.role.role.name}}</span>.</p>
           <p>You are on the <span class='font-weight-medium'>{{ avalon.lobby.role.role.team }}</span> team.</p>
           <p>{{ avalon.lobby.role.role.description }}</p>
           <p v-if='avalon.lobby.role.assassin'>
             You are also the <span class='font-weight-medium'>ASSASSIN</span>!
             It will be up to you to identify MERLIN if the good team succeeds 3 missions.
           </p>
           <div v-if='avalon.lobby.role.sees.length'>
               <p>You see <span class='font-weight-bold'>{{ avalon.lobby.role.sees.joinWithAnd() }}</span>.</p>
           </div>
           <p v-else>
             You do not see anyone.
           </p>
      </v-card-text>
    </v-card>
  </v-bottom-sheet>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { EventBus } from '@/eventBus'
import StatsDisplay from './StatsDisplay.vue'

export default defineComponent({
  name: 'ViewRoleButton',
  components: {
    StatsDisplay
  },
  props: [ 'avalon' ],
  mounted() {
      const onShowRole = () => { this.sheet = true; };
      const onGameEnded = () => { this.sheet = false; };
      this.onShowRole = onShowRole;
      this.onGameEnded = onGameEnded;
      EventBus.on('show-role', onShowRole);
      EventBus.on('GAME_ENDED', onGameEnded);
  },
  beforeUnmount() {
      if (this.onShowRole) EventBus.off('show-role', this.onShowRole);
      if (this.onGameEnded) EventBus.off('GAME_ENDED', this.onGameEnded);
  },
  data() {
      return {
          sheet: false,
          onShowRole: null as (() => void) | null,
          onGameEnded: null as (() => void) | null,
      };
  },
})
</script>
<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>
.role-btn {
  max-width: 160px;
}

.role-btn-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 599px) {
  .role-btn {
    max-width: 120px;
    font-size: 0.8rem;
    padding: 0 8px;
  }
}
</style>
