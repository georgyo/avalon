<template>
  <v-dialog v-model="dialog" max-width='450'>
    <template v-slot:activator="{ props }">
        <v-btn v-bind="props" light :loading='quitting'>
        <v-icon icon="exit_to_app"></v-icon>
        Quit
        </v-btn>
    </template>
    <v-card class="cyan-lighten-4">
      <v-card-title class="cyan-lighten-2">
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

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAvalonStore } from '../stores/avalon'

const avalonStore = useAvalonStore()
const avalon = computed(() => avalonStore.getAvalon())

const quitting = ref(false)
const dialog = ref(false)

const actionDescription = computed(() => {
  if (avalon.value.isGameInProgress) {
    return 'Cancel Game'
  }
  return 'Leave Lobby'
})

const gameInProgressText = computed(() => {
  if (avalon.value.isGameInProgress) {
    return 'The current game will be canceled!'
  } else {
    return ''
  }
})

function quitButtonClicked(): void {
  quitting.value = true
  dialog.value = false
  if (avalon.value.isGameInProgress) {
    avalon.value.cancelGame().finally(() => quitting.value = false)
  } else {
    avalon.value.leaveLobby()
  }
}
</script>
<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>