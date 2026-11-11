# Rythmik

Make beats in your browser. A step sequencer with a synthesized drum kit and 808, built with Vite, vanilla JavaScript and the Web Audio API. No samples, no backend, no network requests: the production build is plain static files.

## Features
- 8 synthesized tracks: Kick, Snare, Clap, Closed hat, Open hat, Rim, Shaker, 808 bass
- 16-step grid, per-step 808 notes (A minor)
- Tempo 60–180 BPM, swing, per-track volume / mute / solo, master volume
- Presets: Afro bass, Trap, Boom bap, Empty
- Autosave in your browser, export / import patterns as JSON
- Keyboard: Space plays/stops, arrow keys move between pads

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

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Hashed assets can be cached for a long time
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    gzip on;
    gzip_types text/css application/javascript image/svg+xml application/json;
}
```

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

If you add a Content-Security-Policy header, allow `worker-src blob:`: the audio clock runs in a small inline Worker so the beat keeps time in background tabs.

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
2. Rap booth: record vocals over the beat, WAV export
3. Effects, including a robot-autotune voice
4. Polish and ship
