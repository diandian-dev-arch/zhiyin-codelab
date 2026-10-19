import './browser-crypto';
import { createApp, defineComponent, h, type Component } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import Tasks from "./views/Tasks.vue";
import Task from "./views/Task.vue";
import Report from "./views/Report.vue";
import TaskEntry from "./views/TaskEntry.vue";
import ReportV2 from "./views/ReportV2.vue";
import Projects from './views/Projects.vue';
import { useSession } from "./api";
import { spotlight } from "./directives/spotlight";
import { reveal } from "./directives/reveal";
import "./style.css";
import '../tokens.css';
import './styles/studio.css';
import './styles/motion.css';
import './styles/manuscript.css';
const businessPage = (legacy: Component, current: Component) =>
  defineComponent({
    setup() {
      const session = useSession();
      return () => h(session.businessVersion === 2 ? current : legacy);
    },
  });
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/projects', component: Projects },
    { path: '/projects/:id', component: Projects },
    { path: "/", component: Tasks },
    { path: "/tasks", component: Tasks },
    { path: "/tasks/:id", component: businessPage(Task, TaskEntry) },
    { path: "/runs/:id", component: businessPage(Report, ReportV2) },
    { path: "/publications/:publicationId", component: ReportV2 },
    { path: "/legacy/tasks/:id", component: Task },
    { path: "/legacy/runs/:id", component: Report },
  ],
});
createApp(App).use(createPinia()).use(router).directive("spotlight", spotlight).directive("reveal", reveal).mount("#app");
