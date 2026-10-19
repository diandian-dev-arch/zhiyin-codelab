import { mix, rgba, type Palette, type RGB } from './theme';

const TAU = Math.PI * 2;

/** Login-only optical treatment; the shared showcase keeps its evidence radar. */
export function drawGlassOrb(
  ctx: CanvasRenderingContext2D, pal: Palette, x: number, y: number,
  radius: number, time: number, accent: RGB, pulse: number,
): void {
  const r = radius * (0.87 + Math.sin(time * 0.32) * 0.008 + pulse * 0.018);
  const warm = mix(accent, pal.c4, 0.28);
  const cool = mix(pal.c5, pal.c2, 0.32);
  const pearl = mix(pal.c3, pal.text, 0.55);
  ctx.save();
  ctx.translate(
    x + Math.sin(time * 0.19) * radius * 0.035,
    y + Math.sin(time * 0.38) * radius * 0.1,
  );

  // Back and front halves share one projection, so the shell occludes the orbit.
  function orbit(front: boolean, index: number) {
    ctx.save();
    ctx.rotate(index === 0 ? -0.42 : 0.83);
    const rx = r * (index === 0 ? 1.58 : 1.31), ry = r * (index === 0 ? 0.48 : 0.63);
    const tint = index === 0 ? warm : cool;
    const gradient = ctx.createLinearGradient(-rx, 0, rx, 0);
    gradient.addColorStop(0, rgba(tint, front ? 0.08 : 0.04));
    gradient.addColorStop(0.38, rgba(tint, front ? 0.62 : 0.17));
    gradient.addColorStop(0.7, rgba(pearl, front ? 0.72 : 0.21));
    gradient.addColorStop(1, rgba(tint, front ? 0.12 : 0.04));
    ctx.strokeStyle = gradient;
    ctx.lineWidth = front ? 1.15 : 0.75;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, front ? 0 : Math.PI, front ? Math.PI : TAU);
    ctx.stroke();
    const angle = time * (index === 0 ? 0.13 : -0.09) + index * 2.1;
    if ((Math.sin(angle) >= 0) === front) {
      const px = Math.cos(angle) * rx, py = Math.sin(angle) * ry;
      const glow = ctx.createRadialGradient(px, py, 0, px, py, 9);
      glow.addColorStop(0, rgba(pearl, 0.65));
      glow.addColorStop(0.25, rgba(tint, 0.28));
      glow.addColorStop(1, rgba(tint, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(px - 9, py - 9, 18, 18);
      ctx.fillStyle = rgba(pearl, 0.9);
      ctx.beginPath(); ctx.arc(px, py, 1.6, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }
  orbit(false, 0); orbit(false, 1);

  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.clip();
  const ground = ctx.createLinearGradient(-r, -r, r, r);
  ground.addColorStop(0, rgba(mix(pal.surface, cool, 0.42), 0.97));
  ground.addColorStop(0.46, rgba(mix(pal.surface, warm, 0.24), 0.97));
  ground.addColorStop(1, rgba(mix(pal.bg, cool, 0.18), 1));
  ctx.fillStyle = ground; ctx.fillRect(-r, -r, r * 2, r * 2);

  const drift = Math.sin(time * 0.17), turn = Math.cos(time * 0.13);
  function reflection(px: number, py: number, size: number, tint: RGB, opacity: number) {
    const g = ctx.createRadialGradient(px, py, 0, px, py, size);
    g.addColorStop(0, rgba(tint, opacity));
    g.addColorStop(0.42, rgba(tint, opacity * 0.65));
    g.addColorStop(1, rgba(tint, 0));
    ctx.fillStyle = g; ctx.fillRect(-r, -r, r * 2, r * 2);
  }
  reflection(-r * 0.4, -r * 0.46, r * 1.22, cool, 0.76);
  reflection(r * (0.28 + drift * 0.09), r * 0.25, r * 1.05, warm, 0.85);
  reflection(-r * 0.36, r * 0.63, r * 0.82, pal.c2, 0.42);
  reflection(r * 0.69, -r * 0.21, r * 0.54, pal.c4, 0.46);

  // Quiet caustic ribbons stay inside the globe, with no expensive pixel shader.
  ctx.save(); ctx.rotate(-0.56 + drift * 0.07);
  for (let i = 0; i < 4; i++) {
    const offset = (i - 1.5) * r * 0.2 + turn * r * 0.07;
    const ribbon = ctx.createLinearGradient(-r, 0, r, 0);
    ribbon.addColorStop(0, rgba(cool, 0));
    ribbon.addColorStop(0.35, rgba(cool, 0.09));
    ribbon.addColorStop(0.62, rgba(pearl, 0.16 - i * 0.025));
    ribbon.addColorStop(1, rgba(warm, 0));
    ctx.strokeStyle = ribbon; ctx.lineWidth = r * (0.06 + i * 0.013);
    ctx.beginPath(); ctx.moveTo(-r * 1.2, offset - r * 0.32);
    ctx.bezierCurveTo(-r * 0.3, offset + r * 0.62, r * 0.2, offset - r * 0.6, r * 1.2, offset + r * 0.28);
    ctx.stroke();
  }
  ctx.restore();

  const shade = ctx.createRadialGradient(-r * 0.28, -r * 0.38, r * 0.08, 0, 0, r);
  shade.addColorStop(0, rgba(pearl, 0.36));
  shade.addColorStop(0.38, rgba(pearl, 0.045));
  shade.addColorStop(0.68, rgba(pal.bg, 0.06));
  shade.addColorStop(0.92, rgba(pal.bg, 0.54));
  shade.addColorStop(1, rgba(cool, 0.22));
  ctx.fillStyle = shade; ctx.fillRect(-r, -r, r * 2, r * 2);

  ctx.save(); ctx.translate(-r * 0.24, -r * 0.48); ctx.rotate(-0.48); ctx.scale(1, 0.38);
  const glint = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.52);
  glint.addColorStop(0, rgba(pearl, 0.72));
  glint.addColorStop(0.24, rgba(pearl, 0.27));
  glint.addColorStop(1, rgba(pearl, 0));
  ctx.fillStyle = glint; ctx.fillRect(-r, -r, r * 2, r * 2); ctx.restore();
  ctx.restore();

  const edge = ctx.createLinearGradient(-r, -r, r, r);
  edge.addColorStop(0, rgba(pearl, 0.68));
  edge.addColorStop(0.32, rgba(cool, 0.24));
  edge.addColorStop(0.58, rgba(warm, 0.08));
  edge.addColorStop(0.85, rgba(warm, 0.5));
  edge.addColorStop(1, rgba(pearl, 0.36));
  ctx.strokeStyle = edge; ctx.lineWidth = 1.25;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();
  ctx.strokeStyle = rgba(pearl, 0.3); ctx.lineWidth = 0.7;
  ctx.beginPath(); ctx.arc(0, 0, r * 0.965, Math.PI * 1.06, Math.PI * 1.56); ctx.stroke();
  orbit(true, 1); orbit(true, 0);
  ctx.restore();
}
