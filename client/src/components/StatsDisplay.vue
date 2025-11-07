<template>
  <div class="d-flex flex-column align-center">
  <table>
    <thead>
      <tr class='stats-header font-weight-medium'>
        <td></td>
        <td>Good</td>
        <td>Evil</td>
        <td>Total</td>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class='font-weight-medium'>Games</td>
        <td>{{ good }}</td>
        <td>{{ evil }}</td>
        <td>{{ games }}</td>
       </tr>
       <tr>
         <td class='font-weight-medium'>Wins</td>
         <td>{{ good_wins }}</td>
         <td>{{ evil_wins }}</td>
         <td>{{ wins }}</td>
        </tr>
        <tr>
          <td class='font-weight-medium'>Losses</td>
          <td>{{ good - good_wins }}</td>
          <td>{{ evil - evil_wins }}</td>
          <td>{{ games - wins }}</td>
        </tr>
        <tr>
          <td class='font-weight-medium'>Win Rate</td>
          <td>{{ good_win_rate }}</td>
          <td>{{ evil_win_rate }}</td>
          <td>{{ win_rate }}</td>
        </tr>
        <tr v-if='globalStats'>
          <td class='font-weight-medium'>All Users</td>
          <td>{{ global_good_win_rate }}</td>
          <td>{{ global_evil_win_rate }}</td>
          <td></td>
        </tr>
    </tbody>
  </table>
  <v-col cols="12" class="pt-2">
    <div class="pt-12">Total Playtime: {{ playtime }} </div>
  </v-col>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue'

interface Stats {
  games?: number
  good?: number
  wins?: number
  good_wins?: number
  playtimeSeconds?: number
}

interface GlobalStats {
  games: number
  good_wins: number
}

interface Props {
  stats?: Stats
  globalStats?: GlobalStats
}

const props = defineProps<Props>()

const games = computed(() => props.stats?.games || 0)
const good = computed(() => props.stats?.good || 0)
const evil = computed(() => games.value - good.value)
const wins = computed(() => props.stats?.wins || 0)
const good_wins = computed(() => props.stats?.good_wins || 0)
const evil_wins = computed(() => wins.value - good_wins.value)
const win_rate = computed(() => games.value ? (100 * wins.value / games.value).toFixed(0) + '%' : 'N/A')
const good_win_rate = computed(() => good.value ? (100 * good_wins.value / good.value).toFixed(0) + '%' : 'N/A')
const evil_win_rate = computed(() => evil.value ? (100 * evil_wins.value / evil.value).toFixed(0) + '%' : 'N/A')
const global_good_win_rate = computed(() => {
  if (!props.globalStats) return 'N/A'
  return (100 * props.globalStats.good_wins / props.globalStats.games).toFixed(0) + '%'
})
const global_evil_win_rate = computed(() => {
  if (!props.globalStats) return 'N/A'
  return (100 * (props.globalStats.games - props.globalStats.good_wins) / props.globalStats.games).toFixed(0) + '%'
})
const playtime = computed(() => {
  const seconds = props.stats?.playtimeSeconds || 0
  const hours = seconds / 60 / 60
  if (hours > 1) {
    return hours.toFixed(1) + " hours"
  } else if (seconds > 60) {
    return (seconds / 60).toFixed(0) + " minutes"
  } else {
    return "Not enough"
  }
})
</script>
<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

table {
    border-collapse: collapse;
}

td {
    text-align: right;
    padding-left: 1em;
    padding-right: 1em;
}

.stats-header {
  border-bottom: 2px solid;
}

</style>