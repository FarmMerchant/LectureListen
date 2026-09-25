// Animated "plexus" background: drifting points joined by lines when close,
// with a gentle pull toward the pointer. Freezes while a lecture is being
// recorded (to leave CPU and battery for recording and transcription), when
// the tab is hidden, and for people who prefer reduced motion.

const canvas = document.getElementById('plexus');
const ctx = canvas?.getContext('2d');

const LINK_DISTANCE = 150; // px at which two points start to connect
const POINTER_RADIUS = 190;
const FRAME_MS = 1000 / 45; // cap the frame rate; smooth enough for slow drift

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let points = [];
let width = 0;
let height = 0;
let dpr = 1;
let colors = { dot: '#8b8cff', line: '139, 140, 255', pointer: '56, 214, 245' };
const pointer = { x: -9999, y: -9999, active: false };
let rafId = 0;
let last = 0;

function readColors() {
  const s = getComputedStyle(document.documentElement);
  colors = {
    dot: s.getPropertyValue('--plexus-dot').trim() || colors.dot,
    line: s.getPropertyValue('--plexus-line').trim() || colors.line,
    pointer: s.getPropertyValue('--plexus-pointer').trim() || colors.pointer,
  };
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  width = window.innerWidth;
  height = window.innerHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Density scales with the screen: fewer points on phones.
  const target = Math.max(28, Math.min(120, Math.round((width * height) / 15000)));
  while (points.length < target) points.push(spawn());
  points.length = target;
  for (const p of points) {
    p.x = Math.min(p.x, width);
    p.y = Math.min(p.y, height);
  }
}

function spawn() {
  const angle = Math.random() * Math.PI * 2;
  const speed = 0.08 + Math.random() * 0.22; // px per frame at 60fps
  return {
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    r: 1 + Math.random() * 1.4,
  };
}

function step(dt) {
  const k = dt / 16.7;
  for (const p of points) {
    if (pointer.active) {
      const dx = pointer.x - p.x;
      const dy = pointer.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < POINTER_RADIUS * POINTER_RADIUS && d2 > 1) {
        const pull = 0.00002 * k;
        p.vx += dx * pull;
        p.vy += dy * pull;
      }
    }
    // Keep speeds gentle after any pointer pull.
    const speed = Math.hypot(p.vx, p.vy);
    if (speed > 0.5) {
      p.vx *= 0.5 / speed;
      p.vy *= 0.5 / speed;
    }
    p.x += p.vx * k;
    p.y += p.vy * k;
    if (p.x < -20) p.x = width + 20;
    else if (p.x > width + 20) p.x = -20;
    if (p.y < -20) p.y = height + 20;
    else if (p.y > height + 20) p.y = -20;
  }
}

function draw() {
  ctx.clearRect(0, 0, width, height);
  const max2 = LINK_DISTANCE * LINK_DISTANCE;

  ctx.lineWidth = 1;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    for (let j = i + 1; j < points.length; j++) {
      const b = points[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > max2) continue;
      const alpha = (1 - Math.sqrt(d2) / LINK_DISTANCE) * 0.42;
      ctx.strokeStyle = `rgba(${colors.line}, ${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  if (pointer.active) {
    for (const p of points) {
      const d = Math.hypot(pointer.x - p.x, pointer.y - p.y);
      if (d > POINTER_RADIUS) continue;
      ctx.strokeStyle = `rgba(${colors.pointer}, ${((1 - d / POINTER_RADIUS) * 0.45).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(pointer.x, pointer.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
  }

  ctx.fillStyle = colors.dot;
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// The app marks <body data-status="recording|paused|stopping"> while a lecture is live.
const frozen = () => document.hidden || reducedMotion.matches || /^(recording|paused|stopping)$/.test(document.body.dataset.status || '');

function frame(now) {
  rafId = 0;
  if (frozen()) return; // restarted by the observers below
  const dt = Math.min(now - (last || now), 100);
  if (dt >= FRAME_MS || !last) {
    last = now;
    step(dt || 16.7);
    draw();
  }
  rafId = requestAnimationFrame(frame);
}

function start() {
  if (rafId || frozen()) {
    if (!rafId) draw(); // a still frame, so the background is never empty
    return;
  }
  last = 0;
  rafId = requestAnimationFrame(frame);
}

if (canvas && ctx) {
  readColors();
  resize();
  draw();
  start();

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resize();
      draw();
    }, 120);
  });
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return; // touch would just yank points around
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.active = true;
  }, { passive: true });
  document.addEventListener('pointerleave', () => { pointer.active = false; });
  window.addEventListener('blur', () => { pointer.active = false; });
  document.addEventListener('visibilitychange', start);
  reducedMotion.addEventListener('change', start);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    readColors();
    draw();
  });
  new MutationObserver(start).observe(document.body, { attributes: true, attributeFilter: ['data-status'] });
}
