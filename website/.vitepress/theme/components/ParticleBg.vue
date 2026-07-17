<template>
  <canvas ref="canvas" class="starfield-canvas" aria-hidden="true"></canvas>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'

const canvas = ref<HTMLCanvasElement>()

const LAYERS = [
  { count: 700, speed: 0.06, minR: 0.3, maxR: 0.8, alpha: 0.80, twinkle: false },
  { count: 200, speed: 0.15, minR: 0.6, maxR: 1.6, alpha: 0.90, twinkle: true },
  { count: 50,  speed: 0.25, minR: 1.2, maxR: 2.6, alpha: 1.0,  twinkle: true, glow: true },
]

interface Star {
  x: number; y: number; r: number; baseR: number
  alpha: number; baseAlpha: number
  color: string
  phase: number; freq: number
  glowColor?: string
}

let ctx: CanvasRenderingContext2D
let stars: Star[] = []
let mouse = { x: 0.5, y: 0.5 }
let animId = 0
let w = 0; let h = 0
let time = 0

const STAR_COLORS = [
  '#ffffff', '#f8f9ff', '#eef0ff',
  '#C4B5FD', '#ddd6fe',           // warm violet
  '#A5F3FC', '#CFFAFE',           // cool cyan
  '#BFDBFE', '#DBEAFE',           // soft blue
]

function pick<T>(arr: T[]) { return arr[Math.floor(Math.random() * arr.length)] }

function resize() {
  if (!canvas.value) return
  w = window.innerWidth
  h = window.innerHeight
  canvas.value.width = w
  canvas.value.height = h
}

function createStars() {
  stars = []
  for (const layer of LAYERS) {
    for (let i = 0; i < layer.count; i++) {
      const baseR = layer.minR + Math.random() * (layer.maxR - layer.minR)
      const baseAlpha = layer.alpha * (0.6 + Math.random() * 0.4)
      const color = pick(STAR_COLORS)
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: baseR, baseR,
        alpha: baseAlpha, baseAlpha,
        color,
        phase: Math.random() * Math.PI * 2,
        freq: 0.3 + Math.random() * 1.2,
        glowColor: layer.glow ? color : undefined,
        _layer: layer,
      } as Star & { _layer: typeof layer })
    }
  }
}

function draw() {
  if (!ctx || !canvas.value) return
  ctx.clearRect(0, 0, w, h)
  time += 0.005

  // Parallax: mouse position shifts each layer at different rates
  const mx = (mouse.x - 0.5) * 50
  const my = (mouse.y - 0.5) * 50

  for (const s of stars) {
    const layer = (s as any)._layer

    // Parallax drift
    s.x += layer.speed * mx * 0.005
    s.y += layer.speed * my * 0.005

    // Wrap around edges
    if (s.x < -10) s.x = w + 10
    if (s.x > w + 10) s.x = -10
    if (s.y < -10) s.y = h + 10
    if (s.y > h + 10) s.y = -10

    // Twinkle
    if (layer.twinkle) {
      const twinkle = 0.35 + 0.65 * Math.sin(time * s.freq + s.phase)
      s.alpha = s.baseAlpha * twinkle
      s.r = s.baseR * (0.65 + 0.35 * twinkle)
    }

    // Glow halo for largest stars
    if (layer.glow) {
      const glow = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 6)
      glow.addColorStop(0, s.glowColor!)
      glow.addColorStop(0.3, s.glowColor!)
      glow.addColorStop(1, 'transparent')
      ctx.beginPath()
      ctx.arc(s.x, s.y, s.r * 6, 0, Math.PI * 2)
      ctx.fillStyle = glow
      ctx.globalAlpha = s.alpha * 0.55
      ctx.fill()
    }

    // Star dot
    ctx.beginPath()
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
    ctx.fillStyle = s.color
    ctx.globalAlpha = s.alpha
    ctx.fill()
  }
  ctx.globalAlpha = 1

  // ── Constellation overlay ──
  const cx = (mouse.x - 0.5) * 40
  const cy = (mouse.y - 0.5) * 40

  // Pre-defined constellation shapes (normalized 0..1, anchored to viewport)
  const constellations = [
    // Top-left: a kite/diamond
    { pts: [[0.12,0.18],[0.18,0.22],[0.20,0.14],[0.14,0.10]], ox: 0, oy: 0 },
    // Upper-right: a W shape
    { pts: [[0.72,0.08],[0.76,0.16],[0.80,0.08],[0.84,0.16],[0.88,0.08]], ox: 0, oy: 0 },
    // Middle-left: a triangle
    { pts: [[0.06,0.52],[0.12,0.60],[0.04,0.62]], ox: 0, oy: 0 },
    // Bottom-right: a zigzag
    { pts: [[0.78,0.70],[0.84,0.64],[0.88,0.72],[0.92,0.65]], ox: 0, oy: 0 },
    // Center-right: a small diamond
    { pts: [[0.68,0.42],[0.72,0.38],[0.76,0.42],[0.72,0.46]], ox: 0, oy: 0 },
    // Bottom-left: a line of 3
    { pts: [[0.08,0.78],[0.14,0.82],[0.10,0.86]], ox: 0, oy: 0 },
  ]

  const constAlpha = 0.28 + 0.08 * Math.sin(time * 0.3)

  for (const con of constellations) {
    ctx.beginPath()
    const pts = con.pts.map(([px, py]) => ({ x: px * w + cx * 0.3, y: py * h + cy * 0.3 }))
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x, pts[i].y)
    }
    // Close some shapes (diamonds, triangles)
    if (con.pts.length <= 4) ctx.closePath()
    ctx.strokeStyle = `rgba(167,139,250,${constAlpha})`
    ctx.lineWidth = 1.0
    ctx.stroke()

    // Tiny anchor stars at constellation nodes
    for (const p of pts) {
      ctx.beginPath()
      ctx.arc(p.x, p.y, 1.4, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(196,181,253,${Math.min(constAlpha * 3, 0.9)})`
      ctx.fill()
    }
  }

  // Drift mouse back to center
  mouse.x += (0.5 - mouse.x) * 0.003
  mouse.y += (0.5 - mouse.y) * 0.003

  animId = requestAnimationFrame(draw)
}

function onMouseMove(e: MouseEvent) {
  mouse.x = e.clientX / w
  mouse.y = e.clientY / h
}

onMounted(() => {
  resize()
  createStars()
  if (canvas.value) {
    ctx = canvas.value.getContext('2d')!
    draw()
  }
  window.addEventListener('resize', () => { resize(); createStars() })
  window.addEventListener('mousemove', onMouseMove)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(animId)
  window.removeEventListener('resize', resize)
  window.removeEventListener('mousemove', onMouseMove)
})
</script>

<style scoped>
.starfield-canvas {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: 1.0;
}
</style>
