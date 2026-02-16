<template>
  <v-dialog v-model="dialog" max-width='450'>
    <template v-slot:activator="{ props }">
        <v-btn v-bind="props" :loading='quitting' class="quit-btn">
        <v-icon start>mdi-exit-to-app</v-icon>
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
export default defineComponent({
  name: 'ToolbarQuitButton',
  props: [ 'avalon' ],
  data() {
      return {
          quitting: false,
          dialog: false
      };
  },
  computed: {
      actionDescription() {
        if (this.avalon.isGameInProgress) {
            return 'Cancel Game';
        }
        return 'Leave Lobby';
      },
      gameInProgressText() {
          if (this.avalon.isGameInProgress) {
              return 'The current game will be canceled!'
          } else {
              return '';
          }
      }
  },
  methods: {
      quitButtonClicked() {
          this.quitting = true;
          this.dialog = false;
          if (this.avalon.isGameInProgress) {
              this.avalon.cancelGame().finally(() => this.quitting = false);
          } else {
              this.avalon.leaveLobby();
          }
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
