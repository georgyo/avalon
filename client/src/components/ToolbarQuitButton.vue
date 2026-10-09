<template>
  <v-dialog v-model="dialog" max-width='450'>
    <template v-slot:activator="{ props }">
        <v-btn v-bind="props" :loading='quitting' class="quit-btn">
        <v-icon start>$exitToApp</v-icon>
        <span class="quit-btn-text">Quit</span>
        </v-btn>
    </template>
    <v-card class="bg-cyan-lighten-4">
      <v-card-title class="bg-cyan-lighten-2">
          <h3>{{ actionDescription }}?</h3>
      </v-card-title>
      <v-card-text>
          {{ gameInProgressText }}
          Are you sure you want to proceed?
      </v-card-text>
      <v-divider></v-divider>
      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn color="primary" @click='quitButtonClicked()'>
            {{ actionDescription }}
        </v-btn>
        <v-btn color="secondary" @click='dialog = false'>
            Nevermind
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { useToast } from 'vue-toastification'

export default defineComponent({
  name: 'ToolbarQuitButton',
  props: [ 'avalon' ],
  setup() {
    const toast = useToast()
    return { toast }
  },
  data() {
      return {
          quitting: false,
          dialog: false
      };
  },
  computed: {
      // During the assassination a cancel is ignored (§3.7 rule 6), and at the mission tally that can lead
      // to it a contributor must not cancel (rule 2a): quitting then only leaves the lobby (§4.5).
      onlyLeaves(): boolean {
        return this.avalon.isGameRunning &&
          (this.avalon.cancelWouldForfeit ||
           (this.avalon.isGameInProgress && this.avalon.game.phase == 'ASSASSINATION'));
      },
      cancels(): boolean {
        return this.avalon.isGameRunning && this.avalon.isPlayer && !this.onlyLeaves;
      },
      actionDescription(): string {
        return this.cancels ? 'Cancel Game' : 'Leave Lobby';
      },
      gameInProgressText(): string {
        if (this.cancels) {
          return 'The current game will be canceled and everyone\'s roles revealed!';
        }
        if (this.onlyLeaves) {
          return 'The game can no longer be canceled; it will continue without you.';
        }
        return '';
      }
  },
  methods: {
      quitButtonClicked() {
          this.quitting = true;
          this.dialog = false;
          const action: Promise<void> = this.cancels ? this.avalon.cancelGame() : this.avalon.leaveLobby();
          action
            .catch((err: Error) => this.toast.error(err.message))
            .finally(() => { this.quitting = false; });
      }
  }
})
</script>
<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>
@media (max-width: 599px) {
  .quit-btn {
    min-width: 0;
    padding: 0 8px;
  }
  .quit-btn-text {
    display: none;
  }
}
</style>
