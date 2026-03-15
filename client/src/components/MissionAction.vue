<template>
  <v-card class="bg-blue-grey-lighten-4">
    <v-card-title class="bg-light-blue-lighten-4">
      Mission in Progress
     </v-card-title>
     <v-card-text>
      <div v-if='needsToVote'>
        <div class="d-flex align-center justify-space-between fill-height">
        <v-btn @click='missionVote(true)'>
            <v-icon start color="green" icon="fa:fas fa-check-circle" />
                SUCCESS
            </v-btn>
        <v-btn @click='missionVote(false)'>
          <v-icon start color="red" icon="fa:fas fa-times-circle" />
            FAIL
        </v-btn>
        </div>
       </div>
       <div v-else>
           {{ waitingForText }}
       </div>
     </v-card-text>
  </v-card>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { difference } from 'lodash-es';

export default defineComponent({
  name: 'MissionAction',
  props: [ 'avalon' ],
  data() {
      return {
          needsToVote: this.avalon.game.currentProposal.team.includes(this.avalon.user.name)
      };
  },
  methods: {
      missionVote(vote: boolean) {
        // no loading state, we want to hide the results as fast as possible
        this.needsToVote = false;
        this.avalon.doMission(vote);
      }
  },
  computed: {
    stillWaitingFor(): string[] {
      return difference(this.avalon.game.currentProposal.team,
                          this.avalon.game.currentMission.team).filter(
                            (n: string) => n != this.avalon.user.name);
    },
    waitingForText(): string {
      if (this.stillWaitingFor.length > 0) {
        return 'Waiting for ' + this.stillWaitingFor.joinWithAnd();
      } else {
        return 'Waiting for results...';
      }
    }
  }
})
</script>
<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
