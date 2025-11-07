<template>
  <v-btn light :loading='loggingOut' @click='logoutButtonClicked()'>
    <v-icon start icon="exit_to_app"></v-icon>
      Logout
  </v-btn>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useAvalonStore } from '../stores/avalon'

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