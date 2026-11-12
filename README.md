# Rythmik

Make beats in your browser, then rap over them. A step sequencer with a synthesized drum kit and 808, a recording booth and a remix deck for your own songs, built with Vite, vanilla JavaScript and the Web Audio API. No samples, no backend, no network requests: the production build is plain static files.

## Features
**Beat**
- 8 synthesized tracks: Kick, Snare, Clap, Closed hat, Open hat, Rim, Shaker, 808 bass
- 16-step grid, presets (Afro bass, Trap, Boom bap, Empty), tempo 60 to 180 BPM
- Effects: Space (reverb) and Echo, plus Filter, Drive and per-track sends
- Export the beat as WAV, export / import patterns as JSON, autosave in your browser

**Booth**
- Pick your mic, record over the looping beat with a count-in, keep multiple takes
- Latency compensation, optional monitoring
- Voice presets: Clean, Robot and Tuned autotune, Radio, Hall, Lo-fi (key, scale and retune speed in Advanced)
- Export the full song or the vocal alone as WAV

**Remix**
- Load your own song (it never leaves your computer), see its waveform and loop any part of it
- One-click Slowed + reverb and Nightcore, speed presets from super slowed to sped up, Space, Muffle, Bass and Volume (keep pitch and fine speed in Advanced)
- Tempo detection plus tap tempo; the beat can play along in time with the song
- Record your takes over the remix in the Booth, export the remix as WAV

**For beginners and pros**
- One Advanced switch reveals swing, per-track volume / mute / solo, master volume, per-step 808 notes and latency trim
- A "?" next to every control explains it in one sentence, plus a short first-visit tour and a Guide page
- Keyboard: Space plays/stops, R records in the Booth, Esc cancels, arrow keys move between pads

## Limits
- Songs up to 10 minutes and 200 MB; everything stays in memory, so very long songs are heavy on phones
- Up to 12 takes at a time
- The mic needs HTTPS (or localhost)
- WAV exports are 16-bit

## Run locally
Requires Node.js 22.12 or newer (Vite 8 and Vitest 5).

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173.

## Test

```bash
npm test
```

Audio tests render offline in Node (via `node-web-audio-api`) and check for silence, clipping and timing.

## Build

```bash
npm run build
```

The static site is written to `dist/`. Preview it with:

```bash
npm run preview
```

## Deploy to a VPS with nginx
Replace `user@your-server` and `rythmik.example.com` with your own values. Use SSH keys; never put passwords or keys in this repo.

1. Build locally:

```bash
npm ci && npm run build
```

2. Create the web root on the server:

```bash
ssh user@your-server "sudo mkdir -p /var/www/rythmik && sudo chown $USER /var/www/rythmik"
```

3. Upload the build:

```bash
rsync -avz --delete dist/ user@your-server:/var/www/rythmik/
```

(Without rsync: `scp -r dist/* user@your-server:/var/www/rythmik/`)

4. Add an nginx site, e.g. `/etc/nginx/sites-available/rythmik`:

```nginx
server {
    listen 80;
    server_name rythmik.example.com;
    root /var/www/rythmik;
    index index.html;

    # Routes live in the URL hash, so missing files can simply 404
    location / {
        try_files $uri $uri/ =404;
    }

    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    # Hashed assets can be cached for a long time
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    gzip on;
    gzip_types text/css text/javascript application/javascript image/svg+xml application/json;

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
}
```

nginx drops server-level `add_header` lines inside a `location` that sets its own, so copy the security headers (and the CSP, if you use one) into those blocks if you want them on every response.

5. Enable it and reload nginx:

```bash
sudo ln -s /etc/nginx/sites-available/rythmik /etc/nginx/sites-enabled/
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

6. Optional HTTPS with Let's Encrypt:

```bash
sudo certbot --nginx -d rythmik.example.com
```

If you add a Content-Security-Policy header, this one works:

```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self' blob:; worker-src 'self' blob:; style-src 'self'; font-src 'self'; img-src 'self' data:; media-src 'self' blob:" always;
```

`blob:` is needed because the audio clock runs in a small inline Worker (so the beat keeps time in background tabs) and mic capture uses an inline AudioWorklet; `data:` covers the panel texture.

The build uses relative asset paths (`base: './'`), so it also works from a subfolder.

## Project structure
```
src/audio/   Web Audio engine, scheduler, synthesized voices, presets, pattern format (no DOM)
src/ui/      Interface, styling, persistence
tests/       Vitest tests (audio rendered offline)
docs/        Engine API reference
```

## Roadmap
1. Beat maker (done)
2. Rap booth: record vocals over the beat, WAV export (done)
3. Effects, including a robot-autotune voice (done)
4. Remix deck: slow down, add reverb and rap over your own tracks (done)
5. Polish and ship (done)

## License
MIT, see [LICENSE](LICENSE).
