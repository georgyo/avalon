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
        :disabled="!canDrag"
        item-key="id"
        @end="onReorderList()">
        <template #item="{element}">
          <v-list-item>
            <template v-slot:prepend>
              <v-icon v-if="canDrag" class="handle mr-2">fas fa-bars</v-icon>
              <v-icon v-if="element == avalon.lobby.admin.name" class="mr-2">mdi-star</v-icon>
              <v-icon v-else-if="element == avalon.user.name" class="mr-2">mdi-account</v-icon>
              <v-icon v-else class="mr-2">mdi-account-outline</v-icon>
            </template>
            <v-list-item-title>{{element}}</v-list-item-title>
            <template v-slot:append>
              <v-btn icon variant="text"
                v-if="(avalon.isAdmin && element != avalon.user.name && !avalon.isGameInProgress)"
                :loading="playersBeingKicked.includes(element)"
                @click.stop="kickPlayerConfirm(element)"
                color="black"
                size="small">
                <v-icon>mdi-close</v-icon>
              </v-btn>
            </template>
          </v-list-item>
        </template>
      </draggable>
    </v-list>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import draggable from "vuedraggable";

export default defineComponent({
  name: "LobbyPlayerList",
  components: {
    draggable
  },
  props: ["avalon"],
  computed: {
    canDrag(): boolean {
      return this.avalon.isAdmin && !this.avalon.isGameInProgress;
    }
  },
  data() {
    return {
      playerList: this.avalon.config.playerList,
      kickPlayerDialog: false,
      playerToKick: "",
      playersBeingKicked: [] as string[]
    };
  },
  methods: {
    onReorderList() {
      this.avalon.config.sortList(this.playerList);
    },
    kickPlayerConfirm(player: string) {
      this.playerToKick = player;
      this.kickPlayerDialog = true;
    },
    kickPlayer(player: string) {
      this.kickPlayerDialog = false;
      this.playersBeingKicked.push(player);
      this.avalon.kickPlayer(player).finally(() =>
          this.playersBeingKicked.splice(
            this.playersBeingKicked.indexOf(player), 1
          )
        );
    }
  },
  watch: {
    "avalon.config.playerList": function(list: string[]) {
      this.playerList = list;
    }
  }
});
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>
</style>
