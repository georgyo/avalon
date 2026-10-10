<template>
  <v-card class="bg-blue-grey-lighten-4">
    <v-card-title>
      Assassination Attempt
     </v-card-title>
     <v-card-text class="bg-light-blue-lighten-4">
      <div v-if='avalon.lobby.role.assassin'>
        <v-btn
         v-bind:disabled='!isValidSelection'
         v-bind:loading='isAssassinating'
         @click='assassinate()'>
                {{ assassinateButtonText }}
        </v-btn>
       </div>
       <div v-else>
           Waiting for target selection
       </div>
     </v-card-text>
  </v-card>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { useToast } from 'vue-toastification'

export default defineComponent({
  name: 'AssassinationAction',
  props: [ 'avalon', 'playerList' ],
  setup() {
    const toast = useToast()
    return { toast }
  },
  data() {
      return {
          isAssassinating: false
      }
  },
  methods: {
      assassinate() {
        this.isAssassinating = true;
        this.avalon.assassinate(this.playerList[0]).catch((err: Error) => {
          this.toast.error(err.message);
          this.isAssassinating = false;
        });
      }
  },
  computed: {
    isValidSelection(): boolean {
        return (this.playerList.length == 1) &&
                (this.playerList[0] != this.avalon.user.name);
    },
    assassinateButtonText(): string {
        if (this.isValidSelection) {
            return "Assassinate " + this.playerList[0];
        } else {
            return "Select target"
        }
    }
  }
})
</script>
<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>

</style>
