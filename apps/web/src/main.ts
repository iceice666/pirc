// The design's three typefaces, self-hosted (OFL) and weight-variable, so no
// request goes to fonts.gstatic.com. Noto Sans TC covers Chinese on machines
// without PingFang; the browser fetches only the unicode-range slices it needs.
import '@fontsource-variable/ibm-plex-sans/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@fontsource-variable/noto-sans-tc/wght.css';
import './app.css';
import './markdown.css';
import App from './App.svelte';
import { mount } from 'svelte';
import { initLocale } from './lib/i18n';

initLocale();

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
