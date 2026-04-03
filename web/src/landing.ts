export function landingPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AEGIS — Persistent Cognitive Kernel by Stackbilt</title>
  <meta name="description" content="AEGIS is an edge-native persistent AI agent running on Cloudflare Workers. 8-tier cognitive dispatch, hybrid vector memory, autonomous task pipeline from issue to PR, ARGUS proactive event layer, and self-improving code generation.">
  <meta name="theme-color" content="#04040a">
  <link rel="canonical" href="https://aegis.stackbilt.dev/">

  <!-- Open Graph -->
  <meta property="og:title" content="AEGIS — Persistent Cognitive Kernel">
  <meta property="og:description" content="AEGIS is an edge-native persistent AI agent running on Cloudflare Workers. 8-tier cognitive dispatch, hybrid vector memory, autonomous task pipeline from issue to PR, ARGUS proactive event layer, and self-improving code generation.">
  <meta property="og:url" content="https://aegis.stackbilt.dev/">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="AEGIS by Stackbilt">
  <meta property="og:image" content="https://imgforge.stackbilt.dev/v2/assets/6d252e847462e25920c261dd65da71fef3726690186c7e1f6883fa60528ab4d8">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="AEGIS — Autonomous Cognitive Agent, edge-first AI kernel by Stackbilt">

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="https://imgforge.stackbilt.dev/v2/assets/6d252e847462e25920c261dd65da71fef3726690186c7e1f6883fa60528ab4d8">
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-T3MSE40BWF"></script>
  <script>
  window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}
  gtag('js',new Date());gtag('config','G-T3MSE40BWF');
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=JetBrains+Mono:wght@300;400;500&family=Instrument+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --bg-deep: #04040a;
      --bg-surface: #080812;
      --bg-card: #0b0b18;
      --border-subtle: rgba(123, 123, 223, 0.06);
      --border-medium: rgba(123, 123, 223, 0.1);
      --accent: #7b7bdf;
      --accent-glow: #8b8bff;
      --accent-teal: #3dd6c8;
      --accent-teal-dim: rgba(61, 214, 200, 0.15);
      --text-primary: #c8c8d8;
      --text-secondary: #6a6a80;
      --text-dim: #2e2e3e;
      --status-green: #2dd4a0;
    }

    html {
      scroll-behavior: smooth;
      -webkit-font-smoothing: antialiased;
    }

    body {
      background: var(--bg-deep);
      color: var(--text-primary);
      font-family: 'Instrument Sans', sans-serif;
      overflow-x: hidden;
      position: relative;
    }

    /* ── Noise texture ─────────────────────────── */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      opacity: 0.025;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
      background-size: 256px 256px;
      pointer-events: none;
      z-index: 1;
    }

    /* ── Ambient glow ──────────────────────────── */
    .ambient {
      position: fixed;
      top: -30%;
      left: 50%;
      transform: translateX(-50%);
      width: 160%;
      height: 80%;
      background: radial-gradient(ellipse at center, rgba(123, 123, 223, 0.035) 0%, rgba(42, 76, 187, 0.015) 40%, transparent 70%);
      pointer-events: none;
      z-index: 0;
      animation: breathe 8s ease-in-out infinite;
    }

    @keyframes breathe {
      0%, 100% { opacity: 1; transform: translateX(-50%) scale(1); }
      50% { opacity: 0.4; transform: translateX(-50%) scale(1.05); }
    }

    /* ── Scan line ─────────────────────────────── */
    .scan-line {
      position: fixed;
      left: 0;
      right: 0;
      height: 1px;
      background: linear-gradient(90deg, transparent 5%, rgba(123, 123, 223, 0.05) 30%, rgba(123, 123, 223, 0.08) 50%, rgba(123, 123, 223, 0.05) 70%, transparent 95%);
      pointer-events: none;
      z-index: 50;
      animation: scan 14s linear infinite;
    }

    @keyframes scan {
      0% { top: -1px; }
      100% { top: 100vh; }
    }

    /* ── Status bar ────────────────────────────── */
    .status-bar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 24px;
      background: rgba(4, 4, 10, 0.85);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--border-subtle);
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      letter-spacing: 0.05em;
      color: var(--text-secondary);
      z-index: 100;
      opacity: 0;
      animation: fadeUp 0.8s ease 0.3s forwards;
    }

    .status-left, .status-right {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--text-dim);
      transition: all 0.6s ease;
    }

    .status-dot.online {
      background: var(--status-green);
      box-shadow: 0 0 8px rgba(45, 212, 160, 0.4);
      animation: pulse-dot 3s ease-in-out infinite;
    }

    .status-dot.offline {
      background: #df5555;
      box-shadow: 0 0 8px rgba(223, 85, 85, 0.4);
    }

    @keyframes pulse-dot {
      0%, 100% { opacity: 1; box-shadow: 0 0 8px rgba(45, 212, 160, 0.4); }
      50% { opacity: 0.5; box-shadow: 0 0 4px rgba(45, 212, 160, 0.2); }
    }

    .status-label {
      text-transform: uppercase;
      letter-spacing: 0.12em;
    }

    .status-version {
      color: var(--text-dim);
    }

    .status-right a {
      color: var(--text-dim);
      text-decoration: none;
      transition: color 0.2s;
    }
    .status-right a:hover { color: var(--accent); }

    /* ═══════════════════════════════════════════
       HERO SECTION
       ═══════════════════════════════════════════ */
    .hero {
      position: relative;
      z-index: 2;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 80px 24px 60px;
    }

    .hero-bg {
      position: absolute;
      inset: 0;
      z-index: 0;
      overflow: hidden;
    }

    .hero-bg img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: center 30%;
      opacity: 0.12;
      filter: saturate(0.7) brightness(0.8);
      animation: hero-reveal 2s ease forwards;
    }

    .hero-bg::after {
      content: '';
      position: absolute;
      inset: 0;
      background:
        radial-gradient(ellipse at center 40%, transparent 20%, var(--bg-deep) 75%),
        linear-gradient(to bottom, transparent 40%, var(--bg-deep) 95%),
        linear-gradient(to top, transparent 70%, var(--bg-deep) 100%);
      pointer-events: none;
    }

    @keyframes hero-reveal {
      from { opacity: 0; transform: scale(1.05); }
      to { opacity: 0.12; transform: scale(1); }
    }

    .sigil-wrap, .title, .subtitle, .tagline, .cap-pills, .scroll-hint {
      position: relative;
      z-index: 2;
    }

    /* ── Sigil ─────────────────────────────────── */
    .sigil-wrap {
      position: relative;
      width: 140px;
      height: 140px;
      margin-bottom: 52px;
      opacity: 0;
      animation: fadeUp 1s ease 0.1s forwards;
    }

    .sigil-glow {
      position: absolute;
      inset: -50px;
      background: radial-gradient(circle, rgba(139, 139, 255, 0.06) 0%, transparent 70%);
      border-radius: 50%;
      animation: glow-breathe 6s ease-in-out infinite;
    }

    @keyframes glow-breathe {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.2); opacity: 0.5; }
    }

    .sigil-ring {
      position: absolute;
      border: 1px solid rgba(123, 123, 223, 0.07);
      border-radius: 50%;
    }

    .sigil-ring-1 {
      inset: -22px;
      animation: ring-spin 80s linear infinite;
    }

    .sigil-ring-2 {
      inset: -40px;
      border-color: rgba(123, 123, 223, 0.04);
      animation: ring-spin 120s linear infinite reverse;
    }

    @keyframes ring-spin { to { transform: rotate(360deg); } }

    .sigil-ring-1::before, .sigil-ring-1::after {
      content: '';
      position: absolute;
      width: 3px;
      height: 3px;
      background: var(--accent);
      border-radius: 50%;
      opacity: 0.4;
    }
    .sigil-ring-1::before { top: -1.5px; left: 50%; transform: translateX(-50%); }
    .sigil-ring-1::after { bottom: -1.5px; left: 50%; transform: translateX(-50%); opacity: 0.2; }

    .sigil-ring-2::before {
      content: '';
      position: absolute;
      width: 2px;
      height: 2px;
      background: var(--accent-teal);
      border-radius: 50%;
      opacity: 0.3;
      top: 50%;
      right: -1px;
      transform: translateY(-50%);
    }

    .sigil-svg {
      width: 100%;
      height: 100%;
      position: relative;
      z-index: 2;
    }

    .sigil-line {
      stroke: rgba(123, 123, 223, 0.12);
      stroke-width: 0.6;
      fill: none;
    }

    .sigil-pulse-path {
      stroke: var(--accent-glow);
      stroke-width: 1;
      fill: none;
      stroke-dasharray: 6 300;
      animation: pulse-travel 5s ease-in-out infinite;
      opacity: 0.5;
    }

    @keyframes pulse-travel {
      0% { stroke-dashoffset: 0; }
      100% { stroke-dashoffset: -306; }
    }

    .sigil-dot { fill: var(--accent); }
    .sigil-dot-glow { fill: var(--accent-glow); opacity: 0; }

    .sigil-dot-1 { animation: dot-drift-1 9s ease-in-out infinite; }
    .sigil-dot-2 { animation: dot-drift-2 11s ease-in-out infinite; }
    .sigil-dot-3 { animation: dot-drift-3 13s ease-in-out infinite; }

    .sigil-dot-glow-1 { animation: dot-glow 4s ease-in-out infinite; }
    .sigil-dot-glow-2 { animation: dot-glow 4s ease-in-out 1.3s infinite; }
    .sigil-dot-glow-3 { animation: dot-glow 4s ease-in-out 2.6s infinite; }

    @keyframes dot-drift-1 {
      0%, 100% { transform: translate(0, 0); }
      30% { transform: translate(1.5px, -1px); }
      70% { transform: translate(-1px, 0.5px); }
    }
    @keyframes dot-drift-2 {
      0%, 100% { transform: translate(0, 0); }
      40% { transform: translate(-1.5px, 1px); }
      80% { transform: translate(1px, -0.5px); }
    }
    @keyframes dot-drift-3 {
      0%, 100% { transform: translate(0, 0); }
      35% { transform: translate(1px, 1.5px); }
      75% { transform: translate(-0.5px, -1px); }
    }
    @keyframes dot-glow {
      0%, 100% { opacity: 0; }
      50% { opacity: 0.6; }
    }

    /* ── Hero typography ───────────────────────── */
    .title {
      font-family: 'Syne', sans-serif;
      font-weight: 800;
      font-size: clamp(52px, 9vw, 88px);
      letter-spacing: 0.18em;
      text-transform: uppercase;
      background: linear-gradient(135deg, var(--text-primary) 0%, var(--accent) 40%, var(--accent-teal) 80%, var(--text-primary) 100%);
      background-size: 300% 300%;
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      animation: fadeUp 0.9s ease 0.3s forwards, gradient-drift 12s ease infinite;
      opacity: 0;
      margin-bottom: 14px;
    }

    @keyframes gradient-drift {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }

    .subtitle {
      font-family: 'JetBrains Mono', monospace;
      font-weight: 300;
      font-size: clamp(12px, 1.8vw, 15px);
      letter-spacing: 0.3em;
      text-transform: uppercase;
      color: var(--text-secondary);
      margin-bottom: 44px;
      opacity: 0;
      animation: fadeUp 0.9s ease 0.5s forwards;
    }

    .tagline {
      font-family: 'Instrument Sans', sans-serif;
      font-size: clamp(15px, 2.2vw, 18px);
      font-weight: 400;
      color: var(--text-secondary);
      max-width: 440px;
      text-align: center;
      line-height: 1.7;
      margin-bottom: 52px;
      opacity: 0;
      animation: fadeUp 0.9s ease 0.7s forwards;
    }

    /* ── Capability pills ──────────────────────── */
    .cap-pills {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: center;
      margin-bottom: 44px;
      opacity: 0;
      animation: fadeUp 0.9s ease 0.9s forwards;
    }

    .cap-pill {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 14px;
      background: rgba(123, 123, 223, 0.03);
      border: 1px solid var(--border-subtle);
      border-radius: 100px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--text-secondary);
      letter-spacing: 0.03em;
    }

    .cap-pill-dot {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--accent-teal);
      opacity: 0.6;
    }

    /* ── Hero links ────────────────────────────── */
    .hero-links {
      display: flex;
      justify-content: center;
      gap: 1rem;
      margin-top: 1.5rem;
      opacity: 0;
      animation: fadeUp 0.8s ease 1s forwards;
    }

    .hero-link-case {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      font-weight: 500;
      color: var(--accent-teal);
      text-decoration: none;
      padding: 8px 18px;
      border: 1px solid var(--accent-teal-dim);
      border-radius: 6px;
      transition: all 0.25s;
      letter-spacing: 0.02em;
    }

    .hero-link-case:hover {
      background: var(--accent-teal-dim);
      border-color: var(--accent-teal);
    }

    .hero-link-health {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      font-weight: 400;
      color: var(--text-secondary);
      text-decoration: none;
      padding: 8px 18px;
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      transition: all 0.25s;
      letter-spacing: 0.02em;
    }

    .hero-link-health:hover {
      border-color: var(--accent);
      color: var(--accent);
    }

    /* ── Scroll indicator ──────────────────────── */
    .scroll-hint {
      position: absolute;
      bottom: 28px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      opacity: 0;
      animation: fadeUp 0.8s ease 1.2s forwards;
    }

    .scroll-hint span {
      font-family: 'JetBrains Mono', monospace;
      font-size: 9px;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: var(--text-dim);
    }

    .scroll-arrow {
      width: 16px;
      height: 16px;
      border-right: 1px solid var(--text-dim);
      border-bottom: 1px solid var(--text-dim);
      transform: rotate(45deg);
      animation: bob 2s ease-in-out infinite;
    }

    @keyframes bob {
      0%, 100% { transform: rotate(45deg) translate(0, 0); opacity: 0.5; }
      50% { transform: rotate(45deg) translate(3px, 3px); opacity: 1; }
    }

    /* ═══════════════════════════════════════════
       CONTENT SECTIONS
       ═══════════════════════════════════════════ */
    .content {
      position: relative;
      z-index: 2;
      max-width: 800px;
      margin: 0 auto;
      padding: 0 24px 120px;
    }

    .section {
      margin-bottom: 96px;
    }

    .section-label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .section-label::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--border-subtle);
    }

    .section h2 {
      font-family: 'Syne', sans-serif;
      font-weight: 700;
      font-size: clamp(24px, 4vw, 32px);
      letter-spacing: 0.04em;
      margin-bottom: 20px;
      color: var(--text-primary);
    }

    .section p {
      font-size: 16px;
      line-height: 1.75;
      color: var(--text-secondary);
      margin-bottom: 16px;
      max-width: 640px;
    }

    .section p strong {
      color: var(--text-primary);
      font-weight: 500;
    }

    /* ── Dispatch tiers ────────────────────────── */
    .tiers {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin-top: 32px;
    }

    .tier {
      display: grid;
      grid-template-columns: 32px 1fr auto;
      gap: 16px;
      align-items: center;
      padding: 14px 18px;
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      transition: all 0.2s ease;
    }

    .tier:first-child { border-radius: 10px 10px 0 0; }
    .tier:last-child { border-radius: 0 0 10px 10px; }

    .tier:hover {
      background: rgba(123, 123, 223, 0.03);
      border-color: var(--border-medium);
    }

    .tier-num {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      font-weight: 500;
      color: var(--text-dim);
      text-align: center;
    }

    .tier-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .tier-name {
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .tier-desc {
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.4;
    }

    .tier-cost {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--text-dim);
      white-space: nowrap;
    }

    .tier-cost.free {
      color: var(--status-green);
    }

    .tier-bar {
      grid-column: 1 / -1;
      height: 2px;
      border-radius: 1px;
      margin-top: 4px;
      opacity: 0.4;
    }

    /* ── Capability cards ──────────────────────── */
    .cap-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
      margin-top: 32px;
    }

    .cap-card {
      padding: 24px;
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      transition: all 0.25s ease;
    }

    .cap-card:hover {
      border-color: var(--border-medium);
      transform: translateY(-2px);
    }

    .cap-card-icon {
      font-family: 'JetBrains Mono', monospace;
      font-size: 20px;
      margin-bottom: 14px;
      display: block;
    }

    .cap-card h3 {
      font-family: 'Syne', sans-serif;
      font-weight: 700;
      font-size: 16px;
      letter-spacing: 0.03em;
      margin-bottom: 8px;
      color: var(--text-primary);
    }

    .cap-card p {
      font-size: 13px;
      line-height: 1.65;
      color: var(--text-secondary);
      margin-bottom: 0;
    }

    /* ── Published work cards ─────────────────── */
    .pub-card {
      cursor: pointer;
    }

    .pub-link {
      display: inline-block;
      margin-top: 12px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      letter-spacing: 0.05em;
      color: var(--accent-teal);
      opacity: 0.6;
      transition: opacity 0.2s ease;
    }

    .pub-card:hover .pub-link {
      opacity: 1;
    }


    /* ── Live status section ────────────────────── */
    .live-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 16px;
      margin-top: 32px;
    }

    .live-stat {
      padding: 20px;
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      text-align: center;
    }

    .live-stat-value {
      font-family: 'JetBrains Mono', monospace;
      font-size: 22px;
      font-weight: 500;
      color: var(--accent);
      letter-spacing: 0.05em;
    }

    .live-stat-label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      color: var(--text-dim);
      margin-top: 6px;
    }

    /* ── Footer ────────────────────────────────── */
    .page-footer {
      position: relative;
      z-index: 2;
      padding: 40px 24px;
      border-top: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      justify-content: space-between;
      max-width: 800px;
      margin: 0 auto;
    }

    .footer-brand {
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      letter-spacing: 0.1em;
      color: var(--text-dim);
      text-transform: uppercase;
      flex-wrap: wrap;
    }

    .footer-brand a:hover { color: var(--accent) !important; }

    .footer-dot {
      width: 2px;
      height: 2px;
      border-radius: 50%;
      background: var(--text-dim);
      opacity: 0.5;
    }

    .footer-login {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      letter-spacing: 0.1em;
      color: var(--text-dim);
      text-decoration: none;
      text-transform: uppercase;
      padding: 6px 14px;
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      transition: all 0.2s ease;
    }

    .footer-login:hover {
      color: var(--accent);
      border-color: var(--border-medium);
    }

    /* ── Animations ────────────────────────────── */
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* ── Scroll reveal ─────────────────────────── */
    .reveal {
      opacity: 0;
      transform: translateY(20px);
      transition: opacity 0.6s ease, transform 0.6s ease;
    }
    .reveal.visible {
      opacity: 1;
      transform: translateY(0);
    }

    /* ── Mobile ────────────────────────────────── */
    @media (max-width: 640px) {
      .status-bar { padding: 0 16px; font-size: 10px; }
      .cap-pills { gap: 8px; padding: 0 8px; }
      .cap-pill { padding: 6px 11px; font-size: 10px; }
      .hero { padding: 60px 20px 48px; }
      .sigil-wrap { width: 100px; height: 100px; margin-bottom: 40px; }
      .sigil-ring-1 { inset: -16px; }
      .sigil-ring-2 { inset: -30px; }
      .content { padding: 0 20px 80px; }
      .section { margin-bottom: 72px; }
      .tier { grid-template-columns: 24px 1fr; gap: 10px; padding: 12px 14px; }
      .tier-cost { grid-column: 2; font-size: 10px; }
      .cap-grid { grid-template-columns: 1fr; }
      .page-footer { flex-direction: column; gap: 16px; text-align: center; }
    }
  </style>
