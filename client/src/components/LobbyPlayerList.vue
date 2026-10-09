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
        :item-key="(item: string) => item"
        @end="onReorderList()">
        <template #item="{element}">
          <v-list-item>
            <template v-slot:prepend>
              <v-icon v-if="canDrag" class="handle mr-2" icon="fa:fas fa-bars" />
              <v-icon v-if="element == avalon.lobby.admin.name" class="mr-2">$star</v-icon>
              <v-icon v-else-if="element == avalon.user.name" class="mr-2">$account</v-icon>
              <v-icon v-else class="mr-2">$accountOutline</v-icon>
            </template>
            <v-list-item-title>{{element}}</v-list-item-title>
            <template v-slot:append>
              <v-btn icon variant="text"
                v-if="(avalon.isAdmin && element != avalon.user.name && !avalon.isGameRunning)"
                :loading="playersBeingKicked.includes(element)"
                @click.stop="kickPlayerConfirm(element)"
                color="black"
                size="small">
                <v-icon>$close</v-icon>
              </v-btn>
            </template>
          </v-list-item>
        </template>
      </draggable>
    </v-list>

    <v-list v-if="avalon.isAdmin && avalon.lobby.requests.length" class="bg-amber-lighten-4 mt-2" data-testid="join-requests">
      <v-list-subheader>Asked to join with the lobby code</v-list-subheader>
      <v-list-item v-for="r in avalon.lobby.requests" :key="r.joinId" :data-testid="'join-request-' + r.name">
        <v-list-item-title>{{ r.name }}</v-list-item-title>
        <template v-slot:append>
          <v-btn size="small" color="green-darken-1" class="mr-1" @click="approve(r.joinId)" :data-testid="'admit-' + r.name">Admit</v-btn>
          <v-btn size="small" variant="text" @click="decline(r.joinId)" :data-testid="'decline-' + r.name">Decline</v-btn>
        </template>
      </v-list-item>
    </v-list>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import draggable from "vuedraggable";
import { useToast } from 'vue-toastification'

export default defineComponent({
  name: "LobbyPlayerList",
  components: {
    draggable
  },
  props: ["avalon"],
  setup() {
    const toast = useToast()
    return { toast }
  },
  computed: {
    canDrag(): boolean {
      return this.avalon.isAdmin && !this.avalon.isGameRunning;
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
    approve(joinId: string) {
      try {
        this.avalon.approveJoin(joinId);
      } catch (err) {
        this.toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    decline(joinId: string) {
      try {
        this.avalon.declineJoin(joinId);
      } catch (err) {
        this.toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    kickPlayerConfirm(player: string) {
      this.playerToKick = player;
      this.kickPlayerDialog = true;
    },
    kickPlayer(player: string) {
      this.kickPlayerDialog = false;
      this.playersBeingKicked.push(player);
      this.avalon.kickPlayer(player).catch((err: Error) => this.toast.error(err.message)).finally(() =>
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
