<template>
  <div>
    <TeamProposalAction
      v-if="teamProposal"
      :avalon="avalon"
      :player-list="selectedPlayers"
    />
    <TeamVoteAction
      v-if="teamVote"
      :avalon="avalon"
    />
    <MissionAction
      v-if="missionAction"
      :avalon="avalon"
    />
    <AssassinationAction
      v-if="assassinationPhase"
      :player-list="selectedPlayers"
      :avalon="avalon"
    />
  </div>
</template>

<script>
import TeamProposalAction from './TeamProposalAction.vue'
import TeamVoteAction from './TeamVoteAction.vue'
import MissionAction from './MissionAction.vue'
import AssassinationAction from './AssassinationAction.vue'

export default {
  name: 'ActionPane',
  components: {
    TeamProposalAction,
    TeamVoteAction,
    MissionAction,
    AssassinationAction
  },
  props: [ 'avalon', 'selectedPlayers' ],
  computed: {
    teamProposal() {
        return this.avalon.game.phase == 'TEAM_PROPOSAL'
    },
    teamVote() {
        return this.avalon.game.phase == 'PROPOSAL_VOTE'
    },
    missionAction() {
        return this.avalon.game.phase == 'MISSION_VOTE'
    },
    assassinationPhase() {
        return this.avalon.game.phase == 'ASSASSINATION'
    },
  },
}
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
