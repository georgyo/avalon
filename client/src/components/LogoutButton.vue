<template>
  <v-btn slot="activator" light :loading='loggingOut' @click='logoutButtonClicked()'>
    <v-icon left>exit_to_app</v-icon>
      Logout
  </v-btn>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useAvalonStore } from '../stores/avalon.js'

const avalonStore = useAvalonStore()
const avalon = computed(() => avalonStore.getAvalon())

const loggingOut = ref(false)

function logoutButtonClicked() {
  loggingOut.value = true
  avalon.value.logout()
}
</script>
<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>