// @ts-check
// ui-src/src/chat/scroll-follow.js. Stick-to-bottom for the thread (spec 008 S3, after Copilot's
// useChatScrolling): follow while within END_THRESHOLD_PX of the end, pause only on an upward scroll, re-pin
// whenever the content grows while following.

export const END_THRESHOLD_PX = 24;

export class ScrollFollower {
  /**
   * @param {Window & typeof globalThis} win @param {HTMLElement} scroller @param {HTMLElement} content
   * @param {(paused: boolean) => void} onPausedChange called when "jump to latest" should show or hide
   */
  constructor(win, scroller, content, onPausedChange) {
    this.scroller = scroller;
    this.onPausedChange = onPausedChange;
    /** Off for views that start at the top and stay there (Find papers' table). */
    this.enabled = true;
    this.following = true;
    this.lastScrollTop = scroller.scrollTop;
    this.onScroll = () => {
      const top = scroller.scrollTop;
      if (this.nearEnd()) this.setFollowing(true);
      else if (top < this.lastScrollTop) this.setFollowing(false);
      this.lastScrollTop = top;
    };
    scroller.addEventListener('scroll', this.onScroll);
    this.resize = new win.ResizeObserver(() => { if (this.enabled && this.following) this.pin(); });
    this.resize.observe(scroller);
    this.resize.observe(content);
  }

  nearEnd() {
    const s = this.scroller;
    return s.scrollHeight - s.clientHeight - s.scrollTop <= END_THRESHOLD_PX;
  }

  pin() {
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.lastScrollTop = this.scroller.scrollTop;
  }

  /** Back to the end and following: a new turn, a reopened chat, "jump to latest". */
  follow() {
    this.enabled = true;
    this.setFollowing(true);
    this.pin();
  }

  /** Stop following altogether, without offering "jump to latest". */
  disable() {
    this.enabled = false;
    this.setFollowing(false);
  }

  /** @param {boolean} following */
  setFollowing(following) {
    this.following = following;
    this.onPausedChange(this.enabled && !following);
  }

  destroy() {
    this.scroller.removeEventListener('scroll', this.onScroll);
    this.resize.disconnect();
  }
}
