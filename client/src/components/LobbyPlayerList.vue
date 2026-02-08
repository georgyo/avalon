<template>
  <div>
    <v-dialog v-model="kickPlayerDialog" max-width='450'>
      <v-card class="cyan lighten-4">
        <v-card-title class="cyan lighten-2">
          <h3>Kick {{playerToKick}}?</h3>
        </v-card-title>
        <v-card-text>Do you wish to kick {{ playerToKick }} from the lobby?</v-card-text>
        <v-divider></v-divider>
        <v-card-actions>
          <v-btn @click="kickPlayer(playerToKick)">Kick {{ playerToKick }}</v-btn>
          <v-btn @click="kickPlayerDialog = false">Cancel</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-list class="blue-grey lighten-4">
      <draggable
        v-model="playerList"
        handle=".handle"
        :disabled=!canDrag
        @end="onReorderList()">
        <v-list-item v-for="player in playerList" :key="player">
          <v-icon left v-if="canDrag" class="handle">fas fa-bars</v-icon>
          <v-icon left v-if="player == avalon.lobby.admin.name">star</v-icon>
          <v-icon left v-else-if="player == avalon.user.name">perm_identity</v-icon>
          <v-icon left v-else>person</v-icon>
          <v-flex xs10>{{player}}</v-flex>
          <v-flex xs1>
            <template v-slot:activator>
<v-btn icon right text
              v-if="(avalon.isAdmin && player != avalon.user.name && !avalon.isGameInProgress)"
              :loading="playersBeingKicked.includes(player)"
              @click.stop="kickPlayerConfirm(player)"
              
              color="black"
              dark>
              <v-icon>clear</v-icon>
            </v-btn>
</template>
          </v-flex>
        </v-list-item>
      </draggable>
    </v-list>
  </div>
</template>

<script lang="ts">
import Vue from 'vue'
import draggable from "vuedraggable";

export default Vue.extend({
  name: "LobbyPlayerList",
  components: {
    draggable
  },
  props: ["avalon"],
  computed: {
    canDrag() {
      return this.avalon.isAdmin && !this.avalon.isGameInProgress;
    }
  },
  data() {
    return {
      playerList: this.avalon.config.playerList,
      kickPlayerDialog: false,
      playerToKick: "",
      playersBeingKicked: []
    };
  },
  methods: {
    onReorderList() {
      this.avalon.config.sortList(this.playerList);
    },
    kickPlayerConfirm(player) {
      this.playerToKick = player;
      this.kickPlayerDialog = true;
    },
    kickPlayer(player) {
      this.kickPlayerDialog = false;
      this.playersBeingKicked.push(player);
      this.avalon.kickPlayer(player).finally(() =>
          this.playersBeingKicked.splice(
            this.playersBeingKicked.indexOf(player)
          )
        );
    }
  },
  watch: {
    "avalon.config.playerList": function(list) {
      this.playerList = list;
    }
  }
});
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>
</style>
