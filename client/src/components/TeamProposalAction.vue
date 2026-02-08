<template>
  <v-card class="bg-blue-grey-lighten-4">
    <v-card-title class="bg-light-blue-lighten-4">
      Team Proposal ({{ avalon.game.currentProposalIdx + 1}}/5)
    </v-card-title>
    <v-card-text>
      <div class="d-flex flex-column align-center justify-center fill-height">
     <div v-if='avalon.game.currentProposer == avalon.user.name'>
        <div class="text-center">Propose a team of {{ avalon.game.currentMission.teamSize }}</div>
        <v-btn
          v-bind:disabled='!isValidSelection'
          v-bind:loading='isProposing'
          v-on:click='proposeTeam()'>Propose Team</v-btn>
     </div>
     <div v-else class="text-center">
       Waiting for {{ avalon.game.currentProposer }} to propose a team of {{ avalon.game.currentMission.teamSize }}
     </div>
      </div>
    </v-card-text>
  </v-card>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

export default defineComponent({
  name: 'TeamProposalAction',
  props: [ 'avalon', 'playerList' ],
  data() {
      return {
          isProposing: false
      };
  },
  computed: {
      isValidSelection(): boolean {
          return this.playerList.length == this.avalon.game.currentMission.teamSize;
      }
  },
  methods: {
      proposeTeam() {
        this.isProposing = true;
        this.avalon.proposeTeam(this.playerList);
      }
  }
})

</script>
<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
