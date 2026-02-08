<template>
  <v-list class="bg-blue-grey-lighten-4">
    <v-list-item
     v-for="(playerName) in avalon.game.players"
      :key="playerName">
    <template v-slot:prepend>
      <div style="width: 40px;">
      <v-checkbox-btn
       color="indigo-darken-2"
       v-if="enableCheckboxes(playerName)"
       v-model="selectedPlayers" :value='playerName'
       density="compact"></v-checkbox-btn>
       <v-checkbox-btn
        v-if="selectedForMission(playerName)"
        :model-value="true"
        color="indigo-lighten-1"
        readonly
        density="compact"></v-checkbox-btn>
      </div>
    </template>
    <template v-slot:default>
      <div class="d-flex align-center">
      <div style="width: 40px; display: flex; align-items: center; justify-content: center;">
        <template v-if='avalon.game.currentProposer == playerName'>
          <v-tooltip location="bottom">
            <template v-slot:activator="{ props }">
              <font-awesome-layers v-bind="props" style="font-size: 1.8em">
                <font-awesome-icon :color='crownColor' :icon='["fas", "crown"]'></font-awesome-icon>
                <font-awesome-layers-text style="font-size: 0.5em"
                :value="avalon.game.currentProposalIdx + 1" transform="down-4 right-4"></font-awesome-layers-text>
              </font-awesome-layers>
            </template>
            <span>{{ playerName }} is proposing the next team</span>
          </v-tooltip>
        </template>
        <template v-else-if='playerName == avalon.game.hammer'>
          <v-icon size="small" icon="fa:fas fa-hammer" />
        </template>
      </div>
      <div class="flex-grow-1">
        {{playerName}}
      </div>
      </div>
    </template>
    <template v-slot:append>
        <div>
        <v-tooltip location="bottom" v-if='tooltipText(playerName)'>
         <template v-slot:activator="{ props }">
          <font-awesome-layers style="font-size: 1.4em" v-bind="props">
            <font-awesome-icon
             v-if="wasOnLastTeamProposed(playerName)"
             color="#629ec1"
             transform="grow-13"
             :icon='["far", "circle"]'></font-awesome-icon>
            <font-awesome-icon color="#4c4c4c" v-if='waitingOnVote(playerName)' :icon='["fas", "ellipsis-h"]'></font-awesome-icon>
            <font-awesome-icon color="#4c4c4c" v-else-if='hasVoted(playerName)'
             transform="left-2 up-1"
             :icon='["fas", "vote-yea"]'></font-awesome-icon>
            <font-awesome-icon v-else-if='approvedProposal(playerName)' transform="right-1"
             color='green' :icon='["far", "thumbs-up"]'>
            </font-awesome-icon>
            <font-awesome-icon v-else-if='rejectedProposal(playerName)' transform="right-1"
            color='#ed1515' :icon='["far", "thumbs-down"]'></font-awesome-icon>
          </font-awesome-layers>
         </template>
        <span>{{ tooltipText(playerName) }}</span>
        </v-tooltip>
        </div>
    </template>
  </v-list-item>
  </v-list>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
export default defineComponent({
  name: 'GamePlayerList',
  props: [ 'avalon' ],
  emits: ['selected-players'],
  data() {
      return {
          selectedPlayers: [] as string[],
          allowSelect: true
      };
    },
  watch: {
    selectedPlayers() {
      let maxSelected = 1;
      if (this.avalon.game.phase == 'TEAM_PROPOSAL') {
        maxSelected = this.avalon.game.currentMission.teamSize;
      }

      if (this.selectedPlayers.length > maxSelected) {
        this.selectedPlayers.shift();
      }
      this.$emit('selected-players', this.selectedPlayers);
    },
    'avalon.game.phase': function() {
      // clear selected players from phase to phase
      this.selectedPlayers.splice(0);
    }
  },
  computed: {
    crownColor(): string {
      return (this.avalon.game.currentProposalIdx < 4) ? '#fcfc00' : '#cc0808';
    },
  },
  methods: {
    enableCheckboxes(name: string) {
      return (this.avalon.game.phase == 'TEAM_PROPOSAL' && this.avalon.game.currentProposer == this.avalon.user.name) ||
             (this.avalon.game.phase == 'ASSASSINATION' && this.avalon.lobby.role.assassin && (name != this.avalon.user.name));
    },
    selectedForMission(name: string) {
      return (this.avalon.game.phase == 'PROPOSAL_VOTE' || this.avalon.game.phase == 'MISSION_VOTE') &&
        this.avalon.game.currentProposal.team.includes(name);
    },
    hasVoted(name: string) {
      return (this.avalon.game.phase == "PROPOSAL_VOTE") &&
             (this.avalon.game.currentProposal.votes.includes(name));
    },
    waitingOnVote(name: string) {
      return (this.avalon.game.phase == "PROPOSAL_VOTE") &&
             (!this.avalon.game.currentProposal.votes.includes(name));
    },
    wasOnLastTeamProposed(name: string) {
      switch (this.avalon.game.phase) {
        case "TEAM_PROPOSAL":
        case "ASSASSINATION":
          return this.avalon.game.lastProposal && this.avalon.game.lastProposal.team.includes(name);
        case "PROPOSAL_VOTE":
        case "MISSION_VOTE":
          return this.avalon.game.currentProposal.team.includes(name);
        default:
          console.error("Unhandled game phase", this.avalon.game.phase);
          return false;
      }
    },
    approvedProposal(name: string) {
      if (this.avalon.game.phase == "TEAM_PROPOSAL" || this.avalon.game.phase == 'ASSASSINATION') {
        return this.avalon.game.lastProposal && this.avalon.game.lastProposal.votes.includes(name);
      } else if (this.avalon.game.phase == "MISSION_VOTE") {
        return this.avalon.game.currentProposal.votes.includes(name);
      }
    },
    rejectedProposal(name: string) {
      if (this.avalon.game.phase == "TEAM_PROPOSAL" || this.avalon.game.phase == 'ASSASSINATION') {
        return this.avalon.game.lastProposal && !this.avalon.game.lastProposal.votes.includes(name);
      } else if (this.avalon.game.phase == "MISSION_VOTE") {
        return !this.avalon.game.currentProposal.votes.includes(name);
      }
    },
    tooltipText(name: string) {
      const states: string[] = [];
      if (this.wasOnLastTeamProposed(name)) {
        states.push('was on the last proposed team');
      }

      if (this.waitingOnVote(name)) {
        states.push('is currently voting on the proposal');
      } else if (this.hasVoted(name)) {
        states.push('has submitted a vote for the proposed team');
      } else if (this.approvedProposal(name)) {
        states.push('approved the last team');
      } else if (this.rejectedProposal(name)) {
        states.push('rejected the last team');
      }

      if (states.length == 0) return null;

      return name + ' ' + states.joinWithAnd();
    }
  }
 })
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
