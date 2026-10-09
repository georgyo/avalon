<template>
  <v-toolbar class='bg-blue-darken-1'>
    <template v-if="avalon.lobby && avalon.lobby.name && avalon.user && avalon.user.name">
    <v-icon start>
      mdi-map-marker
    </v-icon>
     <span class="font-weight-bold text-cyan-lighten-5">{{ avalon.lobby.name }}</span>
     <v-tooltip location="bottom" v-if="avalon.lobby.fingerprint">
       <template v-slot:activator="{ props }">
         <span v-bind="props" class="text-cyan-lighten-4 ml-1 lobby-fingerprint" data-testid="lobby-fingerprint">· {{ avalon.lobby.fingerprint }}</span>
       </template>
       <span>Lobby fingerprint: check that everyone at the table sees {{ avalon.lobby.name }} · {{ avalon.lobby.fingerprint }}</span>
     </v-tooltip>
     <v-btn icon size="small" variant="text" class="ml-1" @click="copyInvite()" data-testid="copy-invite">
       <v-icon size="small">mdi-link-variant</v-icon>
       <v-tooltip activator="parent" location="bottom">Copy invite link</v-tooltip>
     </v-btn>
    <v-spacer></v-spacer>
    <ViewRoleButton :avalon='avalon'></ViewRoleButton>
    <v-spacer></v-spacer>
    <ToolbarQuitButton :avalon='avalon'></ToolbarQuitButton>
    </template>
    <template v-else>
      <v-icon start>mdi-account-circle</v-icon>
      <span class="toolbar-user">{{ avalon.user.name || 'Anonymous player' }}</span>
      <v-spacer></v-spacer>
      <LogoutButton :avalon='avalon' />
    </template>
  </v-toolbar>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { useToast } from 'vue-toastification'
import ToolbarQuitButton from './ToolbarQuitButton.vue';
import ViewRoleButton from './ViewRoleButton.vue'
import LogoutButton from './LogoutButton.vue'

export default defineComponent({
  name: 'GameToolbar',
  components: {
    ToolbarQuitButton,
    ViewRoleButton,
    LogoutButton
  },
  props: [ 'avalon' ],
  setup() {
    const toast = useToast()
    return { toast }
  },
  methods: {
    copyInvite() {
      const link: string = this.avalon.lobby.inviteLink;
      const done = () => this.toast('Invite link copied: ' + link);
      if (navigator.clipboard) {
        navigator.clipboard.writeText(link).then(done).catch(() => this.toast(link, { timeout: 8000 }));
      } else {
        this.toast(link, { timeout: 8000 });
      }
    }
  }
 })
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>
.toolbar-user {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}

.lobby-fingerprint {
  white-space: nowrap;
}

@media (max-width: 599px) {
  .toolbar-user {
    max-width: 150px;
    font-size: 0.85rem;
  }
  .lobby-fingerprint {
    font-size: 0.8rem;
  }
}
</style>
