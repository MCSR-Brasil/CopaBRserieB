/*
  Invisible MP3 radio for GitHub Pages + OBS Browser Source (LOCAL ONLY)
  - Plays .mp3 files from a local folder in this repo (no GitHub API, no playlist file)
  - Discovers files by probing a numeric range with optional prefix/suffix
  - Random playback, nothing visible on the page

  Configure via URL query params (all optional):
  - path:   Folder path containing mp3s (default: "audio")
  - start:  Start number in range (default: 1)
  - end:    End number in range, inclusive (default: 50)
  - prefix: Filename prefix (default: "")
  - suffix: Filename suffix/extension (default: ".mp3")
  - volume: 0.0..1.0 (default: 1.0)
  - unique: 1 to avoid repeats until all have played once (default: 1)

  Filename pattern: `${path}/${prefix}${n}${suffix}` where n in [start, end]
  Example: path=audio, prefix=track_, start=1, end=10, suffix=.mp3 => audio/track_1.mp3 .. audio/track_10.mp3
*/
(function () {
  const params = new URLSearchParams(window.location.search);
  const path = (params.get('path') || 'audio').replace(/^\/+|\/+$/g, '');
  const start = parseInt(params.get('start') || '1', 10);
  const end = parseInt(params.get('end') || '50', 10);
  const prefix = params.get('prefix') || '';
  const suffix = params.get('suffix') || '.mp3';
  const volume = Math.max(0, Math.min(1, parseFloat(params.get('volume') || '1')));
  const unique = params.get('unique') !== '0';
  const autoplayParam = (params.get('autoplay') || 'auto').toLowerCase(); // auto | muted | sound
  const debug = params.get('debug') === '1';
  const nextParam = params.get('next') || params.get('queue') || '';
  const listParam = params.get('list') || params.get('tracks') || '';
  const indexParam = params.get('index');

  const isOBS = !!window.obsstudio || /OBS/i.test(navigator.userAgent || '');
  function shouldStartMuted() {
    if (autoplayParam === 'muted') return true;
    if (autoplayParam === 'sound') return false;
    // auto
    return !isOBS; // In OBS we can start with sound; in browsers start muted
  }

  function fileUrl(n) {
    return `${path}/${prefix}${n}${suffix}`;
  }

  async function probe(url) {
    // GitHub Pages + OBS sometimes behave oddly with HEAD; use a small Range GET fallback.
    try {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (res.ok) return true;
    } catch (_) {
      // ignore, fallback below
    }
    try {
      const res = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        headers: { Range: 'bytes=0-0' },
      });
      return res.ok || res.status === 206;
    } catch (_) {
      return false;
    }
  }

  async function exists(url) {
    // Retry a couple times to reduce the chance of transient failures causing a tiny playlist.
    for (let i = 0; i < 3; i++) {
      const ok = await probe(url);
      if (ok) return true;
      await new Promise(r => setTimeout(r, 150));
    }
    return false;
  }

  async function discoverFiles() {
    const nums = [];
    for (let n = start; n <= end; n++) nums.push(n);
    const results = await Promise.all(
      nums.map(async (n) => ({ n, ok: await exists(fileUrl(n)) }))
    );
    return results.filter(r => r.ok).map(r => fileUrl(r.n));
  }

  function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function parseNextNumbers(raw) {
    if (!raw) return [];
    return raw
      .split(/[,;\s]+/)
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => parseInt(s, 10))
      .filter(n => Number.isFinite(n));
  }

  async function tryReadIndexMd() {
    if (indexParam === '0') return null;
    const indexPath = (indexParam || `${path}/Index.md`).replace(/^\/+/, '');
    try {
      const res = await fetch(indexPath, { cache: 'no-store' });
      if (!res.ok) return null;
      const text = await res.text();
      const entries = [];
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/^\s*(\d+)\s*[-–—:]\s*(.+?)\s*$/);
        if (!m) continue;
        const n = parseInt(m[1], 10);
        if (!Number.isFinite(n)) continue;
        entries.push({ n, name: m[2] });
      }
      if (!entries.length) return null;
      return entries;
    } catch (_) {
      return null;
    }
  }

  async function init() {
    try {
      let files = [];
      const nameByUrl = new Map();

      const listNumbers = parseNextNumbers(listParam);
      if (listNumbers.length) {
        const listUrls = listNumbers.map(n => fileUrl(n));
        const checks = await Promise.all(
          listUrls.map(async (u) => ({ u, ok: await exists(u) }))
        );
        files = checks.filter(x => x.ok).map(x => x.u);
      } else {
        const indexEntries = await tryReadIndexMd();
        if (indexEntries && indexEntries.length) {
          const indexUrls = indexEntries.map(e => ({ url: fileUrl(e.n), name: e.name }));
          const checks = await Promise.all(
            indexUrls.map(async (x) => ({ ...x, ok: await exists(x.url) }))
          );
          files = checks.filter(x => x.ok).map(x => x.url);
          for (const x of checks) {
            if (x.ok && x.name) nameByUrl.set(x.url, x.name);
          }
        }
      }

      if (!files.length) {
        files = await discoverFiles();
      }
      if (!files.length) {
        console.warn('[radio] No MP3 files found. Checked range:', start, '-', end, 'under path:', path);
        return;
      }

      if (debug) {
        console.log('[radio] Discovered files:', files.length, files);
      }

      const forcedNumbers = parseNextNumbers(nextParam);
      let forcedQueue = forcedNumbers.map(n => fileUrl(n));
      if (forcedQueue.length) {
        // Pre-filter to existing files to reduce error-skips.
        const forcedChecks = await Promise.all(
          forcedQueue.map(async (u) => ({ u, ok: await exists(u) }))
        );
        forcedQueue = forcedChecks.filter(x => x.ok).map(x => x.u);
        if (debug) {
          console.log('[radio] Forced queue:', forcedQueue.length, forcedQueue);
        }
      }

      const audio = new Audio();
      audio.autoplay = true; // OBS Browser Source should allow autoplay
      audio.controls = false;
      audio.loop = false;
      audio.preload = 'auto';
      audio.volume = volume;
      audio.crossOrigin = 'anonymous';
      audio.style.display = 'none';
      document.body.appendChild(audio);
      audio.muted = shouldStartMuted();

      let debugEl = null;
      if (debug) {
        debugEl = document.createElement('div');
        debugEl.style.position = 'fixed';
        debugEl.style.left = '10px';
        debugEl.style.top = '10px';
        debugEl.style.zIndex = '9999';
        debugEl.style.padding = '8px 10px';
        debugEl.style.background = 'rgba(0,0,0,0.6)';
        debugEl.style.color = '#fff';
        debugEl.style.font = '12px/1.4 monospace';
        debugEl.style.whiteSpace = 'pre';
        debugEl.textContent = '[radio] init';
        document.body.appendChild(debugEl);
      }

      function attachUserGestureGate() {
        let armed = true;
        const handler = () => {
          if (!armed) return;
          armed = false;
          try { audio.muted = false; } catch (_) {}
          if (audio.paused) {
            audio.play().catch(() => {/* ignore */});
          }
          window.removeEventListener('click', handler);
          window.removeEventListener('keydown', handler);
          window.removeEventListener('touchstart', handler);
        };
        window.addEventListener('click', handler, { once: true });
        window.addEventListener('keydown', handler, { once: true });
        window.addEventListener('touchstart', handler, { once: true, passive: true });
      }

      let queue = unique ? shuffle(files) : files.slice();
      let queueIndex = 0;

      function removeFromQueueIfPresent(url) {
        if (!unique) return;
        const idx = queue.indexOf(url);
        if (idx === -1) return;
        queue.splice(idx, 1);
        if (idx < queueIndex) queueIndex = Math.max(0, queueIndex - 1);
      }

      function nextSrc() {
        if (!files.length) return null;
        if (forcedQueue.length) {
          const url = forcedQueue.shift();
          removeFromQueueIfPresent(url);
          return url;
        }
        if (!unique) return pickRandom(files);

        if (queueIndex >= queue.length) {
          queue = shuffle(files);
          queueIndex = 0;
        }
        const url = queue[queueIndex];
        queueIndex += 1;
        return url;
      }

      async function tryPlay() {
        try {
          await audio.play();
        } catch (err) {
          // If blocked, try muting and retry; attach user gesture to unmute later
          if (err && String(err.name || err).includes('NotAllowedError')) {
            if (!audio.muted) {
              audio.muted = true;
              try { await audio.play(); return; } catch (_) {}
            }
            attachUserGestureGate();
          } else {
            console.warn('[radio] play() failed:', err);
          }
        }
      }

      function playNext() {
        const url = nextSrc();
        if (!url) return;
        const displayName = nameByUrl.get(url) || '';
        // Cache-bust to avoid weird caching in long-running OBS browser sources.
        const cacheBust = `cb=${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const nextUrl = url.includes('?') ? `${url}&${cacheBust}` : `${url}?${cacheBust}`;
        audio.src = nextUrl;
        if (debugEl) {
          const forcedLeft = forcedQueue.length ? `\n[forced left] ${forcedQueue.join(', ')}` : '';
          const nameLine = displayName ? `\n[name] ${displayName}` : '';
          debugEl.textContent = `[radio] files=${files.length}\n[running] ${url}${nameLine}${forcedLeft}`;
        }
        tryPlay();
      }

      audio.addEventListener('ended', playNext);
      audio.addEventListener('error', () => {
        console.error('[radio] Audio error, skipping to next track.', audio.error);
        if (debugEl) {
          debugEl.textContent = `[radio] ERROR -> skip\n${audio.currentSrc || ''}`;
        }
        playNext();
      });

      // Minimal debug
      window.radioDebug = {
        get files() { return files.slice(); },
        get current() { return audio.currentSrc; },
        get currentName() {
          const raw = audio.currentSrc || '';
          const cleaned = raw.split('?')[0];
          return nameByUrl.get(cleaned) || '';
        },
        next: playNext,
        get forcedQueue() { return forcedQueue.slice(); },
        setNext(list) {
          const nums = Array.isArray(list) ? list : parseNextNumbers(String(list || ''));
          forcedQueue = nums.map(n => fileUrl(n));
        },
        setVolume(v) { audio.volume = Math.max(0, Math.min(1, v)); },
        audio,
      };

      playNext();
    } catch (e) {
      console.error('[radio] Unexpected error:', e);
    }
  }

  init();
})();
