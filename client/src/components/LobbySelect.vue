<template>
  <v-container class="d-flex justify-center bg-cyan-lighten-5 lobby-select-container">
    <div class="d-flex flex-column align-center justify-center fill-height lobby-select-inner">
    <template v-if='!showLobbyInput'>
      <v-text-field
        label="Your Name" :model-value="name" @update:model-value="val => name = val.toUpperCase()" ref='nameTextField' :rules="nameRules" :error-messages='errorMsg' autofocus
        class="lobby-input">
      </v-text-field>
      <div class="d-flex flex-column ga-2 lobby-buttons">
        <v-btn
         :disabled='!nameValid' @click='createLobby()' :loading="isCreatingLobby" block>
          Create Lobby
        </v-btn>
        <v-btn :disabled='!nameValid || isCreatingLobby' @click='showLobbyInput = true' block>
          Join Lobby
        </v-btn>
      </div>
  </template>
   <template v-else>
    <v-text-field v-if='!nameValid'
      label="Your Name" :model-value="name" @update:model-value="val => name = val.toUpperCase()" :rules="nameRules"
      class="lobby-input">
    </v-text-field>
    <v-text-field ref="lobbyTextField" :model-value="lobby" @update:model-value="val => lobbyChanged(val)" label="Lobby"
      :error-messages='errorMsg' @keyup.enter="joinLobby()" maxlength="4" data-testid="lobby-code"
      :hint="inviteId ? 'Invite for lobby ' + lobby + ' · ' + inviteId.slice(0, 4).toUpperCase() : 'The 4-letter code shown in the lobby'"
      persistent-hint
      class="lobby-input"></v-text-field>
    <div v-if='candidates.length > 1' class="lobby-buttons pb-2" data-testid="lobby-chooser">
      <p class="text-body-2 pb-1">Several lobbies use the code {{ lobby }}. Check the code and fingerprint shown in the lobby you want:</p>
      <v-list class="bg-blue-grey-lighten-4" density="compact">
        <v-list-item v-for="c in candidates" :key="c.lobbyId" @click="joinCandidate(c)" :disabled="isJoiningLobby"
          :data-testid="'lobby-candidate-' + c.fingerprint">
          <v-list-item-title>{{ c.code }} · {{ c.fingerprint }} — admin {{ c.adminName }}</v-list-item-title>
          <v-list-item-subtitle>{{ c.members.joinWithAnd() }}</v-list-item-subtitle>
        </v-list-item>
      </v-list>
    </div>
    <p v-if='waitingForAdmin' class="text-body-2 pb-2" data-testid="waiting-for-admin">
      Waiting for {{ waitingForAdmin }} to admit you
    </p>
    <div class="d-flex flex-column ga-2 lobby-buttons">
      <v-btn :disabled='!validCode || !nameValid' @click='joinLobby()' :loading="isJoiningLobby" block>
        Join Lobby
      </v-btn>
      <v-btn @click='cancelJoin()' :disabled='isJoiningLobby' block>
        Cancel
      </v-btn>
    </div>
   </template>
  <div style='padding-top: 30px'></div>
  <StatsDisplay :stats='avalon.user.stats' :globalStats='avalon.globalStats'></StatsDisplay>
  </div>
  </v-container>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { ROLES } from '@avalon/common/avalonlib'
import StatsDisplay from './StatsDisplay.vue'
import type { LobbyCandidate } from '@/types'

// §4.1: CODE is 4 letters from this alphabet (no I, O, U)
const LOBBY_CODE_RE = /^[ABCDEFGHJKLMNPQRSTVWXYZ]{4}$/;

function readInvite(): { lobby: string; id: string } | null {
  const params = new URLSearchParams(window.location.search);
  const lobby = (params.get('lobby') ?? '').toUpperCase();
  if (!LOBBY_CODE_RE.test(lobby)) return null;
  const id = (params.get('id') ?? '').toLowerCase();
  return { lobby, id: /^[0-9a-f]{1,64}$/.test(id) ? id : '' };
}

