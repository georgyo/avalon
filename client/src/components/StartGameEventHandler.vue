<template>
     <v-dialog v-model="startGameDialog" persistent max-width='450'>
      <v-card class="cyan-lighten-4">
        <v-card-title class="cyan-lighten-2"><h3>Game Started</h3></v-card-title>
        <v-card-text>
            <p>A new game has started. When you are ready, view your secret role.</p>
            <p>You may also view your role anytime by clicking on your name in the toolbar.</p>        
        </v-card-text>
        <v-divider></v-divider>        
        <v-card-actions>
          <v-spacer></v-spacer>
          <v-btn @click="startGameDialogClosed()">View Role</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
</template>

<script setup>
import { ref, onMounted, inject } from 'vue'

const eventBus = inject('eventBus')
const startGameDialog = ref(false)

const startGameDialogClosed = () => {
  startGameDialog.value = false
  eventBus.emit('show-role')
}

onMounted(() => {
  eventBus.on('GAME_STARTED', () => {
    startGameDialog.value = true
  })

  eventBus.on('GAME_ENDED', () => {
    startGameDialog.value = false
  })
})
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
