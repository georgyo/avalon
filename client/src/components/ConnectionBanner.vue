<template>
  <div class="connection-banner" data-testid="connection-banner" v-if="banner">
    <v-alert :type="banner.type" density="compact" variant="flat" rounded="0" :icon="banner.icon">
      <div class="d-flex flex-wrap align-center ga-2">
        <span :data-testid="'banner-' + banner.id">{{ banner.text }}</span>
        <v-progress-linear v-if="banner.percent != null" :model-value="banner.percent" color="white" height="6"
          rounded class="banner-progress" />
        <v-spacer></v-spacer>
        <v-btn v-if="banner.id == 'read-only'" size="small" variant="outlined" :loading="busy"
          data-testid="use-here" @click="run(() => avalon.useHere())">
          Use here
        </v-btn>
        <v-btn v-if="banner.id == 'lost-secrets' && avalon.isInLobby" size="small" variant="outlined" :loading="busy"
          data-testid="lost-cancel" @click="run(() => avalon.cancelGame())">
          Cancel game
        </v-btn>
      </div>
    </v-alert>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { useToast } from 'vue-toastification'
import { UI_TIMERS } from '@/avalon'

interface Banner {
  id: string;
  type: 'info' | 'warning' | 'error' | 'success';
  icon: string;
  text: string;
  percent?: number;
}

// docs/p2p-protocol.md §7.8: connection and session states that concern the whole page.
export default defineComponent({
  name: 'ConnectionBanner',
  props: [ 'avalon' ],
  setup() {
    const toast = useToast()
    return { toast }
  },
  data() {
    return { busy: false };
  },
  computed: {
    banner(): Banner | null {
      const status = this.avalon.status;
      if (status.kind == 'READ_ONLY_OTHER_TAB') {
        return { id: 'read-only', type: 'info', icon: 'mdi-tab', text: 'Avalon is open in another tab' };
      }
      if (status.kind == 'LOST_SECRETS') {
        return { id: 'lost-secrets', type: 'error', icon: 'mdi-key-remove',
                 text: 'This browser lost the secret keys for this game; it cannot continue' };
      }
      const down: number = this.avalon.disconnectedMs;
      if (down > UI_TIMERS.offlineMs) {
        return { id: 'offline', type: 'warning', icon: 'mdi-wifi-off',
                 text: 'Offline - your moves are saved and will be sent when reconnected' };
      }
      if (down > UI_TIMERS.reconnectingMs) {
        return { id: 'reconnecting', type: 'warning', icon: 'mdi-wifi-strength-alert-outline', text: 'Reconnecting...' };
      }
      if (status.kind == 'CONNECTING') {
        return { id: 'connecting', type: 'info', icon: 'mdi-lan-pending', text: 'Connecting...' };
      }
      if (status.kind == 'SYNCING') {
        return { id: 'syncing', type: 'info', icon: 'mdi-sync', text: `Syncing game data ${status.percent}%`,
                 percent: status.percent };
      }
      if (status.kind == 'ENDING' && this.avalon.isInLobby) {
        return { id: 'ending', type: 'info', icon: 'mdi-flag-checkered',
                 text: `Game over - revealing roles (${status.revealed}/${status.total} devices)`,
                 percent: status.total ? Math.round(100 * status.revealed / status.total) : 0 };
      }
      return null;
    },
  },
  methods: {
    run(action: () => Promise<void>) {
      this.busy = true;
      action()
        .catch((err: Error) => this.toast.error(err.message))
        .finally(() => { this.busy = false; });
    },
  },
})
</script>

<style scoped>
.connection-banner {
  width: 100%;
}

.banner-progress {
  max-width: 200px;
}
</style>
