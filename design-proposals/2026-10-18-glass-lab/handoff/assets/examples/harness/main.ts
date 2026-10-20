// Glass Lab 参考实现运行壳：#/ 首页首屏与证据树，#/login 登录场景
import { createApp, defineComponent, h, ref } from "vue";
import "../../src/styles/glass/tokens.css";
import "../../src/styles/glass/base.css";
import "../../src/styles/glass/motion.css";
import "../../src/styles/glass/components.css";
import { GlassLab } from "../../src/glass";
import GlAmbient from "../../src/components/glass/GlAmbient.vue";
import GlThemeSwitcher from "../../src/components/glass/GlThemeSwitcher.vue";
import LandingHero from "../LandingHero.vue";
import LoginScene from "../LoginScene.vue";

const Root = defineComponent(() => {
  const route = ref(location.hash);
  addEventListener("hashchange", () => (route.value = location.hash));
  const busy = ref(false);
  const onSubmit = () => {
    busy.value = true;
    setTimeout(() => (busy.value = false), 1400);
  };
  return () => [
    h(GlAmbient, { calm: false }),
    route.value.startsWith("#/login") ? h(LoginScene, { busy: busy.value, onSubmit }) : h(LandingHero),
    h("div", { class: "gl-glass", style: "position:fixed;right:20px;bottom:20px;z-index:90;padding:6px;border-radius:999px" }, [
      h(GlThemeSwitcher),
    ]),
  ];
});

createApp(Root).use(GlassLab).mount("#app");
