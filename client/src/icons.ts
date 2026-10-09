/**
 * The Material Design icons the app uses, as SVG paths (Vuetify's `mdi-svg` iconset): only these are
 * bundled, instead of the whole @mdi/font stylesheet and webfont. Templates refer to them as `$name`.
 */
import {
  mdiAccount, mdiAccountCircle, mdiAccountOutline, mdiClose, mdiExitToApp, mdiFlagCheckered, mdiInformation, mdiKeyRemove,
  mdiLanPending, mdiLinkVariant, mdiMapMarker, mdiPlay, mdiStar, mdiSync, mdiTab, mdiWifiOff, mdiWifiStrengthAlertOutline,
} from '@mdi/js'

export const appIcons = {
  account: mdiAccount,
  accountCircle: mdiAccountCircle,
  accountOutline: mdiAccountOutline,
  close: mdiClose,
  exitToApp: mdiExitToApp,
  flagCheckered: mdiFlagCheckered,
  information: mdiInformation,
  keyRemove: mdiKeyRemove,
  lanPending: mdiLanPending,
  linkVariant: mdiLinkVariant,
  mapMarker: mdiMapMarker,
  play: mdiPlay,
  star: mdiStar,
  sync: mdiSync,
  tab: mdiTab,
  wifiOff: mdiWifiOff,
  wifiStrengthAlertOutline: mdiWifiStrengthAlertOutline,
}
