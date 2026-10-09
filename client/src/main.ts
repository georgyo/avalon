import { createApp } from 'vue'
import { createVuetify } from 'vuetify'
import 'vuetify/styles'
import { fa } from 'vuetify/iconsets/fa-svg'
import { aliases, mdi } from 'vuetify/iconsets/mdi-svg'
import App from './App.vue'
import Toast from 'vue-toastification'
import 'vue-toastification/dist/index.css'
// Self-hosted Roboto (the weights Vuetify uses): no third-party font request (§9).
import '@fontsource/roboto/300.css'
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
import '@fontsource/roboto/700.css'
import { appIcons } from './icons'
import { library } from '@fortawesome/fontawesome-svg-core'
import { FontAwesomeIcon, FontAwesomeLayers, FontAwesomeLayersText } from '@fortawesome/vue-fontawesome'

// importing icons used by <font-awesome-icon> and <v-icon icon="fa:...">
import {
  faCrown, faCircle as faSolidCircle, faEllipsisH, faVoteYea,
  faCheckCircle as faSolidCheckCircle, faTimesCircle as faSolidTimesCircle,
  faEnvelopeSquare, faBars, faHammer, faTrophy,
} from '@fortawesome/free-solid-svg-icons'
import { faCircle, faTimesCircle, faCheckCircle, faThumbsUp, faThumbsDown } from '@fortawesome/free-regular-svg-icons'
import { faOldRepublic, faEmpire } from '@fortawesome/free-brands-svg-icons'

library.add(faCrown, faSolidCircle, faCircle,
  faTimesCircle, faCheckCircle, faThumbsDown, faThumbsUp,
  faEllipsisH, faVoteYea, faOldRepublic, faEmpire,
  faSolidCheckCircle, faSolidTimesCircle, faEnvelopeSquare, faBars, faHammer, faTrophy);

const vuetify = createVuetify({
  icons: {
    defaultSet: 'mdi',
    // Vuetify's own aliases plus the app's icons ($star, $play, ...), all SVG paths from @mdi/js.
    aliases: { ...aliases, ...appIcons },
    sets: {
      mdi,
      fa,
    },
  },
  theme: {
    defaultTheme: 'light',
  },
})

const app = createApp(App)

app.use(vuetify)

app.use(Toast, {
  position: 'top-center',
  timeout: 2000,
  maxToasts: 3,
})

app.component('font-awesome-icon', FontAwesomeIcon)
app.component('font-awesome-layers', FontAwesomeLayers)
app.component('font-awesome-layers-text', FontAwesomeLayersText)

app.mount('#app')
