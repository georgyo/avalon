<template>
  <v-card class="bg-blue-grey-lighten-4">
    <v-card-title class="bg-light-blue-lighten-4">
      Team Proposal Vote ({{ avalon.game.currentProposalIdx + 1 }}/5)
    </v-card-title>
    <v-card-text>
      <div>Voting for {{ proposer }} team of {{ avalon.game.currentProposal.team.joinWithAnd() }}</div>
      <div class="d-flex align-center justify-space-between fill-height">
        <v-btn
          :loading="loadingState.yes"
          :disabled="disabledState.yes"
          @click="teamVote(true)"
        >
          <v-icon
            v-if="votedState.yes"
            start
            color="green"
            icon="fa:fas fa-vote-yea"
          />
          <v-icon
            v-else
            start
            color="green"
            icon="fa:far fa-thumbs-up"
          />
          Approve
        </v-btn>
        <v-btn
          :loading="loadingState.no"
          :disabled="disabledState.no"
          @click="teamVote(false)"
        >
          <v-icon
            v-if="votedState.no"
            start
            color="red"
            icon="fa:fas fa-vote-yea"
          />
          <v-icon
            v-else
            start
            color="red"
            icon="fa:far fa-thumbs-down"
          />
          Reject
        </v-btn>
      </div>
    </v-card-text>
  </v-card>
</template>

<script setup>
import { reactive, computed } from 'vue'
import { useAvalonStore } from '../stores/avalon'

const avalonStore = useAvalonStore()
const avalon = computed(() => avalonStore.getAvalon())

const hasVoted = avalon.value.game.currentProposal.votes.includes(avalon.value.user.name)

const loadingState = reactive({ yes: false, no: false })
const disabledState = reactive({ yes: hasVoted, no: hasVoted })
const votedState = reactive({ yes: false, no: false })

const proposer = computed(() => {
  return (avalon.value.game.currentProposer == avalon.value.user.name) ?
    'your' : avalon.value.game.currentProposer + "'s "
})

function teamVote(vote) {
  const myState = vote ? 'yes' : 'no'
  const otherState = vote ? 'no' : 'yes'
  loadingState[myState] = true
  disabledState[otherState] = true
  avalon.value.voteTeam(vote).finally(() => {
    loadingState[myState] = false
    disabledState[myState] = true
    disabledState[otherState] = false
    votedState[myState] = true
    votedState[otherState] = false
  })
}
</script>
<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>