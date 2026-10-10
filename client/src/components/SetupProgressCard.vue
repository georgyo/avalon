<template>
  <v-card class="bg-blue-grey-lighten-4 setup-card" data-testid="setup-progress">
    <v-card-text class="text-center">
      <div class="text-subtitle-1 font-weight-medium">Dealing the cards</div>
      <div data-testid="setup-progress-text">{{ progressText }}</div>
      <v-progress-linear class="mt-2" color="indigo-darken-2" height="8" rounded :model-value="percent" />
      <div class="text-caption pt-2">
        Every device takes part in shuffling and dealing, so nobody (not even the server) knows the roles.
      </div>
      <v-btn v-if="canAbort" class="mt-3" variant="outlined" color="red-darken-2" :loading="aborting"
        data-testid="abort-start" @click="abortStart()">
        Abort start
      </v-btn>
    </v-card-text>
  </v-card>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { useToast } from 'vue-toastification'
import { UI_TIMERS } from '@/avalon'
import type { SetupProgress } from '@/types'

const STAGE_LABELS: Record<SetupProgress['stage'], string> = {
  keys: 'Exchanging keys',
  shuffle: 'Shuffling',
  deal: 'Dealing',
  sight: 'Exchanging what each player sees',
};
const STAGE_ORDER: SetupProgress['stage'][] = ['keys', 'shuffle', 'deal', 'sight'];

export default defineComponent({
  name: 'SetupProgressCard',
  props: [ 'avalon' ],
  setup() {
    const toast = useToast()
    return { toast }
  },
  data() {
    return { aborting: false };
  },
  computed: {
    progress(): SetupProgress | null {
      return this.avalon.setupProgress;
    },
    progressText(): string {
      const p = this.progress;
      if (!p) return 'Starting...';
      // "Shuffling 3/7 - waiting for BOB's device" (§11.3)
      let text = `${STAGE_LABELS[p.stage]} ${p.done}/${p.total}`;
      if (p.waitingFor.length) {
        text += ' - waiting for ' + p.waitingFor.joinWithAnd() + (p.waitingFor.length == 1 ? "'s device" : "'s devices");
      }
      return text;
    },
    percent(): number {
      const p = this.progress;
      if (!p || p.total == 0) return 0;
      const stage = STAGE_ORDER.indexOf(p.stage);
      return Math.round(100 * (stage + p.done / p.total) / STAGE_ORDER.length);
    },
    canAbort(): boolean {
      // §4.6 item 3 / §7.8: key incomplete after 30 s, admin only
      const p = this.progress;
      return this.avalon.isAdmin && !!p && p.stage == 'keys' && this.avalon.setupStageMs > UI_TIMERS.abortStartMs;
    },
  },
  methods: {
    abortStart() {
      this.aborting = true;
      this.avalon.cancelGame()
        .catch((err: Error) => this.toast.error(err.message))
        .finally(() => { this.aborting = false; });
    },
  },
})
</script>

<style scoped>
.setup-card {
  max-width: 520px;
  width: 100%;
}
</style>