</head>
<body>
  <div class="ambient"></div>
  <div class="scan-line"></div>

  <header class="status-bar">
    <div class="status-left">
      <div class="status-dot" id="s-dot"></div>
      <span class="status-label" id="s-label">initializing</span>
    </div>
    <div class="status-right">
      <span class="status-version" id="s-version"></span>
      <a href="https://stackbilt.dev">stackbilt</a>
      <a href="https://docs.stackbilt.dev">docs</a>
      <a href="/chat">operator</a>
    </div>
  </header>

  <!-- ═══════════════════════════════════════════
       HERO
       ═══════════════════════════════════════════ -->
  <section class="hero">
    <div class="hero-bg">
      <img src="https://imgforge.stackbilt.dev/v2/assets/eb41f2d115b7e105809c969f9291e9fbf313b327ded40ec0b25bae9ddf950b72" alt="" loading="eager">
    </div>
    <div class="sigil-wrap">
      <div class="sigil-glow"></div>
      <div class="sigil-ring sigil-ring-1"></div>
      <div class="sigil-ring sigil-ring-2"></div>
      <svg class="sigil-svg" viewBox="0 0 140 140">
        <path class="sigil-line" d="M 70 28 L 38 98 L 102 98 Z" />
        <path class="sigil-pulse-path" d="M 70 28 L 102 98 L 38 98 Z" />
        <g class="sigil-dot-1">
          <circle class="sigil-dot" cx="70" cy="28" r="6" />
          <circle class="sigil-dot-glow sigil-dot-glow-1" cx="70" cy="28" r="10" />
        </g>
        <g class="sigil-dot-2">
          <circle class="sigil-dot" cx="38" cy="98" r="6" />
          <circle class="sigil-dot-glow sigil-dot-glow-2" cx="38" cy="98" r="10" />
        </g>
        <g class="sigil-dot-3">
          <circle class="sigil-dot" cx="102" cy="98" r="6" />
          <circle class="sigil-dot-glow sigil-dot-glow-3" cx="102" cy="98" r="10" />
        </g>
      </svg>
    </div>

    <h1 class="title">AEGIS</h1>
    <p class="subtitle">Persistent Cognitive Kernel</p>
    <p class="tagline">A personal AI agent that runs continuously on the edge. It classifies, routes, remembers, ships code, and improves itself — from GitHub issue to merged PR, autonomously.</p>

    <div class="cap-pills">
      <div class="cap-pill"><span class="cap-pill-dot"></span>8-Tier Dispatch</div>
      <div class="cap-pill"><span class="cap-pill-dot"></span>Hybrid Vector Memory</div>
      <div class="cap-pill"><span class="cap-pill-dot"></span>Issue-to-PR Pipeline</div>
      <div class="cap-pill"><span class="cap-pill-dot"></span>Self-Improvement</div>
      <div class="cap-pill"><span class="cap-pill-dot"></span>ARGUS Proactive Layer</div>
      <div class="cap-pill"><span class="cap-pill-dot"></span>Cross-Repo Intelligence</div>
    </div>

    <div class="hero-links">
      <a href="/pulse" class="hero-link-case">Neural Pulse &rarr;</a>
      <a href="https://kurtovermier.com/projects/aegis" class="hero-link-health">Case Study</a>
      <a href="/health" class="hero-link-health">Health</a>
    </div>

    <div class="scroll-hint">
      <span>How it works</span>
      <div class="scroll-arrow"></div>
    </div>
  </section>

  <!-- ═══════════════════════════════════════════
       CONTENT
       ═══════════════════════════════════════════ -->
  <div class="content">

    <!-- WHAT IS AEGIS -->
    <section class="section reveal">
      <div class="section-label">Overview</div>
      <h2>Not a chatbot. A kernel.</h2>
      <p>
        AEGIS is a <strong>persistent cognitive kernel</strong> — a long-running AI agent that operates continuously on Cloudflare Workers. It doesn't wait to be invoked. It has vector-backed memory that persists across every interaction, goals it evaluates autonomously, a dreaming cycle that reflects nightly, and a full software development pipeline that ships code from issue to merged PR.
      </p>
      <p>
        Every message enters the same pipeline: <strong>classify intent, match against procedural memory, route to the cheapest viable executor, execute, record the outcome</strong>. The kernel learns which executors work for which patterns and optimizes routing over time — pushing work into the lowest-cost tier that produces good results.
      </p>
      <p>
        The recursive loop is the key: the dreaming cycle identifies work, the issue watcher queues it, the taskrunner executes it, the code reviewer validates it. Work items flow through the system and emerge as pull requests. The system improves itself.
      </p>
      <p>
        Built for one operator. No multi-tenant abstractions. No SaaS. Just a personal AI agent that thinks in systems, acts on the edge, and gets sharper with every dispatch.
      </p>
    </section>

    <!-- 8-TIER DISPATCH -->
    <section class="section reveal">
      <div class="section-label">Architecture</div>
      <h2>8-Tier Cognitive Dispatch</h2>
      <p>
        Every query is classified by complexity and routed to the cheapest executor that can handle it. Procedural memory learns from outcomes and short-circuits future routing. A circuit breaker degrades executors that fail consecutively.
      </p>

      <div class="tiers">
        <div class="tier">
          <div class="tier-num">01</div>
          <div class="tier-info">
            <div class="tier-name">Signal</div>
            <div class="tier-desc">Intent classification — Workers AI 3B on-device, Groq 70B fallback</div>
          </div>
          <div class="tier-cost free">near-zero</div>
        </div>
        <div class="tier">
          <div class="tier-num">02</div>
          <div class="tier-info">
            <div class="tier-name">Reflex</div>
            <div class="tier-desc">Procedural memory pattern match — no model call, direct executor routing</div>
          </div>
          <div class="tier-cost free">zero</div>
        </div>
        <div class="tier">
          <div class="tier-num">03</div>
          <div class="tier-info">
            <div class="tier-name">Light</div>
            <div class="tier-desc">Groq 8B — greetings, simple acknowledgments, fast responses</div>
          </div>
          <div class="tier-cost free">near-zero</div>
        </div>
        <div class="tier">
          <div class="tier-num">04</div>
          <div class="tier-info">
            <div class="tier-name">Light+</div>
            <div class="tier-desc">Workers AI Llama 70B — simple queries, no tools needed</div>
          </div>
          <div class="tier-cost free">near-zero</div>
        </div>
        <div class="tier">
          <div class="tier-num">05</div>
          <div class="tier-info">
            <div class="tier-name">Standard</div>
            <div class="tier-desc">GPT-OSS 120B — tool use, moderate reasoning</div>
          </div>
          <div class="tier-cost">low</div>
        </div>
        <div class="tier">
          <div class="tier-num">06</div>
          <div class="tier-info">
            <div class="tier-name">Composite</div>
            <div class="tier-desc">LLM Map-Reduce — Groq plans, CF gathers tools, Groq analyzes, Claude synthesizes</div>
          </div>
          <div class="tier-cost">low</div>
        </div>
        <div class="tier">
          <div class="tier-num">07</div>
          <div class="tier-info">
            <div class="tier-name">Heavy</div>
            <div class="tier-desc">Claude Sonnet — complex reasoning, multi-tool orchestration</div>
          </div>
          <div class="tier-cost">moderate</div>
        </div>
        <div class="tier">
          <div class="tier-num">08</div>
          <div class="tier-info">
            <div class="tier-name">Deep</div>
            <div class="tier-desc">Claude Opus — multi-step reasoning, architectural decisions</div>
          </div>
          <div class="tier-cost">high</div>
        </div>
      </div>
    </section>

    <!-- CAPABILITIES -->
    <section class="section reveal">
      <div class="section-label">Capabilities</div>
      <h2>What the kernel does</h2>

      <div class="cap-grid">
        <div class="cap-card">
          <span class="cap-card-icon">&#x2301;</span>
          <h3>Hybrid Vector Memory</h3>
          <p>Dedicated Memory Worker with Cloudflare Vectorize (BGE-base-en-v1.5, 768-dim). Reciprocal Rank Fusion merges vector and keyword search. Core facts immune to temporal decay. Persona matrix builds operator profile across 6 behavioral dimensions.</p>
        </div>
        <div class="cap-card">
          <span class="cap-card-icon">&#x2692;</span>
          <h3>Autonomous Task Pipeline</h3>
          <p>Full SDLC from issue to PR. GitHub issues auto-queue as tasks. Headless Claude Code sessions execute with safety hooks. Branch-per-task PRs. Codex review validates output. Governance caps prevent runaway execution. The system ships its own code.</p>
        </div>
        <div class="cap-card">
          <span class="cap-card-icon">&#x2234;</span>
          <h3>Procedural Memory</h3>
          <p>Learns which executors succeed for which task patterns. Procedures graduate from learning to learned after consistent success. A circuit breaker degrades unreliable routes. Stale procedures decay after 14 days of disuse.</p>
        </div>
        <div class="cap-card">
          <span class="cap-card-icon">&#x21BB;</span>
          <h3>Self-Improvement + CRIX</h3>
          <p>Scans repositories for improvement opportunities. Creates issues and PRs. Cross-Repo Intelligence Exchange publishes patterns from one repo that are validated and promoted across the ecosystem. Merged PRs reinforce; rejected ones adjust.</p>
        </div>
        <div class="cap-card">
          <span class="cap-card-icon">&#x263D;</span>
          <h3>Dreaming Cycle</h3>
          <p>Nightly multi-phase reflection: memory consolidation, task proposal extraction, agenda triage (promotes stray work items to issues), persona observation, and symbolic reflection via TarotScript. The recursive engine that keeps the system evolving.</p>
        </div>
        <div class="cap-card">
          <span class="cap-card-icon">&#x25CE;</span>
          <h3>Autonomous Goals</h3>
          <p>Persistent goals on configurable schedules. Three-tier authority: auto_low for monitoring, propose for state changes, operator for human-only. Failures downgrade authority. Currently monitoring compliance, finance, infrastructure, and codebase health.</p>
        </div>
        <div class="cap-card">
          <span class="cap-card-icon">&#x2637;</span>
          <h3>ARGUS — Proactive Layer</h3>
          <p>Real-time webhook ingestion from GitHub and Stripe with HMAC verification. Event classification routes critical alerts (CI failures, payment issues) to immediate email; high-priority events queue for daily digest. Pattern detection sweeps for CI failure clusters, payment anomalies, event droughts, and velocity spikes. Zero-inference — pure D1 queries and threshold logic.</p>
        </div>
        <div class="cap-card">
          <span class="cap-card-icon">&#x2638;</span>
          <h3>Infrastructure Monitoring</h3>
          <p>Heartbeat evaluates BizOps dashboard and Cloudflare worker metrics every 6 hours. Triage classifies checks as new, escalated, persisting, or resolved. Chronic medium issues auto-decay to prevent alert fatigue. Escalation system nags on stale agenda items. Daily digest consolidates everything.</p>
        </div>
        <div class="cap-card">
          <span class="cap-card-icon">&#x25C7;</span>
          <h3>Content Pipelines</h3>
          <p>Technical blog with RSS feed and The Roundtable — multi-perspective analysis and research dispatches. Hero images via <a href="https://imgforge.stackbilt.dev" style="color:var(--accent-teal);text-decoration:none;border-bottom:1px solid rgba(61,214,200,0.3)">img-forge</a>. Content published and syndicated to dev.to.</p>
        </div>
      </div>
    </section>

    <!-- PUBLISHED WORK -->
    <section class="section reveal">
      <div class="section-label">Output</div>
      <h2>Published Work</h2>
      <p>
        AEGIS generates original analysis and research autonomously — not canned templates, but structured content produced by the kernel's content pipelines and published after human review.
      </p>

      <div class="cap-grid" style="margin-top:24px">
        <a href="https://blog.stackbilt.dev" class="cap-card pub-card" style="text-decoration:none">
          <span class="cap-card-icon">&#x25C7;</span>
          <h3>The Roundtable</h3>
          <p>Engineering posts, multi-perspective analysis, arxiv research dispatches, and AI infrastructure deep-dives. Four synthetic contributors who disagree. Cross-posted to dev.to.</p>
          <span class="pub-link">blog.stackbilt.dev &rarr;</span>
        </a>
        <a href="https://dev.to/stackbiltadmin" class="cap-card pub-card" style="text-decoration:none">
          <span class="cap-card-icon">&#x270E;</span>
          <h3>dev.to</h3>
          <p>Syndicated engineering content on autonomous agents, edge AI, MCP servers, and developer infrastructure patterns.</p>
          <span class="pub-link">dev.to/stackbiltadmin &rarr;</span>
        </a>
      </div>
    </section>

    <!-- LIVE STATUS -->
    <section class="section reveal">
      <div class="section-label">Status</div>
      <h2>Live Kernel</h2>
      <p>
        Real-time data from the <a href="/health" style="color:var(--accent-teal);text-decoration:none;border-bottom:1px solid rgba(61,214,200,0.3)">/health</a> endpoint. The kernel is always running — these numbers update on every page load.
      </p>

      <div class="live-grid">
        <div class="live-stat">
          <div class="live-stat-value" id="ls-status">&mdash;</div>
          <div class="live-stat-label">Status</div>
        </div>
        <div class="live-stat">
          <div class="live-stat-value" id="ls-version">&mdash;</div>
          <div class="live-stat-label">Version</div>
        </div>
        <div class="live-stat">
          <div class="live-stat-value" id="ls-learned">&mdash;</div>
          <div class="live-stat-label">Learned</div>
        </div>
        <div class="live-stat">
          <div class="live-stat-value" id="ls-learning">&mdash;</div>
          <div class="live-stat-label">Learning</div>
        </div>
        <div class="live-stat">
          <div class="live-stat-value" id="ls-degraded">&mdash;</div>
          <div class="live-stat-label">Degraded</div>
        </div>
      </div>
    </section>

  </div>

  <!-- ═══════════════════════════════════════════
       FOOTER
       ═══════════════════════════════════════════ -->
  <footer class="page-footer">
    <div class="footer-brand">
      <a href="https://stackbilt.dev" style="color:var(--text-dim);text-decoration:none">Stackbilt</a>
      <span class="footer-dot"></span>
      <a href="https://docs.stackbilt.dev" style="color:var(--text-dim);text-decoration:none">Docs</a>
      <span class="footer-dot"></span>
      <a href="https://blog.stackbilt.dev" style="color:var(--text-dim);text-decoration:none">The Roundtable</a>
      <span class="footer-dot"></span>
      <a href="https://github.com/Stackbilt-dev" style="color:var(--text-dim);text-decoration:none">GitHub</a>
      <span class="footer-dot"></span>
      <a href="tel:+12109395335" style="color:var(--text-dim);text-decoration:none">(210) 939-5335</a>
    </div>
    <div style="display:flex;align-items:center;gap:14px">
      <span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text-dim);letter-spacing:0.1em">&copy; 2026 Stackbilt</span>
      <a href="/chat" class="footer-login">Operator Access</a>
    </div>
  </footer>

  <script>
    // ── Health fetch ──────────────────────────────
    fetch('/health?format=json')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var dot = document.getElementById('s-dot');
        var label = document.getElementById('s-label');
        var ver = document.getElementById('s-version');

        if (d.status === 'ok') {
          dot.classList.add('online');
          label.textContent = 'kernel online';
          ver.textContent = 'v' + (d.version || '');

          var k = d.kernel || {};
          document.getElementById('ls-status').textContent = 'Online';
          document.getElementById('ls-version').textContent = d.version || '—';
          document.getElementById('ls-learned').textContent = (k.learned || 0).toString();
          document.getElementById('ls-learning').textContent = (k.learning || 0).toString();
          document.getElementById('ls-degraded').textContent = (k.degraded || 0).toString();
        } else {
          dot.classList.add('offline');
          label.textContent = 'degraded';
          document.getElementById('ls-status').textContent = 'Degraded';
        }
      })
      .catch(function() {
        document.getElementById('s-dot').classList.add('offline');
        document.getElementById('s-label').textContent = 'offline';
        document.getElementById('ls-status').textContent = 'Offline';
      });

    // ── Scroll reveal ────────────────────────────
    var reveals = document.querySelectorAll('.reveal');
    var observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

    reveals.forEach(function(el) { observer.observe(el); });

  </script>
</body>
</html>`;
}
