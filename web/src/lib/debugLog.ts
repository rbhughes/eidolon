// The skeptic-mode debug log: every behind-the-scenes step (stream
// connections, snippet picks, playback start/stop, the model calls with
// their prompts, token counts and cost) as timestamped monospace lines.
// Plain text only -- everything goes in via textContent, since some of it
// (transcripts, model output) is arbitrary text from the outside world.

export type LogTag = 'sys' | 'stream' | 'hop' | 'play' | 'capture' | 'llm' | 'cost' | 'error';

const MAX_LINES = 600;

function timestamp(d = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export class DebugLog {
  /** Whether to keep the newest line in view. Off once the reader scrolls
   * up to read something, back on when they return to the bottom. */
  private follow = true;

  constructor(private el: HTMLElement) {
    el.addEventListener('scroll', () => {
      // A hidden log (spooky mode) has no geometry -- don't let that read
      // as "scrolled up".
      if (el.clientHeight === 0) return;
      this.follow = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
    });
  }

  /** Jump to the newest line, e.g. when the log becomes visible again --
   * it can't scroll while hidden, so it would otherwise show the oldest. */
  scrollToEnd(): void {
    this.follow = true;
    this.el.scrollTop = this.el.scrollHeight;
  }

  /** Append a line. `detail` is shown indented beneath it, verbatim --
   * for prompts and model output. */
  log(tag: LogTag, message: string, detail?: string): void {
    const line = document.createElement('div');
    line.className = `line tag-${tag}`;
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = timestamp();
    const tg = document.createElement('span');
    tg.className = 'tag';
    tg.textContent = tag.padEnd(7);
    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = message;
    // appendChild rather than append(): @cloudflare/workers-types redefines
    // the DOM's variadic append() project-wide (see web/CLAUDE.md).
    line.appendChild(ts);
    line.appendChild(tg);
    line.appendChild(msg);
    if (detail) {
      const pre = document.createElement('pre');
      pre.className = 'detail';
      pre.textContent = detail;
      line.appendChild(pre);
    }
    this.el.appendChild(line);

    while (this.el.childElementCount > MAX_LINES) this.el.firstElementChild!.remove();
    if (this.follow) this.el.scrollTop = this.el.scrollHeight;
  }

  clear(): void {
    this.el.replaceChildren();
  }
}
