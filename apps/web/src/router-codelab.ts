import { createRouter, createWebHistory, useRoute } from 'vue-router';
import { defineComponent, defineAsyncComponent, h, type Component } from 'vue';
import { useSession } from './api';
import ProjectPageLoadError from './components/ProjectPageLoadError.vue';
// Vue Router resolves and caches this module before entering either project
// route. Keep the same loader for list/detail so navigation reuses the view.
const Projects = () => import('./views/Projects.vue').catch(() => ProjectPageLoadError);
import Tasks from './views/Tasks.vue';
import Task from './views/Task.vue';
import TaskEntry from './views/TaskEntry.vue';
import Report from './views/Report.vue';
import ReportV2 from './views/ReportV2.vue';
import Settings from './views/Settings.vue';
import Unavailable from './views/Unavailable.vue';
const Assignments = () => import('./views/Assignments.vue');
const AssignmentDetail = defineAsyncComponent(() => import('./views/AssignmentDetail.vue'));
const CourseTask = defineAsyncComponent(() => import('./views/CourseTask.vue'));
const CourseSubmission = defineAsyncComponent(() => import('./views/CourseSubmission.vue'));
// A task switch always gets fresh form, source and conversation state.
const isolatedCoursePage = (page: Component) => defineComponent({setup(){const route=useRoute();return ()=>h(page,{key:route.path});}});
// Normalize before createWebHistory captures its initial location.
if (location.hash.startsWith('#/')) {
  const target = location.hash.slice(1);
  if (!target.startsWith('//')) history.replaceState(null, '', target);
}
const businessPage = (legacy: Component, current: Component) => defineComponent({
  setup() {
    const session = useSession();
    return () => h(session.businessVersion === 2 ? current : legacy);
  },
});
// The workspace gates page mounting on the authenticated session.
export default createRouter({
  history: createWebHistory(),
  routes: [
    {path: '/', component: Tasks},
    {path: '/login', redirect: to => {
      const target = to.query.redirect;
      return typeof target === 'string' && target.startsWith('/') && !target.startsWith('//') && !target.startsWith('/login')
        ? target : '/projects';
    }},
    {path: '/projects', component: Projects},
    {path: '/projects/:id', component: Projects},
    {path: '/tasks', component: Tasks},
    {path: '/assignments', component: Assignments},
    {path: '/assignments/:id', component: isolatedCoursePage(AssignmentDetail)},
    {path: '/course-tasks/:id', component: isolatedCoursePage(CourseTask)},
    {path: '/course-submissions/:id', component: isolatedCoursePage(CourseSubmission)},
    {path: '/tasks/:id', component: businessPage(Task, TaskEntry)},
    {path: '/runs/:id', component: businessPage(Report, ReportV2)},
    {path: '/publications/:publicationId', component: ReportV2},
    {path: '/legacy/tasks/:id', component: Task},
    {path: '/legacy/runs/:id', component: Report},
    {path: '/teacher/tasks', redirect: '/tasks'},
    {path: '/teacher/students', redirect: '/tasks'},
    {path: '/student/courses', redirect: '/tasks'},
    // Prototype IDs cannot be treated as real task/run/publication IDs.
    {path: '/teacher/review/:id', component: Unavailable},
    {path: '/student/submit/:id', component: Unavailable},
    {path: '/student/report/:id', component: Unavailable},
    {path: '/teacher/analytics', component: Unavailable},
    {path: '/notifications', component: Unavailable},
    {path: '/settings', component: Settings},
    {path: '/welcome', component: () => import('./views/Landing.vue'), meta: { public: true }},
    {path: '/:pathMatch(.*)*', component: Unavailable},
  ],
});
