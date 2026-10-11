// Spooky mode's "ghost talk" visual: a few drifting, glowing waves whose
// height follows the real output level (read from the player's
// AnalyserNode), so they swell when something is actually being said and
// settle to a faint shimmer between words. Stylized, not a literal scope.

const COLORS = ['#b46cff', '#5dff9a', '#ff8a2a'];

export class Waveform {
  private ctx: CanvasRenderingContext2D;
  private samples: Float32Array<ArrayBuffer>;
  private level = 0;
  private running = false;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(
    private canvas: HTMLCanvasElement,
    private analyser: AnalyserNode
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.samples = new Float32Array(analyser.fftSize);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const frame = (t: number) => {
      if (!this.running) return;
      this.draw(t / 1000);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
  }

  private draw(t: number): void {
    const { canvas, ctx } = this;
    // Hidden (skeptic mode) -- nothing to draw.
    if (!canvas.offsetParent) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const s of this.samples) sum += s * s;
    const rms = Math.sqrt(sum / this.samples.length);
    // Fast attack, slow release, so speech reads as breathing swells.
    const target = Math.min(1, rms * 5);
    this.level += (target - this.level) * (target > this.level ? 0.35 : 0.06);

    const speed = this.reducedMotion ? 0.15 : 1;
    const mid = h / 2;
    const amp = h * (0.04 + this.level * 0.42);

    ctx.lineWidth = 2;
    ctx.globalCompositeOperation = 'lighter';
    COLORS.forEach((color, i) => {
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 3) {
        const u = x / w;
        // Taper to the edges so the waves seem to emerge from nothing.
        const envelope = Math.sin(Math.PI * u) ** 1.5;
        const y =
          Math.sin(u * (9 + i * 3) + t * speed * (1.3 + i * 0.4)) * 0.6 +
          Math.sin(u * (23 + i * 5) - t * speed * (2.1 + i * 0.3)) * 0.3 +
          Math.sin(u * 51 + t * speed * 3.7 + i) * 0.1 * this.level;
        const py = mid + y * amp * envelope;
        if (x === 0) ctx.moveTo(x, py);
        else ctx.lineTo(x, py);
      }
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    // Fade both ends out: there the waves converge on the midline and the
    // additive blend of all three colors would otherwise glare white.
    const fade = ctx.createLinearGradient(0, 0, w, 0);
    fade.addColorStop(0, 'rgba(0,0,0,0)');
    fade.addColorStop(0.18, 'rgba(0,0,0,1)');
    fade.addColorStop(0.82, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  }
}
