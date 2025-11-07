<template>
  <div>
    <v-dialog v-model="kickPlayerDialog" max-width='450'>
      <v-card class="bg-cyan-lighten-4">
        <v-card-title class="bg-cyan-lighten-2">
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

    <v-list class="bg-blue-grey-lighten-4">
      <draggable
        v-model="playerList"
        handle=".handle"
        :disabled=!canDrag
        @end="onReorderList()">
        <v-list-item v-for="player in playerList" :key="player">
          <v-icon start v-if="canDrag" class="handle">fas fa-bars</v-icon>
          <v-icon start v-if="player == avalon.lobby.admin.name">star</v-icon>
          <v-icon start v-else-if="player == avalon.user.name">perm_identity</v-icon>
          <v-icon start v-else>person</v-icon>
          <v-col cols="10">{{player}}</v-col>
          <v-col cols="1">
            <v-btn
              v-if="(avalon.isAdmin && player != avalon.user.name && !avalon.isGameInProgress)"
              :loading="playersBeingKicked.includes(player)"
              @click.stop="kickPlayerConfirm(player)"
              icon
              variant="text"
              color="black">
              <v-icon>clear</v-icon>
            </v-btn>
          </v-col>
        </v-list-item>
      </draggable>
    </v-list>
  </div>
</template>

<script>
import draggable from "vuedraggable";

export default {
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
};
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>
</style>
