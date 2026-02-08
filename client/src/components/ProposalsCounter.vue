<template>
<v-container>
  <div class="d-flex align-center justify-space-around">
    <div v-for="n in 5" :key="n">
      <v-icon v-if='avalon.game.currentProposalIdx + 1 == n' icon="fa:fas fa-crown" />
      <v-icon v-else size="small" icon="fa:fas fa-circle" />
    </div>
  </div>
</v-container>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

export default defineComponent({
  name: 'ProposalCounter',
  props: [ 'avalon' ],
})
</script>
<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
