<template>
  <v-card v-if="visible" class="bg-amber-lighten-4 mb-2" data-testid="stall-notice">
    <v-card-text>
      <div v-if="!listBlockers">Waiting for devices...</div>
      <template v-else>
        <div>
          Waiting for <span class="font-weight-bold">{{ blockersText }}</span>
          ({{ elapsedText }}).
        </div>
        <div class="text-body-2">
          Ask {{ seats.joinWithAnd() }} to open Avalon{{ seats.length > 1 ? ' on their devices' : '' }}.
        </div>
        <div v-if="suggestCancel" class="text-body-2 pt-1">
          This has been blocked for a long time; you may want to cancel the game.
        </div>
      </template>
      <div class="d-flex flex-wrap ga-2 pt-2" v-if="showCancel || avalon.canAbandon || avalon.canTakeOver">
        <v-btn v-if="showCancel"
          :color="emphasizeCancel ? 'red-darken-2' : undefined"
          :variant="emphasizeCancel ? 'elevated' : 'outlined'"
          :disabled="avalon.cancelWouldForfeit"
          :loading="busy == 'cancel'"
          data-testid="stall-cancel"
          @click="run('cancel', () => avalon.cancelGame())">
          Cancel game
        </v-btn>
        <v-btn v-if="avalon.canAbandon" variant="outlined" :loading="busy == 'abandon'"
          data-testid="abandon-game" @click="run('abandon', () => avalon.abandonGame())">
          Abandon
        </v-btn>
        <v-btn v-if="avalon.canTakeOver" variant="outlined" :loading="busy == 'takeover'"
          data-testid="take-over" @click="run('takeover', () => avalon.takeOverAdmin())">
          Take over as admin
        </v-btn>
      </div>
      <div v-if="showCancel && avalon.cancelWouldForfeit" class="text-caption pt-1">
        Canceling now would forfeit: your device already counted this mission.
        <template v-if="avalon.canAbandon">Abandon stops waiting on this device without telling anyone.</template>
      </div>
    </v-card-text>
  </v-card>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { useToast } from 'vue-toastification'
import { UI_TIMERS } from '@/avalon'

// §7.8: who blocks a pending step, when to emphasize Cancel, Abandon and Take over.
export default defineComponent({
  name: 'StallNotice',
  props: [ 'avalon' ],
  setup() {
    const toast = useToast()
    return { toast }
  },
  data() {
    return {
      busy: '' as '' | 'cancel' | 'abandon' | 'takeover',
    };
  },
  computed: {
    visible(): boolean {
      return this.avalon.status.kind == 'STALLED' && this.avalon.isPlayer;
    },
    seats(): string[] {
      return this.avalon.stalledSeats;
    },
    listBlockers(): boolean {
      return this.avalon.stalledMs > UI_TIMERS.listBlockersMs;
    },
    blockersText(): string {
      const names: string[] = this.seats;
      return names.joinWithAnd() + (names.length == 1 ? "'s device" : "'s devices");
    },
    elapsedText(): string {
      const s = Math.floor(this.avalon.stalledMs / 1000);
      return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    },
    inShuffle(): boolean {
      const p = this.avalon.setupProgress;
      return !!p && p.stage == 'shuffle';
    },
    emphasizeCancel(): boolean {
      return this.avalon.stalledMs > (this.inShuffle ? UI_TIMERS.emphasizeCancelShuffleMs : UI_TIMERS.emphasizeCancelMs);
    },
    suggestCancel(): boolean {
      return this.avalon.stalledMs > UI_TIMERS.suggestCancelMs && !this.avalon.cancelWouldForfeit;
    },
    showCancel(): boolean {
      // no cancel during the assassination (§3.7 rule 6)
      return this.listBlockers && !(this.avalon.isGameInProgress && this.avalon.game.phase == 'ASSASSINATION');
    },
  },
  methods: {
    run(what: 'cancel' | 'abandon' | 'takeover', action: () => Promise<void>) {
      this.busy = what;
      action()
        .catch((err: Error) => this.toast.error(err.message))
        .finally(() => { this.busy = ''; });
    },
  },
})
</script>