export default defineComponent({
  name: 'LobbySelect',
  components: {
    StatsDisplay
  },
  data() {
    const invite = readInvite();
    return {
      name: this.avalon.user && this.avalon.user.name ? this.avalon.user.name : (this.avalon.preferredName || ''),
      lobby: invite ? invite.lobby : '',
      inviteId: invite ? invite.id : '',
      candidates: [] as LobbyCandidate[],
      waitingForAdmin: '',
      alertTimeoutTimer: null as ReturnType<typeof setTimeout> | null,
      errorMsg: '',
      showLobbyInput: !!invite,
      isJoiningLobby: false,
      isCreatingLobby: false
    };
  },
  props: {
    avalon: { type: Object, required: true }
  },
  computed: {
    nameRules() {
      const roleNames = ROLES.map(r => r.name);
      return [
        (v: string) => !!v || 'Name is required',
        (v: string) => /^[A-Z]+$/.test(v) || 'Name must contain only letters (A-Z)',
        (v: string) => v.length <= 20 || 'Name must be 20 characters or fewer',
        (v: string) => !roleNames.includes(v) || 'Name cannot be a role name',
      ];
    },
    nameValid(): boolean {
      return this.nameRules.every(rule => rule(this.name) === true);
    },
    validCode(): boolean {
      return LOBBY_CODE_RE.test(this.lobby);
    }
  },
  methods: {
    lobbyChanged(val: string) {
      const code = val.toUpperCase();
      if (code != this.lobby) {
        this.candidates = [];
        if (this.inviteId && code != readInvite()?.lobby) this.inviteId = '';
      }
      this.lobby = code;
    },
    createLobby() {
      this.isCreatingLobby = true;
      this.avalon.createLobby(this.name)
        .catch((err: Error) => this.showErrorMessage(err))
        .finally(() => this.isCreatingLobby = false);
    },
    async joinLobby() {
      if (!this.validCode || this.isJoiningLobby) return;
      this.isJoiningLobby = true;
      this.candidates = [];
      try {
        const code = this.lobby;
        let found: LobbyCandidate[] = await this.avalon.findLobbies(code);
        if (this.inviteId) {
          found = found.filter(c => c.lobbyId.startsWith(this.inviteId));
        }
        if (found.length == 0) {
          throw new Error(`Lobby ${code} not found`);
        }
        if (found.length > 1) {
          // never pick silently (§4.3)
          this.candidates = found;
          return;
        }
        await this.join(found[0]);
      } catch (err) {
        this.showErrorMessage(err instanceof Error ? err : String(err));
      } finally {
        this.isJoiningLobby = false;
      }
    },
    async joinCandidate(candidate: LobbyCandidate) {
      if (this.isJoiningLobby) return;
      this.isJoiningLobby = true;
      try {
        await this.join(candidate);
      } catch (err) {
        this.showErrorMessage(err instanceof Error ? err : String(err));
      } finally {
        this.isJoiningLobby = false;
      }
    },
    async join(candidate: LobbyCandidate) {
      this.waitingForAdmin = candidate.adminName;
      try {
        await this.avalon.joinLobby(this.name, candidate.code, candidate.lobbyId);
        if (readInvite()) {
          // strip the invite from the URL once used
          window.history.replaceState(null, '', window.location.pathname);
        }
      } finally {
        this.waitingForAdmin = '';
      }
    },
    cancelJoin() {
      this.candidates = [];
      this.showLobbyInput = false;
    },
    showErrorMessage(errMsg: Error | string) {
      if (this.alertTimeoutTimer != null) {
        clearTimeout(this.alertTimeoutTimer);
      }
      this.errorMsg = errMsg instanceof Error ? errMsg.message : errMsg;
      this.alertTimeoutTimer = setTimeout(() => {
        this.alertTimeoutTimer = null;
        this.errorMsg = '';
      }, 5000);
    },
    setInputWidth(field: string) {
      const size = 20;
      const ref = (this.$refs as Record<string, { $el?: HTMLElement }>)[field];
      if (ref && ref.$el) {
        const input = ref.$el.querySelector('input');
        if (input) input.setAttribute('size', size.toString());
      }
    }
  },
  mounted: function() {
    this.setInputWidth('nameTextField');
    document.title = 'Avalon - ' + (this.name ? this.name : 'Choose a name');
  },
  beforeUnmount: function() {
    if (this.alertTimeoutTimer != null) {
      clearTimeout(this.alertTimeoutTimer);
      this.alertTimeoutTimer = null;
    }
  },
  watch: {
    showLobbyInput: function() {
      let textField = 'lobbyTextField';
      if (!this.showLobbyInput) {
        textField = 'nameTextField';
      }
      this.$nextTick(() => {
        const ref = (this.$refs as Record<string, { $el?: HTMLElement }>)[textField];
        if (ref && ref.$el) {
          const input = ref.$el.querySelector('input');
          if (input) {
            input.focus();
            input.setAttribute('size', '20');
          }
        }
      });
    }
  }
})
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>
.lobby-select-container {
  padding: 12px;
}

.lobby-select-inner {
  width: 100%;
  max-width: 450px;
}

.lobby-input {
  width: 100%;
}

.lobby-input :deep(input) {
  text-transform: uppercase;
}

.lobby-buttons {
  width: 100%;
}

@media (min-width: 600px) {
  .lobby-select-container {
    padding: 16px;
  }
}
</style>
