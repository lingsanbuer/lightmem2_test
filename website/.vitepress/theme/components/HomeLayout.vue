<template>
  <div class="home-page">
    <!-- Background decor -->
    <div class="home-bg" aria-hidden="true">
      <div class="home-orb home-orb--1"></div>
      <div class="home-orb home-orb--2"></div>
      <div class="home-orb home-orb--3"></div>
      <div class="home-grid"></div>
    </div>
    <ParticleBg />

    <!-- Hero Section -->
    <section class="hero-section">
      <img src="/images/logo.svg" alt="LightMem2" class="hero-logo" />

      <h1 class="hero-title">
        <span class="grad">LightMem2</span>
      </h1>

      <p class="hero-tagline">
        An open plugin platform for long-running AI agents.<br>
        Build capabilities once and run them across OpenClaw, Codex, Claude Code, and future agent hosts.
      </p>

      <p class="hero-sub">
        <strong>Featured plugin: TokenPilot</strong> — a cache-aware context runtime that reduces long-session token usage and cost.
      </p>

      <div class="hero-cta">
        <a href="/lightmem2_test/getting-started/quick-start" class="cta-primary">🚀 Quick Start</a>
        <a href="/lightmem2_test/getting-started/install-lightmem2" class="cta-secondary">📦 Install</a>
        <a href="https://github.com/zjunlp/LightMem2" target="_blank" rel="noopener" class="cta-secondary">💻 GitHub</a>
        <a href="https://arxiv.org/abs/2606.17016" target="_blank" rel="noopener" class="cta-secondary">📄 Paper</a>
      </div>

      <!-- KPI Row -->
      <div class="hero-kpi-row">
        <div class="hero-kpi">
          <div class="hero-kpi-num" data-count="95.7" data-count-suffix="%" data-count-dec="1">0%</div>
          <div class="hero-kpi-label">Fewer input tokens<br><span class="kpi-sub">vs. Vanilla · Claw-Eval continuous</span></div>
        </div>
        <div class="hero-kpi">
          <div class="hero-kpi-num" data-count="87.0" data-count-suffix="%" data-count-dec="1">0%</div>
          <div class="hero-kpi-label">Lower cost<br><span class="kpi-sub">vs. Vanilla · Claw-Eval continuous</span></div>
        </div>
        <div class="hero-kpi">
          <div class="hero-kpi-num" data-count="67.4" data-count-suffix="%" data-count-dec="1">0%</div>
          <div class="hero-kpi-label">Fewer input tokens<br><span class="kpi-sub">vs. Vanilla · PinchBench continuous</span></div>
        </div>
        <div class="hero-kpi">
          <div class="hero-kpi-num" data-count="3" data-count-suffix="" data-count-dec="0">0</div>
          <div class="hero-kpi-label">Hosts supported<br><span class="kpi-sub">OpenClaw · Codex · Claude Code</span></div>
        </div>
      </div>
    </section>

    <!-- Architecture: Platform Overview -->
    <section class="landing-section reveal-section">
      <div class="section-container">
        <span class="section-kicker">Platform</span>
        <h2 class="section-title">
          Plugin platform for <span class="grad">long-running AI agents</span>
        </h2>
        <p class="section-sub">
          LightMem2 separates agent capabilities into reusable plugins that run across multiple hosts, so you only build each feature once.
        </p>

        <div class="arch-card">
          <div class="arch-card-label">Platform Architecture</div>
          <div class="arch-row">
            <div class="arch-item">
              <div class="arch-item-icon">🧩</div>
              <div class="arch-item-title">Plugins</div>
              <div class="arch-item-desc">Reusable agent capabilities: context management, memory, and more.</div>
            </div>
            <div class="arch-item">
              <div class="arch-item-icon">⚙️</div>
              <div class="arch-item-title">Core Runtime</div>
              <div class="arch-item-desc">Plugin lifecycle, configuration, and host-independent execution engine.</div>
            </div>
            <div class="arch-item">
              <div class="arch-item-icon">🔌</div>
              <div class="arch-item-title">Host Adapters</div>
              <div class="arch-item-desc">Integration layer connecting plugins to OpenClaw, Codex, and Claude Code.</div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Plugin Catalog -->
    <section class="landing-section reveal-section">
      <div class="section-container">
        <span class="section-kicker">Plugin Catalog</span>
        <h2 class="section-title">
          Available <span class="grad">plugins</span>
        </h2>
        <p class="section-sub">
          Each plugin provides a distinct capability. Install what you need, skip what you don't.
        </p>

        <div class="plugin-table-wrap">
          <table class="plugin-table">
            <thead>
              <tr>
                <th>Plugin</th>
                <th>Capability</th>
                <th>Status</th>
                <th>Hosts</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>TokenPilot</strong></td>
                <td>Cache-aware context management</td>
                <td><span class="status-stable">Stable</span></td>
                <td>
                  <div class="host-chips">
                    <span class="host-chip">OpenClaw</span>
                    <span class="host-chip">Codex</span>
                    <span class="host-chip">Claude Code</span>
                  </div>
                </td>
              </tr>
              <tr>
                <td><strong>Memory Plugin</strong></td>
                <td>Long-term memory</td>
                <td><span class="status-experimental">Experimental</span></td>
                <td><span class="tbd-text">TBD</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- Featured Plugin: TokenPilot -->
    <section class="landing-section reveal-section">
      <div class="section-container">
        <span class="section-kicker">Featured Plugin</span>
        <h2 class="section-title">
          TokenPilot: <span class="grad">cache-efficient context</span>
        </h2>
        <p class="section-sub">
          TokenPilot is the first official LightMem2 plugin. It reduces token usage and cost in long-running agent sessions through stable-prefix rewriting, context reduction, and lifecycle-aware eviction.
        </p>

        <div class="feature-grid">
          <div class="feature-card">
            <h3>🔒 Stable Prefix</h3>
            <p>Rewrites developer-level context into a cache-stable form, dramatically improving cache hit rates across turns.</p>
          </div>
          <div class="feature-card">
            <h3>✂️ Context Reduction</h3>
            <p>Trims oversized tool output before it pollutes later turns, keeping the context window lean without losing signal.</p>
          </div>
          <div class="feature-card">
            <h3>🗑️ Context Eviction</h3>
            <p>Limits how much old context is carried forward as sessions grow, preventing unbounded context bloat.</p>
          </div>
          <div class="feature-card">
            <h3>📊 Reports & Visuals</h3>
            <p>Built-in inspector shows token savings, cache efficiency, and session metrics in real time.</p>
          </div>
        </div>

        <div class="section-link-row">
          <a href="/lightmem2_test/plugin-catalog/tokenpilot/overview" class="cta-primary">Explore TokenPilot →</a>
        </div>
      </div>
    </section>

    <!-- Documentation Directory -->
    <section class="landing-section reveal-section">
      <div class="section-container">
        <span class="section-kicker">Documentation</span>
        <h2 class="section-title">
          Browse the <span class="grad">docs</span>
        </h2>

        <div class="doc-dir-grid">

          <!-- Hosts -->
          <a href="/lightmem2_test/hosts/compatibility" class="doc-dir-card">
            <span class="doc-dir-icon">🔌</span>
            <span class="doc-dir-title">Hosts</span>
            <span class="doc-dir-pages">OpenClaw · Codex · Claude Code — install, verify, and configure</span>
          </a>

          <!-- User Guide -->
          <a href="/lightmem2_test/user-guide/managing-plugins" class="doc-dir-card">
            <span class="doc-dir-icon">📖</span>
            <span class="doc-dir-title">User Guide</span>
            <span class="doc-dir-pages">CLI Reference · Sessions · Visual Inspector · Logs · Uninstall</span>
          </a>

        </div>
      </div>
    </section>

    <!-- Bottom CTA -->
    <section class="bottom-cta">
      <h2>Ready to reduce your agent costs?</h2>
      <p>Install LightMem2 and TokenPilot in under 5 minutes.</p>
      <a href="/lightmem2_test/getting-started/quick-start" class="cta-primary bottom-cta-btn">Get Started →</a>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import ParticleBg from './ParticleBg.vue'

