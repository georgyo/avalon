<template>
  <div v-if="badges.length" class='pt-6'>
    <div class='text-h4' style='text-align: center;'>Achievements</div>
    <div v-for="badge in badges" :key="badge.title" class="pt-2">
    <v-card class="bg-blue-grey-lighten-4" min-width='400' max-width='900'>
      <v-card-title class="bg-cyan-lighten-2">
        <v-icon start color="yellow" icon="fa:fas fa-trophy" />
        <div class='text-h6'>{{ badge.title }}</div></v-card-title>
      <v-card-text>{{ badge.body }}</v-card-text>
    </v-card>
    </div>
  </div>
</template>
<script lang="ts">
import { defineComponent } from 'vue'
import GameAnalysis from "@/avalon-analysis";

export default defineComponent({
  name: "Achievements",
  props: ["avalon"],
  computed: {
    badges() {
      if (this.avalon.lobby.game.outcome.state == 'CANCELED') return [];
      const gameAnalysis = new GameAnalysis(
        this.avalon.lobby.game,
        this.avalon.config.roleMap
      );
      return gameAnalysis.getBadges();
    }
  }
});
</script>
<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>
</style>
