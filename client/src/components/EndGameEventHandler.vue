<template>
     <v-dialog v-model="endGameDialog" fullscreen persistent>
      <v-card v-if='endGameDialog && avalon.game && avalon.game.outcome' class="bg-cyan-lighten-4">
        <v-card-title class="bg-cyan-lighten-2 endGameTitle">
            <div class="d-flex align-center justify-center fill-height w-100">
                <span class='text-h4 font-weight-bold'>{{title}}</span>
            </div>
        </v-card-title>
        <v-card-text class="endgame-content">
            <div class="d-flex flex-column align-center justify-center">
            <div class='endgame-message font-weight-bold' data-testid="endgame-message"> {{ avalon.game.outcome.message }}</div>
            <p v-if='avalon.game.outcome.assassinated'>
                {{ avalon.game.outcome.assassinated }} was assassinated<template v-if='assassinName'> by {{ assassinName }}</template>
            </p>
            <v-alert v-for='cheater in cheaters' :key='"cheater_" + cheater.name + cheater.reason'
              type="error" density="compact" variant="tonal" class="mb-2 endgame-alert" data-testid="endgame-cheater">
              {{ cheater.name }} cheated: {{ cheater.reason }}
            </v-alert>
            <v-alert v-if='unrevealed.length' type="warning" density="compact" variant="tonal" class="mb-2 endgame-alert"
              data-testid="endgame-unrevealed">
              <template v-if='revealsOverdue'>
                {{ unrevealed.joinWithAnd() }} did not reveal - results incomplete
              </template>
              <template v-else>
                Waiting for {{ unrevealed.joinWithAnd() }} to reveal...
              </template>
            </v-alert>
            <p v-else-if='avalon.game.outcome.final === false' class="text-caption">Some results are still incomplete.</p>
            <div class="endgame-table-wrapper">
              <MissionSummaryTable
               :players='avalon.game.players'
               :missions='missions'
               :roles='roleAssignments'
               :missionVotes='avalon.game.outcome.votes' />
            </div>
            <GameAchievements :avalon='avalon' />
            <v-btn class="mt-6" color="primary" size="large" variant="elevated" @click="endGameDialogClosed()">Close</v-btn>
            </div>
        </v-card-text>
      </v-card>
    </v-dialog>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { EventBus } from '@/eventBus'
import GameAchievements from './GameAchievements.vue'
import MissionSummaryTable from './MissionSummaryTable.vue'
import { UI_TIMERS } from '@/avalon'

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
      gameState(): string | null {
          return this.avalon.lobby && this.avalon.lobby.connected ? this.avalon.lobby.game.state : null;
      },
      title() {
          switch (this.avalon.game.outcome.state) {
              case 'GOOD_WIN': return 'Good wins!';
              case 'EVIL_WIN': return 'Evil wins!';
              case 'CANCELED': return 'Game Canceled';
              default: return this.avalon.game.outcome.state;
          }
      },
      roleAssignments() {
        // unknown roles ('UNKNOWN', never revealed, §5.12) sort last
        const roleIndexOf = (name: string) => {
          const idx = this.avalon.config.roles.findIndex((r: {name: string}) => r.name == name);
          return idx < 0 ? Number.MAX_SAFE_INTEGER : idx;
        };
        return this.avalon.game.outcome.roles.slice(0).sort((a: {role: string}, b: {role: string}) =>
          roleIndexOf(a.role) - roleIndexOf(b.role));
      },
      assassinName(): string | null {
        const assassin = this.avalon.game.outcome.roles.find((r: {assassin?: boolean}) => r.assassin);
        return assassin ? assassin.name : null;
      },
      cheaters(): {name: string; reason: string}[] {
        return this.avalon.game.outcome.cheaters ?? [];
      },
      unrevealed(): string[] {
        return this.avalon.game.outcome.unrevealed ?? [];
      },
      revealsOverdue(): boolean {
        return this.avalon.endedMs > UI_TIMERS.missingRevealsMs;
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
  watch: {
      // The fullscreen, persistent dialog would otherwise stay up, empty, once the admin starts the
      // next game (ENDED -> INIT setup), blocking the toolbar during the whole setup.
      gameState(state: string | null) {
          if (state != 'ENDED') this.endGameDialog = false;
      }
  },
  mounted() {
      const onGameEnded = () => { this.endGameDialog = true; };
      const onGameStarted = () => { this.endGameDialog = false; };
      this.onGameEnded = onGameEnded;
      this.onGameStarted = onGameStarted;
      EventBus.on('GAME_ENDED', onGameEnded);
      EventBus.on('GAME_STARTED', onGameStarted);
      EventBus.on('GAME_SETUP', onGameStarted);
  },
  beforeUnmount() {
      if (this.onGameEnded) EventBus.off('GAME_ENDED', this.onGameEnded);
      if (this.onGameStarted) {
          EventBus.off('GAME_STARTED', this.onGameStarted);
          EventBus.off('GAME_SETUP', this.onGameStarted);
      }
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
      padding-left: 10px;
      padding-right: 10px;
      text-align: center;
  }

  .endgame-content {
      padding: 8px;
  }

  .endgame-message {
      font-size: 1.15rem;
      text-align: center;
  }

  .endgame-alert {
      max-width: 600px;
      width: 100%;
  }

  .endgame-table-wrapper {
      overflow-x: auto;
      width: 100%;
      -webkit-overflow-scrolling: touch;
  }

  @media (min-width: 600px) {
    .endGameTitle {
      padding-left: 30px;
    }
    .endgame-content {
      padding: 16px;
    }
    .endgame-message {
      font-size: 1.5rem;
    }
  }
</style>
