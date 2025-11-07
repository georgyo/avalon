<template>
<v-container>
  <div class="d-flex align-center justify-space-around">
    <div v-for="n in 5" :key="n">
      <v-icon v-if='avalon.game.currentProposalIdx + 1 == n' icon="fa:fas fa-crown"></v-icon>
      <v-icon v-else size="small" icon="fa:fas fa-circle"></v-icon>
    </div>
  </div>
</v-container>
</template>

<script setup>
import { computed } from 'vue'
import { useAvalonStore } from '../stores/avalon'

const avalonStore = useAvalonStore()
const avalon = computed(() => avalonStore.getAvalon())
</script>
<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>