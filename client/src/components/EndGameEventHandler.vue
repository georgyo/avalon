<template>
     <v-dialog v-model="endGameDialog" fullscreen persistent>
      <v-card v-if='endGameDialog && avalon.game && avalon.game.outcome' class="bg-cyan-lighten-4">
        <v-card-title class="bg-cyan-lighten-2 endGameTitle">
            <div class="d-flex align-center justify-center fill-height w-100">
                <span class='text-h4 font-weight-bold'>{{title}}</span>
            </div>
        </v-card-title>
        <v-card-text>
            <div class="d-flex flex-column align-center justify-center">
            <div class='text-h5 font-weight-bold'> {{ avalon.game.outcome.message }}</div>
            <p v-if='avalon.game.outcome.assassinated'>
                {{ avalon.game.outcome.assassinated}} was assassinated by
                {{ avalon.game.outcome.roles.find(r => r.assassin ).name }}
            </p>
            <v-container style='overflow-x: auto; width: 100%;'>
              <MissionSummaryTable
               :players='avalon.game.players'
               :missions='missions'
               :roles='roleAssignments'
               :missionVotes='avalon.game.outcome.votes' />
            </v-container>
            <GameAchievements :avalon='avalon' />
            </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer></v-spacer>
          <v-btn @click="endGameDialogClosed()">Close</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { EventBus } from '@/eventBus'
import GameAchievements from './GameAchievements.vue'
import MissionSummaryTable from './MissionSummaryTable.vue'

export default defineComponent({
  name: 'EndGameEventHandler',
  props: [ 'avalon' ],
  components: {
      GameAchievements,
      MissionSummaryTable
  },
  data() {
      return {
          endGameDialog: false,
          onGameEnded: null as (() => void) | null,
          onGameStarted: null as (() => void) | null,
      }
  },
  computed: {
      title() {
          switch (this.avalon.game.outcome.state) {
              case 'GOOD_WIN': return 'Good wins!';
              case 'EVIL_WIN': return 'Evil wins!';
              case 'CANCELED': return 'Game Canceled';
              default: return this.avalon.game.outcome.state;
          }
      },
      roleAssignments() {
        return this.avalon.game.outcome.roles.slice(0).sort((a: {role: string}, b: {role: string}) => {
          const roleIndexOf = (name: string) => this.avalon.config.roles.findIndex((r: {name: string}) => r.name == name);
          return roleIndexOf(a.role) - roleIndexOf(b.role);
        });
      },
      missions() {
          return this.avalon.game.missions.filter((m: {proposals: {state: string}[]}) => m.proposals.filter(p => p.state != 'PENDING').length > 0);
      }
  },
  methods: {
      endGameDialogClosed() {
          this.endGameDialog = false;
      }
  },
  mounted() {
      this.onGameEnded = () => { this.endGameDialog = true; };
      this.onGameStarted = () => { this.endGameDialog = false; };
      EventBus.on('GAME_ENDED', this.onGameEnded);
      EventBus.on('GAME_STARTED', this.onGameStarted);
  },
  beforeUnmount() {
      EventBus.off('GAME_ENDED', this.onGameEnded);
      EventBus.off('GAME_STARTED', this.onGameStarted);
  }
})
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

 table {
    border-collapse: collapse;
 }

 tr {
    height: 2.3em;
 }

 td {
     width: 1.7em;
     padding-left: 6px;
     padding-right: 4px;
 }

  tr:nth-child(even) {
     background-color: Gainsboro;
  }

  tr:nth-child(odd) {
      background-color: bisque;
  }

  td.role {
    border-right: 2px solid;
    white-space: nowrap;
  }

  td.player-name {
      border-left: 2px solid;
  }

  td.mission-result {
    border-right: 2px solid;
  }

  .endGameTitle {
      padding-left: 30px;
      text-align: center;
  }
</style>
