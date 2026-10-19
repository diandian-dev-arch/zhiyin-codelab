import './browser-crypto';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import AppCodeLab from './AppCodeLab.vue';
import router from './router-codelab';
import { spotlight } from './directives/spotlight';
import { reveal } from './directives/reveal';
import './style.css';
import './styles/glass/tokens.css';
import '../tokens.css';
import './styles/studio.css';
// Studio 2.0 elevation and motion layer; loaded last so it refines, never replaces, the base.
import './styles/motion.css';
// 雾港手稿 skin: paper grain, serif hierarchy, hairlines. Loaded last.
import './styles/manuscript.css';
import './styles/coursework.css';
import './styles/glass/base.css';
import './styles/glass/motion.css';
import './styles/glass/components.css';
import './styles/glass/legacy-skin.css';
import './styles/glass/coursework.css';
import './styles/glass/search.css';
import './styles/glass/workspace-finish.css';
import { GlassLab } from './glass';


const app = createApp(AppCodeLab);
const pinia = createPinia();

app.use(pinia);
app.use(GlassLab);
app.use(router);
app.directive('spotlight', spotlight);
app.directive('reveal', reveal);

app.mount('#app');