onMounted(() => {
  // ── KPI count-up animation ──
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const fmt = (val: number, dec: number) =>
    val.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })

  const animateCount = (el: HTMLElement) => {
    const target = parseFloat(el.dataset.count || '0')
    if (Number.isNaN(target)) return
    const dec = parseInt(el.dataset.countDec || '0', 10)
    const suffix = el.dataset.countSuffix || ''
    if (reduceMotion) {
      el.textContent = fmt(target, dec) + suffix
      return
    }
    const dur = 1500
    const start = performance.now()
    const step = (now: number) => {
      const p = Math.min((now - start) / dur, 1)
      const eased = 1 - Math.pow(1 - p, 3)
      el.textContent = fmt(target * eased, dec) + suffix
      if (p < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  const kpiObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          animateCount(e.target as HTMLElement)
          kpiObserver.unobserve(e.target)
        }
      })
    },
    { threshold: 0.4 }
  )

  document.querySelectorAll('[data-count]').forEach((el) => kpiObserver.observe(el))

  // ── Section scroll reveal ──
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('revealed')
          revealObserver.unobserve(e.target)
        }
      })
    },
    { threshold: 0.08 }
  )

  document.querySelectorAll('.reveal-section').forEach((el) => revealObserver.observe(el))
})
</script>

<style scoped>
/* scoped so it only applies inside this component */
</style>
