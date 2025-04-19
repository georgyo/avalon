import { createApp } from 'vue';
import App from './App.vue';

import { createVuetify } from 'vuetify';
import 'vuetify/styles';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import '@mdi/font/css/materialdesignicons.css';

import { library } from '@fortawesome/fontawesome-svg-core';
import { FontAwesomeIcon, FontAwesomeLayers, FontAwesomeLayersText } from '@fortawesome/vue-fontawesome';
import '@fortawesome/fontawesome-free/css/all.min.css';

// importing icons we need for layering and manipulations
import { faCrown, faCircle as faSolidCircle, faEllipsisH, faVoteYea } from '@fortawesome/free-solid-svg-icons';
import { faCircle, faTimesCircle, faCheckCircle, faThumbsUp, faThumbsDown } from '@fortawesome/free-regular-svg-icons';

// register FontAwesome components
library.add(
  faCrown, faSolidCircle, faCircle,
  faTimesCircle, faCheckCircle, faThumbsDown, faThumbsUp,
  faEllipsisH, faVoteYea
);

import Toast from 'vue-toastification';
import 'vue-toastification/dist/index.css';

import mitt from 'mitt';
export const EventBus = mitt();

const vuetify = createVuetify({
  components,
  directives,
  icons: { defaultSet: 'mdi' },
});

const app = createApp(App);

app.use(vuetify);
app.use(Toast, { position: 'top-center', fullWidth: true, duration: 2000 });

app.component('FontAwesomeIcon', FontAwesomeIcon);
app.component('FontAwesomeLayers', FontAwesomeLayers);
app.component('FontAwesomeLayersText', FontAwesomeLayersText);

app.mount('#app');