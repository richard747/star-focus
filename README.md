# Star Focus

A calm focus timer for a child. It runs **10 minutes of focus**, then a **3 minute break**, and keeps going until you stop it. Each finished focus round earns a star.

The countdown is a big ring that drains clockwise. Focus time is green. Break time is blue. The words change too, so color is not the only clue.

## Run it locally

The timer is a static site. Service workers (offline) and the screen wake lock need a real web address, so open it through a small local server instead of double-clicking the file.

```bash
python3 -m http.server 8736
```

Then open [http://127.0.0.1:8736](http://127.0.0.1:8736).

Any other static server works. Serve this folder as-is. Paths are relative, so the site also works under a subpath such as `https://example.com/star-focus/`.

## Use it

- **Start** begins the current round. The same button becomes **Pause**, then **Resume**.
- **Reset** goes back to the start of focus time and stops. Stars stay.
- **Skip** jumps to the next round. Skipping a focus round does not earn a star.
- **Settings** (the sliders) changes focus and break length, from 1 to 60 minutes. The chime can be turned off there, or with the speaker button. **Clear stars** asks you to tap again so it is harder to hit by mistake.
- Times, the chime, and stars are saved on this device in `localStorage`.

If a round is already running, it keeps the time it started with. The new length is used the next time that round begins.

## Add it to an iPhone Home Screen

1. Open the site in **Safari** (the address must be the https site, or your computer on the same Wi-Fi).
2. Tap the **Share** button.
3. Tap **Add to Home Screen**.
4. Tap **Add**.

Open Star Focus from the new icon so it runs full screen, without Safari’s toolbar. The first open should be online. After that, the saved copy can open offline.

Set the minutes inside the home-screen app. On iOS, Safari and a home-screen icon do not always share saved settings.

## Put it on GitHub Pages

1. Push this folder to a GitHub repository. `index.html` should be at the root of the published folder.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Branch: `main`. Folder: **`/ (root)`**. Save.
5. Wait for the site. It will be at `https://<user>.github.io/<repo>/`.

`.nojekyll` is included so GitHub Pages will not run Jekyll. That keeps the fonts, icons, and `sw.js` available. The manifest is `manifest.json` so static hosts serve it as JSON.

Project sites live under `/<repo>/`. Relative links and a service-worker scope of `./` are what make that work. Do not rewrite asset paths to start with `/`.

## How the clock stays honest

The app does not count down by adding up timer ticks. When a round is running it stores the moment that round should end (`Date.now()` plus the time left). Every frame, and again whenever you come back to the app, it subtracts the current time from that moment.

If the screen locked or you switched apps, the next look jumps straight to the right minute and, if a round finished while you were away, into the next one. Several rounds can finish while the page is frozen. The ring, the label, and the stars catch up together. One return adds at most six stars, so a timer left running all evening cannot fill the screen. The time of day on the ring is still the real one.

If the phone actually closed the app and you open it more than an hour after the saved round ended, Star Focus does not invent the missed rounds. It waits at focus time again. Stars you already earned stay. A paused round is restored as paused.

While a round is running, the page asks to stay awake with the [Screen Wake Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API) when the browser has it. The chime is made with Web Audio (no audio file). The first tap unlocks sound, which iOS requires.

## iOS limits

These are limits of the platform, not bugs in the page:

- A website cannot reliably play a sound, buzz, or show a notification while the iPhone is locked or Star Focus has been closed. There is no trustworthy background alarm for a home-screen web app.
- If iOS freezes the page (screen lock, app switch), the clock is corrected from timestamps when you come back, as long as iOS did not throw the page away.
- If iOS did throw the page away, a round that was running is continued from the saved end time only if you return within an hour. Otherwise it starts ready again.
- Wake Lock needs a recent iOS (16.4 or newer) and can still be ignored. The screen may dim or lock anyway. It never keeps the screen on after the phone is locked.
- The silent switch silences the chime.
- Offline use needs one successful online visit after installing, so the service worker can save the files.

## Files

- `index.html`, `styles.css`, `app.js` — the timer
- `manifest.json`, `sw.js`, `icons/` — installable, offline app
- `fonts/` — Nunito, under the [SIL Open Font License](fonts/OFL.txt)
