<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';

const paperBg = ref<HTMLDivElement>();
let mouseX = 50;
let mouseY = 50;
let targetX = 50;
let targetY = 50;
let animationFrame: number;
let motionPreference: MediaQueryList;
function syncMotion() {
  cancelAnimationFrame(animationFrame);
  document.removeEventListener('mousemove', handleMouseMove);
  if (!motionPreference.matches) {
    document.addEventListener('mousemove', handleMouseMove);
    animationFrame = requestAnimationFrame(updateBackground);
  }
}

function handleMouseMove(e: MouseEvent) {
  targetX = (e.clientX / window.innerWidth) * 100;
  targetY = (e.clientY / window.innerHeight) * 100;

  const offsetX = (e.clientX / window.innerWidth - 0.5) * 60;
  const offsetY = (e.clientY / window.innerHeight - 0.5) * 60;

  if (paperBg.value) {
    paperBg.value.style.backgroundPosition = `
      ${offsetX * 1.2}px ${offsetY * 1.2}px,
      ${-offsetX * 1.2}px ${-offsetY * 1.2}px,
      ${offsetX * 0.3}px ${offsetY * 0.3}px,
      ${-offsetX * 0.3}px ${-offsetY * 0.3}px,
      0 0, 0 0, 0 0
    `;
  }
}

function updateBackground() {
  mouseX += (targetX - mouseX) * 0.15;
  mouseY += (targetY - mouseY) * 0.15;

  if (paperBg.value) {
    paperBg.value.style.setProperty('--mouse-x', `${mouseX}%`);
    paperBg.value.style.setProperty('--mouse-y', `${mouseY}%`);
  }

  animationFrame = requestAnimationFrame(updateBackground);
}

onMounted(() => {
  motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  motionPreference.addEventListener('change', syncMotion);
  syncMotion();
});

onUnmounted(() => {
  motionPreference?.removeEventListener('change', syncMotion);
  document.removeEventListener('mousemove', handleMouseMove);
  cancelAnimationFrame(animationFrame);
});
</script>

<template>
  <div ref="paperBg" class="paper-bg"></div>
</template>

<style scoped>
.paper-bg {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background:
    linear-gradient(45deg, transparent 48%, rgba(0,0,0,0.025) 49%, rgba(0,0,0,0.025) 51%, transparent 52%),
    linear-gradient(-45deg, transparent 48%, rgba(0,0,0,0.025) 49%, rgba(0,0,0,0.025) 51%, transparent 52%),
    repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.006) 2px, rgba(0,0,0,0.006) 3px),
    repeating-linear-gradient(90deg, transparent, transparent 2px, rgba(0,0,0,0.006) 2px, rgba(0,0,0,0.006) 3px),
    radial-gradient(circle 500px at var(--mouse-x, 50%) var(--mouse-y, 50%),
      rgba(255, 215, 100, 0.08) 0%, rgba(255, 235, 150, 0.04) 30%, transparent 60%),
    radial-gradient(ellipse 1000px 800px at var(--mouse-x, 50%) var(--mouse-y, 50%),
      rgba(255, 250, 230, 0.25) 0%, transparent 50%),
    linear-gradient(135deg, #fdfbf7 0%, #f9f5ed 50%, #faf7f1 100%);
  background-size: 30px 30px, 30px 30px, 100% 100%, 100% 100%, 100% 100%, 100% 100%, 100% 100%;
  z-index: 0;
  pointer-events: none;
}
</style>
